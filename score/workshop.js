(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  let score;
  let svgText = '';
  let state;
  let starting = false;
  let playGeneration = 0;
  let importGeneration = 0;
  let activeSource = null;
  let activeNoteEnd = Infinity;
  let activeGroups = [];
  let renderOptions;
  const player = new ScorePlayer({ onNote: highlight, onProgress: progress, onStateChange: playbackState, onError: (error) => message(error.message || '试听暂时无法启动，请重试。') });

  function message(value, kind = 'error') {
    $('workshop-message').textContent = value;
    $('workshop-message').hidden = !value;
    $('workshop-message').dataset.kind = kind;
  }
  function seconds(beats) { return beats * 60 / state.bpm; }
  function clock(value) { return `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`; }
  function progress({ beat, totalBeats }) {
    if (beat >= activeNoteEnd - 1e-7) clearHighlight();
    $('playback-progress').max = totalBeats || 1;
    $('playback-progress').value = beat;
    $('playback-time').textContent = `${clock(seconds(beat))} / ${clock(seconds(totalBeats))}`;
    if (player.isPlaying && score) $('playback-status').textContent = `正在试听 · 第 ${Math.min(score.bars.length, Math.floor(beat / score.barBeats) + 1)} / ${score.bars.length} 小节`;
  }
  function clearHighlight() {
    activeGroups.forEach((group) => group.classList.remove('is-active'));
    activeGroups = []; activeSource = null; activeNoteEnd = Infinity;
  }
  function highlight({ note }) {
    if (activeSource === note.sourceId) return;
    clearHighlight(); activeSource = note.sourceId;
    activeNoteEnd = note.start + note.duration;
    activeGroups = Array.from($('score-preview').querySelectorAll('[data-source-id]')).filter((group) => group.dataset.sourceId === note.sourceId);
    activeGroups.forEach((group) => group.classList.add('is-active'));
    const bar = Math.floor(note.start / score.barBeats) + 1;
    $('playback-status').textContent = `正在试听 · 第 ${bar} / ${score.bars.length} 小节`;
  }
  function playbackState({ state: playback, reason }) {
    const playing = playback === 'playing';
    $('score-play').setAttribute('aria-pressed', String(playing));
    $('play-glyph').textContent = playing ? '■' : '▶';
    $('play-label').textContent = playing ? '停止试听' : '试听旋律';
    if (!playing) {
      clearHighlight();
      $('playback-status').textContent = reason === 'ended' ? '试听结束，可以跟着谱慢慢练习。' : '已停止 · 再次试听将从头开始。';
      if (reason === 'interrupted' || reason === 'stalled') message('浏览器或音频设备中断了试听。请保持页面在前台，再点击“试听旋律”重新开始。');
    }
  }
  function stop() {
    playGeneration++; starting = false; player.stop();
    $('score-play').removeAttribute('aria-busy');
  }
  async function togglePlayback() {
    if (player.isPlaying || starting) { stop(); return; }
    message(''); starting = true;
    const generation = ++playGeneration;
    $('score-play').setAttribute('aria-busy', 'true');
    $('play-label').textContent = '准备声音…';
    try { await player.play(score.notes, { bpm: state.bpm, volume: .55, totalBeats: score.totalBeats }); }
    catch (error) { message(error.message || '无法启动音频，请在新版浏览器中重试。'); }
    finally {
      if (generation === playGeneration) {
        starting = false; $('score-play').removeAttribute('aria-busy');
        $('play-label').textContent = player.isPlaying ? '停止试听' : '试听旋律';
      }
    }
  }

  function controls() {
    $('score-name').value = state.title;
    $('instrument-select').value = state.instrument;
    document.querySelector('.workshop-intro .instrument-tag').textContent = `${state.instrument === '21C' ? '21' : '17'} 音 C 调 · 旋律转谱`;
    $('score-bpm').value = state.bpm;
    $('transpose').value = state.transpose;
    const meter = state.meter.join('/');
    const custom = $('score-meter').querySelector('[value="custom"]');
    custom.hidden = ['2/4', '3/4', '4/4', '6/8'].includes(meter);
    custom.textContent = `${meter} · 源文件拍号`;
    $('score-meter').value = custom.hidden ? meter : 'custom';
    $('track-field').hidden = !state.tracks;
    $('source-label').textContent = state.source;
    if (state.tracks) {
      $('example-select').value = '';
      $('track-select').replaceChildren(...state.tracks.map((track) => {
        const option = document.createElement('option');
        option.value = track.id;
        option.textContent = `${track.name || '未命名音轨'} · ${track.notes.length} 音`;
        return option;
      }));
      $('track-select').value = state.trackId;
    } else $('example-select').value = state.exampleId;
  }
  function warnings() {
    const list = [...new Set([...(state.warnings || []), ...score.warnings.filter((item) => !item.includes('原音高已保留并标注'))])];
    if (score.stats.unplayable) list.unshift(`${score.stats.unplayable} 个旋律音在当前琴型上无法直接弹奏，已标为橙色。试听保留这些原始音高；请尝试移调或人工改编。`);
    $('score-warnings').replaceChildren();
    if (!list.length) {
      const ok = document.createElement('p'); ok.className = 'all-playable';
      ok.textContent = `✓ ${score.stats.outputNotes} 个旋律音均在当前琴型的可弹奏音域内。`;
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
    renderOptions = { title: state.title, bpm: state.bpm, instrument: state.instrument, meter: state.meter, subtitle: state.subtitle };
    svgText = ScoreRenderer.render(score, renderOptions);
    $('score-preview').innerHTML = svgText;
    $('score-summary').textContent = `${score.stats.outputNotes} 个音符 · ${score.bars.length} 小节`;
    $('playback-status').textContent = '准备好，从第一小节开始。';
    controls(); warnings(); progress({ beat: 0, totalBeats: score.totalBeats });
    document.title = `${state.title} · 卡林巴数字谱 · 拍间`;
  }
  function apply(next) {
    const candidate = { ...state, ...next };
    try {
      const result = KalimbaScore.buildScore(candidate.notes, { instrument: candidate.instrument, transpose: candidate.transpose, meter: candidate.meter, grid: .25 });
      stop(); state = candidate; score = result; render(); message(''); return true;
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
    apply({ title: data.title, subtitle: data.subtitle, notes: data.notes, source: data.source, bpm: data.bpm, meter: data.meter, transpose: 0, instrument: state?.instrument || '17C', tracks: null, trackId: null, exampleId: data.id, warnings: [] });
  }
  async function importFile(file) {
    if (!file) return;
    const generation = ++importGeneration;
    $('upload-zone').removeAttribute('aria-busy');
    if (file.size > 5 * 1024 * 1024) { message('文件超过 5 MB。请先导出需要的旋律音轨，再导入。'); return; }
    if (!/\.midi?$/i.test(file.name)) { message('请选择 .mid 或 .midi 文件。MP3、WAV 等录音不能直接作为 MIDI 转谱。'); return; }
    $('upload-zone').setAttribute('aria-busy', 'true');
    message('正在读取 MIDI…', 'success');
    try {
      const data = await file.arrayBuffer();
      if (generation !== importGeneration) return;
      const midi = KalimbaMidi.parseMidi(data);
      const tracks = midi.tracks.filter((track) => !track.isPercussion && track.channel !== 9 && track.notes.length);
      if (!tracks.length) throw new Error('这个 MIDI 只有打击乐或没有完整的旋律音符。请换一个包含主旋律的 MIDI。');
      const chosen = tracks.find((track) => /melody|lead|vocal|主旋律|旋律/i.test(track.name)) || tracks[0];
      const bpm = clamp(Math.round(midi.tempo), 30, 240);
      const importWarnings = [...midi.warnings];
      if (Math.round(midi.tempo) !== bpm) importWarnings.push(`原速度 ${Math.round(midi.tempo)} BPM 超出试听范围，已设为 ${bpm} BPM；谱面音符时值不变。`);
      const title = file.name.replace(/\.midi?$/i, '').slice(0, 80) || midi.title || '导入曲谱';
      if (apply({ title, subtitle: 'MIDI 旋律转谱 · 十六分音符网格', notes: chosen.notes, source: `已导入：${file.name} · ${tracks.length} 条可选音轨`, bpm, meter: midi.timeSignature, transpose: 0, instrument: state.instrument, tracks, trackId: chosen.id, exampleId: null, warnings: importWarnings })) {
        message(`已生成「${title}」的数字谱。${tracks.length > 1 ? '请试听并确认所选音轨为主旋律。' : '可以试听核对，再导出图片。'}`, 'success');
      }
    } catch (error) { if (generation === importGeneration) message(error.message || '读取失败，请检查 MIDI 文件是否完整。'); }
    finally { if (generation === importGeneration) $('upload-zone').removeAttribute('aria-busy'); }
  }
  function filename(extension) {
    return `${state.title.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim().slice(0, 70) || '卡林巴曲谱'}-数字谱.${extension}`;
  }
  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = name;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  async function exportPng() {
    const button = $('export-png'); button.disabled = true;
    const content = svgText;
    const name = filename('png');
    const url = URL.createObjectURL(new Blob([content], { type: 'image/svg+xml;charset=utf-8' }));
    try {
      const image = new Image();
      await new Promise((resolve, reject) => { image.onload = resolve; image.onerror = reject; image.src = url; });
      // Bound canvas dimensions and memory for long scores; small scores export at 2x.
      const scale = Math.min(2, 16000 / image.height, Math.sqrt(24000000 / (image.width * image.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('当前浏览器无法生成图片。');
      ctx.fillStyle = '#fffefb'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('图片过大，请改为导出 SVG。');
      download(blob, name);
    } catch (error) { message(error?.message || '图片导出失败，请使用 SVG 导出。'); }
    finally { URL.revokeObjectURL(url); button.disabled = false; }
  }
  function printScore() {
    stop();
    const pages = [];
    let bars = [];
    for (const bar of score.bars) {
      const candidate = [...bars, bar];
      const rendered = ScoreRenderer.render({ ...score, bars: candidate }, renderOptions);
      const height = Number(rendered.match(/height="([\d.]+)"/)[1]);
      if (height > 1380 && bars.length) { pages.push(bars); bars = [bar]; }
      else bars = candidate;
    }
    if (bars.length) pages.push(bars);
    $('print-scores').replaceChildren(...pages.map((pageBars, index) => {
      const page = document.createElement('div'); page.className = 'print-page';
      page.innerHTML = ScoreRenderer.render({ ...score, bars: pageBars }, { ...renderOptions, subtitle: `${state.subtitle} · 第 ${index + 1} / ${pages.length} 页` });
      return page;
    }));
    window.print();
  }

  $('example-select').addEventListener('change', (event) => example(event.target.value));
  $('midi-file').addEventListener('change', (event) => { importFile(event.target.files[0]); event.target.value = ''; });
  $('upload-zone').addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('dragging'); });
  $('upload-zone').addEventListener('dragleave', (event) => { if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.classList.remove('dragging'); });
  $('upload-zone').addEventListener('drop', (event) => { event.preventDefault(); event.currentTarget.classList.remove('dragging'); importFile(event.dataTransfer.files[0]); });
  window.addEventListener('dragover', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  window.addEventListener('drop', (event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
  $('track-select').addEventListener('change', (event) => {
    const track = state.tracks?.find((item) => item.id === event.target.value);
    if (track) apply({ notes: track.notes, trackId: track.id });
  });
  $('instrument-select').addEventListener('change', (event) => apply({ instrument: event.target.value }));
  $('score-meter').addEventListener('change', (event) => { if (event.target.value !== 'custom') apply({ meter: event.target.value.split('/').map(Number) }); });
  $('transpose').addEventListener('change', (event) => {
    const raw = event.target.value;
    if (!raw.trim() || !Number.isFinite(Number(raw))) { controls(); return; }
    apply({ transpose: clamp(Math.round(Number(raw)), -24, 24) });
  });
  $('suggest-transpose').addEventListener('click', () => {
    try {
      const suggestion = KalimbaScore.suggestTranspose(state.notes, state.instrument);
      if (apply({ transpose: suggestion.transpose })) message(`已整体${suggestion.transpose === 0 ? '保留原调' : `${suggestion.transpose > 0 ? '升' : '降'} ${Math.abs(suggestion.transpose)} 个半音`}。生成旋律中 ${score.stats.outputNotes - score.stats.unplayable} / ${score.stats.outputNotes} 个音可直接弹奏。`, 'success');
    } catch (error) { message(error.message); }
  });
  $('score-bpm').addEventListener('change', (event) => {
    const raw = event.target.value;
    if (!raw.trim() || !Number.isFinite(Number(raw))) { controls(); return; }
    apply({ bpm: clamp(Math.round(Number(raw)), 30, 240) });
  });
  $('score-name').addEventListener('change', (event) => apply({ title: event.target.value.trim().slice(0, 80) || '未命名曲谱' }));
  $('score-play').addEventListener('click', togglePlayback);
  $('export-svg').addEventListener('click', () => download(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }), filename('svg')));
  $('export-png').addEventListener('click', exportPng);
  $('print-score').addEventListener('click', printScore);
  window.addEventListener('pagehide', stop);
  example('twinkle');
})();
