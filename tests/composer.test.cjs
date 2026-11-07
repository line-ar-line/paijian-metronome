const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { tmpdir } = require('node:os');
const { chromium } = require('playwright');

const project = path.resolve(__dirname, '..');
const prefix = '/paijian-metronome/';

async function staticServer() {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith(prefix)) { response.writeHead(404); response.end(); return; }
    const filename = path.resolve(project, pathname.slice(prefix.length) || 'composer.html');
    if (!filename.startsWith(project + path.sep)) { response.writeHead(403); response.end(); return; }
    try {
      const body = fs.readFileSync(filename);
      response.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Content-Length': body.length });
      response.end(body);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}${prefix}composer.html` };
}

async function browserSession(run) {
  const { server, url } = await staticServer();
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    page.setDefaultTimeout(7000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await run({ browser, page, url, errors });
    assert.deepEqual(errors, [], 'the editor must not raise uncaught browser errors');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

async function downloadThrough(page, selector) {
  const pending = page.waitForEvent('download');
  await page.locator(selector).click();
  const download = await pending;
  assert.equal(await download.failure(), null);
  return { name: download.suggestedFilename(), bytes: fs.readFileSync(await download.path()) };
}

async function assertNoOverflow(page, label) {
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(dimensions.html <= dimensions.viewport && dimensions.body <= dimensions.viewport,
      `${label} must fit a ${width}px viewport: ${JSON.stringify(dimensions)}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

const storageKey = 'paijian.composer.drafts.v1';
const sample = {
  format: 'paijian-score', version: 1, title: '测试：滑音、和弦与反复', bpm: 90, meter: [4, 4], instrument: '17C',
  voices: [{ name: '旋律', notation: "~(1,3,5):2 1':2 | 0:1 (1,3,5):1 5:2" }],
  repeats: [{ startBar: 1, endBar: 2, times: 2 }],
  credits: ['编配：浏览器验证', '来源：自编练习；保留完整署名'],
};

async function ready(page, url) {
  await page.goto(url);
  await page.locator('.draft-item[aria-current="true"]').waitFor();
  await page.locator('.notation-input').first().waitFor();
}

async function waitForPreview(page) {
  await page.waitForFunction(() => document.querySelector('#composer-preview svg')
    && document.getElementById('notation-error').hidden
    && !document.getElementById('composer-play').disabled);
}

async function importDocument(page, document, name = 'browser-score.json') {
  await page.locator('#composer-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await page.waitForFunction(title => document.getElementById('composer-title').value === title, document.title);
  await waitForPreview(page);
}

function assertSampleDocument(actual, expected) {
  for (const field of ['format', 'version', 'title', 'bpm', 'meter', 'instrument', 'voices', 'repeats', 'credits']) {
    assert.deepEqual(actual[field], expected[field], `${field} must survive JSON export and import`);
  }
}

test('composer saves invalid notation, restores drafts, renames, switches, and deletes through the UI', { timeout: 60000 }, async () => {
  await browserSession(async ({ page, url }) => {
    await ready(page, url);
    await waitForPreview(page);
    assert.equal(await page.locator('.draft-item').count(), 1);
    assert.ok(await page.locator('#composer-preview .note-group').count() > 0);
    assert.equal(await page.locator('#composer-export-svg').isDisabled(), false);
    const originalNotation = await page.locator('.notation-input').first().inputValue();
    const originalId = await page.locator('.draft-item[aria-current="true"]').getAttribute('data-draft-id');

    const invalid = '1 2 BAD_NOTE 4 | 5:4';
    await page.locator('.notation-input').first().fill(invalid);
    await page.waitForFunction(() => !document.getElementById('notation-error').hidden);
    assert.equal(await page.locator('#composer-play').isDisabled(), true);
    assert.equal(await page.locator('#composer-export-svg').isDisabled(), true);
    assert.equal(await page.locator('#composer-export-json').isDisabled(), false, 'an unfinished draft remains exportable');
    await page.waitForFunction(({ key, value }) => (localStorage.getItem(key) || '').includes(value), { key: storageKey, value: invalid });
    await page.reload();
    await page.locator('.notation-input').first().waitFor();
    assert.equal(await page.locator('.notation-input').first().inputValue(), invalid, 'refresh must retain invalid work in progress');
    await page.waitForFunction(() => !document.getElementById('notation-error').hidden);
    assert.equal(await page.locator('#composer-play').isDisabled(), true);
    assert.equal(await page.locator('#composer-export-svg').isDisabled(), true);
    const unfinished = JSON.parse((await downloadThrough(page, '#composer-export-json')).bytes.toString('utf8'));
    assert.equal(unfinished.voices[0].notation, invalid);

    await page.locator('.notation-input').first().fill(originalNotation);
    await waitForPreview(page);
    const renamed = '每日练习 · 第一份';
    await page.locator('#composer-title').fill(renamed);
    await page.waitForFunction(title => document.querySelector('.draft-item[aria-current="true"]').textContent.includes(title), renamed);
    await page.waitForFunction(({ key, value }) => (localStorage.getItem(key) || '').includes(value), { key: storageKey, value: renamed });
    await page.reload();
    await page.locator('.notation-input').first().waitFor();
    assert.equal(await page.locator('#composer-title').inputValue(), renamed);
    assert.equal(await page.locator('.notation-input').first().inputValue(), originalNotation);

    await page.locator('#new-draft').click();
    assert.equal(await page.locator('.draft-item').count(), 2);
    assert.equal(await page.locator('.notation-input').first().inputValue(), '');
    const secondId = await page.locator('.draft-item[aria-current="true"]').getAttribute('data-draft-id');
    assert.notEqual(secondId, originalId);
    await page.locator('#composer-title').fill('每日练习 · 第二份');
    await page.locator('.notation-input').first().fill('1 2 3 4 | 5:4');
    await waitForPreview(page);
    await page.locator(`.draft-item[data-draft-id="${originalId}"]`).click();
    assert.equal(await page.locator('#composer-title').inputValue(), renamed);
    assert.equal(await page.locator('.notation-input').first().inputValue(), originalNotation);
    await page.locator(`.draft-item[data-draft-id="${secondId}"]`).click();
    assert.equal(await page.locator('.notation-input').first().inputValue(), '1 2 3 4 | 5:4');
    await page.reload();
    await page.locator('.notation-input').first().waitFor();
    assert.equal(await page.locator('.draft-item[aria-current="true"]').getAttribute('data-draft-id'), secondId);
    assert.equal(await page.locator('#composer-title').inputValue(), '每日练习 · 第二份');

    page.once('dialog', dialog => dialog.dismiss());
    await page.locator('#delete-draft').click();
    assert.equal(await page.locator('.draft-item').count(), 2, 'canceling deletion preserves both drafts');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#delete-draft').click();
    assert.equal(await page.locator('.draft-item').count(), 1);
    assert.equal(await page.locator('#composer-title').inputValue(), renamed);
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#delete-draft').click();
    assert.equal(await page.locator('.draft-item').count(), 1, 'deleting the last draft creates a usable blank draft');
    assert.equal(await page.locator('.notation-input').first().inputValue(), '');
    await page.reload();
    await page.locator('.notation-input').first().waitFor();
    assert.equal(await page.locator('.draft-item').count(), 1);
    assert.equal(await page.locator('.notation-input').first().inputValue(), '');
  });
});

test('composer JSON and SVG retain glissando, repeats and credits, with actual playback and mobile layout', { timeout: 60000 }, async () => {
  await browserSession(async ({ browser, page, url }) => {
    await page.addInitScript(() => {
      let Player;
      Object.defineProperty(window, 'ScorePlayer', {
        configurable: true,
        get: () => Player,
        set: Original => {
          Player = class extends Original {
            constructor(...args) { super(...args); window.composerAcceptancePlayer = this; }
          };
        },
      });
    });
    await ready(page, url);
    await importDocument(page, sample);
    assert.equal(await page.locator('#composer-preview [data-measure]').count(), 2, 'the printed score has two bars');
    assert.equal(await page.locator('#composer-preview .glissando').count(), 1);
    assert.equal(await page.locator('#composer-preview .repeat-start').count(), 1);
    assert.equal(await page.locator('#composer-preview .repeat-end').count(), 1);
    for (const credit of sample.credits) assert.ok((await page.locator('#composer-preview').textContent()).includes(credit));

    await page.locator('#composer-play').click();
    await page.waitForFunction(() => window.composerAcceptancePlayer.isPlaying && document.querySelector('#composer-preview .is-active'));
    assert.equal(await page.locator('#composer-play').getAttribute('aria-pressed'), 'true');
    const playback = await page.evaluate(() => ({
      state: composerAcceptancePlayer._context.state,
      voices: composerAcceptancePlayer._voices.size,
      totalBeats: composerAcceptancePlayer._score.totalBeats,
      notes: composerAcceptancePlayer._score.entries.map(entry => ({ midi: entry.note.midi, start: entry.note.start, duration: entry.note.duration })),
    }));
    assert.equal(playback.state, 'running', 'the real browser AudioContext must start');
    assert.ok(playback.voices > 0, 'actual synthesized notes must be scheduled');
    assert.equal(playback.totalBeats, 16, 'the two-bar repeat must play four bars');
    assert.equal(playback.notes.length, 16, 'all eight written notes must play twice');
    assert.deepEqual(playback.notes.slice(0, 3).map(note => note.midi), [60, 64, 67]);
    assert.ok(playback.notes[0].start < playback.notes[1].start && playback.notes[1].start < playback.notes[2].start,
      'glissando attacks must rise in time rather than sounding as a simultaneous chord');
    assert.ok(playback.notes.some(note => note.start >= 8), 'playback must include the repeated section');
    await page.locator('#composer-play').click();
    assert.equal(await page.locator('#composer-play').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => composerAcceptancePlayer._voices.size), 0);

    const json = await downloadThrough(page, '#composer-export-json');
    assert.match(json.name, /\.json$/);
    assertSampleDocument(JSON.parse(json.bytes.toString('utf8')), sample);
    const svg = await downloadThrough(page, '#composer-export-svg');
    assert.match(svg.name, /\.svg$/);
    const exported = await page.evaluate(text => {
      const xml = new DOMParser().parseFromString(text, 'image/svg+xml');
      return { errors: xml.querySelectorAll('parsererror').length, bars: xml.querySelectorAll('[data-measure]').length,
        gliss: xml.querySelectorAll('.glissando').length, start: xml.querySelectorAll('.repeat-start').length,
        end: xml.querySelectorAll('.repeat-end').length, text: xml.documentElement.textContent };
    }, svg.bytes.toString('utf8'));
    assert.equal(exported.errors, 0);
    assert.equal(exported.bars, 2);
    assert.equal(exported.gliss, 1);
    assert.equal(exported.start, 1);
    assert.equal(exported.end, 1);
    for (const credit of sample.credits) assert.ok(exported.text.includes(credit));

    const fresh = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    fresh.setDefaultTimeout(7000);
    const freshErrors = [];
    fresh.on('pageerror', error => freshErrors.push(error.message));
    await ready(fresh, url);
    await fresh.locator('#composer-file').setInputFiles({ name: json.name, mimeType: 'application/json', buffer: json.bytes });
    await fresh.waitForFunction(title => document.getElementById('composer-title').value === title, sample.title);
    await waitForPreview(fresh);
    assert.equal(await fresh.locator('.notation-input').first().inputValue(), sample.voices[0].notation);
    const restored = JSON.parse((await downloadThrough(fresh, '#composer-export-json')).bytes.toString('utf8'));
    assertSampleDocument(restored, sample);
    assert.deepEqual(freshErrors, []);
    await fresh.close();

    const screenshots = fs.mkdtempSync(path.join(tmpdir(), 'paijian-composer-qa-'));
    await page.screenshot({ path: path.join(screenshots, 'composer-desktop.png'), fullPage: true });
    if (await page.locator('.composer-extra').getAttribute('open') === null) await page.locator('.composer-extra summary').click();
    await assertNoOverflow(page, 'score editor including repeat and credits controls');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(screenshots, 'composer-mobile.png'), fullPage: true });
    await page.locator('#composer-title').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshots, 'composer-mobile-editor.png') });
    await page.locator('#composer-preview').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(screenshots, 'composer-mobile-preview.png') });
    console.log(`Composer acceptance screenshots: ${screenshots}`);
  });
});

test('composer treats imported titles, credits, and invalid notation as text and preserves work after invalid imports', { timeout: 45000 }, async () => {
  await browserSession(async ({ page, url }) => {
    await ready(page, url);
    const hostile = {
      ...sample,
      title: '<img src=x onerror="window.__composerXss=1">',
      voices: [{ name: '<img src=x>', notation: sample.voices[0].notation }],
      credits: ['</text><foreignObject><img src=x onerror="window.__composerXss=2"></foreignObject>', '普通署名 & < > "'],
    };
    await importDocument(page, hostile);
    assert.equal(await page.evaluate(() => window.__composerXss), undefined);
    assert.equal(await page.locator('#draft-list img, #draft-list script, #composer-preview script, #composer-preview foreignObject, #composer-preview img, #composer-preview [onerror], #composer-preview [onload]').count(), 0);
    assert.ok((await page.locator('#composer-preview').textContent()).includes(hostile.title));
    assert.ok((await page.locator('#composer-preview').textContent()).includes(hostile.credits[0]));
    assertSampleDocument(JSON.parse((await downloadThrough(page, '#composer-export-json')).bytes.toString('utf8')), hostile);
    const beforeCount = await page.locator('.draft-item').count();
    const beforeId = await page.locator('.draft-item[aria-current="true"]').getAttribute('data-draft-id');
    for (const [name, text] of [['broken.json', '{broken'], ['wrong-format.json', JSON.stringify({ format: 'unrecognized', voices: [] })]]) {
      const previousMessage = await page.locator('#composer-message').textContent();
      await page.locator('#composer-file').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
      await page.waitForFunction(previous => {
        const message = document.getElementById('composer-message');
        return !message.hidden && message.dataset.kind === 'error' && message.textContent !== previous;
      }, previousMessage);
      assert.equal(await page.locator('.draft-item').count(), beforeCount, 'rejected imports must not add or overwrite drafts');
      assert.equal(await page.locator('.draft-item[aria-current="true"]').getAttribute('data-draft-id'), beforeId);
      assert.equal(await page.locator('#composer-title').inputValue(), hostile.title);
      assert.equal(await page.locator('.notation-input').first().inputValue(), hostile.voices[0].notation);
    }
    const unsafeNotation = '</textarea><img src=x onerror="window.__composerXss=3">';
    await page.locator('.notation-input').first().fill(unsafeNotation);
    await page.waitForFunction(() => !document.getElementById('notation-error').hidden);
    assert.equal(await page.evaluate(() => window.__composerXss), undefined);
    assert.equal(await page.locator('#notation-error img, #notation-error script, #composer-voices img').count(), 0);
    await assertNoOverflow(page, 'long untrusted text and parser error');
  });
});

test('composer opens a whitelisted public score as a local copy without losing drafts or fetching arbitrary score paths', { timeout: 45000 }, async () => {
  await browserSession(async ({ page, url }) => {
    const expected = JSON.parse(fs.readFileSync(path.join(project, 'scores/heixiu-rhapsody.json'), 'utf8'));
    const fetches = [];
    page.on('request', request => {
      if (['fetch', 'xhr'].includes(request.resourceType())) fetches.push(request.url());
    });
    await ready(page, url);
    await page.locator('#composer-title').fill('本地保留草稿');
    const unfinished = '1 2 unfinished 4';
    await page.locator('.notation-input').first().fill(unfinished);
    const originalId = await page.locator('.draft-item[aria-current="true"]').getAttribute('data-draft-id');
    await page.waitForFunction(({ key, value }) => (localStorage.getItem(key) || '').includes(value), { key: storageKey, value: unfinished });

    await page.goto(`${url}?score=heixiu-rhapsody&keep=1#editor`);
    await page.waitForFunction(title => document.getElementById('composer-title').value === title, expected.title);
    await waitForPreview(page);
    assert.equal(await page.locator('.draft-item').count(), 2, 'a public score creates a separate local draft');
    const copyId = await page.locator('.draft-item[aria-current="true"]').getAttribute('data-draft-id');
    assert.notEqual(copyId, originalId);
    assert.equal(new URL(page.url()).searchParams.has('score'), false, 'refresh must not create another copy');
    assert.equal(new URL(page.url()).searchParams.get('keep'), '1');
    assert.equal(new URL(page.url()).hash, '#editor');
    assert.equal(await page.locator('.notation-input').count(), expected.voices.length);
    const exported = JSON.parse((await downloadThrough(page, '#composer-export-json')).bytes.toString('utf8'));
    assertSampleDocument(exported, expected);
    assert.equal(exported.description, expected.description);
    assert.deepEqual(fetches, [new URL('scores/heixiu-rhapsody.json', url).href]);

    await page.reload();
    await page.locator('.notation-input').first().waitFor();
    assert.equal(await page.locator('.draft-item').count(), 2);
    assert.equal(await page.locator('.draft-item[aria-current="true"]').getAttribute('data-draft-id'), copyId);
    assert.equal(fetches.length, 1, 'refresh of the copied score does not fetch it again');
    await page.locator(`.draft-item[data-draft-id="${originalId}"]`).click();
    assert.equal(await page.locator('#composer-title').inputValue(), '本地保留草稿');
    assert.equal(await page.locator('.notation-input').first().inputValue(), unfinished);

    const rejected = [
      '../scores/private.json',
      'https://example.invalid/injected.json',
      '//example.invalid/injected.json',
      'scores/heixiu-rhapsody.json',
      'heixiu-rhapsody/../../private.json',
      'javascript:window.__composerXss=1',
    ];
    for (const score of rejected) {
      await page.goto(`${url}?score=${encodeURIComponent(score)}`);
      await page.waitForFunction(() => {
        const message = document.getElementById('composer-message');
        return message && !message.hidden && message.dataset.kind === 'error';
      });
      assert.equal(await page.locator('.draft-item').count(), 2, `invalid public id must not create a draft: ${score}`);
      assert.equal(await page.locator('.draft-item[aria-current="true"]').getAttribute('data-draft-id'), originalId);
      assert.equal(await page.locator('.notation-input').first().inputValue(), unfinished);
      assert.equal(await page.evaluate(() => window.__composerXss), undefined);
      assert.equal(fetches.length, 1, `invalid public id must not issue a fetch: ${score}`);
    }
  });
});

test('composer restores an unfinished JSON backup with invalid tempo and repeats, then recovers after correction', { timeout: 45000 }, async () => {
  await browserSession(async ({ browser, page, url }) => {
    await ready(page, url);
    await waitForPreview(page);
    const title = '未完成草稿 · 备份恢复';
    const notation = sample.voices[0].notation;
    await page.locator('#composer-title').fill(title);
    await page.locator('.notation-input').first().fill(notation);
    await waitForPreview(page);
    if (await page.locator('.composer-extra').getAttribute('open') === null) await page.locator('.composer-extra summary').click();
    await page.locator('#add-repeat').click();
    await page.locator('#repeat-0-times').fill('1');
    await page.locator('#composer-bpm').fill('');
    await page.waitForFunction(() => !document.getElementById('notation-error').hidden);
    assert.equal(await page.locator('#composer-play').isDisabled(), true);
    assert.equal(await page.locator('#composer-export-svg').isDisabled(), true);

    const backup = await downloadThrough(page, '#composer-export-json');
    const original = JSON.parse(backup.bytes.toString('utf8'));
    assert.equal(original.bpm, 0, 'an empty tempo input must remain represented as the unfinished value');
    assert.equal(original.repeats[0].times, 1, 'backup must not normalize an invalid repeat count');
    assert.equal(original.voices[0].notation, notation);

    // A separate browser context proves restoration comes from the downloaded
    // backup, not the original tab's local storage or in-memory editor state.
    const fresh = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    fresh.setDefaultTimeout(7000);
    const freshErrors = [];
    fresh.on('pageerror', error => freshErrors.push(error.message));
    await ready(fresh, url);
    assert.equal(await fresh.locator('.draft-item').count(), 1);
    assert.notEqual(await fresh.locator('#composer-title').inputValue(), title);
    await fresh.locator('#composer-file').setInputFiles({ name: backup.name, mimeType: 'application/json', buffer: backup.bytes });
    await fresh.waitForFunction(expected => document.getElementById('composer-title').value === expected, title);
    await fresh.waitForFunction(() => !document.getElementById('notation-error').hidden);
    assert.equal(await fresh.locator('.draft-item').count(), 2);
    assert.equal(await fresh.locator('#composer-bpm').inputValue(), '0');
    assert.equal(await fresh.locator('#repeat-0-times').inputValue(), '1');
    assert.equal(await fresh.locator('.notation-input').first().inputValue(), notation);
    assert.equal(await fresh.locator('#composer-play').isDisabled(), true);
    assert.equal(await fresh.locator('#composer-export-svg').isDisabled(), true);
    const restored = JSON.parse((await downloadThrough(fresh, '#composer-export-json')).bytes.toString('utf8'));
    assertSampleDocument(restored, original);

    await fresh.locator('#composer-bpm').fill('80');
    await fresh.waitForFunction(() => !document.getElementById('notation-error').hidden
      && document.getElementById('notation-error').textContent.includes('反复'));
    assert.equal(await fresh.locator('#composer-play').isDisabled(), true, 'the remaining invalid repeat still prevents playback');
    if (await fresh.locator('.composer-extra').getAttribute('open') === null) await fresh.locator('.composer-extra summary').click();
    await fresh.locator('#repeat-0-times').fill('2');
    await waitForPreview(fresh);
    assert.equal(await fresh.locator('#composer-export-svg').isDisabled(), false);
    assert.equal(await fresh.locator('#notation-error').isVisible(), false);
    assert.equal(await fresh.locator('#composer-preview .repeat-start').count(), 1);
    assert.equal(await fresh.locator('#composer-preview .repeat-end').count(), 1);
    assert.equal(await fresh.locator('.notation-input').first().inputValue(), notation);
    assert.deepEqual(freshErrors, []);
    await fresh.close();
  });
});
