const assert = require('node:assert/strict');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { chromium } = require('playwright');

const appUrl = pathToFileURL(path.resolve(__dirname, '../index.html')).href;

test('browser playback, controls, saved settings, audio rendering, and mobile layout', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      // Capture the real engine instance without exposing test hooks in production.
      let Engine;
      Object.defineProperty(window, 'MetronomeEngine', {
        configurable: true,
        get: () => Engine,
        set: Original => {
          Engine = class extends Original {
            constructor(callbacks, dependencies) {
              super(callbacks, dependencies);
              window.testEngine = this;
              this.testBeats = [];
              const onBeat = this.onBeat;
              this.onBeat = event => { this.testBeats.push(event); onBeat(event); };
            }
          };
        },
      });
    });
    await page.goto(appUrl);
    assert.equal(await page.locator('#bpm-input').inputValue(), '60');
    assert.equal(await page.locator('.beat-dot').count(), 4);
    await page.locator('#bpm-input').fill('120');
    await page.locator('#bpm-input').press('Enter');
    await page.locator('#toggle-play').click();
    await page.waitForFunction(() => window.testEngine.testBeats.length >= 4);
    const timing = await page.evaluate(() => window.testEngine.testBeats.map(e => e.audioTime));
    for (let i = 1; i < timing.length; i++) assert.ok(Math.abs(timing[i] - timing[i - 1] - 0.5) < 0.00001);
    assert.equal(await page.locator('#toggle-play').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => Number(document.getElementById('bar-count').textContent) >= 1);
    await page.locator('#toggle-play').click();
    const pausedTime = await page.locator('#session-time').innerText();
    assert.equal(await page.evaluate(() => window.testEngine._voices.size), 0);
    await page.waitForTimeout(1100);
    assert.equal(await page.locator('#session-time').innerText(), pausedTime);
    assert.equal(await page.locator('.beat-dot.current').count(), 0);

    await page.locator('#meter').selectOption('6/8');
    assert.equal(await page.locator('.beat-dot').count(), 6);
    assert.equal(await page.locator('.beat-dot[data-accent="2"]').count(), 2);
    assert.match(await page.locator('#meter-note').innerText(), /八分音符/);
    await page.locator('[data-subdivision="4"]').click();
    assert.equal(await page.locator('.preview-tick').count(), 24);
    await page.locator('.beat-dot').first().click();
    assert.equal(await page.locator('.beat-dot').first().getAttribute('data-accent'), '0');
    await page.locator('#mute').click();
    assert.equal(await page.locator('#volume').inputValue(), '0');
    await page.locator('#toggle-play').click();
    assert.equal(await page.evaluate(() => window.testEngine.settings.volume), 0);
    await page.locator('#toggle-play').click();
    await page.reload();
    assert.equal(await page.locator('#volume').inputValue(), '0');
    assert.equal(await page.locator('#meter').inputValue(), '6/8');
    assert.equal(await page.locator('[data-subdivision="4"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.beat-dot').first().getAttribute('data-accent'), '0');
    await page.locator('#mute').click();
    assert.equal(await page.locator('#volume').inputValue(), '60');

    // Tap tempo and input boundaries must work through real DOM interactions.
    await page.clock.install();
    for (let i = 0; i < 5; i++) {
      await page.locator('#tap-tempo').dispatchEvent('click');
      if (i < 4) await page.clock.runFor(500);
    }
    assert.equal(await page.locator('#bpm-input').inputValue(), '120');
    await page.locator('#bpm-input').fill('999');
    await page.locator('#bpm-input').press('Enter');
    assert.equal(await page.locator('#bpm-input').inputValue(), '240');
    await page.locator('#bpm-input').fill('');
    await page.locator('#bpm-input').press('Tab');
    assert.equal(await page.locator('#bpm-input').inputValue(), '240');
    await page.locator('#bpm-input').fill('12');
    await page.locator('#bpm-input').press('Enter');
    assert.equal(await page.locator('#bpm-input').inputValue(), '30');
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await page.locator('#bpm-input').inputValue(), '34');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#toggle-play').getAttribute('aria-pressed'), 'true');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#toggle-play').getAttribute('aria-pressed'), 'false');

    // The app must use bar numbers even if the browser skips visual frames.
    await page.locator('#reset-session').click();
    await page.evaluate(() => window.testEngine.onBeat({ beat: 2, subdivision: 1, bar: 8, audioTime: 0, bpm: 60 }));
    assert.equal(await page.locator('#bar-count').innerText(), '7');
    assert.equal(await page.locator('.beat-dot.current').innerText(), '3');

    // Render the actual synthesizer with the browser's Web Audio implementation.
    const rendered = await page.evaluate(async () => {
      const results = [];
      for (const sound of ['wood', 'click', 'bell']) {
        for (const volume of [0, 0.6]) {
          const context = new OfflineAudioContext(1, 44100, 44100);
          const engine = new MetronomeEngine();
          engine.settings.sound = sound;
          engine._context = context;
          engine._master = context.createGain();
          engine._master.gain.value = volume;
          engine._master.connect(context.destination);
          engine._sound(0.1, 2);
          engine._sound(0.4, 1);
          engine._sound(0.7, -1);
          const output = (await context.startRendering()).getChannelData(0);
          const energy = (from, to) => {
            const segment = output.slice(from * 44100, to * 44100);
            return segment.reduce((sum, n) => sum + n * n, 0) / segment.length;
          };
          results.push({ sound, volume, strong: energy(0.1, 0.22), normal: energy(0.4, 0.52), sub: energy(0.7, 0.82), silence: energy(0.25, 0.35), peak: Math.max(...output.map(Math.abs)) });
        }
      }
      return results;
    });
    for (const result of rendered) {
      assert.ok(result.peak < 1, `${result.sound} must not clip`);
      assert.equal(result.silence, 0);
      if (result.volume === 0) assert.equal(result.peak, 0);
      else {
        assert.ok(result.strong > result.normal && result.normal > result.sub && result.sub > 0, `${result.sound} must distinguish accent levels`);
      }
    }

    // Malformed persisted data should fall back to a working default.
    await page.evaluate(() => localStorage.setItem('paijian.metronome.v1', '{broken'));
    await page.reload();
    assert.equal(await page.locator('#bpm-input').inputValue(), '60');
    await page.screenshot({ path: path.resolve(__dirname, '../preview-desktop.png'), fullPage: true });
    for (const width of [320, 390, 768]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `no horizontal overflow at ${width}px`);
      await page.locator('#meter').selectOption('6/8');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `six beats fit at ${width}px`);
      await page.locator('#meter').selectOption('4/4');
      if (width === 390) await page.screenshot({ path: path.resolve(__dirname, '../preview-mobile.png'), fullPage: true });
    }
    assert.deepEqual(errors, []);
    console.log('Verified file:// startup, real audio timing and rendering, pause/resume, meter, accents, subdivisions, volume, persistence, tap tempo, keyboard, frame skips, and 320/390/768px layouts.');
  } finally { await browser.close(); }
});
