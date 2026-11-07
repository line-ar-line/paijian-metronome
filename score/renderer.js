(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ScoreRenderer = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  const text = (x, y, value, extra = '') => `<text x="${x}" y="${y}" ${extra}>${escape(value)}</text>`;
  const widthOf = (token) => Math.max(34, 28 + Math.max(0, Math.floor(token.duration) - 1) * 20 + (token.accidental ? 12 : 0));
  const wrap = (value, limit) => {
    const characters = Array.from(value);
    const lines = [];
    for (let i = 0; i < characters.length; i += limit) lines.push(characters.slice(i, i + limit).join(''));
    return lines.length ? lines : [''];
  };

  const positiveInteger = value => Number.isInteger(value) && value > 0;
  const totalBarCount = (score, options) => positiveInteger(options.totalBars) ? options.totalBars : positiveInteger(score.totalBarCount) ? score.totalBarCount : score.bars.length;
  const measureWidths = score => score.bars.map(bar => ({ bar, minimum: Math.max(180, bar.tokens.reduce((n, token) => n + widthOf(token), 0) + 24) }));

  function pageHeader(score, options) {
    const title = Array.from(String(options.title || score.options?.title || '未命名曲谱')).slice(0, 80).join('');
    const titleLines = wrap(title, 32);
    const pageNumber = positiveInteger(options.pageNumber) ? options.pageNumber : positiveInteger(score.pageNumber) ? score.pageNumber : null;
    const pageCount = positiveInteger(options.pageCount) ? options.pageCount : positiveInteger(score.pageCount) ? score.pageCount : null;
    let subtitle = Array.from(String(options.subtitle || '旋律数字谱')).slice(0, 160).join('');
    if (pageNumber && pageCount) {
      subtitle += ` · 第 ${pageNumber}/${pageCount} 页`;
      if (score.bars.length) subtitle += ` · 第 ${score.bars[0].index + 1}–${score.bars[score.bars.length - 1].index + 1} 小节`;
    }
    const subtitleLines = wrap(subtitle, 64);
    const titleExtra = (titleLines.length - 1) * 35;
    const headerExtra = titleExtra + (subtitleLines.length - 1) * 18;
    return { title, titleLines, subtitleLines, titleExtra, headerExtra, headerHeight: 178 + headerExtra, pageNumber, pageCount };
  }

  function layout(score, options, measures = measureWidths(score)) {
    const margin = 52;
    // Preserve legible glyph spacing even for unusually long/dense measures.
    // The enclosing viewer can scroll horizontally; fonts must not overlap.
    let width = 1040;
    for (const entry of measures) width = Math.max(width, entry.minimum + margin * 2);
    const innerWidth = width - margin * 2;
    const rows = [];
    let row = [];
    let used = 0;
    for (const { bar, minimum } of measures) {
      if (row.length && (used + minimum > innerWidth || row.length >= 4)) { rows.push(row); row = []; used = 0; }
      row.push({ bar, minimum }); used += minimum;
    }
    if (row.length) rows.push(row);
    const rowHeight = 126;
    const header = pageHeader(score, options);
    const height = header.headerHeight + rows.length * rowHeight + 72;
    return { margin, width, innerWidth, rows, rowHeight, height, ...header };
  }

  // Pages retain all aggregate score fields and all original bar/token objects.
  // An empty score has no pages. If even a single row plus the title cannot fit
  // maxHeight, that row gets its own page rather than being lost or truncated.
  function paginate(score, options = {}, maxHeight = 1380) {
    if (typeof maxHeight !== 'number' || !Number.isFinite(maxHeight) || maxHeight <= 0) throw new Error('分页高度必须是大于 0 的有限数值。');
    if (!score.bars.length) return [];
    const measures = measureWidths(score);
    const totalBars = totalBarCount(score, options);
    const pages = [];
    let current = [];
    function savePage() {
      pages.push({ ...score, bars: current.map(entry => entry.bar), totalBarCount: totalBars, pageNumber: pages.length + 1 });
    }
    for (const measure of measures) {
      const candidate = current.concat(measure);
      const candidateScore = { ...score, bars: candidate.map(entry => entry.bar) };
      // Reserve enough space for the longest possible page count before its
      // exact value is known. This may leave a little whitespace, never overflow.
      const reserved = { ...options, pageNumber: pages.length + 1, pageCount: score.bars.length, totalBars };
      const geometry = layout(candidateScore, reserved, candidate);
      if (current.length && geometry.height > maxHeight) {
        savePage();
        current = [measure];
      } else current = candidate;
    }
    if (current.length) savePage();
    for (const page of pages) page.pageCount = pages.length;
    return pages;
  }

  function render(score, options = {}) {
    const { margin, width, innerWidth, rows, rowHeight, height, title, titleLines, subtitleLines, titleExtra, headerExtra, headerHeight, pageNumber } = layout(score, options);
    const totalBars = totalBarCount(score, options);
    const titleId = `score-title${pageNumber ? `-${pageNumber}` : ''}`;
    const descriptionId = `score-description${pageNumber ? `-${pageNumber}` : ''}`;
    const meter = score.options?.meter || options.meter || [4, 4];
    const instrument = (options.instrument || score.options?.instrument) === '21C' ? '21 音 C 调' : '17 音 C 调';
    const items = [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"${width > 1040 ? ` style="min-width:${width}px"` : ''} role="img" aria-labelledby="${titleId} ${descriptionId}">`,
      `<title id="${titleId}">${escape(title)} · 卡林巴数字谱</title>`,
      `<desc id="${descriptionId}">1 等于 C4；上方的点表示高八度，下方的点表示低八度。下划线表示八分或十六分音符，横线延长一拍，弧线连接同一个音。橙色音符表示当前琴型无法直接弹奏。</desc>`,
      '<style>text{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;fill:#263d32}.note-number{font-family:Georgia,"Times New Roman",serif;font-size:31px;font-weight:500}.note-group .note-focus{fill:transparent}.note-group.is-active .note-focus{fill:#e5edda}.note-group.is-active .note-number{fill:#305337}.note-group.unplayable .note-number,.note-group.unplayable .accidental{fill:#b16337}.note-group.unplayable .note-focus{fill:#fff1df}.note-group.unplayable.is-active .note-focus{fill:#f5dfbd}.note-dot{fill:#263d32}.note-line{stroke:#263d32;stroke-width:1.6;fill:none}.tie{stroke:#64785c;stroke-width:1.3;fill:none}.small{font-size:12px;fill:#7f8b76}.measure-number{font-size:11px;fill:#9ba58e}</style>',
      `<rect width="${width}" height="${height}" fill="#fffefb"/>`,
      text(margin, 38, '拍间  /  KALIMBA SCORE', 'class="small" letter-spacing="2"'),
      ...titleLines.map((line, index) => text(width / 2, 85 + index * 35, line, 'class="score-heading" text-anchor="middle" font-size="28" font-weight="600"')),
      ...subtitleLines.map((line, index) => text(width / 2, 112 + titleExtra + index * 18, line, 'text-anchor="middle" class="small score-subtitle"')),
      text(margin, 151 + headerExtra, `1 = C4 · ${meter[0]}/${meter[1]} · ♩ = ${options.bpm || 80}`, 'font-size="15"'),
      text(width - margin, 151 + headerExtra, `${instrument} · 全曲 ${totalBars} 小节`, 'text-anchor="end" class="small"'),
      `<path d="M${margin} ${164 + headerExtra}H${width - margin}" stroke="#e2e6da" fill="none"/>`,
    ];
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const current = rows[rowIndex];
      const minimumTotal = current.reduce((n, entry) => n + entry.minimum, 0);
      const free = Math.max(0, innerWidth - minimumTotal);
      const y = headerHeight + rowIndex * rowHeight;
      const rowNotes = [];
      let x = margin;
      for (let barIndex = 0; barIndex < current.length; barIndex++) {
        const { bar, minimum } = current[barIndex];
        const barWidth = minimum + free / current.length;
        const baseline = y + 66;
        const widths = bar.tokens.map(widthOf);
        const tokensWidth = widths.reduce((a, b) => a + b, 0);
        const available = barWidth - 18;
        const positions = [];
        let offset = x + 9;
        for (let i = 0; i < widths.length; i++) {
          const tokenWidth = widths[i] / tokensWidth * available;
          positions.push({ x: offset, width: tokenWidth }); offset += tokenWidth;
        }
        items.push(`<g data-measure="${bar.index}">`);
        items.push(text(x + 4, y + 17, String(bar.index + 1).padStart(2, '0'), 'class="measure-number"'));
        for (let i = 0; i < bar.tokens.length; i++) {
          const token = bar.tokens[i];
          const box = positions[i];
          const extension = Math.max(0, Math.floor(token.duration) - 1);
          const symbolCount = extension + 1;
          const unit = box.width / symbolCount;
          const noteX = box.x + unit / 2;
          const rest = token.midi === null;
          rowNotes.push({ token, noteX, baseline });
          const source = token.sourceId === null || token.sourceId === undefined ? '' : token.sourceId;
          const bad = !rest && !token.playable;
          items.push(`<g class="note-group${bad ? ' unplayable' : ''}" data-token-id="${escape(token.id)}" data-source-id="${escape(source)}">`);
          items.push(`<rect class="note-focus" x="${box.x + 1}" y="${baseline - 43}" width="${Math.max(1, box.width - 2)}" height="77" rx="6"/>`);
          items.push(`<title>${escape(rest ? `休止 ${token.duration} 拍` : `${token.accidental || ''}${token.degree}，${token.octave > 0 ? `高 ${token.octave} 个八度，` : token.octave < 0 ? `低 ${-token.octave} 个八度，` : ''}${token.duration} 拍${bad ? `；${token.reason}` : ''}`)}</title>`);
          items.push(text(noteX, baseline, rest ? '0' : token.degree, 'class="note-number" text-anchor="middle"'));
          if (token.accidental && !rest) items.push(text(noteX - 17, baseline - 8, token.accidental, 'class="accidental" font-size="19" text-anchor="middle"'));
          if (!rest) {
            const dots = Math.abs(token.octave || 0);
            for (let dot = 0; dot < dots; dot++) {
              const dotY = token.octave > 0 ? baseline - 33 - dot * 7 : baseline + 21 + dot * 7;
              items.push(`<circle class="note-dot" cx="${noteX}" cy="${dotY}" r="2"/>`);
            }
          }
          if (token.duration < 1) {
            const lines = token.duration < 0.5 ? 2 : 1;
            for (let line = 0; line < lines; line++) items.push(`<path class="note-line" d="M${noteX - 10} ${baseline + 7 + line * 5}h20"/>`);
          }
          if (token.duration === 1.5 || token.duration === 0.75) items.push(`<circle class="note-dot" cx="${noteX + 17}" cy="${baseline - 6}" r="2"/>`);
          for (let dash = 1; dash <= extension; dash++) {
            items.push(text(box.x + unit * (dash + 0.5), rest ? baseline : baseline - 2, rest ? '0' : '−', rest ? 'class="note-number" text-anchor="middle"' : 'font-size="26" text-anchor="middle"'));
          }
          items.push('</g>');
        }
        const last = bar.index === totalBars - 1;
        items.push(`<path class="measure-barline${last ? ' final-barline' : ''}" d="M${x + barWidth} ${baseline - 29}v48" stroke="#8d9982" stroke-width="${last ? 2.8 : 1}"/>`);
        if (last) items.push(`<path d="M${x + barWidth - 5} ${baseline - 29}v48" stroke="#8d9982"/>`);
        items.push('</g>');
        x += barWidth;
      }
      // Draw one continuous tie between neighboring symbols, including across
      // bar lines. A row break gets an outgoing/incoming continuation instead.
      for (let i = 0; i < rowNotes.length; i++) {
        const { token, noteX, baseline } = rowNotes[i];
        if (token.midi === null) continue;
        const tieY = baseline - Math.max(43, 33 + Math.max(0, token.octave - 1) * 7 + 8);
        const previous = rowNotes[i - 1];
        const next = rowNotes[i + 1];
        const samePrevious = previous && previous.token.sourceId === token.sourceId && previous.token.tieOut;
        const sameNext = next && next.token.sourceId === token.sourceId && next.token.tieIn;
        if (token.tieIn && !samePrevious) {
          items.push(`<path class="tie" d="M${margin} ${tieY}Q${(margin + noteX - 6) / 2} ${tieY - 16} ${noteX - 6} ${tieY}"/>`);
        }
        if (token.tieOut) {
          const end = sameNext ? next.noteX - 6 : width - margin;
          items.push(`<path class="tie" d="M${noteX + 6} ${tieY}Q${(noteX + 6 + end) / 2} ${tieY - 16} ${end} ${tieY}"/>`);
        }
      }
    }
    items.push(`<path d="M${margin} ${height - 58}H${width - margin}" stroke="#e2e6da"/>`);
    items.push(text(margin, height - 33, '数字对应 C 调琴键 · 上下圆点表示八度 · 0 为休止 · 连线内的音只拨一次', 'class="small"'));
    items.push(text(width - margin, height - 33, score.stats?.unplayable ? '橙色音符需要移调或改编' : '拍间 · 把旋律放在指尖', 'text-anchor="end" class="small"'));
    items.push('</svg>');
    return items.join('\n');
  }
  return { render, paginate };
});
