(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const shorten = (value, max) => Array.from(String(value)).slice(0, max).join('');
  let score;
  let svgText = '';
  let pages = [];
  let pageIndex = 0;
  let barToPage = [];
  let nodesBySource = new Map();
  let state;
  let starting = false;
  let playGeneration = 0;
  let importGeneration = 0;
  let scoreRevision = 0;
  let activeSources = new Set();
  let activeGroups = [];
  let renderOptions;
  let positionBeat = 0;
  let currentBar = -1;
  let scrubbing = false;
  let resumeAfterScrub = false;
  let pendingScoreLoad = null;
  const scoreControlIds = ['score-play', 'score-restart', 'playback-progress', 'score-bpm', 'score-name', 'page-select', 'previous-page', 'next-page', 'export-svg', 'export-png', 'export-json', 'print-score', 'score-mode', 'instrument-select', 'score-meter', 'transpose', 'suggest-transpose', 'track-select'];
  const favorites = globalThis.ScoreUserLibrary;
  const player = new ScorePlayer({ onActiveNotes: highlight, onProgress: progress, onStateChange: playbackState, onError: (error) => message(error.message || '播放暂时无法启动，请重试。') });

  function message(value, kind = 'error') {
    $('workshop-message').textContent = value;
    $('workshop-message').hidden = !value;
    $('workshop-message').dataset.kind = kind;
  }
  function setScoreReady(ready) {
    scoreControlIds.forEach(id => { $(id).disabled = !ready; });
    document.querySelector('.playback-hint').hidden = !ready;
    if (!ready) $('favorite-score').disabled = true;
  }
  function scorePlaceholder(title, detail) {
    const panel = document.createElement('div'); panel.className = 'score-load-state';
    const heading = document.createElement('strong'); heading.textContent = title;
    const description = document.createElement('p'); description.textContent = detail;
    panel.append(heading, description); $('score-preview').replaceChildren(panel);
  }
  function beginScoreLoad(kind, id) {
    scrubbing = false; resumeAfterScrub = false; stop();
    score = undefined; state = undefined; pages = []; pageIndex = 0;
    barToPage = []; nodesBySource.clear(); positionBeat = 0; currentBar = -1; scoreRevision++;
    pendingScoreLoad = { kind, id };
    setScoreReady(false);
    $('score-name').value = ''; $('score-name').placeholder = '正在加载所选曲目…';
    $('source-label').textContent = ''; $('score-summary').textContent = '';
    $('full-score-info').textContent = '正在载入所选曲目的完整数字谱…';
    $('example-select').value = '';
    $('page-select').replaceChildren(); $('page-range').textContent = '';
    $('score-warnings').replaceChildren();
    for (const name of ['original-score', 'edit-authored', 'export-json', 'score-performance-note', 'track-field', 'score-load-actions']) $(name).hidden = true;
    $('favorite-score').textContent = '☆ 收藏'; $('favorite-score').setAttribute('aria-pressed', 'false');
    updateTime(0, 0); $('playback-status').textContent = '曲谱加载后即可播放。';
    scorePlaceholder('正在加载所选曲目', '加载完成后会在这里显示完整数字谱。');
    $('score-preview').setAttribute('aria-busy', 'true');
    document.title = '正在加载曲谱 · 拍间';
    message('正在载入所选曲目…', 'success');
  }
  function namePendingScore(title) {
    $('score-name').value = shorten(title, 80);
    $('full-score-info').textContent = `正在载入《${title}》的完整数字谱…`;
    document.title = `${title} · 正在加载 · 拍间`;
    scorePlaceholder(`正在加载《${title}》`, '加载完成后会在这里显示完整数字谱。');
  }
  function failScoreLoad(error) {
    const detail = error.name === 'AbortError' ? '曲谱加载超时，请点击“重新加载”重试。'
      : error instanceof TypeError ? '曲谱暂时无法加载，请检查网络后重试。' : error.message || '曲谱暂时无法加载，请重试。';
    score = undefined; state = undefined; pages = []; barToPage = []; nodesBySource.clear();
    setScoreReady(false);
    for (const id of ['original-score', 'edit-authored', 'export-json', 'score-performance-note', 'track-field']) $(id).hidden = true;
    scorePlaceholder('这首曲谱尚未加载成功', detail);
    $('full-score-info').textContent = '未载入所选曲谱';
    $('playback-status').textContent = '加载成功后即可播放。';
    $('score-summary').textContent = '';
    $('score-load-actions').hidden = false;
    $('score-preview').removeAttribute('aria-busy');
    document.title = `${$('score-name').value || '所选曲谱'} · 加载失败 · 拍间`;
    message(detail);
  }
  function seconds(beats) { return beats * 60 / (state?.bpm || 80); }
  function hasUnmetered() { return Boolean(score?.unmeteredSections?.length); }
  function totalBeats() { return state?.compiled?.totalBeats || score?.sourceTotalBeats || 0; }
  function playLabel() { return positionBeat > 0 && positionBeat < totalBeats() ? '继续播放' : '播放'; }
  function clock(value) { return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; }
  function barAt(beat) {
    if (!score?.bars.length) return -1;
    const playedBar = Math.floor(beat / score.barBeats);
    return score.playbackBarMap
      ? score.playbackBarMap[Math.min(playedBar, score.playbackBarMap.length - 1)]
      : Math.min(score.bars.length - 1, playedBar);
  }
  function positionLabel(beat) { return score ? `第 ${barAt(beat) + 1} / ${score.bars.length} 小节` : '准备好'; }
  function updateTime(beat, length = totalBeats()) {
    const slider = $('playback-progress');
    slider.max = length || 1;
    slider.value = beat;
    slider.style.setProperty('--played', `${length ? beat / length * 100 : 0}%`);
    slider.setAttribute('aria-valuetext', `${clock(seconds(beat))}，${positionLabel(beat)}，全长 ${clock(seconds(length))}`);
    $('playback-time').textContent = `${clock(seconds(beat))} / ${clock(seconds(length))}`;
  }
  function paintCurrentBar() {
    $('score-preview').querySelectorAll('[data-measure]').forEach(group => {
      const current = Number(group.dataset.measure) === currentBar;
      group.classList.toggle('is-current-measure', current);
      if (current) group.setAttribute('aria-current', 'step');
      else group.removeAttribute('aria-current');
    });
  }
  function followBar(bar, immediate = false) {
    if (bar < 0 || barToPage[bar] === undefined) return;
    const pageChanged = barToPage[bar] !== pageIndex;
    if (pageChanged) showPage(barToPage[bar]);
    const group = $('score-preview').querySelector(`[data-measure="${bar}"]`);
    if (!group) return;
    const preview = $('score-preview');
    const bounds = group.getBoundingClientRect();
    const viewport = preview.getBoundingClientRect();
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = immediate || pageChanged || reducedMotion ? 'instant' : 'smooth';
    // Leave space for the sticky player; only move when the next measure needs it.
    const top = document.querySelector('.score-player').offsetHeight + 32;
    if (bounds.top < top || bounds.bottom > innerHeight - 32) {
      window.scrollTo({ top: Math.max(0, window.scrollY + bounds.top - top - 16), behavior });
    }
    if (bounds.left < viewport.left + 12 || bounds.right > viewport.right - 12) {
      preview.scrollTo({ left: Math.max(0, preview.scrollLeft + bounds.left - viewport.left - 16), behavior });
    }
  }
  function cancelFollowScroll() {
    window.scrollTo({ top: window.scrollY, left: window.scrollX, behavior: 'instant' });
    const preview = $('score-preview');
    preview.scrollTo({ left: preview.scrollLeft, behavior: 'instant' });
  }
  function progress({ beat, totalBeats: length }) {
    if (scrubbing || !score) return;
    positionBeat = clamp(beat, 0, length);
    updateTime(positionBeat, length);
    const bar = barAt(positionBeat);
    const changed = bar !== currentBar;
    currentBar = bar;
    if (changed) paintCurrentBar();
    if (player.isPlaying) {
      $('playback-status').textContent = `正在播放${hasUnmetered() ? '正文' : ''} · ${positionLabel(positionBeat)}`;
      if ($('follow-pages').checked && changed) followBar(bar);
    }
  }
  function clearHighlight() {
    activeGroups.forEach((group) => group.classList.remove('is-active'));
    activeGroups = []; activeSources.clear();
  }
  function highlight({ notes }) {
    activeSources = new Set(notes.map(note => note.sourceId));
    paintHighlight();
  }
  function paintHighlight() {
    activeGroups.forEach((group) => group.classList.remove('is-active'));
    activeGroups = [...activeSources].flatMap(id => nodesBySource.get(id) || []);
    activeGroups.forEach((group) => group.classList.add('is-active'));
  }
  function showPage(index) {
    if (!pages.length) return;
    pageIndex = clamp(index || 0, 0, pages.length - 1);
    svgText = ScoreRenderer.render(pages[pageIndex], renderOptions);
    $('score-preview').innerHTML = svgText;
    nodesBySource = new Map();
    $('score-preview').querySelectorAll('[data-source-id]').forEach((group) => {
      const id = group.dataset.sourceId;
      if (!id) return;
      if (!nodesBySource.has(id)) nodesBySource.set(id, []);
      nodesBySource.get(id).push(group);
    });
    makeMeasuresInteractive();
    paintHighlight();
    paintCurrentBar();
    $('page-select').value = String(pageIndex);
    $('previous-page').disabled = pageIndex === 0;
    $('next-page').disabled = pageIndex === pages.length - 1;
    const { bars, unmeteredSection } = pages[pageIndex];
    $('page-range').textContent = unmeteredSection
      ? `${unmeteredSection.title} · 未定节奏间奏页 · 不参与试听`
      : bars.length ? `第 ${bars[0].index + 1}–${bars[bars.length - 1].index + 1} 小节 · 共 ${score.bars.length} 小节` : '';
  }
  function makeMeasuresInteractive() {
    const svg = $('score-preview').querySelector('svg');
    if (!svg) return;
    svg.setAttribute('role', 'group');
    svg.querySelectorAll('[data-measure]').forEach(group => {
      const index = Number(group.dataset.measure);
      group.setAttribute('role', 'button');
      group.setAttribute('tabindex', '0');
      group.setAttribute('aria-label', `第 ${index + 1} 小节，从这里播放`);
      const box = group.getBBox();
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      hit.classList.add('measure-hit');
      for (const [name, value] of Object.entries({ x: box.x - 3, y: box.y - 8, width: box.width + 3, height: box.height + 16, rx: 7 })) hit.setAttribute(name, value);
      group.prepend(hit);
    });
  }
  function syncPlayButton() {
    const playing = player.isPlaying;
    $('score-play').setAttribute('aria-pressed', String(playing));
    $('play-glyph').textContent = playing ? 'Ⅱ' : '▶';
    $('play-label').textContent = starting ? '准备声音…' : playing ? '暂停' : playLabel();
  }
  function playbackState({ state: playback, reason }) {
    if (playback === 'playing') {
      starting = false;
      if ($('follow-pages').checked && !scrubbing) followBar(currentBar, true);
    } else {
      clearHighlight();
      cancelFollowScroll();
      if (!scrubbing) $('playback-status').textContent = reason === 'ended'
        ? `${hasUnmetered() ? '正文' : '全曲'}播放结束 · 点击播放可从头再练。`
        : `已暂停 · ${positionLabel(positionBeat)}`;
      if (reason === 'interrupted' || reason === 'stalled') message('浏览器或音频设备中断了播放。请保持页面在前台，点击“继续播放”接着练习。');
    }
    syncPlayButton();
  }
  function stop(reason = 'pause') {
    playGeneration++; starting = false; player.stop(reason);
    $('score-play').removeAttribute('aria-busy');
    syncPlayButton();
  }
  async function startPlayback(beat = positionBeat) {
    if (!score) return;
    scrubbing = false; resumeAfterScrub = false;
    message('');
    // Stop first so the old clock cannot overwrite a newly chosen position.
    stop('seek');
    positionBeat = clamp(beat, 0, totalBeats());
    currentBar = -1;
    progress({ beat: positionBeat, totalBeats: totalBeats() });
    starting = true;
    const generation = ++playGeneration;
    $('score-play').setAttribute('aria-busy', 'true');
    syncPlayButton();
    try { await player.play(state.compiled?.playbackNotes || score.notes, { bpm: state.bpm, volume: .55, totalBeats: totalBeats(), startBeat: positionBeat }); }
    catch (error) { message(error.message || '无法启动音频，请在新版浏览器中重试。'); }
    finally {
      if (generation === playGeneration) {
        starting = false; $('score-play').removeAttribute('aria-busy');
        syncPlayButton();
      }
    }
  }
  function togglePlayback() {
    if (player.isPlaying || starting) { stop(); return; }
    startPlayback(positionBeat >= totalBeats() ? 0 : positionBeat);
  }
  function beginScrub() {
    if (!score || scrubbing) return;
    resumeAfterScrub = player.isPlaying || starting;
    // Capture the audible position before suppressing further progress events.
    stop('seek');
    scrubbing = true;
  }
  function previewSeek() {
    const beat = Number($('playback-progress').value);
    beginScrub();
    updateTime(beat);
    $('playback-status').textContent = `定位到 · ${positionLabel(beat)}`;
  }
  function commitSeek() {
    if (!scrubbing) return;
    const beat = Number($('playback-progress').value);
    const resume = resumeAfterScrub;
    scrubbing = false; resumeAfterScrub = false;
    progress({ beat, totalBeats: totalBeats() });
    $('playback-status').textContent = `已定位 · ${positionLabel(beat)}`;
    syncPlayButton();
    if ($('follow-pages').checked) followBar(currentBar, true);
    if (resume) startPlayback(beat);
  }
  function playMeasure(index) {
    if (!score) return;
    let performanceBar = index;
    if (score.playbackBarMap) {
      const occurrences = score.playbackBarMap.flatMap((bar, played) => bar === index ? [played] : []);
      const now = Math.floor(positionBeat / score.barBeats);
      performanceBar = occurrences.find(played => played >= now) ?? occurrences[0];
    }
    if (performanceBar !== undefined) startPlayback(performanceBar * score.barBeats);
  }

  function controls() {
    if (!score || !state) return;
    const authored = !!state.document;
    syncPlayButton();
    $('score-performance-note').hidden = !hasUnmetered();
    $('score-performance-note').textContent = hasUnmetered() ? '试听仅含正文；间奏音高已完整保留，时值待定。' : '';
    for (const id of ['score-mode', 'score-meter', 'transpose', 'suggest-transpose']) $(id).disabled = authored;
    $('score-name').value = state.title;
    $('instrument-select').value = state.instrument;
    document.querySelector('.workshop-intro .instrument-tag').textContent = `${state.instrument === '21C' ? '21' : '17'} 音 C 调 · ${authored ? '人工编配' : state.mode === 'polyphonic' ? '多音转谱' : '单音转谱'}`;
    document.querySelector('.workshop-intro .intro-copy').textContent = authored ? '读谱、播放、收藏，保留完整声部与演奏标记。' : '导入一首 MIDI，把旋律与伴奏一起变成完整数字谱。';
    document.querySelector('.guide-footnote').textContent = hasUnmetered() ? '正文按拍点对齐；间奏保留原稿各声部的列对齐，空位不代表休止时长。间奏分组不是小节，暂无确定节奏，不参与试听。' : authored ? '声部按编配保留；同一拍上下堆叠的是和弦，波形向上箭头表示从低到高滑奏。播放按反复标记展开；有原图时可在谱面下方对照。' : '声部行是自动排版，不是左右手指法。节奏按十六分音符网格规整，三连音与复杂指法需人工校对。单音 MIDI 本身没有伴奏，切换模式不会凭空生成和声。';
    $('score-mode').value = state.mode;
    $('mode-description').textContent = authored ? '保留作者声部、和弦、反复和滑音。需要改音符或拍号，可打开“编辑副本”。' : state.mode === 'polyphonic'
      ? '保留所选音轨的和弦、伴奏与独立延音。上下声部对齐的音同时拨响；声部行用于排版，不代表左右手。'
      : '同一拍只保留最高音，重叠长音会截短。适合先练旋律；这不会自动识别主旋律。';
    $('score-bpm').value = state.bpm;
    $('transpose').value = state.transpose;
    const meter = state.meter.join('/');
    const custom = $('score-meter').querySelector('[value="custom"]');
    custom.hidden = ['2/4', '3/4', '4/4', '6/8'].includes(meter);
    custom.textContent = `${meter} · 源文件拍号`;
    $('score-meter').value = custom.hidden ? meter : 'custom';
    $('track-field').hidden = !state.tracks;
    $('source-label').textContent = state.source;
    if (state.sourceUrl) {
      const link = document.createElement('a');
      link.href = state.sourceUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = ' 查看原谱 ↗'; $('source-label').append(link);
    }
    if (state.catalogEntry) {
      const entry = state.catalogEntry;
      const attribution = document.createElement('span');
      attribution.textContent = ` · ${entry.license} · ${entry.attribution}`;
      $('source-label').append(attribution);
      const midi = document.createElement('a');
      midi.href = entry.file; midi.download = `${entry.id}.mid`; midi.textContent = ' 下载原始 MIDI ↧';
      $('source-label').append(midi);
    }
    if (state.tracks) {
      $('example-select').value = '';
      const allTracks = document.createElement('option');
      allTracks.value = '__all__'; allTracks.textContent = `合并全部声部 · ${state.tracks.length} 条音轨`;
      $('track-select').replaceChildren(...(state.tracks.length > 1 ? [allTracks] : []), ...state.tracks.map((track) => {
        const option = document.createElement('option');
        option.value = track.id;
        option.textContent = `${track.name || '未命名音轨'} · ${track.notes.length} 音`;
        return option;
      }));
      $('track-select').value = state.trackId;
    } else $('example-select').value = state.exampleId;
    $('export-json').hidden = !authored;
    $('edit-authored').hidden = !state.authoredEntry;
    if (state.authoredEntry) $('edit-authored').href = `composer.html?score=${encodeURIComponent(state.authoredEntry.id)}`;
    $('original-score').hidden = !state.authoredEntry?.sourceUrl;
    if (state.authoredEntry?.sourceUrl) {
      $('original-image').src = state.authoredEntry.sourceUrl;
      $('original-image').alt = `${state.title}用户提供原谱`;
      $('original-link').href = state.authoredEntry.sourceUrl;
    }
    syncFavorite();
  }
  function favoriteId() { return state?.authoredEntry?.id || state?.catalogEntry?.id || null; }
  function syncFavorite() {
    const id = favoriteId(), button = $('favorite-score');
    button.disabled = !id;
    const active = !!id && favorites.has(id);
    button.setAttribute('aria-pressed', String(active));
    button.textContent = active ? '★ 已收藏' : '☆ 收藏';
    button.title = id ? '收藏保存在当前浏览器，可在曲库查看' : '曲库中的已发布曲谱可以收藏；自制谱请在制谱页保存草稿';
  }
  function warnings() {
    const list = [...new Set([...(state.warnings || []), ...score.warnings.filter((item) => !item.includes('原音高已保留并标注'))])];
    if (score.stats.unplayable) list.unshift(`${score.stats.unplayable} 个音符在当前琴型上无法直接弹奏，已标为橙色。试听保留这些原始音高；请尝试移调或人工改编。`);
    if (!state.document && state.mode === 'polyphonic' && score.stats.maxPolyphony > 2) list.unshift(`最多 ${score.stats.maxPolyphony} 个音同时持续，已全部保留。琴键音域可覆盖不等于双拇指能原样弹奏，密集和弦可能需要滑音或人工改编。`);
    $('score-warnings').replaceChildren();
    if (!list.length) {
      const ok = document.createElement('p'); ok.className = 'all-playable';
      ok.textContent = `✓ ${score.stats.outputNotes} 个音符均在当前琴型的音域内。${state.mode === 'polyphonic' && score.stats.maxPolyphony > 1 ? `最多 ${score.stats.maxPolyphony} 音同时持续。` : ''}`;
      $('score-warnings').append(ok); return;
    }
    const details = document.createElement('details');
    details.open = true;
    const summary = document.createElement('summary'); summary.textContent = `转谱说明 · ${list.length} 项需要留意`;
    const ul = document.createElement('ul');
    list.forEach((item) => { const li = document.createElement('li'); li.textContent = item; ul.append(li); });
    details.append(summary, ul); $('score-warnings').append(details);
  }
  function render() {
    setScoreReady(true);
    renderOptions = { title: state.title, bpm: state.bpm, instrument: state.instrument, meter: state.meter, subtitle: `${state.subtitle} · ${state.mode === 'polyphonic' ? '保留多音' : '单音简化'}` };
    if (state.document) renderOptions.credits = state.document.credits;
    if (state.catalogEntry) {
      const entry = state.catalogEntry;
      const transposition = state.transpose === 0 ? '保留原调' : `整体${state.transpose > 0 ? '升' : '降'} ${Math.abs(state.transpose)} 个半音`;
      renderOptions.credits = [
        entry.attribution,
        `数字谱由拍间转换：起止规整为十六分音符、统一练习速度；${transposition}；${state.mode === 'polyphonic' ? '保留所选音轨的多音' : '最高音单音简化'}。`,
      ];
    }
    pages = ScoreRenderer.paginate(score, renderOptions);
    barToPage = new Array(score.bars.length);
    pages.forEach((page, index) => page.bars.forEach((bar) => { barToPage[bar.index] = index; }));
    $('page-select').replaceChildren(...pages.map((page, index) => {
      const option = document.createElement('option'); option.value = String(index);
      option.textContent = `第 ${index + 1} / ${pages.length} 页${page.unmeteredSection ? ` · ${page.unmeteredSection.title}` : ''}`; return option;
    }));
    showPage(0);
    const groups = (score.unmeteredSections || []).reduce((total, section) => total + section.groups.length, 0);
    $('score-summary').textContent = hasUnmetered() ? `正文 ${score.stats.outputNotes} 个音符 · 间奏 ${score.stats.unmeteredNotes} 个音符` : `${score.stats.outputNotes} 个音符 · ${score.bars.length} 小节`;
    $('full-score-info').textContent = hasUnmetered() ? `完整数字谱 · 正文 ${score.bars.length} 小节 + 间奏 ${groups} 组 / ${pages.length} 页 · 试听正文，导出包含全部页` : state.document ? `完整编配 · 谱面 ${score.bars.length} 小节 / ${pages.length} 页 · 含反复播放 ${score.playbackBarMap.length} 小节` : `已转完源文件全时长 · ${score.bars.length} 小节 / ${pages.length} 页 · 导出包含所有页`;
    $('playback-status').textContent = hasUnmetered() ? '准备好，试听正文从第一小节开始；间奏不参与试听。' : '准备好，从第一小节开始。';
    controls(); warnings(); progress({ beat: 0, totalBeats: state.compiled?.totalBeats || score.sourceTotalBeats });
    document.title = `${state.title} · 卡林巴数字谱 · 拍间`;
    $('score-load-actions').hidden = true;
    $('score-preview').removeAttribute('aria-busy');
    $('score-name').placeholder = '给这页谱起个名字';
    pendingScoreLoad = null;
  }
  function apply(next) {
    const candidate = { ...state, ...next };
    try {
      let result;
      if (candidate.document) {
        candidate.compiled = ScoreDocument.compile({ ...candidate.document, title: candidate.title, bpm: candidate.bpm, instrument: candidate.instrument });
        candidate.document = candidate.compiled.document;
        candidate.notes = candidate.compiled.score.notes;
        result = candidate.compiled.score;
      } else {
        candidate.compiled = null;
        result = KalimbaScore.buildScore(candidate.notes, { instrument: candidate.instrument, transpose: candidate.transpose, meter: candidate.meter, grid: .25, totalBeats: candidate.totalBeats, mode: candidate.mode });
      }
      scrubbing = false; resumeAfterScrub = false;
      stop(); positionBeat = 0; currentBar = -1;
      state = candidate; score = result; scoreRevision++; render(); message(''); return true;
    } catch (error) {
      if (state) controls();
      message(error.message || '无法转换这段旋律，请尝试其他音轨。');
      return false;
    }
  }
  function example(id) {
    const data = ScoreExamples.find((item) => item.id === id);
    if (!data) return;
    importGeneration++;
    $('upload-zone').removeAttribute('aria-busy');
    $('score-preview').removeAttribute('aria-busy');
    apply({ document: null, authoredEntry: null, title: data.title, subtitle: data.subtitle, notes: data.notes, source: data.source, sourceUrl: data.sourceUrl || null, totalBeats: data.notes.reduce((end, note) => Math.max(end, note.start + note.duration), 0), bpm: data.bpm, meter: data.meter, transpose: 0, instrument: state?.instrument || '17C', mode: data.mode || state?.mode || 'polyphonic', tracks: null, trackId: null, exampleId: data.id, catalogEntry: null, warnings: [] });
  }
  function importMidiData(data, name, catalogEntry = null) {
    const midi = KalimbaMidi.parseMidi(data);
    const tracks = midi.tracks.filter((track) => !track.isPercussion && track.channel !== 9 && track.notes.length);
    if (!tracks.length) throw new Error('这个 MIDI 只有打击乐或没有完整的旋律音符。请换一个包含主旋律的 MIDI。');
    const chosen = tracks.find((track) => /melody|lead|vocal|主旋律|旋律/i.test(track.name)) || tracks[0];
    const mode = catalogEntry ? 'polyphonic' : state?.mode || 'polyphonic';
    const merge = mode === 'polyphonic' && tracks.length > 1;
    const bpm = clamp(Math.round(midi.tempo), 30, 240);
    const importWarnings = [...midi.warnings];
    if (Math.round(midi.tempo) !== bpm) importWarnings.push(`原速度 ${Math.round(midi.tempo)} BPM 超出试听范围，已设为 ${bpm} BPM；谱面音符时值不变。`);
    const title = shorten(catalogEntry?.title || name.replace(/\.midi?$/i, ''), 80) || midi.title || '导入曲谱';
    const source = catalogEntry
      ? `内置曲库 · ${catalogEntry.title} · ${catalogEntry.composer} · ${catalogEntry.scope || '来源发布的完整 MIDI 文件'}`
      : `已导入完整文件：${name} · ${tracks.length} 条可选音轨`;
    if (apply({ document: null, authoredEntry: null, title, subtitle: '源文件全时长 · 卡林巴数字谱', notes: merge ? tracks.flatMap(track => track.notes) : chosen.notes, source, sourceUrl: catalogEntry?.sourceUrl || null, totalBeats: midi.totalBeats, bpm, meter: midi.timeSignature, transpose: 0, instrument: state?.instrument || '17C', mode, tracks, trackId: merge ? '__all__' : chosen.id, exampleId: null, catalogEntry, warnings: importWarnings })) {
      message(`已转完「${title}」的整个文件，共 ${score.bars.length} 小节、${pages.length} 页。${merge ? '已合并全部非鼓声音轨，可以切换单条音轨练习。' : '可以试听核对，再导出全谱。'}`, 'success');
    } else throw new Error($('workshop-message').textContent || '这首曲谱转换失败，请重试。');
  }
  async function importFile(file) {
    if (!file) return;
    const generation = ++importGeneration;
    $('upload-zone').removeAttribute('aria-busy');
    $('score-preview').removeAttribute('aria-busy');
    if (file.size > 20 * 1024 * 1024) { message('文件超过 20 MB，未生成部分乐谱。可以导出完整旋律音轨、减少无关伴奏后重新导入。'); return; }
    if (/\.json$/i.test(file.name)) {
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('JSON 曲谱超过 2 MB，请检查文件。');
        const data = JSON.parse(await file.text());
        if (generation === importGeneration) openDocument(data);
      } catch (error) { if (generation === importGeneration) message(error.message || '无法读取 JSON 曲谱。'); }
      return;
    }
    if (!/\.midi?$/i.test(file.name)) { message('请选择 MIDI 或拍间制谱导出的 JSON 文件。'); return; }
    $('upload-zone').setAttribute('aria-busy', 'true');
    message('正在读取 MIDI…', 'success');
    try {
      const data = await file.arrayBuffer();
      if (generation !== importGeneration) return;
      importMidiData(data, file.name);
    } catch (error) { if (generation === importGeneration) message(error.message || '读取失败，请检查 MIDI 文件是否完整。'); }
    finally { if (generation === importGeneration) $('upload-zone').removeAttribute('aria-busy'); }
  }
  function openDocument(data, entry = null) {
    const compiled = ScoreDocument.compile(data), doc = compiled.document;
    if (apply({ document: doc, authoredEntry: entry, title: doc.title, bpm: doc.bpm, meter: doc.meter, instrument: doc.instrument, mode: 'polyphonic', transpose: 0, notes: compiled.score.notes, totalBeats: compiled.score.totalBeats, tracks: null, trackId: null, exampleId: null, catalogEntry: null, subtitle: '人工编配 · 双声部与技法按谱保留', source: entry?.attribution || (entry ? `内置曲库 · ${doc.title}` : '导入的拍间制谱文件'), sourceUrl: entry?.sourceUrl || null, warnings: doc.description ? [doc.description] : [] })) message(hasUnmetered() ? '已载入正文与全部间奏数字谱；试听正文，间奏暂不参与试听。' : '已载入完整编配，试听会执行反复与向上滑奏。', 'success');
    else throw new Error($('workshop-message').textContent || '这首曲谱转换失败，请重试。');
  }
  async function openPublishedScore(id) {
    const generation = ++importGeneration;
    beginScoreLoad('score', id);
    const entry = globalThis.CuratedScores?.entries?.find(e => e.id === id);
    if (!entry || !/^scores\/[a-z0-9-]+\.json$/.test(entry.file) || (entry.sourceUrl && !/^scores\/[a-z0-9-]+\.(jpg|png|webp)$/.test(entry.sourceUrl))) { failScoreLoad(new Error('没有找到这份已发布曲谱，请返回曲库选择。')); return; }
    namePendingScore(entry.title);
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 20000);
    $('score-preview').setAttribute('aria-busy', 'true');
    try {
      let data;
      const documents = globalThis.CuratedScores?.documents;
      if (documents && Object.prototype.hasOwnProperty.call(documents, id)) data = documents[id];
      else {
        const response = await fetch(entry.file, { signal: controller.signal });
        if (!response.ok) throw new Error('曲谱暂时无法加载，请刷新重试。');
        data = await response.json();
      }
      if (generation === importGeneration) openDocument(data, entry);
    } catch (error) { if (generation === importGeneration) failScoreLoad(error); }
    finally { clearTimeout(timeout); if (generation === importGeneration) $('score-preview').removeAttribute('aria-busy'); }
  }
  async function openCatalogPiece(id) {
    const generation = ++importGeneration;
    beginScoreLoad('piece', id);
    if (!/^mutopia-\d+$/.test(id)) { failScoreLoad(new Error('曲目链接无效，请从内置曲库重新选择。')); return; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      if (!globalThis.ScoreCatalog) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          const abort = () => { script.remove(); reject(new Error('曲库加载超时，请刷新页面重试。')); };
          script.src = 'catalog/index.js';
          script.onload = () => { controller.signal.removeEventListener('abort', abort); resolve(); };
          script.onerror = () => { controller.signal.removeEventListener('abort', abort); script.remove(); reject(new Error('无法加载曲目索引，请检查网络后重试。')); };
          controller.signal.addEventListener('abort', abort, { once: true });
          document.head.append(script);
        });
      }
      if (generation !== importGeneration) return;
      const entry = globalThis.ScoreCatalog?.entries?.find(item => item.id === id);
      if (!entry || entry.file !== `catalog/midi/${id}.mid`) throw new Error('曲库中没有这首曲子，请返回内置曲库重新选择。');
      namePendingScore(entry.title);
      if (location.protocol === 'file:') throw new Error('本地直接打开网页时，请在曲库下载这首 MIDI 后用“导入完整 MIDI 文件”打开，或通过本地网页服务器访问。在线网站可直接载入。');
      const response = await fetch(entry.file, { signal: controller.signal });
      if (!response.ok) throw new Error('这首 MIDI 暂时无法载入，请刷新重试或从曲库下载原文件。');
      const data = await response.arrayBuffer();
      if (generation !== importGeneration) return;
      if (data.byteLength !== entry.bytes) throw new Error('下载的 MIDI 文件大小不完整，未生成部分曲谱，请刷新重试。');
      importMidiData(data, `${id}.mid`, entry);
    } catch (error) {
      if (generation === importGeneration) failScoreLoad(error);
    } finally {
      clearTimeout(timeout);
      if (generation === importGeneration) $('score-preview').removeAttribute('aria-busy');
    }
  }
  function filename(extension) {
    return `${shorten(state.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim(), 70) || '卡林巴曲谱'}-数字谱.${extension}`;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function pngBytes(content) {
    const url = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      // Each complete page is rendered separately, avoiding canvas clipping.
      const scale = Math.min(2, 16000 / image.height, Math.sqrt(24000000 / (image.width * image.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('当前浏览器无法生成图片。');
      ctx.fillStyle = '#fffefb'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('当前页图片生成失败，请改为导出全谱 SVG。');
      return new Uint8Array(await blob.arrayBuffer());
    } finally { URL.revokeObjectURL(url); }
  }
  async function exportAll(format) {
    if (!score) return;
    const buttons = [$('export-png'), $('export-svg')];
    buttons.forEach((button) => { button.disabled = true; });
    const button = format === 'png' ? buttons[0] : buttons[1];
    const originalLabel = button.textContent;
    const exportPages = [...pages];
    const revision = scoreRevision;
    const options = { ...renderOptions };
    const baseName = filename(format);
    const archiveName = filename('zip').replace(/\.zip$/, `-全部${exportPages.length}页.zip`);
    try {
      const files = [];
      const encoder = new TextEncoder();
      let archiveBytes = 22;
      for (let i = 0; i < exportPages.length; i++) {
        button.textContent = `导出 ${i + 1}/${exportPages.length} 页`;
        const content = ScoreRenderer.render(exportPages[i], options);
        const data = format === 'png' ? await pngBytes(content) : encoder.encode(content);
        const name = exportPages.length === 1 ? baseName : baseName.replace(new RegExp(`\\.${format}$`), `-第${String(i + 1).padStart(Math.max(3, String(exportPages.length).length), '0')}页.${format}`);
        archiveBytes += data.byteLength + 94 + encoder.encode(name).byteLength * 2;
        if (archiveBytes > 256 * 1024 * 1024) throw new Error('全谱导出超过 256 MB，已停止整份导出且未下载部分页。请使用全谱 SVG 或打印 / PDF。');
        files.push({ name, data });
        // Yield between pages so long-score exports keep the UI responsive.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (files.length === 1) download(new Blob([files[0].data], { type: format === 'png' ? 'image/png' : 'image/svg+xml;charset=utf-8' }), baseName);
      else download(ScoreExport.zip(files), archiveName);
      if (revision === scoreRevision) message(`全谱已导出，共 ${files.length} 页${files.length > 1 ? '，ZIP 内包含每一页' : ''}。`, 'success');
    } catch (error) { if (revision === scoreRevision) message(error?.message || '全谱导出失败；未下载不完整的谱图，请重试或使用打印 / PDF。'); }
    finally { buttons.forEach((item) => { item.disabled = false; }); button.textContent = originalLabel; }
  }
  function printScore() {
    if (!score) return;
    stop();
    $('print-scores').replaceChildren(...pages.map((pageScore) => {
      const page = document.createElement('div'); page.className = 'print-page';
      page.innerHTML = ScoreRenderer.render(pageScore, renderOptions);
      return page;
    }));
    window.print();
  }

  $('example-select').addEventListener('change', (event) => example(event.target.value));
  $('retry-score-load').addEventListener('click', () => {
    if (!pendingScoreLoad) return;
    const { kind, id } = pendingScoreLoad;
    if (kind === 'piece') openCatalogPiece(id);
    else openPublishedScore(id);
  });
  $('midi-file').addEventListener('change', (event) => { importFile(event.target.files[0]); event.target.value = ''; });
  $('upload-zone').addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('dragging'); });
  $('upload-zone').addEventListener('dragleave', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('dragging'); });
  $('upload-zone').addEventListener('drop', (event) => { event.preventDefault(); event.currentTarget.classList.remove('dragging'); importFile(event.dataTransfer.files[0]); });
  window.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  window.addEventListener('drop', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  $('track-select').addEventListener('change', (event) => {
    if (event.target.value === '__all__' && state?.tracks) { apply({ notes: state.tracks.flatMap(track => track.notes), trackId: '__all__' }); return; }
    const track = state?.tracks?.find((item) => item.id === event.target.value);
    if (track) apply({ notes: track.notes, trackId: track.id });
  });
  $('score-mode').addEventListener('change', (event) => apply({ mode: event.target.value }));
  $('instrument-select').addEventListener('change', (event) => apply({ instrument: event.target.value }));
  $('score-meter').addEventListener('change', (event) => { if (event.target.value !== 'custom') apply({ meter: event.target.value.split('/').map(Number) }); });
  $('transpose').addEventListener('change', (event) => {
    const raw = event.target.value;
    if (!raw.trim() || !Number.isFinite(Number(raw))) { controls(); return; }
    apply({ transpose: clamp(Math.round(Number(raw)), -24, 24) });
  });
  $('suggest-transpose').addEventListener('click', () => {
    if (!score) return;
    try {
      const suggestion = KalimbaScore.suggestTranspose(state.notes, state.instrument);
      if (apply({ transpose: suggestion.transpose })) message(`已整体${suggestion.transpose === 0 ? '保留原调' : `${suggestion.transpose > 0 ? '升' : '降'} ${Math.abs(suggestion.transpose)} 个半音`}。谱中 ${score.stats.outputNotes - score.stats.unplayable} / ${score.stats.outputNotes} 个音在琴键音域内。`, 'success');
    } catch (error) { message(error.message); }
  });
  $('score-bpm').addEventListener('change', (event) => {
    const raw = event.target.value;
    if (!raw.trim() || !Number.isFinite(Number(raw))) { controls(); return; }
    apply({ bpm: clamp(Math.round(Number(raw)), 30, 240) });
  });
  $('score-name').addEventListener('change', (event) => apply({ title: shorten(event.target.value.trim(), 80) || '未命名曲谱' }));
  $('score-play').addEventListener('click', togglePlayback);
  $('score-restart').addEventListener('click', () => startPlayback(0));
  $('playback-progress').addEventListener('pointerdown', beginScrub);
  $('playback-progress').addEventListener('input', previewSeek);
  $('playback-progress').addEventListener('change', commitSeek);
  $('playback-progress').addEventListener('pointerup', commitSeek);
  $('playback-progress').addEventListener('pointercancel', commitSeek);
  $('playback-progress').addEventListener('blur', commitSeek);
  $('follow-pages').addEventListener('change', () => {
    if ($('follow-pages').checked && player.isPlaying) followBar(currentBar, true);
    else if (!$('follow-pages').checked) cancelFollowScroll();
  });
  $('score-preview').addEventListener('click', event => {
    const measure = event.target.closest('[data-measure]');
    if (measure) playMeasure(Number(measure.dataset.measure));
  });
  $('score-preview').addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const measure = event.target.closest('[data-measure]');
    if (measure) { event.preventDefault(); playMeasure(Number(measure.dataset.measure)); }
  });
  $('previous-page').addEventListener('click', () => showPage(pageIndex - 1));
  $('next-page').addEventListener('click', () => showPage(pageIndex + 1));
  $('page-select').addEventListener('change', (event) => showPage(Number(event.target.value)));
  $('export-svg').addEventListener('click', () => exportAll('svg'));
  $('export-png').addEventListener('click', () => exportAll('png'));
  $('print-score').addEventListener('click', printScore);
  $('export-json').addEventListener('click', () => { if (score && state?.document) download(new Blob([JSON.stringify(state.document, null, 2)], { type: 'application/json' }), filename('json')); });
  $('favorite-score').addEventListener('click', () => {
    const id = favoriteId(); if (!id) return;
    const result = favorites.toggle(id);
    syncFavorite();
    message(result.ok ? (result.favorite ? '已收藏，可在“找曲谱 → 只看收藏”打开。收藏保存在当前浏览器。' : '已取消收藏。') : result.error, result.ok ? 'success' : 'error');
  });
  favorites.subscribe(syncFavorite);
  window.addEventListener('pagehide', stop);
  const query = new URLSearchParams(location.search);
  const initialExample = query.get('example');
  if (query.has('score')) openPublishedScore(query.get('score'));
  else if (query.has('piece')) openCatalogPiece(query.get('piece'));
  else example(ScoreExamples.some((item) => item.id === initialExample) ? initialExample : 'ode-duet');
})();
