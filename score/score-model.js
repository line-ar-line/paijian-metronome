(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KalimbaScore = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const LIMITS = Object.freeze({ maxBars: 2048, maxNotes: 100000 });
  const INSTRUMENTS = Object.freeze({ '17C': { low: 60, high: 88 }, '21C': { low: 53, high: 88 } });
  const DEGREES = ['1', '1', '2', '2', '3', '4', '4', '5', '5', '6', '6', '7'];
  const BLACK_KEYS = new Set([1, 3, 6, 8, 10]);
  const DURATIONS = [16, 12, 8, 6, 4, 3, 2, 1]; // Sixteenth-note units.

  function assertInstrument(instrument) {
    if (!Object.prototype.hasOwnProperty.call(INSTRUMENTS, instrument)) throw new Error('暂时只支持 17 音 C 调或 21 音 C 调卡林巴。');
  }

  function assertMidi(midi) {
    if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new Error('音高必须是 0–127 范围内的整数 MIDI 音符。');
  }

  function pitchInfo(midi, instrument = '17C') {
    assertMidi(midi);
    assertInstrument(instrument);
    const pitchClass = midi % 12;
    const accidental = BLACK_KEYS.has(pitchClass) ? '#' : '';
    const range = INSTRUMENTS[instrument];
    const reasons = [];
    if (accidental) reasons.push('当前琴没有这个升号音');
    if (midi < range.low || midi > range.high) reasons.push('超出当前琴的音域');
    return {
      midi, degree: DEGREES[pitchClass], accidental,
      octave: Math.floor(midi / 12) - 5,
      playable: reasons.length === 0,
      reason: reasons.join('；'),
    };
  }

  function normalizeOptions(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('转谱设置必须是一个对象。');
    const instrument = options.instrument === undefined ? '17C' : options.instrument;
    assertInstrument(instrument);
    const transpose = options.transpose === undefined ? 0 : options.transpose;
    if (!Number.isInteger(transpose) || transpose < -24 || transpose > 24) throw new Error('移调范围为 -24 到 +24 个半音。');
    const meter = options.meter === undefined ? [4, 4] : options.meter;
    if (!Array.isArray(meter) || meter.length !== 2 || !Number.isInteger(meter[0]) || meter[0] < 1 || meter[0] > 12 || ![2, 4, 8, 16].includes(meter[1])) {
      throw new Error('拍号分子须为 1–12，分母须为 2、4、8 或 16。');
    }
    if (options.grid !== undefined && options.grid !== 0.25) throw new Error('当前数字谱按十六分音符（四分之一拍）整理节奏。');
    const totalBeats = options.totalBeats === undefined ? 0 : options.totalBeats;
    if (typeof totalBeats !== 'number' || !Number.isFinite(totalBeats) || totalBeats < 0) throw new Error('完整乐曲的总时长须为大于或等于 0 的有限拍数。');
    return { instrument, transpose, meter: [...meter], grid: 0.25, title: String(options.title ?? '').slice(0, 200), totalBeats };
  }

  function validateNotes(notes) {
    if (!Array.isArray(notes)) throw new Error('音符数据必须是一个数组。');
    if (notes.length > LIMITS.maxNotes) throw new Error(`音符超过完整转谱支持的 ${LIMITS.maxNotes} 个，本次不生成不完整曲谱。可从音乐软件导出完整旋律轨后重试。`);
    notes.forEach((note, index) => {
      if (!note || typeof note !== 'object') throw new Error(`第 ${index + 1} 个音符格式无效。`);
      assertMidi(note.midi);
      if (typeof note.start !== 'number' || !Number.isFinite(note.start) || note.start < 0) throw new Error(`第 ${index + 1} 个音符的开始时间无效。`);
      if (typeof note.duration !== 'number' || !Number.isFinite(note.duration) || note.duration <= 0) throw new Error(`第 ${index + 1} 个音符的时值必须大于 0。`);
      if (note.velocity !== undefined && (typeof note.velocity !== 'number' || !Number.isFinite(note.velocity) || note.velocity < 0 || note.velocity > 1)) {
        throw new Error(`第 ${index + 1} 个音符的力度须为 0–1。`);
      }
    });
  }

  function buildScore(input, userOptions = {}) {
    const options = normalizeOptions(userOptions);
    validateNotes(input);
    const barTicks = options.meter[0] * 16 / options.meter[1];
    const maxTicks = barTicks * LIMITS.maxBars;
    const durationError = () => new Error(`完整乐曲超过当前支持的 ${LIMITS.maxBars} 小节，本次拒绝转换整个文件，不生成部分曲谱。`);
    if (options.totalBeats * 4 > maxTicks) throw durationError();
    const stats = { inputNotes: input.length, outputNotes: 0, unplayable: 0, removedPolyphony: 0, clippedOverlaps: 0, quantized: 0 };
    const warnings = [];
    let sourceEndBeat = 0;

    const prepared = input.map((note, index) => {
      const originalEnd = note.start + note.duration;
      if (originalEnd * 4 > maxTicks) throw durationError();
      sourceEndBeat = Math.max(sourceEndBeat, originalEnd);
      const startTick = Math.round(note.start * 4);
      // Quantize note endpoints, not just durations, to preserve the grid's gaps.
      const endTick = Math.max(startTick + 1, Math.round(originalEnd * 4));
      if (endTick > maxTicks) throw durationError();
      if (Math.abs(startTick / 4 - note.start) > 1e-7 || Math.abs((endTick - startTick) / 4 - note.duration) > 1e-7) stats.quantized++;
      const midi = note.midi + options.transpose;
      if (midi < 0 || midi > 127) throw new Error('移调后有音符超出 MIDI 音高范围，请减小移调幅度。');
      return { sourceId: `n${index}`, midi, startTick, endTick, velocity: note.velocity === undefined ? 0.8 : note.velocity };
    }).sort((a, b) => a.startTick - b.startTick || b.midi - a.midi || b.endTick - a.endTick || a.sourceId.localeCompare(b.sourceId));

    // This intentionally produces a single melody line. All simplifications are
    // counted and disclosed; the UI must not imply automatic melody extraction.
    const chosen = [];
    for (const note of prepared) {
      if (chosen.length && chosen[chosen.length - 1].startTick === note.startTick) stats.removedPolyphony++;
      else chosen.push({ ...note });
    }
    chosen.forEach((note, index) => {
      const next = chosen[index + 1];
      if (next && note.endTick > next.startTick) { note.endTick = next.startTick; stats.clippedOverlaps++; }
    });
    const finalTick = chosen.length ? chosen[chosen.length - 1].endTick : 0;
    // A selected melody can finish before the song's end or before a discarded
    // accompaniment note. Preserve that complete timeline as rests instead of
    // shortening the piece. A too-short supplied duration never clips notes.
    const sourceTotalBeats = Math.max(sourceEndBeat, options.totalBeats, finalTick / 4);
    const barCount = Math.ceil(sourceTotalBeats * 4 / barTicks);
    if (barCount > LIMITS.maxBars) throw durationError();
    const bars = Array.from({ length: barCount }, (_, index) => ({ index, start: index * barTicks / 4, duration: barTicks / 4, tokens: [] }));
    const notes = chosen.map(note => {
      const info = pitchInfo(note.midi, options.instrument);
      if (!info.playable) stats.unplayable++;
      return { ...info, pitchInfo: info, sourceId: note.sourceId, start: note.startTick / 4, duration: (note.endTick - note.startTick) / 4, velocity: note.velocity };
    });
    stats.outputNotes = notes.length;

    let nextTokenId = 0;
    function addSpan(startTick, endTick, note = null) {
      let cursor = startTick;
      while (cursor < endTick) {
        const barIndex = Math.floor(cursor / barTicks);
        const available = Math.min(endTick, (barIndex + 1) * barTicks) - cursor;
        const duration = DURATIONS.find(value => value <= available);
        const info = note ? note.pitchInfo : { midi: null, degree: '0', accidental: '', octave: 0, playable: true, reason: '' };
        bars[barIndex].tokens.push({
          ...info, id: `token-${nextTokenId++}`, sourceId: note ? note.sourceId : null,
          start: cursor / 4, duration: duration / 4,
          tieIn: !!note && cursor > note.start * 4,
          tieOut: !!note && cursor + duration < (note.start + note.duration) * 4,
        });
        cursor += duration;
      }
    }
    let cursor = 0;
    notes.forEach(note => {
      const start = note.start * 4;
      if (cursor < start) addSpan(cursor, start);
      cursor = start + note.duration * 4;
      addSpan(start, cursor, note);
    });
    if (cursor < barCount * barTicks) addSpan(cursor, barCount * barTicks);

    if (stats.removedPolyphony) warnings.push(`同一位置有多个音符，已保留最高音并省略 ${stats.removedPolyphony} 个同时音；这是单旋律简化，并非自动识别主旋律。`);
    if (stats.clippedOverlaps) warnings.push(`有 ${stats.clippedOverlaps} 个音符与后续音符重叠，已缩短至后续音符开始处。`);
    if (stats.quantized) warnings.push(`${stats.quantized} 个音符的起止时间已按十六分音符网格规整；断奏长度、休止与三连音可能改变，请对照原曲校对。`);
    if (stats.unplayable) warnings.push(`${stats.unplayable} 个音符超出当前琴的音域或含升号；原音高已保留并标注，可尝试整体移调。`);
    return { bars, notes, warnings, stats, totalBeats: barCount * barTicks / 4, sourceTotalBeats, sourceEndBeat, barBeats: barTicks / 4, options };
  }

  function suggestTranspose(notes, instrument = '17C') {
    assertInstrument(instrument);
    validateNotes(notes);
    if (!notes.length) return { transpose: 0, playable: 0, total: 0 };
    let best = null;
    for (let transpose = -24; transpose <= 24; transpose++) {
      let playable = 0, weight = 0;
      for (const note of notes) {
        const midi = note.midi + transpose;
        if (midi >= 0 && midi <= 127 && pitchInfo(midi, instrument).playable) {
          playable++;
          weight += note.duration;
        }
      }
      if (!best || weight > best.weight + 1e-8 || (Math.abs(weight - best.weight) <= 1e-8 && (playable > best.playable || (playable === best.playable && Math.abs(transpose) < Math.abs(best.transpose))))) {
        best = { transpose, playable, total: notes.length, weight };
      }
    }
    return { transpose: best.transpose, playable: best.playable, total: best.total };
  }

  return { pitchInfo, buildScore, suggestTranspose, LIMITS };
});
