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
  const ode = [
    [64], [64], [65], [67], [67], [65], [64], [62],
    [60], [60], [62], [64], [64, 1.5], [62, .5], [62, 2],
    [64], [64], [65], [67], [67], [65], [64], [62],
    [60], [60], [62], [64], [62, 1.5], [60, .5], [60, 2],
  ];
  const higher = [
    [60, .5], [64, .5], [67, .5], [72, .5], [76], [72],
    [62, .5], [65, .5], [69, .5], [74, .5], [77], [74],
    [64, .5], [67, .5], [72, .5], [76, .5], [79, 1.5], [76, .5],
    [72, 3], [60],
  ];
  root.ScoreExamples = [
    { id: 'twinkle', title: '小星星', subtitle: '传统旋律 · 单音练习版', bpm: 80, meter: [4, 4], notes: sequence(twinkle), source: '公版传统旋律，程序内置练习编排' },
    { id: 'ode', title: '欢乐颂', subtitle: '贝多芬 · 主题节选', bpm: 88, meter: [4, 4], notes: sequence(ode), source: '贝多芬《第九交响曲》公版主题，单音节选' },
    { id: 'higher', title: '指尖小练习', subtitle: '拍间原创 · 左右手与高音练习', bpm: 72, meter: [4, 4], notes: sequence(higher), source: '拍间原创练习' },
  ];
})(typeof globalThis !== 'undefined' ? globalThis : window);
