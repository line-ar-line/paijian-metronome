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
  const state = {
    query: (parameters.get('q') || '').slice(0, 160),
    composer: parameters.get('composer') || '',
    instrument: parameters.get('instrument') || '',
    texture: ['single', 'polyphonic'].includes(parameters.get('texture')) ? parameters.get('texture') : '',
    sort: ['default', 'title', 'composer', 'coverage'].includes(parameters.get('sort')) ? parameters.get('sort') : 'default',
    page: Math.max(1, Number.parseInt(parameters.get('page'), 10) || 1),
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

  function prepare(entry, index) {
    if (!entry || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(String(entry.id || ''))) throw new Error('目录中有无法识别的曲目编号。');
    const title = String(entry.title || '未命名来源文件');
    const composer = String(entry.composer || '作曲家未标注');
    const instrument = String(entry.instrument || '编制未标注');
    const notes = finiteCount(entry.notes);
    const playable = finiteCount(entry.playable17Count);
    const ratio = notes > 0 && playable !== null && playable <= notes ? playable / notes : null;
    const composerText = normalized(composer);
    const aliases = Object.entries(composerAliases).filter(([key]) => composerText.includes(key)).map(([, value]) => value).join(' ');
    const file = String(entry.file || '');
    return {
      ...entry, index, title, composer, instrument, notes, playable, ratio,
      bars: finiteCount(entry.bars),
      maxPolyphony: finiteCount(entry.maxPolyphony),
      searchText: normalized([title, composer, aliases, instrument, entry.style || '', entry.id].join(' ')),
      file: /^catalog\/midi\/[A-Za-z0-9_-]+\.midi?$/.test(file) ? file : null,
      sourceUrl: publicUrl(entry.sourceUrl),
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
    const polyphonic = entry.maxPolyphony > 1;
    heading.append(element('span', 'catalog-piece-number', `NO. ${String(entry.index + 1).padStart(4, '0')}`));
    const texture = entry.maxPolyphony === null || entry.maxPolyphony === 0 ? '多音情况未统计' : polyphonic ? `最多 ${entry.maxPolyphony} 音同时持续` : '单音旋律';
    heading.append(element('span', `catalog-piece-badge${polyphonic ? ' polyphonic' : ''}`, texture));
    const title = element('h3');
    const titleLink = element('a', 'catalog-piece-title', entry.title);
    titleLink.href = `./score.html?piece=${encodeURIComponent(entry.id)}`;
    title.append(titleLink);
    const details = element('dl', 'catalog-piece-details');
    addDetail(details, '原编制', entry.instrument);
    const extent = `${entry.bars === null ? '小节数未统计' : `${number(entry.bars)} 小节`} · ${entry.notes === null ? '音符数未统计' : `${number(entry.notes)} 音符`}`;
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
    const open = element('a', 'catalog-open', '打开数字谱 →');
    open.href = titleLink.href;
    open.setAttribute('aria-label', `打开《${entry.title}》数字谱`);
    actions.append(open);
    if (entry.file) {
      const midi = element('a', 'catalog-midi', 'MIDI ↓');
      midi.href = entry.file;
      midi.download = entry.file.slice(entry.file.lastIndexOf('/') + 1);
      midi.setAttribute('aria-label', `下载《${entry.title}》完整来源 MIDI`);
      if (Number.isFinite(entry.bytes)) midi.title = `下载源文件 · ${Math.max(1, Math.round(entry.bytes / 1024))} KB`;
      actions.append(midi);
    }
    const source = element('div', 'catalog-piece-source');
    if (entry.sourceUrl) {
      const original = element('a', '', '来源 / 原谱 ↗');
      original.href = entry.sourceUrl; original.target = '_blank'; original.rel = 'noopener noreferrer';
      if (entry.attribution) original.title = String(entry.attribution);
      source.append(original);
    }
    if (entry.license) {
      const license = element(entry.licenseUrl ? 'a' : 'span', '', String(entry.license));
      if (entry.licenseUrl) { license.href = entry.licenseUrl; license.target = '_blank'; license.rel = 'noopener noreferrer'; }
      source.append(license);
    }
    card.append(heading, title, element('p', 'catalog-piece-composer', entry.composer), details, coverage, actions);
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
      for (const key of ['q', 'composer', 'instrument', 'texture', 'sort', 'page']) url.searchParams.delete(key);
      if (state.query) url.searchParams.set('q', state.query);
      for (const key of ['composer', 'instrument', 'texture']) if (state[key]) url.searchParams.set(key, state[key]);
      if (state.sort !== 'default') url.searchParams.set('sort', state.sort);
      if (state.page > 1) url.searchParams.set('page', state.page);
      history.replaceState(null, '', url);
    } catch { /* Some local-file browsers disallow URL state updates. */ }
  }

  function render() {
    const terms = normalized(state.query).split(' ').filter(Boolean);
    matched = entries.filter((entry) => (
      terms.every(term => entry.searchText.includes(term)) &&
      (!state.composer || entry.composer === state.composer) &&
      (!state.instrument || entry.instrument === state.instrument) &&
      (!state.texture || (state.texture === 'single' ? entry.maxPolyphony === 1 : entry.maxPolyphony > 1))
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
    const filtered = Boolean(state.query.trim() || state.composer || state.instrument || state.texture);
    $('catalog-results-title').textContent = filtered ? '筛选结果' : '所有曲目';
    $('catalog-result-count').textContent = matched.length ? `${number(matched.length)} 份曲谱 · 正在显示第 ${number(from + 1)}–${number(from + visible.length)} 份` : '0 份匹配曲谱';
    $('catalog-reset').hidden = !filtered && state.sort === 'default';
    $('catalog-empty').hidden = matched.length > 0;
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
    Object.assign(state, { query: '', composer: '', instrument: '', texture: '', sort: 'default', page: 1 });
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
    entries = catalog.entries.map(prepare);
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
    $('catalog-provenance').textContent = `目录收录 ${number(entries.length)} 份完整来源文件 · 来源 ${String(catalog.source || '开放乐谱库')}${date}。作品、乐章与版本范围以条目标题和原谱为准。`;
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
