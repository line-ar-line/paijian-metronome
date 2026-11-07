(() => {
  'use strict';

  const PAGE_SIZE = 24;
  const $ = (id) => document.getElementById(id);
  const collator = new Intl.Collator(['zh-CN', 'en'], { sensitivity: 'base', numeric: true });
  const number = (value) => value.toLocaleString('zh-CN');
  const normalized = (value) => String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  const finiteCount = (value) => Number.isInteger(value) && value >= 0 ? value : null;
  const composerAliases = {
    bach: '巴赫 巴哈', beethoven: '贝多芬', mozart: '莫扎特', chopin: '肖邦',
    schubert: '舒伯特', schumann: '舒曼', handel: '亨德尔 韩德尔',
    tchaikovsky: '柴可夫斯基', pachelbel: '帕赫贝尔', debussy: '德彪西',
    satie: '萨蒂', vivaldi: '维瓦尔第', brahms: '勃拉姆斯', haydn: '海顿',
    mendelssohn: '门德尔松', grieg: '格里格', rachmaninoff: '拉赫玛尼诺夫',
  };
  const parameters = new URLSearchParams(location.search);
  const favorites = window.ScoreUserLibrary;
  const state = {
    query: (parameters.get('q') || '').slice(0, 160),
    composer: parameters.get('composer') || '',
    instrument: parameters.get('instrument') || '',
    texture: ['single', 'polyphonic'].includes(parameters.get('texture')) ? parameters.get('texture') : '',
    sort: ['default', 'title', 'composer', 'coverage'].includes(parameters.get('sort')) ? parameters.get('sort') : 'default',
    page: Math.max(1, Number.parseInt(parameters.get('page'), 10) || 1),
    favorites: parameters.get('favorites') === '1',
  };
  let entries = [];
  let matched = [];

  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }

  function publicUrl(value) {
    try {
      const url = new URL(String(value));
      return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch { return null; }
  }

  function sourceUrl(value) {
    if (typeof value === 'string' && /^scores\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i.test(value)) return value;
    return publicUrl(value);
  }

  function favoriteNotice(value, isError = false) {
    $('catalog-favorite-message').textContent = value;
    $('catalog-favorite-message').hidden = !value;
    $('catalog-favorite-message').dataset.kind = isError ? 'error' : 'success';
  }

  function prepare(entry, index) {
    if (!entry || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(String(entry.id || ''))) throw new Error('目录中有无法识别的曲目编号。');
    const title = String(entry.title || '未命名来源文件');
    const composer = String(entry.composer || '作曲家未标注');
    const instrument = String(entry.instrument || '编制未标注');
    const format = ['paijian-score', 'score-images'].includes(entry.format) ? entry.format : 'midi';
    const images = format === 'score-images';
    const notes = images ? null : finiteCount(entry.notes);
    const playable = images ? null : finiteCount(entry.playable17Count);
    const ratio = notes > 0 && playable !== null && playable <= notes ? playable / notes : null;
    const composerText = normalized(composer);
    const aliases = Object.entries(composerAliases).filter(([key]) => composerText.includes(key)).map(([, value]) => value).join(' ');
    const file = String(entry.file || '');
    const maxPolyphony = images ? null : finiteCount(entry.maxPolyphony);
    return {
      ...entry, index, title, composer, instrument, notes, playable, ratio, format,
      bars: images ? null : finiteCount(entry.bars),
      printedBars: finiteCount(entry.printedBars),
      maxPolyphony,
      texture: images ? (['single', 'polyphonic'].includes(entry.texture) ? entry.texture : null) : maxPolyphony > 1 ? 'polyphonic' : maxPolyphony === 1 ? 'single' : null,
      sourcePages: Array.isArray(entry.sourcePages) ? entry.sourcePages.filter(page => page && typeof page.file === 'string' && /^scores\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp)$/i.test(page.file)) : [],
      sourceArchive: typeof entry.sourceArchive === 'string' && /^scores\/[A-Za-z0-9_-]+\.zip$/.test(entry.sourceArchive) ? entry.sourceArchive : null,
      searchText: normalized([title, composer, aliases, instrument, entry.style || '', entry.id].join(' ')),
      file: !images && (format === 'paijian-score' ? /^scores\/[A-Za-z0-9_-]+\.json$/ : /^catalog\/midi\/[A-Za-z0-9_-]+\.midi?$/).test(file) ? file : null,
      sourceUrl: sourceUrl(entry.sourceUrl),
      licenseUrl: publicUrl(entry.licenseUrl),
    };
  }

  function addDetail(list, label, value, className) {
    const row = element('div');
    row.append(element('dt', '', label), element('dd', className, value));
    list.append(row);
  }

  function coverageLabel(entry) {
    if (entry.ratio === null) return '未统计';
    if (entry.ratio === 1) return '100%';
    if (entry.ratio > 0 && entry.ratio < 0.001) return '<0.1%';
    return `${Math.min(99.9, Math.round(entry.ratio * 1000) / 10)}%`;
  }

  function pieceCard(entry) {
    const card = element('article', 'catalog-piece');
    card.dataset.pieceId = entry.id;
    const heading = element('div', 'catalog-piece-top');
    const images = entry.format === 'score-images';
    const polyphonic = entry.texture === 'polyphonic';
    heading.append(element('span', 'catalog-piece-number', `NO. ${String(entry.index + 1).padStart(4, '0')}`));
    const texture = images ? (polyphonic ? '多音原谱' : entry.texture === 'single' ? '单音原谱' : '原图曲谱') : entry.maxPolyphony === null || entry.maxPolyphony === 0 ? '多音情况未统计' : polyphonic ? `最多 ${entry.maxPolyphony} 音同时持续` : '单音旋律';
    heading.append(element('span', `catalog-piece-badge${polyphonic ? ' polyphonic' : ''}`, texture));
    const title = element('h3');
    const titleLink = element('a', 'catalog-piece-title', entry.title);
    titleLink.href = images ? `./original.html?score=${encodeURIComponent(entry.id)}` : `./score.html?${entry.format === 'paijian-score' ? 'score' : 'piece'}=${encodeURIComponent(entry.id)}`;
    title.append(titleLink);
    const details = element('dl', 'catalog-piece-details');
    addDetail(details, '原编制', entry.instrument);
    const extent = images
      ? `${number(entry.sourcePages.length)} 张原图${entry.printedBars === null ? '' : ` · ${number(entry.printedBars)} 小节正文`}`
      : `${entry.bars === null ? '小节数未统计' : `${number(entry.bars)} 小节`} · ${entry.notes === null ? '音符数未统计' : `${number(entry.notes)} 音符`}`;
    addDetail(details, '源文件', extent, 'catalog-range');
    if (entry.style) addDetail(details, '风格', String(entry.style));
    if (entry.scope) addDetail(details, '范围', String(entry.scope));

    const coverage = element('div', 'catalog-coverage');
    coverage.dataset.level = entry.ratio !== null && entry.ratio < 0.8 ? 'low' : 'normal';
    const coverageTop = element('div', 'catalog-coverage-top');
    coverageTop.append(element('span', '', 'C17 原调覆盖'), element('span', 'catalog-coverage-value', coverageLabel(entry)));
    coverage.title = entry.ratio === null ? '此文件尚无原调音域统计。' : `${number(entry.playable)} / ${number(entry.notes)} 个源音符位于标准 17 音 C 调琴键内；这不表示和弦与指法都可直接弹奏。`;
    const track = element('div', 'catalog-coverage-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = element('span', 'catalog-coverage-fill');
    fill.style.width = `${(entry.ratio || 0) * 100}%`;
    track.append(fill); coverage.append(coverageTop, track);

    const actions = element('div', 'catalog-piece-actions');
    const open = element('a', 'catalog-open', images ? '打开原谱 →' : '打开数字谱 →');
    open.href = titleLink.href;
    open.setAttribute('aria-label', `打开《${entry.title}》${images ? '原谱' : '数字谱'}`);
    actions.append(open);
    const favorite = element('button', 'catalog-favorite', favorites?.has(entry.id) ? '★' : '☆');
    favorite.type = 'button';
    favorite.dataset.favoriteId = entry.id;
    favorite.setAttribute('aria-pressed', String(Boolean(favorites?.has(entry.id))));
    favorite.setAttribute('aria-label', `${favorites?.has(entry.id) ? '取消收藏' : '收藏'}《${entry.title}》`);
    favorite.title = favorites?.has(entry.id) ? '取消收藏' : '收藏曲谱';
    favorite.disabled = !favorites;
    actions.append(favorite);
    const downloadFile = images ? entry.sourceArchive : entry.file;
    if (downloadFile) {
      const kind = images ? '原图 ZIP' : entry.format === 'paijian-score' ? 'JSON' : 'MIDI';
      const midi = element('a', 'catalog-midi', `${kind} ↓`);
      midi.href = downloadFile;
      midi.download = downloadFile.slice(downloadFile.lastIndexOf('/') + 1);
      midi.setAttribute('aria-label', `下载《${entry.title}》${images ? '全部原图 ZIP' : kind === 'JSON' ? '可编辑曲谱 JSON' : '完整来源 MIDI'}`);
      if (Number.isFinite(entry.bytes)) midi.title = `下载源文件 · ${Math.max(1, Math.round(entry.bytes / 1024))} KB`;
      actions.append(midi);
    }
    const source = element('div', 'catalog-piece-source');
    if (images || entry.sourceUrl) {
      const original = element('a', '', images ? '查看全部原图 ↗' : entry.format === 'paijian-score' ? '查看原图 ↗' : '来源 / 原谱 ↗');
      original.href = images ? titleLink.href : entry.sourceUrl; original.target = '_blank'; original.rel = 'noopener noreferrer';
      if (entry.attribution) original.title = String(entry.attribution);
      source.append(original);
    }
    if (entry.license) {
      const license = element(entry.licenseUrl ? 'a' : 'span', '', String(entry.license));
      if (entry.licenseUrl) { license.href = entry.licenseUrl; license.target = '_blank'; license.rel = 'noopener noreferrer'; }
      source.append(license);
    }
    card.append(heading, title, element('p', 'catalog-piece-composer', entry.composer), details);
    if (!images) card.append(coverage);
    card.append(actions);
    const attribution = entry.maintainer || entry.attribution;
    if (attribution) card.append(element('p', 'catalog-piece-attribution', `${entry.maintainer ? '编谱署名' : '署名'}：${String(attribution)}`));
    card.append(source);
    return card;
  }

  function fillFilter(id, values, firstLabel) {
    const select = $(id);
    const first = element('option', '', firstLabel); first.value = '';
    const unique = [...new Set(values)].sort(collator.compare);
    select.replaceChildren(first, ...unique.map((value) => {
      const option = element('option', '', value); option.value = value; return option;
    }));
    return new Set(unique);
  }

  function remember() {
    try {
      const url = new URL(location.href);
      for (const key of ['q', 'composer', 'instrument', 'texture', 'sort', 'page', 'favorites']) url.searchParams.delete(key);
      if (state.query) url.searchParams.set('q', state.query);
      for (const key of ['composer', 'instrument', 'texture']) if (state[key]) url.searchParams.set(key, state[key]);
      if (state.sort !== 'default') url.searchParams.set('sort', state.sort);
      if (state.page > 1) url.searchParams.set('page', state.page);
      if (state.favorites) url.searchParams.set('favorites', '1');
      history.replaceState(null, '', url);
    } catch { /* Some local-file browsers disallow URL state updates. */ }
  }

  function render() {
    const terms = normalized(state.query).split(' ').filter(Boolean);
    matched = entries.filter((entry) => (
      terms.every(term => entry.searchText.includes(term)) &&
      (!state.composer || entry.composer === state.composer) &&
      (!state.instrument || entry.instrument === state.instrument) &&
      (!state.texture || entry.texture === state.texture) &&
      (!state.favorites || favorites?.has(entry.id))
    ));
    if (state.sort === 'title') matched.sort((a, b) => collator.compare(a.title, b.title) || a.index - b.index);
    else if (state.sort === 'composer') matched.sort((a, b) => collator.compare(a.composer, b.composer) || collator.compare(a.title, b.title) || a.index - b.index);
    else if (state.sort === 'coverage') matched.sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1) || a.index - b.index);
    const totalPages = Math.ceil(matched.length / PAGE_SIZE);
    state.page = Math.min(Math.max(1, state.page), Math.max(1, totalPages));
    const from = (state.page - 1) * PAGE_SIZE;
    const visible = matched.slice(from, from + PAGE_SIZE);
    const fragment = document.createDocumentFragment();
    visible.forEach(entry => fragment.append(pieceCard(entry)));
    $('catalog-grid').replaceChildren(fragment);
    const filtered = Boolean(state.query.trim() || state.composer || state.instrument || state.texture || state.favorites);
    const favoriteCount = entries.filter(entry => favorites?.has(entry.id)).length;
    $('catalog-favorite-count').textContent = number(favoriteCount);
    $('catalog-favorites-only').setAttribute('aria-pressed', String(state.favorites));
    $('catalog-results-title').textContent = state.favorites ? '我的收藏' : filtered ? '筛选结果' : '所有曲目';
    $('catalog-result-count').textContent = matched.length ? `${number(matched.length)} 份曲谱 · 正在显示第 ${number(from + 1)}–${number(from + visible.length)} 份` : '0 份匹配曲谱';
    $('catalog-reset').hidden = !filtered && state.sort === 'default';
    $('catalog-empty').hidden = matched.length > 0;
    $('catalog-empty-title').textContent = state.favorites ? (favoriteCount ? '收藏中没有匹配的曲谱' : '还没有收藏曲谱') : '没有找到匹配的曲目';
    $('catalog-empty-copy').textContent = state.favorites && !favoriteCount ? '点击曲谱上的星标，把想练的曲子留在这里。' : '试试更短的曲名、英文作曲家姓名，或减少筛选条件。';
    $('catalog-empty-reset').textContent = state.favorites && !favoriteCount ? '去找曲谱' : '查看全部曲目';
    $('catalog-empty-reset').hidden = false;
    $('catalog-pagination').hidden = totalPages <= 1;
    $('catalog-previous').disabled = state.page <= 1;
    $('catalog-next').disabled = state.page >= totalPages;
    $('catalog-page-select').replaceChildren(...Array.from({ length: totalPages }, (_, index) => {
      const option = element('option', '', `第 ${index + 1} 页`); option.value = index + 1; return option;
    }));
    $('catalog-page-select').value = String(state.page);
    $('catalog-page-total').textContent = `共 ${totalPages} 页`;
    document.querySelector('.catalog-results').setAttribute('aria-busy', 'false');
    remember();
  }

  function reset() {
    Object.assign(state, { query: '', composer: '', instrument: '', texture: '', sort: 'default', page: 1, favorites: false });
    $('catalog-query').value = '';
    $('catalog-composer').value = ''; $('catalog-instrument').value = ''; $('catalog-texture').value = ''; $('catalog-sort').value = 'default';
    render();
  }

  function changePage(value) {
    state.page = value; render();
    document.querySelector('.catalog-results').scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  try {
    const catalog = window.ScoreCatalog;
    if (!catalog || !Array.isArray(catalog.entries) || !catalog.entries.length) throw new Error('目录文件没有成功加载。');
    const curated = Array.isArray(window.CuratedScores?.entries) ? window.CuratedScores.entries : [];
    entries = [...curated, ...catalog.entries].map(prepare);
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('目录存在重复的曲目编号。');
    $('catalog-total').textContent = number(entries.length);
    const composers = fillFilter('catalog-composer', entries.map(entry => entry.composer), '全部作曲家');
    const instruments = fillFilter('catalog-instrument', entries.map(entry => entry.instrument), '全部编制');
    if (!composers.has(state.composer)) state.composer = '';
    if (!instruments.has(state.instrument)) state.instrument = '';
    $('catalog-query').value = state.query;
    $('catalog-composer').value = state.composer;
    $('catalog-instrument').value = state.instrument;
    $('catalog-texture').value = state.texture;
    $('catalog-sort').value = state.sort;
    const date = typeof catalog.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(catalog.updatedAt) ? ` · 更新 ${catalog.updatedAt.slice(0, 10)}` : '';
    $('catalog-provenance').textContent = `目录收录 ${number(entries.length)} 份曲谱${curated.length ? `，含 ${number(curated.length)} 份原图整理谱` : ''} · MIDI 来源 ${String(catalog.source || '开放乐谱库')}${date}。作品范围、署名与许可请查看具体条目。`;
    $('catalog-filters').addEventListener('submit', (event) => { event.preventDefault(); state.query = $('catalog-query').value; state.page = 1; render(); });
    $('catalog-query').addEventListener('input', (event) => { if (!event.isComposing) { state.query = event.target.value; state.page = 1; render(); } });
    $('catalog-query').addEventListener('compositionend', (event) => { state.query = event.target.value; state.page = 1; render(); });
    for (const [id, key] of [['catalog-composer', 'composer'], ['catalog-instrument', 'instrument'], ['catalog-texture', 'texture'], ['catalog-sort', 'sort']]) {
      $(id).addEventListener('change', (event) => { state[key] = event.target.value; state.page = 1; render(); });
    }
    $('catalog-reset').addEventListener('click', reset);
    $('catalog-empty-reset').addEventListener('click', reset);
    $('catalog-previous').addEventListener('click', () => changePage(state.page - 1));
    $('catalog-next').addEventListener('click', () => changePage(state.page + 1));
    $('catalog-page-select').addEventListener('change', event => changePage(Number(event.target.value)));
    $('catalog-favorites-only').addEventListener('click', () => { state.favorites = !state.favorites; state.page = 1; render(); });
    $('catalog-grid').addEventListener('click', event => {
      const button = event.target.closest('button[data-favorite-id]');
      if (!button || !favorites) return;
      const entry = entries.find(item => item.id === button.dataset.favoriteId);
      const result = favorites.toggle(entry.id);
      favoriteNotice(result.ok ? `${result.favorite ? '已收藏' : '已取消收藏'}《${entry.title}》` : result.error, !result.ok);
    });
    favorites?.subscribe(snapshot => {
      const active = document.activeElement;
      const focusedId = active?.dataset.favoriteId;
      const focusedIndex = focusedId ? [...$('catalog-grid').querySelectorAll('button[data-favorite-id]')].indexOf(active) : -1;
      favoriteNotice(snapshot.error, Boolean(snapshot.error));
      render();
      if (focusedId) {
        const buttons = [...$('catalog-grid').querySelectorAll('button[data-favorite-id]')];
        const next = buttons.find(button => button.dataset.favoriteId === focusedId) || buttons[Math.min(focusedIndex, buttons.length - 1)] || $('catalog-favorites-only');
        next.focus({ preventScroll: true });
      }
    });
    const storageError = favorites?.getState().error || (!favorites ? '收藏功能暂时未能加载，请刷新页面重试。' : '');
    favoriteNotice(storageError, Boolean(storageError));
    render();
  } catch (error) {
    $('catalog-grid').replaceChildren();
    $('catalog-result-count').textContent = '内置目录暂时无法显示';
    $('catalog-empty').hidden = false;
    $('catalog-empty-title').textContent = '目录没有加载成功';
    $('catalog-empty-copy').textContent = `${error.message || '加载时遇到问题。'} 请刷新页面重试，也可以使用下方的外部曲库入口。`;
    $('catalog-empty-reset').hidden = true;
    $('catalog-pagination').hidden = true;
    document.querySelector('.catalog-results').setAttribute('aria-busy', 'false');
  }
})();
