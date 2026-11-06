(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const STORAGE_KEY = 'paijian.metronome.v1';
  const METERS = { '2/4': 2, '3/4': 3, '4/4': 4, '6/8': 6 };
  const defaults = { bpm: 60, meter: '4/4', subdivision: 1, accents: [2, 1, 1, 1], volume: 0.6, sound: 'wood' };
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  function readSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved || typeof saved !== 'object') return { ...defaults, accents: [...defaults.accents] };
      const meter = Object.hasOwn(METERS, saved.meter) ? saved.meter : defaults.meter;
      return {
        bpm: Number.isFinite(saved.bpm) ? clamp(Math.round(saved.bpm), 30, 240) : 60,
        meter,
        subdivision: [1, 2, 3, 4].includes(saved.subdivision) ? saved.subdivision : 1,
        accents: Array.from({ length: METERS[meter] }, (_, i) => [0, 1, 2].includes(saved.accents?.[i]) ? saved.accents[i] : i === 0 ? 2 : 1),
        volume: Number.isFinite(saved.volume) ? clamp(saved.volume, 0, 1) : 0.6,
        sound: ['wood', 'click', 'bell'].includes(saved.sound) ? saved.sound : 'wood',
      };
    } catch { return { ...defaults, accents: [...defaults.accents] }; }
  }
  let settings = readSettings();
  let starting = false;
  let startRequest = 0;
  let lastVolume = settings.volume || 0.6;
  let taps = [];
  let tapReset;
  let elapsedMs = 0;
  let runStarted = null;
  let completedBars = 0;
  let currentBar = 1;
  let countedThroughBar = 1;
  let wakeLock = null;
  let wakeRequest = 0;
  let currentPreview = null;
  const engine = new MetronomeEngine({ onBeat, onStateChange, onError: () => showMessage('声音暂时无法启动。请检查浏览器音频权限，再点击“开始练习”重试。') });
  const toEngine = () => ({ ...settings, beatsPerBar: METERS[settings.meter] });

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); }
    catch { document.querySelector('.saved-indicator').textContent = '本次设置仅在当前页面保留'; }
  }
  function showMessage(text) { $('message').textContent = text; $('message').hidden = !text; }
  function paintRange(element) {
    element.style.setProperty('--fill', `${100 * (Number(element.value) - Number(element.min)) / (Number(element.max) - Number(element.min))}%`);
  }
  function tempoName(bpm) {
    if (bpm < 66) return 'Largo · 舒缓地';
    if (bpm < 76) return 'Adagio · 从容地';
    if (bpm < 108) return 'Andante · 行走般';
    if (bpm < 120) return 'Moderato · 适中地';
    if (bpm < 168) return 'Allegro · 轻快地';
    return 'Presto · 急速地';
  }
  function renderTempo() {
    $('bpm-input').value = settings.bpm;
    $('bpm-slider').value = settings.bpm;
    $('tempo-name').textContent = tempoName(settings.bpm);
    $('decrease').disabled = settings.bpm <= 30;
    $('increase').disabled = settings.bpm >= 240;
    paintRange($('bpm-slider'));
    document.querySelectorAll('[data-tempo]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.tempo) === settings.bpm)));
  }
  function changeTempo(value) {
    if (!Number.isFinite(Number(value)) || String(value).trim() === '') { renderTempo(); return; }
    settings.bpm = clamp(Math.round(Number(value)), 30, 240);
    renderTempo(); engine.configure({ bpm: settings.bpm }); save();
  }
  function renderBeats() {
    const names = ['静音', '轻拍', '重拍'];
    $('beat-dots').replaceChildren(...settings.accents.map((accent, index) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'beat-dot'; button.dataset.accent = accent;
      button.textContent = index + 1;
      button.setAttribute('aria-label', `第 ${index + 1} 拍：${names[accent]}，点击切换为${names[(accent + 1) % 3]}`);
      button.addEventListener('click', () => {
        settings.accents[index] = (settings.accents[index] + 1) % 3;
        const wasCurrent = button.classList.contains('current');
        renderBeats();
        if (wasCurrent) $('beat-dots').children[index].classList.add('current');
        $('beat-dots').children[index].focus({ preventScroll: true });
        engine.configure({ accents: [...settings.accents] }); save();
      });
      return button;
    }));
    $('beat-dots').dataset.count = settings.accents.length;
  }
  function renderRhythm() {
    $('meter').value = settings.meter;
    $('meter-caption').textContent = settings.meter === '6/8' ? '每小节 6 个八分音符' : `每小节 ${METERS[settings.meter]} 拍`;
    $('meter-note').textContent = settings.meter === '6/8' ? 'BPM 按八分音符计数，按 3 + 3 分组。' : 'BPM 以四分音符为一拍。';
    $('subdivision-caption').textContent = ['每拍一下', '每拍两下', '每拍三下', '每拍四下'][settings.subdivision - 1];
    document.querySelectorAll('[data-subdivision]').forEach((button) => button.setAttribute('aria-pressed', String(Number(button.dataset.subdivision) === settings.subdivision)));
    $('rhythm-preview').replaceChildren(...Array.from({ length: METERS[settings.meter] }, () => {
      const group = document.createElement('span'); group.className = 'preview-group';
      for (let i = 0; i < settings.subdivision; i++) { const tick = document.createElement('i'); tick.className = 'preview-tick'; group.append(tick); }
      return group;
    }));
    currentPreview = null;
  }
  function renderSound() {
    document.querySelectorAll('[data-sound]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.sound === settings.sound)));
    $('volume').value = Math.round(settings.volume * 100);
    $('volume-value').value = `${Math.round(settings.volume * 100)}%`;
    $('mute').setAttribute('aria-label', settings.volume === 0 ? '恢复声音' : '静音');
    $('mute').setAttribute('aria-pressed', String(settings.volume === 0));
    $('mute').querySelector('use').setAttribute('href', settings.volume === 0 ? '#i-muted' : '#i-volume');
    paintRange($('volume'));
  }
  function changeVolume(value) {
    settings.volume = clamp(value, 0, 1);
    if (settings.volume > 0) lastVolume = settings.volume;
    engine.setVolume(settings.volume); renderSound(); save();
  }
  function onBeat(event) {
    // Visual callbacks may skip frames or whole bars in a background tab.
    // The audio engine's bar number still represents every completed bar.
    currentBar = event.bar;
    if (event.bar > countedThroughBar) {
      completedBars += event.bar - countedThroughBar;
      countedThroughBar = event.bar;
      $('bar-count').textContent = completedBars;
    }
    Array.from($('beat-dots').children).forEach((button, i) => button.classList.toggle('current', i === event.beat));
    currentPreview?.classList.remove('active');
    currentPreview = $('rhythm-preview').children[event.beat]?.children[event.subdivision];
    currentPreview?.classList.add('active');
  }
  function updateClock() {
    const totalSeconds = Math.floor((elapsedMs + (runStarted === null ? 0 : performance.now() - runStarted)) / 1000);
    $('session-time').textContent = `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }
  async function acquireWakeLock() {
    if (!('wakeLock' in navigator) || wakeLock || document.hidden || !engine.isRunning) return;
    const request = ++wakeRequest;
    try {
      const lock = await navigator.wakeLock.request('screen');
      if (!engine.isRunning || request !== wakeRequest) { await lock.release(); return; }
      wakeLock = lock;
      lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; });
    } catch { /* Some browsers and power-saving modes do not offer wake locks. */ }
  }
  function onStateChange({ state, reason }) {
    const running = state === 'running';
    currentBar = 1;
    countedThroughBar = 1;
    if (running && runStarted === null) runStarted = performance.now();
    if (!running && runStarted !== null) { elapsedMs += performance.now() - runStarted; runStarted = null; }
    $('toggle-play').setAttribute('aria-pressed', String(running));
    $('toggle-play').querySelector('span').textContent = running ? '暂停练习' : '开始练习';
    $('toggle-play').querySelector('use').setAttribute('href', running ? '#i-pause' : '#i-play');
    $('play-status').classList.toggle('is-playing', running);
    $('play-status').querySelector('span').textContent = running ? '正在练习' : '准备好了';
    if (running) acquireWakeLock();
    else {
      wakeRequest++;
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
      document.querySelectorAll('.beat-dot.current, .preview-tick.active').forEach((el) => el.classList.remove('current', 'active'));
      if (reason === 'interrupted' || reason === 'stalled') showMessage('播放已暂停：浏览器或音频设备中断了节拍。点击“开始练习”即可重新开始。');
    }
    updateClock();
  }
  async function togglePlay() {
    if (starting || engine.isRunning) {
      startRequest++; starting = false; engine.stop();
      $('toggle-play').removeAttribute('aria-busy');
      $('toggle-play').querySelector('span').textContent = '开始练习';
      return;
    }
    showMessage(''); starting = true;
    const request = ++startRequest;
    $('toggle-play').setAttribute('aria-busy', 'true');
    $('toggle-play').querySelector('span').textContent = '正在准备…';
    try { await engine.start(toEngine()); }
    catch { showMessage('无法启用声音，请在支持 Web Audio 的浏览器中重试。'); }
    finally {
      if (request === startRequest) {
        starting = false; $('toggle-play').removeAttribute('aria-busy');
        $('toggle-play').querySelector('span').textContent = engine.isRunning ? '暂停练习' : '开始练习';
      }
    }
  }
  function tapTempo() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2400) taps = [];
    taps.push(now); taps = taps.slice(-7);
    if (taps.length > 1) {
      const intervals = taps.slice(1).map((t, i) => t - taps[i]);
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const steady = intervals.filter((n) => Math.abs(n - median) < median * 0.35);
      const interval = steady.reduce((sum, n) => sum + n, 0) / steady.length;
      const detected = Math.round(60000 / interval);
      changeTempo(detected);
      $('tap-hint').textContent = detected < 30 || detected > 240 ? `已设为 ${settings.bpm} BPM（支持 30–240 BPM），请继续均匀敲击。` : `约 ${settings.bpm} BPM · 已敲 ${taps.length} 次，继续敲击会更准确。`;
    } else $('tap-hint').textContent = '再敲一下，跟着你想练习的节奏。';
    clearTimeout(tapReset);
    tapReset = setTimeout(() => { taps = []; $('tap-hint').textContent = '跟着熟悉的旋律敲几下，找到它的速度。'; }, 2600);
  }

  $('decrease').addEventListener('click', () => changeTempo(settings.bpm - 1));
  $('increase').addEventListener('click', () => changeTempo(settings.bpm + 1));
  $('bpm-input').addEventListener('change', (event) => changeTempo(event.target.value));
  $('bpm-input').addEventListener('blur', renderTempo);
  $('bpm-input').addEventListener('keydown', (event) => { if (event.key === 'Enter') { changeTempo(event.target.value); event.target.blur(); } });
  $('bpm-slider').addEventListener('input', (event) => changeTempo(event.target.value));
  document.querySelectorAll('[data-tempo]').forEach((button) => button.addEventListener('click', () => changeTempo(button.dataset.tempo)));
  $('meter').addEventListener('change', (event) => {
    settings.meter = event.target.value;
    settings.accents = Array.from({ length: METERS[settings.meter] }, (_, i) => i === 0 || (settings.meter === '6/8' && i === 3) ? 2 : 1);
    currentBar = countedThroughBar = 1;
    renderBeats(); renderRhythm(); engine.configure(toEngine()); save();
  });
  document.querySelectorAll('[data-subdivision]').forEach((button) => button.addEventListener('click', () => {
    const next = Number(button.dataset.subdivision);
    if (next === settings.subdivision) return;
    settings.subdivision = next; currentBar = countedThroughBar = 1;
    renderRhythm(); engine.configure({ subdivision: settings.subdivision }); save();
  }));
  document.querySelectorAll('[data-sound]').forEach((button) => button.addEventListener('click', () => {
    settings.sound = button.dataset.sound; renderSound(); engine.configure({ sound: settings.sound }); save();
  }));
  $('volume').addEventListener('input', (event) => changeVolume(Number(event.target.value) / 100));
  $('mute').addEventListener('click', () => changeVolume(settings.volume === 0 ? lastVolume : 0));
  $('toggle-play').addEventListener('click', togglePlay);
  $('tap-tempo').addEventListener('click', tapTempo);
  $('reset-session').addEventListener('click', () => {
    elapsedMs = 0; runStarted = engine.isRunning ? performance.now() : null;
    completedBars = 0;
    // Exclude the partial bar that was already underway when Reset was pressed.
    countedThroughBar = engine.isRunning ? currentBar + 1 : 1;
    $('bar-count').textContent = '0'; updateClock();
  });
  document.addEventListener('keydown', (event) => {
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input, select, textarea, [contenteditable="true"]')) return;
    if (event.code === 'Space') {
      // Let native buttons consume Space, keeping keyboard activation accessible.
      if (event.target.closest('button, a')) return;
      event.preventDefault(); togglePlay();
    } else if (event.key.toLowerCase() === 't') { event.preventDefault(); tapTempo(); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); changeTempo(settings.bpm + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 4 : 1)); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { updateClock(); acquireWakeLock(); } });
  window.addEventListener('pagehide', () => { startRequest++; starting = false; engine.stop(); });
  renderTempo(); renderBeats(); renderRhythm(); renderSound();
  setInterval(updateClock, 250);
})();
