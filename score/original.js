(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const favorites = window.ScoreUserLibrary;
  const localImage = value => typeof value === 'string' && /^scores\/[a-z0-9-]+\.(?:jpe?g|png|webp)$/.test(value);
  const localArchive = value => typeof value === 'string' && /^scores\/[a-z0-9-]+\.zip$/.test(value);
  const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const status = (text, kind = '') => {
    $('original-status').textContent = text;
    $('original-status').dataset.kind = kind;
  };

  try {
    const id = new URLSearchParams(location.search).get('score');
    const entries = window.CuratedScores?.entries;
    if (!Array.isArray(entries)) throw new Error('曲谱目录未能加载，请刷新页面重试。');
    const entry = entries.find(item => item.id === id && item.format === 'score-images');
    if (!entry) throw new Error('没有找到这份原图曲谱，请返回曲库重新选择。');
    const pages = entry.sourcePages;
    if (!Array.isArray(pages) || !pages.length || !pages.every(page => localImage(page.file))) throw new Error('这份曲谱的原图目录不完整，请返回曲库重试。');

    document.title = `${entry.title} · 卡林巴原图谱 · 拍间`;
    $('original-title').textContent = entry.title;
    $('original-meta').textContent = [entry.instrument, entry.key, Array.isArray(entry.meter) ? `${entry.meter.join('/')} 拍` : '', '原图阅读版'].filter(Boolean).join(' · ');
    $('original-scope').textContent = entry.scope || `${pages.length} 张原图`;
    $('original-reading-note').textContent = entry.readingNote || '';
    $('original-playback-note').textContent = entry.playbackNote || '原图阅读版，暂不提供自动试听。';
    $('original-attribution').textContent = entry.attribution || '';
    for (const name of ['original-actions', 'original-local-note', 'original-notes', 'original-toolbar']) $(name).hidden = false;
    const archive = $('original-archive');
    archive.hidden = !localArchive(entry.sourceArchive);
    if (!archive.hidden) { archive.href = entry.sourceArchive; archive.download = entry.sourceArchive.split('/').pop(); }

    function favoriteMessage(text, error = false) {
      $('original-favorite-status').textContent = text;
      $('original-favorite-status').hidden = !text;
      $('original-favorite-status').dataset.kind = error ? 'error' : 'success';
    }
    function updateFavorite() {
      const saved = Boolean(favorites?.has(id));
      $('original-favorite').textContent = saved ? '★ 已收藏' : '☆ 收藏曲谱';
      $('original-favorite').setAttribute('aria-pressed', String(saved));
      $('original-favorite').disabled = !favorites;
      const error = favorites?.getState().error || (!favorites ? '收藏功能未能加载，请刷新页面重试。' : '');
      favoriteMessage(error, Boolean(error));
    }
    $('original-favorite').addEventListener('click', () => {
      const result = favorites.toggle(id);
      favoriteMessage(result.ok ? `${result.favorite ? '已收藏' : '已取消收藏'}《${entry.title}》` : result.error, !result.ok);
    });
    favorites?.subscribe(updateFavorite);
    updateFavorite();

    const states = pages.map(() => 'loading');
    function updateImages() {
      const loaded = states.filter(value => value === 'loaded').length;
      const failed = states.filter(value => value === 'error').length;
      $('original-gallery').setAttribute('aria-busy', String(states.includes('loading')));
      $('original-print').disabled = loaded !== pages.length;
      if (failed) status(`${failed} 张原图未能加载，请点击对应图片下方的“重新加载”，或下载全部原图查看。`, 'error');
      else if (loaded < pages.length) status(`正在加载原图 ${loaded} / ${pages.length}…`);
      else status(`全部 ${pages.length} 张原图已加载，包含手写标注。`, 'success');
    }
    pages.forEach((page, index) => {
      const figure = element('figure', undefined, 'original-page');
      figure.id = `original-page-${index + 1}`;
      const label = `${index + 1} / ${pages.length} · ${page.label || '原图'}`;
      const caption = element('figcaption');
      caption.append(element('h2', label));
      const links = element('div', undefined, 'original-page-links');
      const open = element('a', '打开原尺寸 ↗');
      open.href = page.file; open.target = '_blank'; open.rel = 'noopener';
      open.setAttribute('aria-label', `打开${page.label || '原图'}原尺寸`);
      const download = element('a', '下载此图 ↓');
      download.href = page.file; download.download = page.file.split('/').pop();
      download.setAttribute('aria-label', `下载${page.label || '原图'}`);
      links.append(open, download); caption.append(links);
      const viewport = element('div', undefined, 'original-image-viewport');
      viewport.tabIndex = 0;
      viewport.setAttribute('role', 'region');
      viewport.setAttribute('aria-label', `${page.label || '原图'}，放大后可横向滚动`);
      const img = element('img');
      img.alt = `《${entry.title}》${page.label || '原图'}，保留原图全部内容`;
      if (Number.isInteger(page.width) && page.width > 0) img.width = page.width;
      if (Number.isInteger(page.height) && page.height > 0) img.height = page.height;
      const error = element('p', '这张原图未能加载。', 'original-image-error');
      const retry = element('button', '重新加载'); retry.type = 'button';
      error.append(retry); error.hidden = true;
      img.addEventListener('load', () => { states[index] = 'loaded'; error.hidden = true; updateImages(); });
      img.addEventListener('error', () => { states[index] = 'error'; error.hidden = false; updateImages(); });
      retry.addEventListener('click', () => { states[index] = 'loading'; error.hidden = true; updateImages(); img.src = `${page.file}?retry=${Date.now()}`; });
      img.src = page.file;
      viewport.append(img); figure.append(caption, viewport, error);
      $('original-gallery').append(figure);
      const option = element('option', label); option.value = String(index);
      $('original-jump').append(option);
    });
    $('original-jump').addEventListener('change', event => {
      const figure = $('original-gallery').children[Number(event.target.value)];
      figure?.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    $('original-zoom').addEventListener('change', event => {
      const scale = ['150', '200'].includes(event.target.value) ? event.target.value : '100';
      $('original-gallery').style.setProperty('--image-scale', `${scale}%`);
    });
    $('original-print').addEventListener('click', () => { if (states.every(value => value === 'loaded')) window.print(); });
    updateImages();
  } catch (error) {
    $('original-gallery').setAttribute('aria-busy', 'false');
    status(error.message || '原图曲谱暂时无法显示，请刷新页面重试。', 'error');
  }
})();
