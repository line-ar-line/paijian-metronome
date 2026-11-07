(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ScorePlayer = api.ScorePlayer;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const LOOKAHEAD = 0.12;
  const START_DELAY = 0.04;
  const MAX_NOTES = 100000;
  const MAX_BEATS = 49152;
  const MAX_POLYPHONY = 16;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function midiFrequency(midi) { return 440 * Math.pow(2, (midi - 69) / 12); }

  function normalizeScore(notes, options = {}) {
    if (!Array.isArray(notes) || notes.length === 0) throw new Error('乐谱中没有可播放的音符，请先添加旋律。');
    if (notes.length > MAX_NOTES) throw new Error(`音符超过本地试听的 ${MAX_NOTES} 个资源上限，已拒绝整首播放。可重新导出完整旋律音轨，去掉不需要的伴奏。`);
    const bpm = options.bpm === undefined ? 80 : options.bpm;
    const volume = options.volume === undefined ? 0.6 : options.volume;
    if (!Number.isFinite(bpm) || bpm <= 0) throw new Error('播放速度必须是有效的正数。');
    if (!Number.isFinite(volume)) throw new Error('音量必须是有效的数字。');
    const entries = notes.map((input, index) => {
      if (!input || !Number.isInteger(input.midi) || input.midi < 0 || input.midi > 127) {
        throw new Error(`第 ${index + 1} 个音符的音高无效，请使用 0–127 之间的 MIDI 音高。`);
      }
      if (!Number.isFinite(input.start) || input.start < 0 || !Number.isFinite(input.duration) || input.duration <= 0) {
        throw new Error(`第 ${index + 1} 个音符的开始位置或时值无效。`);
      }
      if (input.start + input.duration > MAX_BEATS) throw new Error(`第 ${index + 1} 个音符超出 ${MAX_BEATS} 拍的本地播放长度范围，已拒绝整首播放。请检查源文件的时间设置；可重新导出完整旋律音轨，去掉不需要的伴奏。`);
      if (input.duration < 1 / 1024) throw new Error(`第 ${index + 1} 个音符短于可精确试听的时值，已拒绝整首播放，请检查源文件的音符时值。`);
      if (input.velocity !== undefined && !Number.isFinite(input.velocity)) throw new Error(`第 ${index + 1} 个音符的力度无效。`);
      return { index, note: { ...input, velocity: input.velocity === undefined ? 1 : clamp(input.velocity, 0, 1) } };
    }).sort((a, b) => a.note.start - b.note.start || a.index - b.index);
    // A malformed import must not allocate thousands of oscillators simultaneously.
    let activeEnds = [];
    let noteEnd = 0;
    for (const entry of entries) {
      activeEnds = activeEnds.filter(end => end > entry.note.start + 1e-9);
      activeEnds.push(entry.note.start + entry.note.duration);
      noteEnd = Math.max(noteEnd, entry.note.start + entry.note.duration);
      if (activeEnds.length > MAX_POLYPHONY) throw new Error(`同时发声的音符不能超过 ${MAX_POLYPHONY} 个，已达到本地合成器的资源上限并拒绝整首播放。可重新导出完整旋律音轨，去掉不需要的伴奏。`);
    }
    if (options.totalBeats !== undefined && (!Number.isFinite(options.totalBeats) || options.totalBeats < 0 || options.totalBeats > MAX_BEATS)) {
      throw new Error(`乐谱总时长必须是 0–${MAX_BEATS} 之间的有效拍数，超出本地资源范围时会拒绝整首播放。请检查源文件的时间设置；可重新导出完整旋律音轨，去掉不需要的伴奏。`);
    }
    return {
      entries,
      bpm: clamp(bpm, 30, 240),
      volume: clamp(volume, 0, 1),
      // A supplied length can extend trailing rests but may never cut off a note.
      totalBeats: Math.max(noteEnd, options.totalBeats || 0)
    };
  }

  class ScorePlayer {
    constructor(callbacks = {}, dependencies = {}) {
      this.onNote = callbacks.onNote || (() => {});
      this.onStateChange = callbacks.onStateChange || (() => {});
      this.onProgress = callbacks.onProgress || (() => {});
      this.onError = callbacks.onError || (() => {});
      this._dependencies = dependencies;
      this._context = null;
      this._master = null;
      this._playing = false;
      this._generation = 0;
      this._score = null;
      this._volume = 0.6;
      this._voices = new Set();
      this._nextIndex = 0;
      this._visualIndex = 0;
      this._startTime = 0;
      this._endTime = 0;
      this._lastTick = 0;
      this._lastProgress = 0;
      this._timer = null;
      this._worker = null;
      this._frame = null;
      this._tick = () => {
        try { this._schedule(); }
        catch (error) { this._fail(error); }
      };
    }

    get isPlaying() { return this._playing; }

    async play(notes, options = {}) {
      this._halt();
      const generation = ++this._generation;
      try {
        this._score = normalizeScore(notes, options);
        this._volume = this._score.volume;
        this._lastProgress = 0;
        if (!this._context || this._context.state === 'closed') {
          const createContext = this._dependencies.createContext || (() => {
            const AudioContext = root.AudioContext || root.webkitAudioContext;
            if (!AudioContext) throw new Error('当前浏览器不支持音频播放，请使用新版 Chrome、Safari 或 Edge。');
            return new AudioContext({ latencyHint: 'interactive' });
          });
          const context = createContext();
          this._context = context;
          context.onstatechange = () => {
            if (this._context === context && this._playing && context.state !== 'running') this.stop('interrupted');
          };
        }
        if (this._context.state !== 'running') await this._context.resume();
        if (generation !== this._generation) return false;
        if (this._context.state !== 'running') throw new Error('音频未能启动，请再次点击播放。');
        this._master = this._context.createGain();
        this._master.gain.setValueAtTime(this._volume, this._context.currentTime);
        this._master.connect(this._context.destination);
        this._startTime = this._context.currentTime + START_DELAY;
        this._endTime = this._startTime + this._score.totalBeats * 60 / this._score.bpm;
        this._lastTick = this._context.currentTime;
        this._nextIndex = 0;
        this._visualIndex = 0;
        this._playing = true;
        this.onProgress({ beat: 0, totalBeats: this._score.totalBeats });
        this.onStateChange({ state: 'playing', reason: 'play' });
        if (generation !== this._generation || !this._playing) return false;
        this._schedule();
        this._startClock();
        this._startVisuals();
        return true;
      } catch (error) {
        if (generation !== this._generation) return false;
        this._fail(error);
        return false;
      }
    }

    stop(reason = 'stop') {
      if (this._playing) this._reportProgress(this._audibleTime());
      ++this._generation;
      this._halt();
      this.onStateChange({ state: 'stopped', reason });
    }

    setVolume(value) {
      if (!Number.isFinite(value)) return;
      this._volume = clamp(value, 0, 1);
      if (this._master) {
        const now = this._context.currentTime;
        this._master.gain.cancelScheduledValues(now);
        this._master.gain.setTargetAtTime(this._volume, now, 0.005);
      }
    }

    _schedule() {
      if (!this._playing) return;
      const context = this._context;
      const now = context.currentTime;
      if (context.state !== 'running') { this.stop('interrupted'); return; }
      const secondsPerBeat = 60 / this._score.bpm;
      const next = this._score.entries[this._nextIndex];
      // Stop after a missed deadline instead of replaying several old notes at once.
      if (now - this._lastTick > 0.35 || (next && this._startTime + next.note.start * secondsPerBeat < now - 0.04)) {
        this.stop('stalled'); return;
      }
      this._lastTick = now;
      while (this._nextIndex < this._score.entries.length) {
        const entry = this._score.entries[this._nextIndex];
        const time = this._startTime + entry.note.start * secondsPerBeat;
        if (time >= now + LOOKAHEAD) break;
        if (entry.note.velocity > 0) this._pluck(entry.note, time, entry.note.duration * secondsPerBeat);
        this._nextIndex += 1;
      }
      // Completion runs on the scheduling clock too, so it works in hidden tabs.
      if (this._audibleTime() >= this._endTime) this._complete();
    }

    _pluck(note, time, duration) {
      const frequency = midiFrequency(note.midi);
      const amplitude = note.velocity * 0.34;
      // One pluck per input note: a long/tied note keeps its original envelope.
      // Quiet, rapidly decaying upper partials add the metallic kalimba attack.
      this._partial(frequency, time, duration, amplitude, true);
      this._partial(frequency * 2.76, time, Math.min(duration, 0.35), amplitude * 0.17, false);
      this._partial(frequency * 5.4, time, Math.min(duration, 0.15), amplitude * 0.055, false);
    }

    _partial(frequency, time, duration, amplitude, fundamental) {
      const context = this._context;
      // Do not synthesize upper partials above Nyquist; they would alias on high notes.
      if (context.sampleRate && frequency >= context.sampleRate * 0.48) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const attack = Math.min(0.003, duration * 0.12);
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, time);
      gain.gain.setValueAtTime(0.00001, time);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.00002, amplitude), time + attack);
      if (fundamental && duration > 0.025) {
        gain.gain.exponentialRampToValueAtTime(Math.max(0.00002, amplitude * 0.22), time + Math.min(0.45, duration * 0.55));
      }
      gain.gain.exponentialRampToValueAtTime(0.00001, time + duration);
      gain.gain.setValueAtTime(0, time + duration);
      oscillator.connect(gain);
      gain.connect(this._master);
      const voice = { oscillator, gain };
      this._voices.add(voice);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); this._voices.delete(voice); };
      oscillator.start(time);
      oscillator.stop(time + duration + 0.002);
    }

    _audibleTime() {
      const context = this._context;
      if (context.getOutputTimestamp && root.performance) {
        const stamp = context.getOutputTimestamp();
        if (stamp.contextTime > 0 && stamp.performanceTime > 0) {
          return Math.min(context.currentTime, stamp.contextTime + (root.performance.now() - stamp.performanceTime) / 1000);
        }
      }
      return context.currentTime - (context.baseLatency || 0) - (context.outputLatency || 0);
    }

    _reportProgress(audibleTime) {
      const beat = clamp((audibleTime - this._startTime) * this._score.bpm / 60, 0, this._score.totalBeats);
      // Output timestamp jitter should never make the playhead go backwards.
      this._lastProgress = Math.max(this._lastProgress, beat);
      this.onProgress({ beat: this._lastProgress, totalBeats: this._score.totalBeats });
    }

    _flushVisuals() {
      if (!this._playing) return;
      const audibleTime = this._audibleTime();
      const secondsPerBeat = 60 / this._score.bpm;
      let latest;
      while (this._visualIndex < this._score.entries.length) {
        const entry = this._score.entries[this._visualIndex];
        if (this._startTime + entry.note.start * secondsPerBeat > audibleTime) break;
        latest = entry;
        this._visualIndex += 1;
      }
      // After a hidden tab returns, show its current note without replaying flashes.
      if (latest) this.onNote({ index: latest.index, note: latest.note });
      if (this._playing) this._reportProgress(audibleTime);
    }

    _complete() {
      this._flushVisuals();
      if (!this._playing) return;
      const totalBeats = this._score.totalBeats;
      ++this._generation;
      this._halt();
      this._lastProgress = totalBeats;
      this.onProgress({ beat: totalBeats, totalBeats });
      this.onStateChange({ state: 'stopped', reason: 'ended' });
    }

    _fail(error) {
      ++this._generation;
      this._halt();
      this.onError(error);
      this.onStateChange({ state: 'stopped', reason: 'error' });
    }

    _startClock() {
      if (this._dependencies.manualClock) return;
      if (root.Worker && root.Blob && root.URL && root.URL.createObjectURL) {
        let url;
        try {
          url = root.URL.createObjectURL(new root.Blob(['setInterval(() => postMessage(0), 25);'], { type: 'text/javascript' }));
          const worker = new root.Worker(url);
          this._worker = worker;
          worker.onmessage = this._tick;
          worker.onerror = (event) => {
            event.preventDefault(); worker.terminate();
            if (this._worker !== worker) return;
            this._worker = null;
            if (this._playing && this._timer === null) this._timer = root.setInterval(this._tick, 25);
          };
          return;
        } catch (_) {
          if (this._worker) this._worker.terminate();
          this._worker = null;
        } finally { if (url) root.URL.revokeObjectURL(url); }
      }
      this._timer = root.setInterval(this._tick, 25);
    }

    _startVisuals() {
      if (this._dependencies.manualClock || !root.requestAnimationFrame) return;
      const render = () => {
        if (!this._playing) return;
        this._flushVisuals();
        if (this._playing) this._frame = root.requestAnimationFrame(render);
      };
      this._frame = root.requestAnimationFrame(render);
    }

    _halt() {
      this._playing = false;
      if (this._worker) this._worker.terminate();
      this._worker = null;
      if (this._timer !== null) root.clearInterval(this._timer);
      this._timer = null;
      if (this._frame !== null && root.cancelAnimationFrame) root.cancelAnimationFrame(this._frame);
      this._frame = null;
      if (this._master) {
        this._master.gain.cancelScheduledValues(this._context.currentTime);
        this._master.gain.setValueAtTime(0, this._context.currentTime);
        this._master.disconnect();
      }
      this._master = null;
      for (const voice of this._voices) {
        try { voice.oscillator.stop(); } catch (_) { /* The voice may already have ended. */ }
        voice.oscillator.disconnect(); voice.gain.disconnect();
      }
      this._voices.clear();
    }
  }

  return { ScorePlayer, midiFrequency, normalizeScore };
});
