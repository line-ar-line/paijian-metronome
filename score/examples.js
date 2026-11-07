(function (root) {
  'use strict';
  function sequence(values) {
    let start = 0;
    return values.map(([midi, duration = 1]) => {
      const note = { midi, start, duration, velocity: 0.8 };
      start += duration;
      return note;
    });
  }
  const twinkle = [
    [60], [60], [67], [67], [69], [69], [67, 2],
    [65], [65], [64], [64], [62], [62], [60, 2],
    [67], [67], [65], [65], [64], [64], [62, 2],
    [67], [67], [65], [65], [64], [64], [62, 2],
    [60], [60], [67], [67], [69], [69], [67, 2],
    [65], [65], [64], [64], [62], [62], [60, 2],
  ];
  // Full 16-measure soprano melody from Mutopia item 528 (Public Domain).
  // The source is in G major; transpose the entire melody to C5-based C major
  // so its low dominant and high notes all fit a 17-key C kalimba.
  const ode = [
    [64], [64], [65], [67], [67], [65], [64], [62],
    [60], [60], [62], [64], [64, 1.5], [62, .5], [62, 2],
    [64], [64], [65], [67], [67], [65], [64], [62],
    [60], [60], [62], [64], [62, 1.5], [60, .5], [60, 2],
    [62], [62], [64], [60],
    [62], [64, .5], [65, .5], [64], [60],
    [62], [64, .5], [65, .5], [64], [62],
    [60], [62], [55, 2],
    [64], [64], [65], [67], [67], [65], [64], [62],
    [60], [60], [62], [64], [62, 1.5], [60, .5], [60, 2],
  ].map(([midi, duration = 1]) => [midi + 12, duration]);
  const higher = [
    [60, .5], [64, .5], [67, .5], [72, .5], [76], [72],
    [62, .5], [65, .5], [69, .5], [74, .5], [77], [74],
    [64, .5], [67, .5], [72, .5], [76, .5], [79, 1.5], [76, .5],
    [72, 3], [60],
  ];
  // A new simple accompaniment, not the original SATB harmony. Every melody
  // note above stays intact; two half-note bass tones cover each complete bar.
  // D4 beneath the low G4 in bar 12 avoids doubling the same kalimba tine.
  const bassPairs = [
    [60, 67], [60, 67], [60, 67], [60, 67],
    [60, 67], [60, 67], [60, 67], [67, 60],
    [67, 60], [67, 60], [67, 62], [60, 62],
    [60, 67], [60, 67], [60, 67], [67, 60],
  ];
  const odeDuet = sequence(ode).concat(bassPairs.flatMap((pair, bar) => pair.map((midi, half) => ({
    midi, start: bar * 4 + half * 2, duration: 2, velocity: 0.56,
  })))).sort((a, b) => a.start - b.start || a.midi - b.midi || a.duration - b.duration);
  root.ScoreExamples = [
    { id: 'ode-duet', title: '欢乐颂 · 双音伴奏版', subtitle: '完整 16 小节主题 · 旋律＋简易伴奏', bpm: 76, meter: [4, 4], mode: 'polyphonic', notes: odeDuet, source: '完整旋律来自 Mutopia #528 公版赞美诗版本；拍间另编简易伴奏，共 16 小节、94 音。非原版四声部配器。', sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=528' },
    { id: 'twinkle', title: '小星星', subtitle: '完整 12 小节旋律 · C 调单音编配', bpm: 80, meter: [4, 4], notes: sequence(twinkle), source: '公版传统旋律 · 完整 12 小节，含中段与再现' },
    { id: 'ode', title: '欢乐颂', subtitle: '完整 16 小节主题 · C 调单音编配', bpm: 88, meter: [4, 4], notes: sequence(ode), source: 'Mutopia #528 公版赞美诗版本 · 完整 16 小节高声部旋律，统一移至 C 调', sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=528' },
    { id: 'higher', title: '指尖小练习', subtitle: '拍间原创 · 完整 4 小节练习', bpm: 72, meter: [4, 4], notes: sequence(higher), source: '拍间原创练习 · 完整 4 小节' },
  ];
})(typeof globalThis !== 'undefined' ? globalThis : window);
