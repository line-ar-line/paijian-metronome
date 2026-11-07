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
  root.ScoreExamples = [
    { id: 'twinkle', title: '小星星', subtitle: '完整 12 小节旋律 · C 调单音编配', bpm: 80, meter: [4, 4], notes: sequence(twinkle), source: '公版传统旋律 · 完整 12 小节，含中段与再现' },
    { id: 'ode', title: '欢乐颂', subtitle: '完整 16 小节主题 · C 调单音编配', bpm: 88, meter: [4, 4], notes: sequence(ode), source: 'Mutopia #528 公版赞美诗版本 · 完整 16 小节高声部旋律，统一移至 C 调', sourceUrl: 'https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=528' },
    { id: 'higher', title: '指尖小练习', subtitle: '拍间原创 · 完整 4 小节练习', bpm: 72, meter: [4, 4], notes: sequence(higher), source: '拍间原创练习 · 完整 4 小节' },
  ];
})(typeof globalThis !== 'undefined' ? globalThis : window);
