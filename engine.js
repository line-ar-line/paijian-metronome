(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.MetronomeEngine = api.MetronomeEngine;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const DEFAULTS = Object.freeze({
    bpm: 80, beatsPerBar: 4, subdivision: 1,
    accents: [2, 1, 1, 1], volume: 0.65, sound: 'wood'
  });
  const LOOKAHEAD = 0.12;
  const START_DELAY = 0.04;
  const STALL_TOLERANCE = 0.06;

  function bounded(value, fallback, min, max) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
  }

  function normalizeSettings(patch = {}, previous = DEFAULTS) {
    const source = { ...previous, ...patch };
    const beatsPerBar = Math.round(bounded(source.beatsPerBar, 4, 1, 12));
    const subdivision = [1, 2, 3, 4].includes(Number(source.subdivision)) ? Number(source.subdivision) : 1;
    const suppliedAccents = Array.isArray(source.accents) ? source.accents : [];
    return {
      bpm: Math.round(bounded(source.bpm, 80, 30, 240)),
      beatsPerBar,
      subdivision,
      accents: Array.from({ length: beatsPerBar }, (_, index) =>
        [0, 1, 2].includes(suppliedAccents[index]) ? suppliedAccents[index] : (index === 0 ? 2 : 1)),
      volume: bounded(source.volume, 0.65, 0, 1),
      sound: ['wood', 'click', 'bell'].includes(source.sound) ? source.sound : 'wood'
    };
  }

  // BPM always counts one displayed beat, irrespective of the subdivision count.
  function tickDuration(settings) {
    return 60 / settings.bpm / settings.subdivision;
  }

  class MetronomeEngine {
    constructor(callbacks = {}, dependencies = {}) {
      this.onBeat = callbacks.onBeat || (() => {});
      this.onStateChange = callbacks.onStateChange || (() => {});
      this.onError = callbacks.onError || (() => {});
      this.settings = normalizeSettings();
      this._dependencies = dependencies;
      this._context = null;
      this._master = null;
      this._running = false;
      this._generation = 0;
      this._voices = new Set();
      this._events = [];
      this._frame = null;
      this._timer = null;
      this._worker = null;
      this._beat = 0;
      this._subdivision = 0;
      this._bar = 1;
      this._nextTime = 0;
    }

    get isRunning() { return this._running; }

    async start(settings = {}) {
      this._halt();
      const generation = ++this._generation;
      this.settings = normalizeSettings(settings, this.settings);
      try {
        if (!this._context || this._context.state === 'closed') {
          const createContext = this._dependencies.createContext || (() => {
            const AudioContext = root.AudioContext || root.webkitAudioContext;
            if (!AudioContext) throw new Error('当前浏览器不支持 Web Audio，请使用新版 Chrome、Safari 或 Edge。');
            return new AudioContext({ latencyHint: 'interactive' });
          });
          this._context = createContext();
          this._context.onstatechange = () => {
            if (this._running && this._context.state !== 'running') this.stop('interrupted');
          };
        }
        if (this._context.state !== 'running') await this._context.resume();
        // A stop or a second start during resume must invalidate this start.
        if (generation !== this._generation) return false;
        if (this._context.state !== 'running') throw new Error('音频未能启动，请再次点击开始。');
        this._master = this._context.createGain();
        this._master.gain.setValueAtTime(this.settings.volume, this._context.currentTime);
        this._master.connect(this._context.destination);
        this._running = true;
        this._resetPosition();
        this.onStateChange({ state: 'running', reason: 'start' });
        this._schedule();
        this._startClock();
        this._startVisuals();
        return true;
      } catch (error) {
        if (generation !== this._generation) return false;
        this._halt();
        this.onError(error);
        this.onStateChange({ state: 'stopped', reason: 'error' });
        return false;
      }
    }

    stop(reason = 'stop') {
      ++this._generation;
      this._halt();
      this.onStateChange({ state: 'stopped', reason });
    }

    configure(patch = {}) {
      const previous = this.settings;
      this.settings = normalizeSettings(patch, previous);
      if (!this._running) return;
      this.setVolume(this.settings.volume);
      if (previous.beatsPerBar !== this.settings.beatsPerBar || previous.subdivision !== this.settings.subdivision) {
        // Cancel the old pattern before resetting so no stale accented beat leaks through.
        this._cancelVoices();
        this._events = [];
        this._resetPosition();
        this._schedule();
      }
      // Other changes apply to newly scheduled ticks. A previously planned beat
      // interval can finish at the old tempo, which preserves the current phase.
    }

    setVolume(value) {
      this.settings.volume = bounded(value, this.settings.volume, 0, 1);
      if (this._master) {
        const now = this._context.currentTime;
        this._master.gain.cancelScheduledValues(now);
        this._master.gain.setTargetAtTime(this.settings.volume, now, 0.005);
      }
    }

    _resetPosition() {
      this._beat = 0;
      this._subdivision = 0;
      this._bar = 1;
      this._nextTime = this._context.currentTime + START_DELAY;
    }

    _schedule() {
      if (!this._running) return;
      const now = this._context.currentTime;
      if (this._context.state !== 'running') { this.stop('interrupted'); return; }
      // Do not bunch missed ticks together after device sleep or a long main-thread stall.
      if (this._nextTime < now - STALL_TOLERANCE) { this.stop('stalled'); return; }
      // RAF may be paused in a hidden tab; keep only recent visual events.
      while (this._events.length && this._events[0].audioTime < now - 0.5) this._events.shift();
      while (this._nextTime < now + LOOKAHEAD) {
        const event = {
          beat: this._beat, subdivision: this._subdivision,
          bar: this._bar, audioTime: this._nextTime, bpm: this.settings.bpm
        };
        const accent = this.settings.accents[this._beat];
        if (accent !== 0) this._sound(this._nextTime, this._subdivision === 0 ? accent : -1);
        this._events.push(event);
        // Advance on the audio clock, never by the elapsed JavaScript timer time.
        this._nextTime += tickDuration(this.settings);
        this._subdivision += 1;
        if (this._subdivision >= this.settings.subdivision) {
          this._subdivision = 0;
          this._beat += 1;
          if (this._beat >= this.settings.beatsPerBar) { this._beat = 0; this._bar += 1; }
        }
      }
    }

    _sound(time, accent) {
      const strong = accent === 2;
      const sub = accent === -1;
      const level = sub ? 0.12 : (strong ? 0.48 : 0.32);
      const frequency = sub ? 750 : (strong ? 1500 : 1050);
      if (this.settings.sound === 'bell') {
        this._tone(time, frequency * 0.68, level * 0.65, 0.11, 'sine');
        this._tone(time, frequency * 1.37, level * 0.19, 0.065, 'sine');
      } else if (this.settings.sound === 'click') {
        this._tone(time, frequency, level * 0.65, 0.022, 'square');
      } else {
        this._tone(time, frequency * 0.7, level, 0.045, 'sine', frequency * 0.36);
      }
    }

    _tone(time, frequency, level, duration, type, endFrequency) {
      const context = this._context;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, time);
      if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, time + duration);
      // Tiny attack avoids harsh discontinuities; the short exponential decay makes a clean click.
      gain.gain.setValueAtTime(0.0001, time);
      gain.gain.exponentialRampToValueAtTime(level, time + 0.0015);
      gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
      oscillator.connect(gain);
      gain.connect(this._master);
      const voice = { oscillator, gain };
      this._voices.add(voice);
      oscillator.onended = () => {
        oscillator.disconnect();
        gain.disconnect();
        this._voices.delete(voice);
      };
      oscillator.start(time);
      oscillator.stop(time + duration + 0.003);
    }

    _startClock() {
      if (this._dependencies.manualClock) return;
      // A small worker avoids ordinary background-tab timer clamping where browsers allow it.
      // Browser/device suspension can still stop audio; the stall guard handles that explicitly.
      if (root.Worker && root.Blob && root.URL && root.URL.createObjectURL) {
        let url;
        try {
          url = root.URL.createObjectURL(new root.Blob(['setInterval(() => postMessage(0), 25);'], { type: 'text/javascript' }));
          this._worker = new root.Worker(url);
          this._worker.onmessage = () => this._schedule();
          this._worker.onerror = (event) => {
            event.preventDefault();
            if (this._worker) this._worker.terminate();
            this._worker = null;
            if (this._running && this._timer === null) this._timer = root.setInterval(() => this._schedule(), 25);
          };
          return;
        } catch (_) {
          if (this._worker) this._worker.terminate();
          this._worker = null;
        } finally {
          if (url) root.URL.revokeObjectURL(url);
        }
      }
      this._timer = root.setInterval(() => this._schedule(), 25);
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

    _flushVisuals() {
      const audibleTime = this._audibleTime();
      let latest;
      while (this._events.length && this._events[0].audioTime <= audibleTime) latest = this._events.shift();
      // On returning to a background tab, render the current beat instead of replaying old flashes.
      if (latest) this.onBeat(latest);
    }

    _startVisuals() {
      if (this._dependencies.manualClock || !root.requestAnimationFrame) return;
      const render = () => {
        if (!this._running) return;
        this._flushVisuals();
        this._frame = root.requestAnimationFrame(render);
      };
      this._frame = root.requestAnimationFrame(render);
    }

    _cancelVoices() {
      for (const voice of this._voices) {
        try { voice.oscillator.stop(); } catch (_) { /* Already ended. */ }
        voice.oscillator.disconnect();
        voice.gain.disconnect();
      }
      this._voices.clear();
    }

    _halt() {
      this._running = false;
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
      this._cancelVoices();
      this._events = [];
    }
  }

  return { MetronomeEngine, normalizeSettings, tickDuration };
});
