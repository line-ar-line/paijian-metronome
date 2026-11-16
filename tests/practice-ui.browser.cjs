const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function session(run, width = 390) {
  const root = path.resolve(__dirname, '..');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg' };
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname);
    if (!file.startsWith(root + path.sep)) { res.writeHead(404).end(); return; }
    try { const bytes = fs.readFileSync(file); res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }).end(bytes); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(6000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await run(page, `http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(errors, []);
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
}

test('mobile score links open a compact practice view while settings and exports remain reachable', async () => {
  await session(async (page, base) => {
    await page.goto(base + '/score.html?score=xu');
    await page.locator('#score-preview svg').waitFor();
    assert.equal(await page.locator('#practice-toggle').getAttribute('aria-pressed'), 'true');
    assert.ok((await page.locator('#score-preview').boundingBox()).y < 640);
    assert.equal(await page.locator('#score-settings').getAttribute('open'), null);
    await page.locator('#score-settings > summary').click();
    assert.equal(await page.locator('#instrument-select').isVisible(), true);
    await page.locator('#score-settings > summary').click();
    await page.locator('#score-more > summary').click();
    assert.equal(await page.locator('#export-svg').isVisible(), true);
    await page.locator('#practice-toggle').click();
    assert.equal(await page.locator('#practice-toggle').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('#instrument-select').isVisible(), true);
    assert.equal(await page.locator('#export-svg').isVisible(), true);
  });
});


test('mobile reflow preserves every measure, enlarges notes and keeps the reading position after rotation', async () => {
  await session(async (page, base) => {
    await page.goto(base + '/score.html?score=xu');
    await page.locator('#score-preview svg').waitFor();
    await page.waitForFunction(() => document.querySelector('#score-preview svg').getBoundingClientRect().width < 400);
    const measureIds = [];
    const count = await page.locator('#page-select option').count();
    for (let i = 0; i < count; i++) {
      await page.locator('#page-select').selectOption(String(i));
      measureIds.push(...await page.locator('#score-preview [data-measure]').evaluateAll(nodes => nodes.map(n => Number(n.dataset.measure))));
    }
    assert.deepEqual(measureIds, Array.from({ length: 73 }, (_, i) => i));
    await page.locator('#page-select').selectOption('0');
    const before = await page.locator('#score-preview .note-number').first().boundingBox();
    await page.locator('#score-text-size').selectOption('1.4');
    await page.waitForFunction(() => document.querySelector('#score-preview svg').getBoundingClientRect().width > 390);
    const after = await page.locator('#score-preview .note-number').first().boundingBox();
    assert.ok(after.height > before.height * 1.3);
    await page.locator('#score-text-size').selectOption('1');
    await page.locator('#page-select').selectOption('2');
    const anchor = Number(await page.locator('#score-preview [data-measure]').first().getAttribute('data-measure'));
    await page.setViewportSize({ width: 740, height: 390 });
    await page.waitForFunction(bar => !!document.querySelector(`#score-preview [data-measure="${bar}"]`), anchor);
    assert.equal(await page.locator('#score-play').getAttribute('aria-pressed'), 'false');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
});

test('measure loops count in, repeat at increasing tempo and stop without restarting', async () => {
  await session(async (page, base) => {
    await page.addInitScript(() => {
      let Original;
      window.practicePlays = [];
      Object.defineProperty(window, 'ScorePlayer', { get: () => Original, set: Value => {
        Original = class extends Value {
          constructor(...args) { super(...args); window.practicePlayer = this; }
          play(notes, options) { window.practicePlays.push({ ...options }); return super.play(notes, options); }
        };
      } });
    });
    await page.goto(base + '/score.html?score=xu');
    await page.locator('#score-preview svg').waitFor();
    await page.locator('#score-bpm').fill('232'); await page.locator('#score-bpm').dispatchEvent('change');
    await page.locator('.practice-options > summary').click();
    await page.locator('#loop-start').fill('2'); await page.locator('#loop-start').dispatchEvent('change');
    await page.locator('#loop-end').fill('2'); await page.locator('#loop-end').dispatchEvent('change');
    await page.locator('#loop-tempo-step').selectOption('4');
    await page.locator('#practice-count-in').check();
    await page.locator('#loop-enabled').check();
    await page.locator('#score-play').click();
    await page.waitForFunction(() => practicePlays.length >= 3);
    const plays = await page.evaluate(() => practicePlays.slice(0, 3));
    assert.deepEqual(plays.map(p => [p.startBeat, p.endBeat, p.bpm, p.countInBeats]), [[3, 6, 232, 3], [3, 6, 236, 3], [3, 6, 240, 3]]);
    await page.locator('#score-play').click();
    const stopped = await page.evaluate(() => practicePlays.length);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => practicePlays.length), stopped);
    assert.equal(await page.evaluate(() => practicePlayer.isPlaying), false);
    await page.locator('#loop-start').fill('10'); await page.locator('#loop-start').dispatchEvent('change');
    assert.equal(await page.locator('#loop-enabled').isChecked(), false);
    assert.match(await page.locator('#workshop-message').innerText(), /有效的小节范围/);
  });
});

test('mobile practice fits ordinary measures and follows active notes on wider pages', async () => {
  await session(async (page, base) => {
    await page.addInitScript(() => {
      let Player;
      Object.defineProperty(window, 'ScorePlayer', { get: () => Player, set: Original => {
        Player = class extends Original { constructor(...args) { super(...args); window.reviewPlayer = this; } };
      } });
    });
    await page.goto(base + '/score.html?score=heixiu-rhapsody');
    await page.locator('#score-preview svg').waitFor();
    await page.waitForFunction(() => document.querySelector('#score-preview').scrollWidth <= document.querySelector('#score-preview').clientWidth + 1);
    assert.equal(await page.locator('#score-overflow-hint').isVisible(), false);
    const digit = await page.locator('#score-preview .note-number').first().boundingBox();
    assert.ok(digit.height >= 20);
    await page.locator('#score-text-size').selectOption('1.4');
    await page.waitForFunction(() => !document.getElementById('score-overflow-hint').hidden);
    for (let index = 0; index < await page.locator('#page-select option').count(); index++) {
      await page.locator('#page-select').selectOption(String(index));
      if (await page.locator('#score-preview [data-measure="12"]').count()) break;
    }
    await page.locator('#score-preview [data-measure="12"]').focus();
    await page.locator('#score-preview [data-measure="12"]').press('Enter');
    await page.waitForFunction(() => reviewPlayer.isPlaying);
    await page.evaluate(() => {
      const notes = [...document.querySelectorAll('#score-preview [data-measure="12"] .note-group[data-source-id]')].filter(node => node.dataset.sourceId);
      window.reviewLastSource = notes.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left)[0].dataset.sourceId;
      reviewPlayer.onActiveNotes({ notes: [{ sourceId: reviewLastSource }], beat: 51.5 });
    });
    assert.ok(await page.locator('#score-preview').evaluate(el => el.scrollLeft > 100));
    await page.locator('#follow-pages').uncheck();
    await page.locator('#score-preview').evaluate(el => { el.scrollLeft = 0; });
    await page.evaluate(() => reviewPlayer.onActiveNotes({ notes: [{ sourceId: reviewLastSource }], beat: 51.5 }));
    assert.equal(await page.locator('#score-preview').evaluate(el => el.scrollLeft), 0);
    await page.locator('#score-play').click();
  });
});

test('leaving a loop honors clicked measures, seeking and full-song restart including repeat offsets', async () => {
  await session(async (page, base) => {
    await page.addInitScript(() => {
      let Player; window.reviewPlays = [];
      Object.defineProperty(window, 'ScorePlayer', { get: () => Player, set: Original => {
        Player = class extends Original {
          constructor(...args) { super(...args); window.reviewPlayer = this; }
          play(notes, options) { reviewPlays.push({ ...options }); return super.play(notes, options); }
        };
      } });
    });
    await page.goto(base + '/score.html?score=heixiu-rhapsody');
    await page.locator('#score-preview svg').waitFor();
    await page.locator('.practice-options > summary').click();
    for (const [id, value] of [['loop-start', '2'], ['loop-end', '3']]) {
      await page.locator('#' + id).fill(value); await page.locator('#' + id).dispatchEvent('change');
    }
    await page.locator('#loop-enabled').check();
    await page.locator('.practice-options > summary').click();
    assert.match(await page.locator('#playback-loop').innerText(), /循环 2–3 小节/);
    await page.locator('#score-preview [data-measure="4"]').focus();
    await page.locator('#score-preview [data-measure="4"]').press('Enter');
    await page.waitForFunction(() => reviewPlayer.isPlaying);
    assert.equal(await page.evaluate(() => reviewPlays.at(-1).startBeat), 16);
    assert.equal(await page.evaluate(() => reviewPlays.at(-1).endBeat), undefined);
    assert.match(await page.locator('#playback-loop').innerText(), /已退出循环/);
    await page.locator('#score-play').click();
    await page.locator('.practice-options > summary').click();
    for (const [id, value] of [['loop-start', '13'], ['loop-end', '20']]) {
      await page.locator('#' + id).fill(value); await page.locator('#' + id).dispatchEvent('change');
    }
    await page.locator('#loop-enabled').check();
    await page.locator('#playback-progress').evaluate(el => {
      el.value = '84'; el.dispatchEvent(new Event('input')); el.dispatchEvent(new Event('change'));
    });
    assert.equal(await page.locator('#loop-enabled').isChecked(), false);
    assert.equal(Number(await page.locator('#playback-progress').inputValue()), 116);
    assert.equal(await page.evaluate(() => reviewPlayer.isPlaying), false);
    await page.locator('#loop-enabled').check();
    await page.locator('#score-restart').click();
    await page.waitForFunction(() => reviewPlayer.isPlaying);
    assert.equal(await page.evaluate(() => reviewPlays.at(-1).startBeat), 0);
    assert.equal(await page.evaluate(() => reviewPlays.at(-1).endBeat), undefined);
    await page.locator('#score-play').click();
    await page.locator('#loop-enabled').check();
    await page.locator('#exit-loop').click();
    assert.equal(Number(await page.locator('#playback-progress').inputValue()), 48);
    assert.equal(await page.evaluate(() => reviewPlayer.isPlaying), false);
  });
});

test('the compact catalog exposes recent practice, favorites and authored kalimba scores', async () => {
  await session(async (page, base) => {
    await page.goto(base + '/score.html?score=xu');
    await page.locator('#score-preview svg').waitFor();
    await page.locator('#score-play').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('paijian.recent-practice.v1'))?.ids[0] === 'xu');
    await page.goto(base + '/library.html');
    await page.locator('.catalog-piece').first().waitFor();
    assert.ok((await page.locator('.catalog-piece').first().boundingBox()).y < 800);
    assert.equal(await page.locator('#catalog-advanced').getAttribute('open'), null);
    await page.locator('#catalog-recent').click();
    assert.equal(await page.locator('.catalog-piece').count(), 1);
    assert.equal(await page.locator('.catalog-piece').getAttribute('data-piece-id'), 'xu');
    await page.reload();
    await page.locator('.catalog-piece').waitFor();
    assert.equal(await page.locator('#catalog-recent').getAttribute('aria-pressed'), 'true');
    await page.locator('#catalog-kalimba').click();
    assert.equal(await page.locator('.catalog-piece').count(), 2);
    assert.equal(await page.locator('.catalog-piece[data-piece-id^="mutopia-"]').count(), 0);
    await page.locator('#catalog-advanced > summary').click();
    assert.equal(await page.locator('#catalog-composer').isVisible(), true);
    await page.locator('#catalog-all').click();
    assert.equal(await page.locator('.catalog-piece').count(), 24);
  });
});

test('point-and-click composing inserts rhythms, chords and glissandi, locates notes, and undoes unfinished edits', async () => {
  await session(async (page, base) => {
    await page.goto(base + '/composer.html');
    await page.locator('#voice-notation-0').waitFor();
    await page.locator('#new-draft').click();
    const input = page.locator('#voice-notation-0');
    for (const note of [1, 2, 3, 4]) await page.locator(`[data-note-degree="${note}"]`).click();
    assert.equal(await input.inputValue(), '1 2 3 4');
    await page.waitForFunction(() => !document.getElementById('composer-play').disabled);
    await page.locator('#notation-bar').click();
    await page.locator('#notation-mode').selectOption('glissando');
    for (const note of [1, 3, 5]) await page.locator(`[data-note-degree="${note}"]`).click();
    await page.locator('#notation-duration').selectOption('2');
    await page.locator('#notation-insert-chord').click();
    await page.locator('#notation-rest').click();
    assert.equal(await input.inputValue(), '1 2 3 4 | ~(1,3,5):2 0:2');
    await page.waitForFunction(() => !document.getElementById('composer-play').disabled);
    await page.locator('#composer-preview [data-token-id="v0-b0-e1-t0"]').click();
    assert.equal(await input.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), '2');
    await page.locator('#notation-mode').selectOption('single');
    await page.locator('#notation-octave').selectOption("'");
    await page.locator('#notation-duration').selectOption('1');
    await page.locator('[data-note-degree="7"]').click();
    assert.equal(await input.inputValue(), "1 7' 3 4 | ~(1,3,5):2 0:2");
    await page.locator('#notation-undo').click();
    assert.equal(await input.inputValue(), '1 2 3 4 | ~(1,3,5):2 0:2');
    await page.locator('#notation-redo').click();
    assert.ok((await input.inputValue()).includes("7'"));
    await input.fill('1:');
    await page.locator('#notation-undo').click();
    assert.ok((await input.inputValue()).includes("7'"));
    await page.locator('#notation-redo').click();
    assert.equal(await input.inputValue(), '1:');
    await page.reload();
    await page.locator('#voice-notation-0').waitFor();
    assert.equal(await input.inputValue(), '1:');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  });
});

test('preview editing locates a written tie continuation and toolbar edits target the chosen voice', async () => {
  await session(async (page, base) => {
    await page.goto(base + '/composer.html');
    await page.locator('#new-draft').click();
    const first = page.locator('#voice-notation-0');
    await first.fill('1:4~ | 1:4');
    await page.waitForFunction(() => !document.getElementById('composer-play').disabled);
    await page.locator('#add-voice').click();
    await page.waitForFunction(() => !document.getElementById('composer-play').disabled);
    await page.locator('#composer-preview [data-token-id="v0-b1-e0-t0"]').click();
    assert.equal(await first.evaluate(el => el.value.slice(el.selectionStart, el.selectionEnd)), '1:4');
    await page.locator('#voice-name-1').fill('低音');
    assert.equal(await page.locator('#notation-voice option[value="1"]').innerText(), '低音');
    await page.locator('#notation-voice').selectOption('1');
    const second = page.locator('#voice-notation-1');
    await second.evaluate(el => el.setSelectionRange(0, el.value.length));
    await page.locator('#notation-duration').selectOption('4');
    await page.locator('[data-note-degree="5"]').click();
    assert.equal(await second.inputValue(), '5:4');
    assert.equal(await first.inputValue(), '1:4~ | 1:4');
    await second.press('ControlOrMeta+z');
    assert.equal(await second.inputValue(), '0:4 | 0:4');
    assert.equal(await first.inputValue(), '1:4~ | 1:4');
  });
});

test('composing reports missing beats beside the keyboard and follows the editing measure', async () => {
  await session(async (page, base) => {
    await page.goto(base + '/composer.html');
    await page.locator('#new-draft').click();
    const input = page.locator('#voice-notation-0');
    await page.locator('[data-note-degree="1"]').click();
    assert.match(await page.locator('#notation-bar-status').innerText(), /第 1 小节：1 \/ 4 拍，还差 3 拍/);
    const keyboard = await page.locator('.notation-keyboard').boundingBox();
    const status = await page.locator('#notation-bar-status').boundingBox();
    assert.ok(status.y - (keyboard.y + keyboard.height) < 300);
    await page.waitForFunction(() => !document.getElementById('notation-inline-error').hidden);
    assert.match(await page.locator('#notation-inline-error').innerText(), /1 拍，需要 4 拍/);
    await page.locator('#notation-duration').selectOption('3');
    await page.locator('#notation-rest').click();
    assert.match(await page.locator('#notation-bar-status').innerText(), /4 \/ 4 拍，已写满/);
    await page.waitForFunction(() => !document.getElementById('composer-play').disabled);
    assert.equal(await page.locator('#notation-inline-error').isVisible(), false);
    await page.locator('#notation-bar').click();
    assert.match(await page.locator('#notation-bar-status').innerText(), /第 2 小节：0 \/ 4 拍，还差 4 拍/);
    await page.locator('#notation-duration').selectOption('1');
    await page.locator('[data-note-degree="2"]').click();
    await input.fill('1 0:3 | 2:');
    await page.waitForFunction(() => document.getElementById('notation-bar-status').textContent.includes('音符格式待完善'));
    assert.equal(await input.inputValue(), '1 0:3 | 2:');
    await page.locator('#notation-undo').click();
    assert.equal(await input.inputValue(), '1 0:3 | 2');
    assert.match(await page.locator('#notation-bar-status').innerText(), /第 2 小节：1 \/ 4 拍/);
  });
});
