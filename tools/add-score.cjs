#!/usr/bin/env node
'use strict';
// Validate a complete editable score before adding it to the public catalog.
const fs = require('node:fs');
const path = require('node:path');
const { compile } = require('../score/document.js');
const args = process.argv.slice(2);
const usage = '用法：node tools/add-score.cjs <导出的JSON> <英文曲目ID，例如 my-song>';
try {
  if (args.length !== 2 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args[1]) || args[1].length > 70) throw new Error(usage);
  const [input, id] = args;
  const root = path.resolve(__dirname, '..');
  const target = path.join(root, 'scores', `${id}.json`);
  if (fs.existsSync(target)) throw new Error('这个曲目 ID 已存在。请使用新的 ID，避免覆盖已有作品。');
  if (fs.statSync(input).size > 2 * 1024 * 1024) throw new Error('JSON 文件超过 2 MB。');
  const { document, score } = compile(JSON.parse(fs.readFileSync(input, 'utf8')));
  const indexPath = path.join(root, 'curated', 'index.js');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8').replace(/^globalThis\.CuratedScores\s*=\s*/, '').replace(/;\s*$/, ''));
  if (index.entries.some(e => e.id === id)) throw new Error('目录已经使用这个曲目 ID。');
  index.entries.push({ id, title: document.title, format: 'paijian-score', file: `scores/${id}.json`, license: '作者自定，参见署名', composer: '参见曲谱署名', instrument: `${document.instrument === '17C' ? '17' : '21'}音C调卡林巴`, scope: `完整${score.bars.length}小节，反复展开${score.playbackBarMap.length}小节`, notes: score.notes.length, bars: score.bars.length, maxPolyphony: score.stats.maxPolyphony, playable17Count: score.notes.filter(n => n.midi >= 60 && n.midi <= 88 && [0,2,4,5,7,9,11].includes(n.midi % 12)).length, attribution: document.credits.join('；') || '作者未填写署名' });
  index.documents = { ...(index.documents || {}), [id]: document };
  fs.writeFileSync(target, JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(indexPath, 'globalThis.CuratedScores = ' + JSON.stringify(index, null, 2) + ';\n');
  console.log(`已加入完整曲谱：${document.title}\n请检查 scores/${id}.json 与 curated/index.js，再提交并推送到 GitHub。\n发布后链接：https://line-ar-line.github.io/paijian-metronome/score.html?score=${id}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
