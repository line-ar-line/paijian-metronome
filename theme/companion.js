(() => {
  'use strict';
  const intro = document.querySelector('main > .intro');
  if (!intro) return;
  const assetRoot = new URL('assets/', document.currentScript.src);
  const frameUrl = name => new URL(`companion-${name}.svg`, assetRoot).href;
  const storageKey = 'paijian.forest.v1';
  const defaults = { motion: true, focus: false };
  let preferences = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && typeof saved === 'object') {
      for (const key of Object.keys(defaults)) if (typeof saved[key] === 'boolean') preferences[key] = saved[key];
    }
  } catch { /* The theme also works when storage is unavailable. */ }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const greetings = document.body.classList.contains('library-page')
    ? ['下一首，一起慢慢练。', '喜欢的旋律，值得收藏。']
    : document.body.classList.contains('composer-page')
      ? ['把今天的灵感写下来。', '这一小节，听起来不错。']
      : document.body.classList.contains('community-page')
        ? ['今天的一点点，也算数。', '小黑在这里，陪你坚持。']
        : document.body.classList.contains('workshop-page')
          ? ['一小节一小节，慢慢来。', '找到你的节奏就很好。']
          : ['今天，也一起练一会儿吧。', '慢一点，旋律会更清楚。'];

  const preferencesBar = document.createElement('div');
  preferencesBar.className = 'forest-preferences';
  preferencesBar.setAttribute('role', 'group');
  preferencesBar.setAttribute('aria-label', '陪练主题设置');
  preferencesBar.innerHTML = `<span class="forest-room-label"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 14C2 5 9 3 16 3c0 8-4 13-10 11M4 17l8-9"/></svg>小黑的森林练习室</span><div class="forest-preference-actions"><button class="forest-preference" id="forest-motion" type="button" aria-pressed="true"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10V4l4 3h4l4-3v6c0 4-2 6-6 6s-6-2-6-6Z"/><path d="M7 10v1m6-1v1"/></svg><span>陪练动态</span></button><button class="forest-preference" id="forest-focus" type="button" aria-pressed="false"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M7 3H3v4m10-4h4v4M3 13v4h4m6 0h4v-4"/><circle cx="10" cy="10" r="2"/></svg><span>专注模式</span></button></div>`;
  const settingNote = document.createElement('p');
  settingNote.className = 'forest-setting-note';
  settingNote.setAttribute('role', 'status');
  intro.before(preferencesBar, settingNote);

  const scene = document.createElement('div');
  scene.className = 'forest-scene';
  scene.innerHTML = `<span class="forest-scene-label">小黑陪你练 ♪</span><span class="forest-note forest-note-one" aria-hidden="true">♪</span><span class="forest-note forest-note-two" aria-hidden="true">♬</span><button type="button" class="companion-portrait" aria-label="和小黑打个招呼"><img class="companion-frame" width="180" height="180" alt="抱着卡林巴的小黑" draggable="false"></button><p class="forest-companion-caption"></p><p class="forest-companion-hint">点点小黑，打个招呼</p>`;
  const introCopy = intro.firstElementChild;
  for (const item of Array.from(intro.children).slice(1)) {
    item.classList.add('forest-intro-meta');
    introCopy.append(item);
  }
  intro.append(scene);
  const image = scene.querySelector('img');
  const caption = scene.querySelector('.forest-companion-caption');
  const portrait = scene.querySelector('button');
  const motionButton = document.getElementById('forest-motion');
  const focusButton = document.getElementById('forest-focus');
  caption.textContent = greetings[0];
  image.src = frameUrl('idle');

  const empty = document.querySelector('#catalog-empty > span');
  if (empty) {
    const emptyImage = document.createElement('img');
    emptyImage.className = 'forest-empty-companion';
    emptyImage.src = frameUrl('rest');
    emptyImage.width = 116; emptyImage.height = 116; emptyImage.alt = '';
    empty.replaceChildren(emptyImage);
  }
  const footer = document.querySelector('.page-shell > footer');
  if (footer) {
    const credit = document.createElement('div');
    credit.className = 'forest-credit';
    const label = document.createElement('span');
    label.textContent = '小黑陪练 · 同人主题';
    const preview = document.createElement('a');
    preview.href = new URL('frames-preview.html', new URL('../', assetRoot)).href;
    preview.textContent = '看看动作差分 ↗';
    credit.append(label, preview); footer.after(credit);
  }

  const playingButton = document.querySelector('#toggle-play, #score-play, #composer-play');
  let playing = playingButton?.getAttribute('aria-pressed') === 'true';
  let idleTimer = null;
  let actionTimers = [];
  let actionVersion = 0;
  let greetingIndex = 0;
  const motionAllowed = () => preferences.motion && !preferences.focus && !reducedMotion.matches && !document.hidden;
  const setFrame = name => { const next = frameUrl(name); if (image.src !== next) image.src = next; };
  function clearAction() {
    actionVersion++;
    actionTimers.forEach(clearTimeout); actionTimers = [];
  }
  function settle() { setFrame(playing ? 'ready' : 'idle'); }
  function scheduleBlink() {
    clearTimeout(idleTimer); idleTimer = null;
    if (!motionAllowed() || playing) return;
    idleTimer = setTimeout(() => {
      if (!motionAllowed() || playing) return;
      sequence([['blink-half', 0], ['blink', 70], ['blink-half', 150], ['idle', 220]], 240);
    }, 4800 + Math.random() * 4200);
  }
  function sequence(frames, duration) {
    clearAction(); clearTimeout(idleTimer); idleTimer = null;
    if (!motionAllowed()) { settle(); return; }
    const version = actionVersion;
    for (const [frame, delay] of frames) {
      actionTimers.push(setTimeout(() => { if (version === actionVersion && motionAllowed()) setFrame(frame); }, delay));
    }
    actionTimers.push(setTimeout(() => {
      if (version !== actionVersion) return;
      settle(); scheduleBlink();
    }, duration));
  }
  function greet(animate) {
    caption.textContent = greetings[++greetingIndex % greetings.length];
    if (animate) sequence([['ready', 0], ['wave', 120], ['ready', 340], ['wave', 490]], 800);
  }
  function applyPreferences() {
    document.body.dataset.forestFocus = String(preferences.focus);
    document.body.dataset.forestMotion = String(preferences.motion);
    motionButton.setAttribute('aria-pressed', String(preferences.motion));
    focusButton.setAttribute('aria-pressed', String(preferences.focus));
    motionButton.title = reducedMotion.matches ? '系统已开启减少动态，角色保持静止' : '控制眨眼和挥爪动画';
    clearAction(); settle(); scheduleBlink();
  }
  function savePreferences() {
    try { localStorage.setItem(storageKey, JSON.stringify(preferences)); settingNote.textContent = ''; }
    catch { settingNote.textContent = '当前浏览器无法保存偏好，本页设置仍然有效。'; }
  }
  motionButton.addEventListener('click', () => { preferences.motion = !preferences.motion; applyPreferences(); savePreferences(); });
  focusButton.addEventListener('click', () => { preferences.focus = !preferences.focus; applyPreferences(); savePreferences(); });
  portrait.addEventListener('click', event => greet(event.detail !== 0));
  if (playingButton) {
    new MutationObserver(() => {
      const next = playingButton.getAttribute('aria-pressed') === 'true';
      if (next === playing) return;
      playing = next; clearAction(); clearTimeout(idleTimer);
      caption.textContent = playing ? '小黑也在认真听。' : '休息一下，再继续。';
      setFrame(playing ? 'ready' : 'rest');
      scheduleBlink();
    }).observe(playingButton, { attributes: true, attributeFilter: ['aria-pressed'] });
  }
  window.addEventListener('paijian:checkin-saved', () => {
    caption.textContent = '今天的坚持，小黑记住啦！';
    sequence([['ready', 0], ['wave', 130], ['ready', 380], ['wave', 540]], 900);
  });
  document.addEventListener('visibilitychange', () => { clearAction(); settle(); scheduleBlink(); });
  reducedMotion.addEventListener('change', applyPreferences);
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    try {
      const saved = JSON.parse(event.newValue);
      preferences = { motion: typeof saved?.motion === 'boolean' ? saved.motion : defaults.motion,
        focus: typeof saved?.focus === 'boolean' ? saved.focus : defaults.focus };
      applyPreferences();
    } catch { /* Ignore malformed preferences from another tab. */ }
  });
  window.addEventListener('pagehide', () => { clearAction(); clearTimeout(idleTimer); });
  window.addEventListener('pageshow', () => { settle(); scheduleBlink(); });
  // Six small local SVGs share a fixed canvas, so the first gesture never flashes.
  for (const frame of ['idle', 'blink-half', 'blink', 'ready', 'wave', 'rest']) {
    const preload = new Image(); preload.src = frameUrl(frame);
  }
  applyPreferences();
})();
