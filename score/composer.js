(function (root, factory) {
  'use strict';
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ScoreComposer = api;
  if (root.document?.body?.classList.contains('composer-page')) api.mount();
})(typeof globalThis !== 'undefined' ? globalThis : window, function (root) {
  'use strict';

  const DRAFT_KEY = 'paijian.composer.drafts.v1';
  const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
  const clone = value => JSON.parse(JSON.stringify(value));
  const uniqueId = () => root.crypto?.randomUUID ? root.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function blankDocument() {
    return { format: 'paijian-score', version: 1, title: '未命名曲谱', bpm: 80, meter: [4, 4], instrument: '17C', voices: [{ name: '旋律', notation: '' }], repeats: [], credits: [] };
  }

  function starterDocument() {
    return { ...blankDocument(), title: '指尖练习 · 示例', voices: [{ name: '旋律', notation: "1 2 3 5 | 6:0.5 5:0.5 3 2 0 |\n(1,3,5):2 0 5 | ~(1,3,5):2 1':2" }], credits: ['拍间 · 原创四小节练习'] };
  }

  function safeFilename(value) {
    let name = Array.from(String(value || '未命名曲谱').normalize('NFC').replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g, '-').replace(/[. ]+$/g, '')).slice(0, 80).join('').replace(/[. ]+$/g, '');
    if (!name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `曲谱-${name || '未命名'}`;
    return name;
  }

  // Import an editing snapshot without demanding that its unfinished BPM,
  // repeat fields, or notation compile yet. Public scores use the stricter
  // ScoreDocument.normalize; the editor keeps recoverable drafts lossless.
  function restoreDocument(input) {
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!object(input) || input.format !== 'paijian-score' || input.version !== 1) throw new Error('请选择拍间制谱导出的第 1 版 JSON 曲谱。');
    if (typeof input.title !== 'string' || input.title.length > 1000 || typeof input.bpm !== 'number' || !Number.isFinite(input.bpm)) throw new Error('JSON 中的标题或速度字段格式无效。');
    if (!Array.isArray(input.meter) || input.meter.length !== 2 || input.meter.some(value => !Number.isInteger(value)) || !['17C', '21C'].includes(input.instrument)) throw new Error('JSON 中的拍号或琴型字段格式无效。');
    if (!Array.isArray(input.voices) || input.voices.length < 1 || input.voices.length > 4 || input.voices.some(voice => !object(voice) || typeof voice.name !== 'string' || voice.name.length > 1000 || typeof voice.notation !== 'string' || voice.notation.length > 200000)) throw new Error('JSON 须包含 1–4 个有效的数字谱声部。');
    const repeats = input.repeats ?? [];
    if (!Array.isArray(repeats) || repeats.length > 100 || repeats.some(repeat => !object(repeat) || ['startBar', 'endBar', 'times'].some(field => typeof repeat[field] !== 'number' || !Number.isFinite(repeat[field])))) throw new Error('JSON 中的反复段字段格式无效。');
    const credits = input.credits ?? [];
    if (!Array.isArray(credits) || credits.length > 16000 || credits.some(credit => typeof credit !== 'string') || credits.join('\n').length > 16000) throw new Error('JSON 中的署名字段格式无效或超过 16000 字。');
    const sections = input.unmeteredSections ?? [];
    if (!Array.isArray(sections) || sections.length > 8 || sections.some(section => !object(section) || typeof section.title !== 'string' || section.title.length > 1000 || typeof section.afterBar !== 'number' || !Number.isFinite(section.afterBar) || (section.description !== undefined && (typeof section.description !== 'string' || section.description.length > 16000)) || !Array.isArray(section.voices) || !section.voices.length || section.voices.length > 4 || section.voices.some(voice => !object(voice) || typeof voice.name !== 'string' || voice.name.length > 1000 || typeof voice.notation !== 'string' || voice.notation.length > 20000))) throw new Error('JSON 中的未定节奏段格式无效。');
    return { ...clone(input), repeats: clone(repeats), credits: clone(credits) };
  }

  // Keep the editing document, including unfinished notation, separate from the
  // compiled score. A syntax error must never discard the user's latest text.
  function createDraftStore(storage) {
    let state = { version: 1, activeId: null, drafts: [] };
    let lastRaw = null;
    let blocked = null;
    try {
      lastRaw = storage.getItem(DRAFT_KEY);
      if (lastRaw !== null) {
        const saved = JSON.parse(lastRaw);
        if (!saved || saved.version !== 1 || !Array.isArray(saved.drafts) || saved.drafts.length > 1000 || saved.drafts.some(draft => !draft || typeof draft.id !== 'string' || !draft.id || !draft.document || typeof draft.document !== 'object' || Array.isArray(draft.document) || !Array.isArray(draft.document.voices) || !draft.document.voices.length || draft.document.voices.some(voice => !voice || typeof voice.notation !== 'string'))) {
          throw new Error('本地草稿格式无法读取，原始数据已保留。请先导出当前修改，再检查浏览器中的草稿数据。');
        }
        if (new Set(saved.drafts.map(draft => draft.id)).size !== saved.drafts.length) throw new Error('本地草稿编号重复，原始数据已保留，请先导出当前修改。');
        state = saved;
        if (!state.drafts.some(draft => draft.id === state.activeId)) state.activeId = state.drafts[0]?.id || null;
      }
    } catch (error) {
      blocked = error instanceof SyntaxError ? new Error('本地草稿数据无法解析，原始数据已保留。当前修改请使用 JSON 导出备份。') : error;
    }
    function persist() {
      if (blocked) throw blocked;
      try {
        if (storage.getItem(DRAFT_KEY) !== lastRaw) {
          throw new Error('另一个标签页更新了草稿。本页已停止覆盖保存，请先导出当前 JSON，再刷新查看最新草稿。');
        }
        const nextRaw = JSON.stringify(state);
        storage.setItem(DRAFT_KEY, nextRaw);
        lastRaw = nextRaw;
      } catch (error) {
        blocked = error;
        throw error;
      }
    }
    function current() { return state.drafts.find(draft => draft.id === state.activeId) || null; }
    return {
      get error() { return blocked; },
      list: () => clone(state.drafts),
      current: () => current() ? clone(current()) : null,
      create(document) {
        if (state.drafts.length >= 1000) throw new Error('当前浏览器最多保存 1000 份草稿，请导出备份后删除不需要的草稿。');
        const draft = { id: uniqueId(), updatedAt: new Date().toISOString(), document: clone(document) };
        state.drafts.unshift(draft);
        state.activeId = draft.id;
        persist();
        return clone(draft);
      },
      update(document) {
        const draft = current();
        if (!draft) throw new Error('没有打开的草稿。');
        draft.document = clone(document);
        draft.updatedAt = new Date().toISOString();
        persist();
      },
      select(id) {
        if (!state.drafts.some(draft => draft.id === id)) throw new Error('没有找到这份草稿。');
        state.activeId = id;
        persist();
      },
      remove(id) {
        state.drafts = state.drafts.filter(draft => draft.id !== id);
        if (state.activeId === id) state.activeId = state.drafts[0]?.id || null;
        persist();
      },
    };
  }

  function mount() {
    const $ = id => root.document.getElementById(id);
    if (!$('composer-form')) return;
    if (root.matchMedia?.('(max-width: 800px)').matches) root.document.querySelector('.syntax-guide')?.removeAttribute('open');
    let storage;
    try { storage = root.localStorage; }
    catch (error) { storage = { getItem() { throw error; } }; }
    const drafts = createDraftStore(storage);
    let documentData = blankDocument();
    let compiled = null;
    let pages = [];
    let renderOptions = {};
    let pageIndex = 0;
    let timer = null;
    let starting = false;
    let importGeneration = 0;
    let activeGroups = [];
    let activeNotes = [];
    let nodesBySource = new Map();
    let barToPage = [];
    const player = new root.ScorePlayer({
      onActiveNotes(event) { activeNotes = event.notes; paintHighlight(); },
      onProgress: updateProgress,
      onStateChange(event) {
        starting = false;
        const playing = event.state === 'playing';
        $('composer-play').textContent = playing ? (hasUnmetered() ? '■ 停止试听正文' : '■ 停止试听') : `▶ ${playLabel()}`;
        $('composer-play').setAttribute('aria-pressed', String(playing));
        if (!playing) {
          activeNotes = [];
          paintHighlight();
          $('composer-playback-status').textContent = hasUnmetered()
            ? (event.reason === 'ended' ? '正文试听完成；间奏请按数字谱自行练习。' : event.reason === 'stalled' || event.reason === 'interrupted' ? '正文试听已中断，点击“试听正文”重新开始。' : '已停止试听正文，可以继续修改。')
            : event.reason === 'ended' ? '这一遍，练习完成。' : event.reason === 'stalled' || event.reason === 'interrupted' ? '试听已中断，点击可重新开始。' : '已停止，可以继续修改。';
        }
      },
      onError(error) { starting = false; message(error.message || '试听暂时无法启动，请重试。', true); },
    });

    function message(text, error = false) {
      $('composer-message').textContent = text;
      $('composer-message').hidden = !text;
      $('composer-message').dataset.kind = error ? 'error' : 'success';
    }
    function storageWarning(error) {
      const detail = /标签页|原始数据|无法解析/.test(error?.message || '') ? error.message : '浏览器未能保存草稿，可能是存储空间不足或存储被禁用。';
      $('storage-warning').textContent = `${detail} 当前内容仍在编辑器中，请导出 JSON 备份。`;
      $('storage-warning').hidden = false;
      $('save-status').textContent = '尚未保存 · 请导出 JSON';
    }
    function mutateStore(action) {
      try { action(); $('save-status').textContent = '已自动保存到此浏览器'; return true; }
      catch (error) { storageWarning(error); return false; }
    }
    function time(value) { return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; }
    function hasUnmetered() { return Array.isArray(documentData.unmeteredSections) && documentData.unmeteredSections.length > 0; }
    function playLabel() { return hasUnmetered() ? '试听正文' : '试听全曲'; }
    function updateProgress({ beat, totalBeats }) {
      const bpm = compiled?.document?.bpm || Number(documentData.bpm) || 80;
      $('composer-progress').max = totalBeats || 1;
      $('composer-progress').value = beat;
      $('composer-playback-time').textContent = `${time(beat * 60 / bpm)} / ${time(totalBeats * 60 / bpm)}`;
      if (player.isPlaying && compiled) {
        const playingBar = Math.floor(beat / compiled.score.barBeats);
        const map = compiled.score.playbackBarMap;
        const printBar = Array.isArray(map) ? map[Math.min(playingBar, map.length - 1)] : playingBar;
        const barIndex = Number.isInteger(printBar) ? printBar : printBar?.barIndex ?? printBar?.index ?? playingBar;
        $('composer-playback-status').textContent = `正在${hasUnmetered() ? '试听正文' : '试听'} · 印刷第 ${barIndex + 1} 小节`;
        if ($('composer-follow-pages').checked && barToPage[barIndex] !== undefined && barToPage[barIndex] !== pageIndex) showPage(barToPage[barIndex]);
      }
    }
    function paintHighlight() {
      activeGroups.forEach(group => group.classList.remove('is-active'));
      const ids = new Set(activeNotes.map(note => note.sourceId));
      activeGroups = [...ids].flatMap(id => nodesBySource.get(id) || []);
      activeGroups.forEach(group => group.classList.add('is-active'));
    }
    function showPage(index) {
      if (!pages.length) return;
      pageIndex = Math.max(0, Math.min(index, pages.length - 1));
      $('composer-preview').innerHTML = root.ScoreRenderer.render(pages[pageIndex], renderOptions);
      nodesBySource = new Map();
      $('composer-preview').querySelectorAll('[data-source-id]').forEach(group => {
        const id = group.dataset.sourceId;
        if (!id) return;
        if (!nodesBySource.has(id)) nodesBySource.set(id, []);
        nodesBySource.get(id).push(group);
      });
      paintHighlight();
      $('composer-page-select').value = String(pageIndex);
      $('composer-previous-page').disabled = pageIndex === 0;
      $('composer-next-page').disabled = pageIndex === pages.length - 1;
      const { bars, unmeteredSection } = pages[pageIndex];
      $('composer-page-range').textContent = unmeteredSection
        ? `${unmeteredSection.title} · 未定节奏间奏页 · 不参与试听`
        : bars.length ? `第 ${bars[0].index + 1}–${bars[bars.length - 1].index + 1} 小节` : '';
    }
    function placeholder(text) {
      $('composer-preview').replaceChildren();
      const paragraph = root.document.createElement('p');
      paragraph.className = 'preview-placeholder';
      paragraph.textContent = text;
      $('composer-preview').append(paragraph);
      nodesBySource.clear();
      activeGroups = [];
    }
    function clearPreview(text) {
      compiled = null; pages = []; barToPage = [];
      placeholder(text);
      $('composer-play').disabled = true;
      $('composer-export-svg').disabled = true;
      $('composer-previous-page').disabled = true;
      $('composer-next-page').disabled = true;
      $('composer-page-select').disabled = true;
      $('composer-page-select').replaceChildren(new Option('暂无谱页', '0'));
      $('composer-page-range').textContent = '';
      $('composer-summary').textContent = '';
      $('composer-warnings').replaceChildren();
      updateProgress({ beat: 0, totalBeats: 0 });
    }
    function refreshPreview() {
      root.clearTimeout(timer);
      timer = null;
      $('notation-error').hidden = true;
      $('composer-play').textContent = `▶ ${playLabel()}`;
      $('composer-performance-note').hidden = !hasUnmetered();
      $('composer-performance-note').textContent = hasUnmetered() ? [documentData.description, '试听正文；未定节奏间奏保留全部音高与列对齐，不参与试听。'].filter(Boolean).join(' ') : '';
      $('composer-form').querySelectorAll('.notation-input').forEach(input => input.setAttribute('aria-invalid', 'false'));
      if (!documentData.voices.some(voice => voice.notation.trim())) {
        clearPreview('在上方写下第一小节，数字谱会出现在这里。');
        $('composer-playback-status').textContent = '写好后，试听你的旋律。';
        return;
      }
      try {
        const result = root.ScoreDocument.compile(documentData);
        renderOptions = { title: result.document.title, bpm: result.document.bpm, instrument: result.document.instrument, subtitle: '手工卡林巴数字谱', credits: result.document.credits || [] };
        const nextPages = root.ScoreRenderer.paginate(result.score, renderOptions);
        if (!nextPages.length) throw new Error('还没有可预览的小节，请先写入音符或休止。');
        compiled = result;
        pages = nextPages;
        barToPage = [];
        pages.forEach((page, index) => page.bars.forEach(bar => { barToPage[bar.index] = index; }));
        $('composer-page-select').replaceChildren(...pages.map((page, index) => new Option(`第 ${index + 1} / ${pages.length} 页${page.unmeteredSection ? ` · ${page.unmeteredSection.title}` : ''}`, String(index))));
        $('composer-page-select').disabled = false;
        showPage(pageIndex);
        const groups = (result.score.unmeteredSections || []).reduce((total, section) => total + section.groups.length, 0);
        $('composer-summary').textContent = hasUnmetered() ? `正文 ${result.score.bars.length} 小节 + 间奏 ${groups} 组 · ${pages.length} 页` : `${result.score.bars.length} 小节 · ${result.document.voices.length} 声部 · ${pages.length} 页`;
        $('composer-play').disabled = !result.playbackNotes.length;
        $('composer-export-svg').disabled = false;
        $('composer-playback-status').textContent = hasUnmetered() ? (result.playbackNotes.length ? '已更新，可试听正文；间奏不参与试听。' : '正文全部为休止；正文和间奏均可预览、导出。') : result.playbackNotes.length ? '已更新，随时可以试听。' : '全曲是休止，可预览和导出。';
        updateProgress({ beat: 0, totalBeats: result.totalBeats });
        const warnings = [...new Set([...(result.warnings || []), ...(result.score.warnings || [])])];
        $('composer-warnings').replaceChildren(...warnings.map(warning => { const li = root.document.createElement('li'); li.textContent = warning; return li; }));
      } catch (error) {
        clearPreview('修正上方提示后，预览会自动更新。你的编辑内容仍保留在草稿中。');
        $('notation-error').textContent = error.message || '暂时无法生成曲谱，请检查数字谱格式。';
        $('notation-error').hidden = false;
        $('composer-form').querySelectorAll('.notation-input').forEach(input => input.setAttribute('aria-invalid', 'true'));
        $('composer-playback-status').textContent = '请先修正格式，再试听或导出谱图。';
      }
    }

    function renderDraftList() {
      const current = drafts.current();
      const list = drafts.list();
      $('draft-count').textContent = `${list.length} 首`;
      $('draft-list').replaceChildren(...list.map(draft => {
        const button = root.document.createElement('button');
        button.type = 'button'; button.className = 'draft-item'; button.dataset.draftId = draft.id;
        button.setAttribute('aria-current', String(current?.id === draft.id));
        const title = root.document.createElement('strong'); title.textContent = draft.document.title || '未命名曲谱';
        const date = root.document.createElement('small');
        const updated = new Date(draft.updatedAt);
        date.textContent = Number.isNaN(updated.getTime()) ? '本地草稿' : `修改于 ${updated.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
        button.append(title, date);
        button.addEventListener('click', () => { if (draft.id === drafts.current()?.id) return; stop(); mutateStore(() => drafts.select(draft.id)); fillCurrent(); });
        return button;
      }));
    }
    function element(tag, properties = {}) { const node = root.document.createElement(tag); Object.assign(node, properties); return node; }
    function renderVoices() {
      $('composer-voices').replaceChildren(...documentData.voices.map((voice, index) => {
        const section = element('section', { className: 'voice-editor' });
        const heading = element('div', { className: 'voice-heading' });
        const label = element('label', { htmlFor: `voice-name-${index}` });
        label.append(element('span', { textContent: `声部 ${index + 1}` }));
        const name = element('input', { id: `voice-name-${index}`, className: 'text-input voice-name', type: 'text', value: voice.name || '', maxLength: 16, placeholder: '声部名称' });
        name.dataset.voiceIndex = index;
        name.setAttribute('aria-label', `声部 ${index + 1} 名称`);
        label.append(name); heading.append(label);
        if (documentData.voices.length > 1) {
          const remove = element('button', { className: 'secondary-button remove-voice', type: 'button', textContent: '移除' });
          remove.setAttribute('aria-label', `移除声部 ${index + 1}`);
          remove.addEventListener('click', () => {
            documentData = collect();
            const currentVoice = documentData.voices[index];
            if (currentVoice.notation.trim() && !root.confirm(`移除“${currentVoice.name || `声部 ${index + 1}`}”？建议先导出备份。`)) return;
            documentData.voices.splice(index, 1); renderVoices(); edited(true);
          });
          heading.append(remove);
        }
        const textarea = element('textarea', { id: `voice-notation-${index}`, className: 'text-input notation-input', value: voice.notation, rows: 4, maxLength: 200000, spellcheck: false, placeholder: '例如：1 2 3 5 | 6:2 5:2' });
        textarea.dataset.voiceIndex = index;
        textarea.setAttribute('aria-label', `声部 ${index + 1} 数字谱`);
        textarea.setAttribute('aria-describedby', 'notation-error');
        textarea.setAttribute('autocapitalize', 'off');
        textarea.setAttribute('autocomplete', 'off');
        section.append(heading, textarea);
        return section;
      }));
      $('add-voice').disabled = documentData.voices.length >= 4;
    }
    function renderRepeats() {
      $('composer-repeats').replaceChildren(...(documentData.repeats || []).map((repeat, index) => {
        const row = element('div', { className: 'repeat-row' });
        for (const [key, text, max] of [['startBar', '起始小节', 2048], ['endBar', '结束小节', 2048], ['times', '总次数', 8]]) {
          const label = element('label', { className: 'composer-field', htmlFor: `repeat-${index}-${key}` });
          const input = element('input', { className: 'text-input', type: 'number', id: `repeat-${index}-${key}`, min: key === 'times' ? 2 : 1, max, step: 1, value: repeat[key] });
          input.dataset.repeatIndex = index; input.dataset.repeatField = key;
          label.append(element('span', { textContent: text }), input); row.append(label);
        }
        const remove = element('button', { type: 'button', className: 'secondary-button', textContent: '移除' });
        remove.setAttribute('aria-label', `移除反复段 ${index + 1}`);
        remove.addEventListener('click', () => { documentData = collect(); documentData.repeats.splice(index, 1); renderRepeats(); edited(true); });
        row.append(remove); return row;
      }));
    }
    function renderUnmetered() {
      const sections = Array.isArray(documentData.unmeteredSections) ? documentData.unmeteredSections : [];
      $('composer-unmetered').hidden = !sections.length;
      $('composer-unmetered-sections').replaceChildren(...sections.map((section, index) => {
        const card = element('section', { className: 'composer-card unmetered-section' });
        card.dataset.sectionIndex = index;
        const field = (key, text, input) => {
          const label = element('label', { className: 'composer-field credits-field', htmlFor: `unmetered-${index}-${key}` });
          input.id = label.htmlFor; input.dataset.sectionField = key;
          label.append(element('span', { textContent: text }), input); card.append(label);
        };
        field('title', `间奏 ${index + 1} 标题`, element('input', { className: 'text-input', type: 'text', value: section.title || '', maxLength: 80 }));
        field('afterBar', '排在正文第几小节之后', element('input', { className: 'text-input', type: 'number', min: 1, max: 2048, step: 1, value: section.afterBar }));
        field('description', '间奏说明', element('textarea', { className: 'text-input', rows: 3, maxLength: 1500, value: section.description || '' }));
        const voices = element('div', { className: 'composer-voices' });
        (section.voices || []).forEach((voice, voiceIndex) => {
          const editor = element('div', { className: 'unmetered-voice' });
          const heading = element('div', { className: 'voice-heading' });
          const nameId = `unmetered-${index}-voice-${voiceIndex}-name`;
          const label = element('label', { htmlFor: nameId });
          label.append(element('span', { textContent: `声部 ${voiceIndex + 1}` }), element('input', { id: nameId, className: 'text-input voice-name', type: 'text', maxLength: 16, value: voice.name || '' }));
          heading.append(label);
          const notation = element('textarea', { id: `unmetered-${index}-voice-${voiceIndex}-notation`, className: 'text-input notation-input unmetered-notation', rows: 4, maxLength: 20000, value: voice.notation, spellcheck: false });
          notation.setAttribute('aria-label', `间奏 ${index + 1} 声部 ${voiceIndex + 1} 数字谱`);
          notation.setAttribute('aria-describedby', 'unmetered-syntax notation-error');
          notation.setAttribute('autocapitalize', 'off'); notation.setAttribute('autocomplete', 'off');
          editor.append(heading, notation); voices.append(editor);
        });
        card.append(voices);
        return card;
      }));
    }
    function collect() {
      return {
        ...documentData,
        title: $('composer-title').value,
        bpm: Number($('composer-bpm').value),
        meter: $('composer-meter').value.split('/').map(Number),
        instrument: $('composer-instrument').value,
        voices: Array.from($('composer-voices').querySelectorAll('.voice-editor'), section => ({ name: section.querySelector('.voice-name').value, notation: section.querySelector('.notation-input').value })),
        repeats: Array.from($('composer-repeats').querySelectorAll('.repeat-row'), row => Object.fromEntries(Array.from(row.querySelectorAll('input'), input => [input.dataset.repeatField, Number(input.value)]))),
        credits: $('composer-credits').value.split('\n').filter(line => line.trim()),
        ...(hasUnmetered() ? { unmeteredSections: Array.from($('composer-unmetered-sections').querySelectorAll('.unmetered-section'), (section, index) => ({
          ...documentData.unmeteredSections[index],
          title: section.querySelector('[data-section-field="title"]').value,
          afterBar: Number(section.querySelector('[data-section-field="afterBar"]').value),
          description: section.querySelector('[data-section-field="description"]').value,
          voices: Array.from(section.querySelectorAll('.unmetered-voice'), (voice, voiceIndex) => ({ ...documentData.unmeteredSections[index].voices[voiceIndex], name: voice.querySelector('.voice-name').value, notation: voice.querySelector('.unmetered-notation').value })),
        })) } : {}),
      };
    }
    function stop() { root.clearTimeout(timer); timer = null; player.stop('edit'); starting = false; }
    function edited(alreadyCollected = false) {
      stop(); message('');
      if (!alreadyCollected) documentData = collect();
      mutateStore(() => drafts.update(documentData));
      renderDraftList();
      $('composer-play').disabled = true;
      $('composer-export-svg').disabled = true;
      $('composer-summary').textContent = '正在更新预览…';
      timer = root.setTimeout(refreshPreview, 160);
    }
    function fillCurrent() {
      stop(); message('');
      const draft = drafts.current();
      documentData = draft?.document || blankDocument();
      $('composer-title').value = documentData.title ?? '';
      $('composer-bpm').value = documentData.bpm ?? 80;
      const meter = Array.isArray(documentData.meter) ? documentData.meter.join('/') : '4/4';
      if (!Array.from($('composer-meter').options).some(option => option.value === meter)) $('composer-meter').append(new Option(meter, meter));
      $('composer-meter').value = meter;
      $('composer-instrument').value = documentData.instrument || '17C';
      $('composer-credits').value = Array.isArray(documentData.credits) ? documentData.credits.join('\n') : '';
      renderVoices(); renderRepeats(); renderUnmetered(); renderDraftList();
      pageIndex = 0;
      refreshPreview();
      if (drafts.error) storageWarning(drafts.error);
      else $('save-status').textContent = '已自动保存到此浏览器';
    }
    function create(document) { stop(); mutateStore(() => drafts.create(document)); fillCurrent(); }
    function download(blob, filename) {
      const url = root.URL.createObjectURL(blob);
      const anchor = element('a', { href: url, download: filename });
      root.document.body.append(anchor); anchor.click(); anchor.remove();
      root.setTimeout(() => root.URL.revokeObjectURL(url), 10000);
    }

    $('composer-form').addEventListener('submit', event => event.preventDefault());
    $('composer-form').addEventListener('input', () => edited());
    $('composer-form').addEventListener('change', event => { if (event.target.tagName === 'SELECT') edited(); });
    $('new-draft').addEventListener('click', () => { create(blankDocument()); $('composer-title').focus(); $('composer-title').select(); });
    $('new-example').addEventListener('click', () => create(starterDocument()));
    $('duplicate-draft').addEventListener('click', () => { const copy = collect(); copy.title = `${copy.title || '未命名曲谱'} · 副本`.slice(0, 80); create(copy); });
    $('delete-draft').addEventListener('click', () => {
      const current = drafts.current();
      if (!current || !root.confirm(`删除“${current.document.title || '未命名曲谱'}”？此操作无法撤销，请确认已导出需要的备份。`)) return;
      stop(); mutateStore(() => drafts.remove(current.id));
      if (!drafts.current()) mutateStore(() => drafts.create(blankDocument()));
      fillCurrent();
    });
    $('add-voice').addEventListener('click', () => {
      documentData = collect();
      if (documentData.voices.length >= 4) return;
      const count = compiled?.score?.bars.length || 1;
      const barBeats = documentData.meter[0] * 4 / documentData.meter[1];
      documentData.voices.push({ name: `声部 ${documentData.voices.length + 1}`, notation: Array.from({ length: count }, () => `0:${barBeats}`).join(' | ') });
      renderVoices(); edited(true);
      $('composer-voices').querySelector('.voice-editor:last-child textarea').focus();
    });
    $('add-repeat').addEventListener('click', () => {
      documentData = collect();
      documentData.repeats.push({ startBar: 1, endBar: compiled?.score?.bars.length || 1, times: 2 });
      renderRepeats(); edited(true);
    });
    $('composer-play').addEventListener('click', async () => {
      if (player.isPlaying || starting) { player.stop(); starting = false; return; }
      if (timer) refreshPreview();
      if (!compiled?.playbackNotes.length) return;
      starting = true; message('');
      $('composer-play').textContent = '■ 取消启动';
      await player.play(compiled.playbackNotes, { bpm: compiled.document.bpm, totalBeats: compiled.totalBeats, volume: 0.6 });
      starting = false;
    });
    $('composer-previous-page').addEventListener('click', () => showPage(pageIndex - 1));
    $('composer-next-page').addEventListener('click', () => showPage(pageIndex + 1));
    $('composer-page-select').addEventListener('change', () => showPage(Number($('composer-page-select').value)));
    $('composer-export-json').addEventListener('click', () => {
      documentData = collect();
      download(new Blob([JSON.stringify(documentData, null, 2) + '\n'], { type: 'application/json;charset=utf-8' }), `${safeFilename(documentData.title)}.json`);
      message('JSON 已导出；请保留这份文件，以便换设备或再次编辑。');
    });
    $('composer-export-svg').addEventListener('click', () => {
      if (timer) refreshPreview();
      if (!compiled || !pages.length) return;
      try {
        const title = safeFilename(documentData.title);
        const files = pages.map((page, index) => ({ name: `${title}-${String(index + 1).padStart(3, '0')}.svg`, data: root.ScoreRenderer.render(page, renderOptions) }));
        if (files.length === 1) download(new Blob([files[0].data], { type: 'image/svg+xml;charset=utf-8' }), `${title}.svg`);
        else download(root.ScoreExport.zip(files), `${title}-全谱SVG.zip`);
        message(`已导出完整 ${files.length} 页 SVG 曲谱。`);
      } catch (error) { message(error.message || '导出失败，请重试。', true); }
    });
    $('import-json').addEventListener('click', () => $('composer-file').click());
    $('composer-file').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      const generation = ++importGeneration;
      try {
        if (file.size > MAX_IMPORT_BYTES) throw new Error('JSON 文件超过 2 MB，请选择拍间导出的曲谱 JSON。');
        const input = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
        if (generation !== importGeneration) return;
        const imported = restoreDocument(input);
        create(imported);
        message(`已导入“${imported.title || '未命名曲谱'}”，并作为一份新草稿保留。`);
      } catch (error) { if (generation === importGeneration) message(error instanceof SyntaxError ? '文件不是有效的 JSON，请选择导出的曲谱文件。' : error.message, true); }
    });
    root.addEventListener('pagehide', () => { stop(); });
    root.addEventListener('storage', event => {
      if (event.key === DRAFT_KEY || event.key === null) storageWarning(new Error('另一个标签页更新了草稿。请先导出本页 JSON，再刷新查看最新草稿。'));
    });
    if (!drafts.current()) mutateStore(() => drafts.create(starterDocument()));
    fillCurrent();
    const requestedScore = new URL(root.location.href).searchParams.get('score');
    if (requestedScore) {
      const entry = root.CuratedScores?.entries?.find(item => item.id === requestedScore && item.format === 'paijian-score');
      if (!entry || typeof entry.file !== 'string' || !/^scores\/[a-zA-Z0-9_-]+\.json$/.test(entry.file)) {
        message('没有找到这首公开曲谱，请从曲库重新打开。', true);
      } else {
        message('正在载入公开曲谱的可编辑副本…');
        const controller = new AbortController();
        const timeout = root.setTimeout(() => controller.abort(), 15000);
        const generation = ++importGeneration;
        const load = async () => {
          const documents = root.CuratedScores?.documents;
          if (documents && Object.prototype.hasOwnProperty.call(documents, requestedScore)) return root.ScoreDocument.normalize(documents[requestedScore]);
          const response = await root.fetch(new URL(entry.file, root.location.href), { signal: controller.signal });
          if (!response.ok) throw new Error(`公开曲谱加载失败（${response.status}）。`);
          const text = await response.text();
          if (text.length > MAX_IMPORT_BYTES) throw new Error('公开曲谱超过 2 MB，无法载入。');
          return root.ScoreDocument.normalize(JSON.parse(text));
        };
        load().then(imported => {
          if (generation !== importGeneration) return;
          create(imported);
          const cleanUrl = new URL(root.location.href);
          cleanUrl.searchParams.delete('score');
          root.history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
          message(`已创建“${imported.title}”的可编辑副本，修改将保存为你的本地草稿。`);
        }).catch(error => {
          if (generation !== importGeneration) return;
          message(error.name === 'AbortError' ? '公开曲谱加载超时，请稍后重试。' : error instanceof TypeError ? '公开曲谱暂时无法加载，请检查网络后重试。' : error.message || '公开曲谱暂时无法加载，请稍后重试。', true);
        }).finally(() => root.clearTimeout(timeout));
      }
    }
  }

  return { DRAFT_KEY, MAX_IMPORT_BYTES, blankDocument, starterDocument, safeFilename, restoreDocument, createDraftStore, mount };
});
