(function (root, factory) {
  const model = typeof module === 'object' && module.exports ? require('./score-model.js') : root.KalimbaScore;
  const api = factory(model);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ScoreDocument = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function (model) {
  'use strict';
  const lengths = [16, 12, 8, 6, 4, 3, 2, 1];
  const semitones = [0, 0, 2, 4, 5, 7, 9, 11];
  const clean = (value, limit) => {
    if (value !== undefined && value !== null && typeof value !== 'string') throw new Error('曲名、声部名与说明必须为文字。');
    const text = value ?? '';
    if (Array.from(text).length > limit) throw new Error(`曲名、声部名或说明超过 ${limit} 字，请缩短后再保存。`);
    return text;
  };
  function normalize(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.format !== 'paijian-score' || input.version !== 1) throw new Error('请选择拍间制谱导出的第 1 版 JSON 曲谱。');
    if (!Array.isArray(input.voices) || !input.voices.length || input.voices.length > 4) throw new Error('曲谱需要 1–4 个声部。');
    const bpm = Number(input.bpm);
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 240) throw new Error('速度须为 30–240 BPM。');
    const meter = input.meter;
    if (!Array.isArray(meter) || meter.length !== 2 || !Number.isInteger(meter[0]) || meter[0] < 1 || meter[0] > 12 || ![2, 4, 8, 16].includes(meter[1])) throw new Error('拍号格式无效。');
    if (!['17C', '21C'].includes(input.instrument)) throw new Error('请选择 17 音或 21 音 C 调琴。');
    const voices = input.voices.map((voice, index) => {
      if (!voice || typeof voice.notation !== 'string' || voice.notation.length > 200000) throw new Error(`声部 ${index + 1} 的数字谱格式无效或过长。`);
      return { name: clean(voice.name || `声部 ${index + 1}`, 16), notation: voice.notation };
    });
    const repeats = input.repeats ?? [];
    if (!Array.isArray(repeats) || repeats.length > 100) throw new Error('反复段格式无效。');
    const normalizedRepeats = repeats.map(item => {
      if (!item || !Number.isInteger(item.startBar) || !Number.isInteger(item.endBar) || item.startBar < 1 || item.endBar < item.startBar || !Number.isInteger(item.times) || item.times < 2 || item.times > 8) throw new Error('反复段须填写起止小节及 2–8 次总演奏次数。');
      return { startBar: item.startBar, endBar: item.endBar, times: item.times };
    }).sort((a, b) => a.startBar - b.startBar);
    normalizedRepeats.forEach((r, i) => { if (i && r.startBar <= normalizedRepeats[i - 1].endBar) throw new Error('暂不支持重叠或嵌套的反复段。'); });
    const credits = input.credits ?? [];
    if (!Array.isArray(credits) || credits.length > 12 || credits.some(c => typeof c !== 'string' || c.length > 1000)) throw new Error('署名须为最多 12 行文字，每行不超过 1000 字。');
    return { format: 'paijian-score', version: 1, title: clean(input.title || '未命名曲谱', 80), bpm, meter: [...meter], instrument: input.instrument, voices, repeats: normalizedRepeats, credits: [...credits], description: clean(input.description, 1500) };
  }
  function pitch(value) {
    const match = /^(#?)([1-7])('{1,2}|_{1,2})?$/.exec(value);
    if (!match) throw new Error(`无法识别音符「${value}」。用 1–7，' 表示高八度，_ 表示低八度。`);
    const octave = match[3] ? (match[3][0] === "'" ? 1 : -1) * match[3].length : 0;
    return 60 + semitones[Number(match[2])] + octave * 12 + (match[1] ? 1 : 0);
  }
  function parseVoice(voice, barTicks) {
    let text = voice.notation.trim().replace(/\r/g, '');
    if (text.endsWith('|')) text = text.slice(0, -1).trim();
    if (!text) throw new Error(`「${voice.name}」还没有音符。`);
    const bars = text.split('|');
    if (bars.length > 2048) throw new Error('曲谱最多支持 2048 个小节。');
    return bars.map((bar, index) => {
      const tokens = bar.trim().match(/~?\([^)]*\)(?::[^\s|]+)?|[^\s|]+/g) || [];
      let tick = 0;
      const events = tokens.map(token => {
        const match = /^(.*?)(?::(\d+(?:\.\d+)?))?$/.exec(token);
        const body = match[1], duration = match[2] === undefined ? 1 : Number(match[2]);
        if (!(duration > 0) || !Number.isInteger(duration * 4) || duration * 4 > barTicks) throw new Error(`「${voice.name}」第 ${index + 1} 小节：时值须为 0.25 拍的倍数，且不超过一小节。`);
        const chord = /^(~?)\((.+)\)$/.exec(body);
        const pitches = body === '0' ? [] : chord ? chord[2].split(',').map(v => pitch(v.trim())) : [pitch(body)];
        if (pitches.length > 8 || new Set(pitches).size !== pitches.length) throw new Error('和弦最多 8 个音，且不能重复同一音高。');
        if (chord && pitches.length < 2) throw new Error('和弦或滑音至少需要两个音。');
        const event = { tick, ticks: duration * 4, pitches: pitches.sort((a, b) => b - a), glissando: !!chord?.[1] };
        tick += event.ticks;
        return event;
      });
      if (tick !== barTicks) throw new Error(`「${voice.name}」第 ${index + 1} 小节有 ${tick / 4} 拍，需要 ${barTicks / 4} 拍。用 0 补休止，或修改音符时值。`);
      return events;
    });
  }
  function compile(input) {
    const document = normalize(input);
    const barTicks = document.meter[0] * 16 / document.meter[1];
    const voices = document.voices.map(v => parseVoice(v, barTicks));
    const count = voices[0].length;
    if (voices.some(v => v.length !== count)) throw new Error('所有声部的小节数量必须相同；空小节可用 0:4（4/4 拍）表示。');
    if (document.repeats.some(r => r.endBar > count)) throw new Error('反复段超出了曲谱的小节范围。');
    const notes = [], warnings = [];
    const bars = Array.from({ length: count }, (_, index) => ({ index, start: index * barTicks / 4, duration: barTicks / 4, tokens: [], voices: [] }));
    const rest = { midi: null, degree: '0', octave: 0, accidental: '', playable: true, reason: '' };
    voices.forEach((voiceBars, voiceIndex) => voiceBars.forEach((events, barIndex) => {
      const bar = bars[barIndex], lane = { index: voiceIndex, tokens: [] };
      events.forEach((event, eventIndex) => {
        const group = `v${voiceIndex}-b${barIndex}-e${eventIndex}`;
        const infos = event.pitches.map((midi, i) => ({ ...model.pitchInfo(midi, document.instrument), sourceId: `${group}-p${i}` }));
        infos.forEach(info => notes.push({ ...info, start: bar.start + event.tick / 4, duration: event.ticks / 4, velocity: voiceIndex ? .68 : .85, voiceIndex, glissandoGroup: event.glissando ? group : null }));
        let offset = 0;
        while (offset < event.ticks) {
          const ticks = lengths.find(n => n <= event.ticks - offset);
          const token = { ...(infos[0] || rest), sourceId: infos[0]?.sourceId || null, id: `${group}-t${offset}`, start: bar.start + (event.tick + offset) / 4, duration: ticks / 4, voiceIndex, tieIn: infos.length > 0 && offset > 0, tieOut: infos.length > 0 && offset + ticks < event.ticks, ...(infos.length > 1 ? { pitches: infos } : {}), glissando: event.glissando && offset === 0 };
          lane.tokens.push(token); bar.tokens.push(token); offset += ticks;
        }
      });
      bar.voices.push(lane);
    }));
    if (notes.length > 100000) throw new Error('曲谱超过 100000 个音符，无法保存为完整练习谱。');
    const unplayable = notes.filter(n => !n.playable).length;
    if (unplayable) warnings.push(`${unplayable} 个音符超出当前琴的自然音范围，已保留原音并标橙色。`);
    document.repeats.forEach(r => { bars[r.startBar - 1].repeatStart = true; bars[r.endBar - 1].repeatEnd = r.times; });
    const playbackBarMap = [];
    for (let i = 0; i < count; i++) {
      playbackBarMap.push(i);
      const repeat = document.repeats.find(r => r.endBar === i + 1);
      if (repeat) for (let t = 1; t < repeat.times; t++) for (let b = repeat.startBar - 1; b <= i; b++) playbackBarMap.push(b);
    }
    if (playbackBarMap.length > 2048) throw new Error('展开反复后超过 2048 小节。');
    const byBar = Array.from({ length: count }, () => []);
    for (const n of notes) byBar[Math.floor(n.start * 4 / barTicks)].push(n);
    const playbackNotes = [];
    playbackBarMap.forEach((barIndex, playIndex) => {
      const barNotes = byBar[barIndex];
      for (const note of barNotes) {
        const group = note.glissandoGroup ? barNotes.filter(n => n.glissandoGroup === note.glissandoGroup).sort((a, b) => a.midi - b.midi) : [];
        // A short rising sweep changes attacks only; the written rhythm stays intact.
        const step = group.length ? Math.min(.035 * document.bpm / 60, note.duration * .4 / (group.length - 1)) : 0;
        const delay = group.length ? group.findIndex(n => n.sourceId === note.sourceId) * step : 0;
        playbackNotes.push({ ...note, start: (playIndex - barIndex) * barTicks / 4 + note.start + delay, duration: note.duration - delay });
      }
    });
    if (playbackNotes.length > 100000) throw new Error('展开反复后超过 100000 个音符，无法完整试听。');
    const changes = notes.flatMap(n => [{ time: n.start, delta: 1 }, { time: n.start + n.duration, delta: -1 }]).sort((a, b) => a.time - b.time || a.delta - b.delta);
    let active = 0, maxPolyphony = 0;
    changes.forEach(c => { active += c.delta; maxPolyphony = Math.max(maxPolyphony, active); });
    const totalBeats = playbackBarMap.length * barTicks / 4;
    const score = { bars, notes, warnings, stats: { inputNotes: notes.length, outputNotes: notes.length, unplayable, voiceCount: voices.length, maxPolyphony, quantized: 0, removedPolyphony: 0, clippedOverlaps: 0 }, voiceNames: document.voices.map(v => v.name), authored: true, playbackBarMap, totalBeats: count * barTicks / 4, sourceTotalBeats: count * barTicks / 4, barBeats: barTicks / 4, options: { instrument: document.instrument, mode: 'polyphonic', meter: document.meter, title: document.title } };
    return { document, score, playbackNotes, totalBeats, warnings };
  }
  return { normalize, compile };
});
