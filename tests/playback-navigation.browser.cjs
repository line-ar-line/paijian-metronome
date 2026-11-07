const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const ScoreDocument = require('../score/document.js');

const project = path.resolve(__dirname, '..');
const prefix = '/paijian-metronome/';
const xu = ScoreDocument.compile(JSON.parse(fs.readFileSync(path.join(project, 'scores/xu.json'), 'utf8')));
const repeated = ScoreDocument.compile(JSON.parse(fs.readFileSync(path.join(project, 'scores/heixiu-rhapsody.json'), 'utf8')));

async function browserSession(run) {
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg' };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const filename = path.resolve(project, pathname.slice(prefix.length));
    if (!pathname.startsWith(prefix) || !filename.startsWith(project + path.sep)) { response.writeHead(404); response.end(); return; }
    try { const bytes = fs.readFileSync(filename); response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream' }); response.end(bytes); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const errors = [];
    context.on('page', page => { page.setDefaultTimeout(7000); page.on('pageerror', error => errors.push(error.message)); });
    await context.addInitScript(() => {
      window.navigationPlays = [];
      window.navigationActiveNotes = [];
      window.navigationFreezeProgress = false;
      let Player;
      Object.defineProperty(window, 'ScorePlayer', { configurable: true, get: () => Player, set: Original => {
        Player = class extends Original {
          constructor(callbacks, dependencies) {
            super({ ...callbacks,
              onProgress(event) { if (!window.navigationFreezeProgress) callbacks.onProgress?.(event); },
              onActiveNotes(event) { window.navigationActiveNotes = event.notes; callbacks.onActiveNotes?.(event); },
            }, dependencies);
            window.navigationPlayer = this;
            window.navigationCallbacks = callbacks;
          }
          play(notes, options) {
            window.navigationPlays.push({ count: notes.length, options: { ...options } });
            return super.play(notes, options);
          }
        };
      } });
    });
    const base = `http://127.0.0.1:${server.address().port}${prefix}`;
    await run({ context, base });
    assert.deepEqual(errors, [], 'playback navigation must not produce uncaught browser errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function ready(page, base, id, title) {
  await page.goto(base + `score.html?score=${id}`);
  await page.waitForFunction(title => document.getElementById('score-name')?.value === title
    && document.querySelector('#score-preview svg'), title);
  assert.equal(await page.locator('#playback-progress').getAttribute('type'), 'range');
  assert.equal(await page.locator('#follow-pages').isChecked(), true);
}

async function pageMap(page) {
  const count = await page.locator('#page-select option').count();
  const map = new Map();
  for (let index = 0; index < count; index++) {
    await page.locator('#page-select').selectOption(String(index));
    for (const bar of await page.locator('#score-preview [data-measure]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.measure)))) map.set(bar, index);
  }
  await page.locator('#page-select').selectOption('0');
  return map;
}

// Dispatch the same input/change events emitted by a range control. Pointer and
// native keyboard interactions are covered separately below.
async function seek(page, beat) {
  await page.locator('#playback-progress').evaluate((input, beat) => {
    input.value = String(beat);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, beat);
}

async function lastStart(page) {
  return page.evaluate(() => navigationPlays.at(-1)?.options.startBeat || 0);
}

async function pause(page) {
  if (await page.evaluate(() => navigationPlayer.isPlaying)) await page.locator('#score-play').click();
  await page.waitForFunction(() => !navigationPlayer.isPlaying);
}

async function frame(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test('Xu preserves pause position, seeks while playing or paused, and starts a tied bar by mouse or keyboard', { timeout: 30000 }, async () => {
  await browserSession(async ({ context, base }) => {
    const page = await context.newPage();
    await ready(page, base, 'xu', '嘘');
    const map = await pageMap(page);
    assert.equal(map.size, 73);
    assert.equal(await page.locator('#playback-progress').getAttribute('max'), '219');
    assert.match(await page.locator('#play-label').innerText(), /播放/);

    await seek(page, 30);
    assert.equal(Number(await page.locator('#playback-progress').inputValue()), 30);
    assert.equal(await page.evaluate(() => navigationPlayer.isPlaying), false);
    assert.equal(await page.evaluate(() => navigationPlays.length), 0, 'seeking before playback must remain silent');
    await page.locator('#score-play').click();
    await page.waitForFunction(() => navigationPlayer.isPlaying && Number(document.getElementById('playback-progress').value) > 30.05);
    assert.equal(await lastStart(page), 30);
    assert.match(await page.locator('#play-label').innerText(), /暂停/);
    await pause(page);
    const paused = Number(await page.locator('#playback-progress').inputValue());
    assert.ok(paused > 30 && paused < 32);
    assert.match(await page.locator('#play-label').innerText(), /继续播放/);
    await page.waitForTimeout(150);
    assert.equal(Number(await page.locator('#playback-progress').inputValue()), paused, 'paused position must not advance or reset');
    await page.locator('#score-play').click();
    await page.waitForFunction(() => navigationPlayer.isPlaying);
    assert.ok(Math.abs(await lastStart(page) - paused) < 0.02, 'continue starts at the retained absolute beat');

    await seek(page, 96);
    await page.waitForFunction(() => navigationPlayer.isPlaying && navigationPlays.at(-1).options.startBeat === 96);
    assert.equal(await page.locator('#page-select').inputValue(), String(map.get(32)), 'seek to bar 33 changes to its printed page');
    const tied = xu.playbackNotes.find(note => note.voiceIndex === 0 && note.start === 93 && note.midi === 72);
    assert.equal(tied.duration, 6);
    await page.waitForFunction(id => navigationActiveNotes.some(note => note.sourceId === id), tied.sourceId);
    assert.ok(await page.locator(`#score-preview [data-measure="32"] [data-source-id="${tied.sourceId}"].is-active`).count() > 0, 'the continuing note is active when playback begins inside its tie');

    await pause(page);
    const beforePausedSeek = await page.evaluate(() => navigationPlays.length);
    await seek(page, 60);
    assert.equal(Number(await page.locator('#playback-progress').inputValue()), 60);
    assert.equal(await page.evaluate(() => navigationPlayer.isPlaying), false);
    assert.equal(await page.evaluate(() => navigationPlays.length), beforePausedSeek);

    const range = page.locator('#playback-progress');
    await range.scrollIntoViewIfNeeded();
    const box = await range.boundingBox();
    await page.mouse.move(box.x + box.width * .28, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .65, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    const dragged = Number(await range.inputValue());
    assert.ok(dragged > 125 && dragged < 160, `drag positions the paused range, got ${dragged}`);
    assert.equal(await page.evaluate(() => navigationPlayer.isPlaying), false);
    await range.focus(); await range.press('Home');
    assert.equal(Number(await range.inputValue()), 0);
    await range.press('ArrowRight');
    const step = Number(await range.getAttribute('step')) || 1;
    assert.equal(Number(await range.inputValue()), step, 'the native keyboard range remains usable');

    await page.locator('#page-select').selectOption(String(map.get(32)));
    const bar33 = page.locator('#score-preview [data-measure="32"]');
    assert.equal(await bar33.getAttribute('role'), 'button');
    assert.equal(await bar33.getAttribute('tabindex'), '0');
    await bar33.locator('.note-number').first().click();
    await page.waitForFunction(() => navigationPlayer.isPlaying && navigationPlays.at(-1).options.startBeat === 96);
    await pause(page);
    await page.locator('#page-select').selectOption(String(map.get(33)));
    const bar34 = page.locator('#score-preview [data-measure="33"]');
    await bar34.focus(); await bar34.press('Enter');
    await page.waitForFunction(() => navigationPlayer.isPlaying && navigationPlays.at(-1).options.startBeat === 99);
    await pause(page);
    await bar34.focus(); await bar34.press('Space');
    await page.waitForFunction(() => navigationPlayer.isPlaying && navigationPlays.at(-1).options.startBeat === 99);
    await page.locator('#score-restart').click();
    await page.waitForFunction(() => navigationPlayer.isPlaying && navigationPlays.at(-1).options.startBeat === 0);
    assert.ok(Number(await range.inputValue()) < 1);
    assert.deepEqual(await page.evaluate(() => ({ count: navigationPlays.at(-1).count, beats: navigationPlays.at(-1).options.totalBeats })), { count: 295, beats: 219 });
    await seek(page, 219);
    await page.waitForFunction(() => !navigationPlayer.isPlaying && Number(document.getElementById('playback-progress').value) === 219);
    assert.equal(await page.locator('#page-select').inputValue(), String(map.get(72)), 'seeking to the end while playing reveals the last printed page');
    assert.match(await page.locator('#playback-status').innerText(), /播放结束/);
    assert.equal(await page.locator('#play-label').innerText(), '播放');
    await page.locator('#score-play').click();
    await page.waitForFunction(() => navigationPlayer.isPlaying && navigationPlays.at(-1).options.startBeat === 0);
    await pause(page);
  });
});

test('playback follows offscreen measures vertically and horizontally, while the follow switch preserves manual reading position', { timeout: 30000 }, async () => {
  await browserSession(async ({ context, base }) => {
    const page = await context.newPage();
    await ready(page, base, 'xu', '嘘');
    const map = await pageMap(page);
    await page.locator('#score-play').click();
    await page.waitForFunction(() => navigationPlayer.isPlaying);
    // Keep the real transport running, but inject deterministic absolute progress
    // events so this UI test need not wait for several minutes of music.
    await page.evaluate(() => { navigationFreezeProgress = true; window.scrollTo({ top: 0, behavior: 'instant' }); });
    const firstPage = await page.locator('#page-select').inputValue();
    const lastBarOnFirstPage = Math.max(...[...map].filter(([, index]) => String(index) === firstPage).map(([bar]) => bar));
    const firstScroll = await page.evaluate(() => scrollY);
    await page.evaluate(beat => navigationCallbacks.onProgress({ beat, totalBeats: 219 }), lastBarOnFirstPage * 3 + .1);
    await page.waitForFunction(barIndex => {
      const bar = document.querySelector(`#score-preview [data-measure="${barIndex}"]`).getBoundingClientRect();
      const player = document.querySelector('.score-player').getBoundingClientRect();
      return bar.top >= player.bottom && bar.bottom <= innerHeight - 24;
    }, lastBarOnFirstPage);
    assert.equal(await page.locator('#page-select').inputValue(), firstPage, 'following a later row does not need a page change');
    assert.ok(await page.evaluate(() => scrollY) > firstScroll, 'the page scrolls down when playback reaches a lower row on the same score page');

    // Start a genuine smooth scroll back to the first row, then turn following
    // off while it is moving. Toggling must cancel the existing animation too.
    const beforeMoving = await page.evaluate(() => scrollY);
    await page.evaluate(() => navigationCallbacks.onProgress({ beat: 0, totalBeats: 219 }));
    await page.waitForFunction(before => Math.abs(scrollY - before) > 2, beforeMoving);
    const canceled = await page.locator('#follow-pages').evaluate(input => {
      input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true }));
      return { y: scrollY, x: document.getElementById('score-preview').scrollLeft };
    });
    await page.waitForTimeout(150);
    const settled = await page.evaluate(() => ({ y: scrollY, x: document.getElementById('score-preview').scrollLeft }));
    // Chrome may commit the compositor's last frame after cancellation. A few
    // pixels are acceptable; the old smooth animation must not keep running.
    assert.ok(Math.abs(settled.y - canceled.y) <= 8 && Math.abs(settled.x - canceled.x) <= 8, 'turning follow off cancels an in-flight smooth scroll');
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => ({ y: scrollY, x: document.getElementById('score-preview').scrollLeft })), settled, 'the canceled scroll remains stationary');
    await page.locator('#follow-pages').check();
    await page.evaluate(() => navigationCallbacks.onProgress({ beat: 96, totalBeats: 219 }));
    await frame(page);
    assert.equal(await page.locator('#page-select').inputValue(), String(map.get(32)));
    const followed = await page.locator('#score-preview [data-measure="32"]').evaluate(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, scroll: scrollY, height: innerHeight }));
    assert.ok(followed.scroll > 0 && followed.bottom > 0 && followed.top < followed.height, 'automatic following brings the active bar into the viewport');

    await page.locator('#follow-pages').uncheck();
    await page.locator('#page-select').selectOption('0');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await frame(page);
    const before = await page.evaluate(() => ({ y: scrollY, x: document.getElementById('score-preview').scrollLeft, page: document.getElementById('page-select').value }));
    await page.evaluate(() => navigationCallbacks.onProgress({ beat: 216, totalBeats: 219 }));
    await frame(page);
    assert.deepEqual(await page.evaluate(() => ({ y: scrollY, x: document.getElementById('score-preview').scrollLeft, page: document.getElementById('page-select').value })), before, 'disabled follow leaves both page selection and scroll positions unchanged');

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth), `player controls fit ${width}px`);
    }
    await page.locator('#follow-pages').check();
    await page.locator('#page-select').selectOption('0');
    const rightmost = await page.locator('#score-preview [data-measure]').evaluateAll(nodes => nodes.map(node => ({ bar: Number(node.dataset.measure), left: node.getBoundingClientRect().left })).sort((a, b) => b.left - a.left)[0].bar);
    await page.locator('#score-preview').evaluate(node => { node.scrollLeft = 0; });
    await page.evaluate(beat => navigationCallbacks.onProgress({ beat, totalBeats: 219 }), rightmost * 3 + .1);
    await page.waitForFunction(barIndex => {
      const viewport = document.getElementById('score-preview').getBoundingClientRect();
      const bar = document.querySelector(`#score-preview [data-measure="${barIndex}"]`).getBoundingClientRect();
      return bar.left >= viewport.left && bar.right <= viewport.right;
    }, rightmost);
    const mobile = await page.locator(`#score-preview [data-measure="${rightmost}"]`).evaluate(node => {
      const viewport = document.getElementById('score-preview'), box = viewport.getBoundingClientRect(), bar = node.getBoundingClientRect();
      return { scroll: viewport.scrollLeft, left: bar.left, right: bar.right, viewportLeft: box.left, viewportRight: box.right, overflow: document.documentElement.scrollWidth > innerWidth };
    });
    assert.ok(mobile.scroll > 0, 'a bar to the right scrolls the score container on mobile');
    assert.ok(mobile.right > mobile.viewportLeft && mobile.left < mobile.viewportRight, 'the current bar is horizontally visible');
    assert.equal(mobile.overflow, false, 'the document itself never gains horizontal overflow');

    await page.locator('#follow-pages').uncheck();
    await page.locator('#score-preview').evaluate(node => { node.scrollLeft = 0; });
    await page.evaluate(beat => {
      navigationCallbacks.onProgress({ beat: 0, totalBeats: 219 });
      navigationCallbacks.onProgress({ beat, totalBeats: 219 });
    }, rightmost * 3 + .2);
    await frame(page);
    const manualLeft = await page.locator('#score-preview').evaluate(node => node.scrollLeft);
    assert.ok(manualLeft <= 8, 'manual horizontal position is preserved with follow off');
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#score-preview').evaluate(node => node.scrollLeft), manualLeft, 'progress cannot restart horizontal scrolling with follow off');
    await pause(page);
    await page.evaluate(() => { navigationFreezeProgress = false; });
    const bar = page.locator(`#score-preview [data-measure="${rightmost}"]`);
    await bar.focus(); await bar.press('Enter');
    await page.waitForFunction(beat => navigationPlayer.isPlaying && navigationPlays.at(-1).options.startBeat === beat, rightmost * 3);
    await pause(page);
  });
});

test('clicking a repeated printed bar chooses its current or next occurrence and falls back to the first occurrence', { timeout: 30000 }, async () => {
  assert.equal(repeated.score.playbackBarMap.length, 37);
  assert.equal(repeated.totalBeats, 148);
  await browserSession(async ({ context, base }) => {
    const page = await context.newPage();
    await ready(page, base, 'heixiu-rhapsody', '嘿咻狂想曲');
    const map = await pageMap(page);
    assert.equal(await page.locator('#playback-progress').getAttribute('max'), '148');
    for (const [position, printedBar, expectedBeat] of [[0, 13, 48], [50, 13, 48], [76, 13, 80], [82, 13, 80], [84, 17, 96], [120, 13, 48]]) {
      await pause(page);
      await seek(page, position);
      await page.locator('#page-select').selectOption(String(map.get(printedBar - 1)));
      const bar = page.locator(`#score-preview [data-measure="${printedBar - 1}"]`);
      await bar.focus(); await bar.press('Enter');
      await page.waitForFunction(() => navigationPlayer.isPlaying);
      assert.equal(await lastStart(page), expectedBeat, `from beat ${position}, printed bar ${printedBar} chooses beat ${expectedBeat}`);
      assert.match(await page.locator('#playback-status').innerText(), new RegExp(`第 ${printedBar} / 29 小节`));
    }
    assert.deepEqual(await page.evaluate(() => ({ count: navigationPlays.at(-1).count, beats: navigationPlays.at(-1).options.totalBeats })), { count: 245, beats: 148 });
    await pause(page);
  });
});
