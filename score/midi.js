(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KalimbaMidi = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const MAX_BYTES = 20 * 1024 * 1024;
  const MAX_TRACKS = 256;
  const MAX_NOTES = 100000;

  class Reader {
    constructor(bytes, start = 0, end = bytes.length) {
      this.bytes = bytes;
      this.position = start;
      this.end = end;
    }

    ensure(length) {
      if (!Number.isInteger(length) || length < 0 || length > this.end - this.position) {
        throw new Error('MIDI 文件数据不完整：音轨、事件或数据块被截断。请重新导出文件。');
      }
    }

    byte() { this.ensure(1); return this.bytes[this.position++]; }
    uint16() { return this.byte() * 256 + this.byte(); }
    uint32() { return this.byte() * 0x1000000 + this.byte() * 0x10000 + this.byte() * 256 + this.byte(); }
    text4() { return String.fromCharCode(this.byte(), this.byte(), this.byte(), this.byte()); }

    take(length) {
      this.ensure(length);
      const result = this.bytes.subarray(this.position, this.position + length);
      this.position += length;
      return result;
    }

    vlq() {
      let result = 0;
      for (let i = 0; i < 4; i++) {
        const byte = this.byte();
        result = result * 128 + (byte & 0x7f);
        if (!(byte & 0x80)) return result;
      }
      throw new Error('MIDI 文件包含超过 4 字节的可变长度数值，格式无效。');
    }

    dataByte() {
      const value = this.byte();
      if (value >= 0x80) throw new Error('MIDI 音符事件的数据字节无效，文件可能已损坏。');
      return value;
    }
  }

  function decodeName(bytes) {
    let value;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (_) { value = new TextDecoder('windows-1252').decode(bytes); }
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 160);
  }

  function parseMidi(input) {
    let bytes;
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else throw new TypeError('请提供 MIDI 文件的 ArrayBuffer 或 Uint8Array 数据。');
    if (bytes.byteLength > MAX_BYTES) throw new Error('MIDI 超过本地处理的 20 MiB 资源上限，已拒绝整个文件。可重新导出完整旋律音轨，去掉不需要的伴奏和扩展数据。');

    const reader = new Reader(bytes);
    if (reader.text4() !== 'MThd') throw new Error('这不是标准 MIDI 文件。请选择从制谱软件导出的 .mid 或 .midi 文件。');
    const headerLength = reader.uint32();
    if (headerLength < 6) throw new Error('MIDI 文件头长度无效，至少需要 6 字节。');
    reader.ensure(headerLength);
    const headerEnd = reader.position + headerLength;
    const format = reader.uint16();
    const trackCount = reader.uint16();
    const division = reader.uint16();
    if (format === 2) throw new Error('暂不支持 MIDI 格式 2。请在制谱软件中重新导出为格式 0 或格式 1。');
    if (format !== 0 && format !== 1) throw new Error('MIDI 文件格式编号无效；仅支持标准格式 0 和格式 1。');
    if (!trackCount || trackCount > MAX_TRACKS) throw new Error('MIDI 音轨数量需在 1–256 条之间，当前文件未导入。可重新导出完整旋律音轨，去掉不需要的伴奏。');
    if (format === 0 && trackCount !== 1) throw new Error('MIDI 格式 0 应当只包含一条音轨，文件头无效。');
    if (division & 0x8000) throw new Error('暂不支持 SMPTE 时间码 MIDI。请重新导出为按拍计时（PPQ）的 MIDI 文件。');
    if (!division) throw new Error('MIDI 的每四分音符刻度数（PPQ）不能为零。');
    reader.position = headerEnd;

    const ppq = division;
    const sources = [];
    const warnings = [];
    const meta = { tempo: null, meter: null, laterTempo: false, laterMeter: false, conflictingTempo: false, conflictingMeter: false };
    const counts = { attacks: 0, orphanOffs: 0, unclosed: 0, zeroDuration: 0, groups: 0 };
    let sustainUsed = false;
    let programChanged = false;
    let unknownChunks = false;

    function parseTrack(trackReader, sourceIndex) {
      const source = { name: '', channels: new Map(), endTick: 0, noteEndTick: 0 };
      const programs = Array(16).fill(0);
      const pending = Array.from({ length: 16 }, () => new Map());
      let tick = 0;
      let runningStatus = 0;
      let ended = false;

      function groupFor(channel) {
        if (!source.channels.has(channel)) {
          if (++counts.groups > MAX_TRACKS) throw new Error('按通道拆分后超过 256 条音轨，达到本地处理的资源上限，已拒绝整个文件。可重新导出完整旋律音轨，去掉不需要的伴奏。');
          source.channels.set(channel, { channel, program: programs[channel], notes: [] });
        }
        return source.channels.get(channel);
      }

      while (trackReader.position < trackReader.end) {
        tick += trackReader.vlq();
        if (!Number.isSafeInteger(tick)) throw new Error('MIDI 时间超出可精确处理的数值范围，已拒绝整个文件。请从制谱软件重新导出完整旋律音轨，并检查时间设置。');
        let status = trackReader.byte();
        if (status < 0x80) {
          if (!runningStatus) throw new Error(`第 ${sourceIndex + 1} 条 MIDI 音轨缺少事件状态字节。`);
          trackReader.position--;
          status = runningStatus;
        } else if (status < 0xf0) runningStatus = status;
        else runningStatus = 0;

        if (status === 0xff) {
          const type = trackReader.byte();
          if (type >= 0x80) throw new Error('MIDI 元事件类型无效，文件可能已损坏。');
          const data = trackReader.take(trackReader.vlq());
          if (type === 0x2f) {
            if (data.length !== 0) throw new Error('MIDI 音轨结束标记的长度必须为零。');
            if (trackReader.position !== trackReader.end) throw new Error(`第 ${sourceIndex + 1} 条音轨在结束标记后仍有数据，请重新导出 MIDI。`);
            source.endTick = tick;
            ended = true;
            break;
          }
          if (type === 0x03 && !source.name) source.name = decodeName(data);
          if (type === 0x51) {
            if (data.length !== 3) throw new Error('MIDI 速度事件必须包含 3 字节。');
            const micros = data[0] * 65536 + data[1] * 256 + data[2];
            if (!micros) throw new Error('MIDI 速度事件的每拍时长不能为零。');
            if (tick === 0) {
              if (meta.tempo === null) meta.tempo = micros;
              else if (meta.tempo !== micros) meta.conflictingTempo = true;
            } else meta.laterTempo = true;
          }
          if (type === 0x58) {
            if (data.length !== 4) throw new Error('MIDI 拍号事件必须包含 4 字节。');
            if (!data[0] || data[1] > 7) throw new Error('MIDI 拍号无效或分母超过 128，请导出常用拍号。');
            const meter = [data[0], 2 ** data[1]];
            if (tick === 0) {
              if (meta.meter === null) meta.meter = meter;
              else if (meta.meter[0] !== meter[0] || meta.meter[1] !== meter[1]) meta.conflictingMeter = true;
            } else meta.laterMeter = true;
          }
          continue;
        }
        if (status === 0xf0 || status === 0xf7) {
          trackReader.take(trackReader.vlq());
          continue;
        }
        if (status >= 0xf0) throw new Error(`MIDI 包含不受支持的系统事件 0x${status.toString(16).toUpperCase()}，请重新导出标准 MIDI。`);

        const command = status >> 4;
        const channel = status & 0x0f;
        const first = trackReader.dataByte();
        const second = command === 0x0c || command === 0x0d ? null : trackReader.dataByte();
        if (command === 0x0c) { programs[channel] = first; continue; }
        if (command === 0x0b && first === 64) sustainUsed = true;
        if (command === 0x09 && second > 0) {
          if (++counts.attacks > MAX_NOTES) throw new Error('MIDI 起音超过 100,000 个，达到本地处理的资源上限，已拒绝整个文件。可重新导出完整旋律音轨，去掉不需要的伴奏。');
          const group = groupFor(channel);
          if (group.program !== programs[channel]) programChanged = true;
          let queue = pending[channel].get(first);
          if (!queue) { queue = { entries: [], head: 0 }; pending[channel].set(first, queue); }
          queue.entries.push({ tick, velocity: second / 127 });
        } else if (command === 0x08 || (command === 0x09 && second === 0)) {
          const queue = pending[channel].get(first);
          if (!queue || queue.head >= queue.entries.length) { counts.orphanOffs++; continue; }
          // MIDI permits overlapping attacks of the same pitch. Match releases FIFO.
          const attack = queue.entries[queue.head++];
          if (queue.head === queue.entries.length) pending[channel].delete(first);
          if (tick === attack.tick) { counts.zeroDuration++; continue; }
          groupFor(channel).notes.push({ midi: first, start: attack.tick / ppq, duration: (tick - attack.tick) / ppq, velocity: attack.velocity });
          source.noteEndTick = Math.max(source.noteEndTick, tick);
        }
      }
      if (!ended) throw new Error(`第 ${sourceIndex + 1} 条 MIDI 音轨缺少结束标记，文件可能不完整。`);
      for (const pitches of pending) for (const queue of pitches.values()) counts.unclosed += queue.entries.length - queue.head;
      return source;
    }

    while (reader.position < reader.end) {
      const kind = reader.text4();
      const length = reader.uint32();
      reader.ensure(length);
      if (kind === 'MTrk') {
        if (sources.length >= trackCount) throw new Error('MIDI 的实际音轨数量超过文件头声明，文件格式无效。');
        sources.push(parseTrack(new Reader(bytes, reader.position, reader.position + length), sources.length));
      } else unknownChunks = true;
      reader.position += length;
    }
    if (sources.length !== trackCount) throw new Error('MIDI 的音轨数量不足，文件可能被截断。');
    if (counts.unclosed || counts.zeroDuration) {
      const issues = [];
      if (counts.unclosed) issues.push(`${counts.unclosed} 个缺少结束事件的音符`);
      if (counts.zeroDuration) issues.push(`${counts.zeroDuration} 个时值为零的音符`);
      throw new Error(`MIDI 源文件含有 ${issues.join('、')}，无法确定这些音符的完整时值，已拒绝整个文件。请在制谱软件中修复后重新导出完整旋律音轨。`);
    }

    // Source EOT is part of the musical timeline, even when a conductor or drum
    // track carries its longest trailing rest and does not become a melody track.
    const totalBeats = sources.reduce((latest, source) => Math.max(latest, source.endTick, source.noteEndTick), 0) / ppq;

    const tracks = sources.flatMap((source, sourceIndex) => Array.from(source.channels.values())
      .filter(group => group.notes.length)
      .map(group => ({
        id: `${sourceIndex}:${group.channel}`,
        name: `${source.name || `音轨 ${sourceIndex + 1}`} · ${group.channel === 9 ? '打击乐' : `通道 ${group.channel + 1}`}`,
        channel: group.channel,
        program: group.program,
        isPercussion: group.channel === 9,
        endBeat: Math.max(source.endTick, source.noteEndTick) / ppq,
        notes: group.notes.sort((a, b) => a.start - b.start || a.midi - b.midi || a.duration - b.duration),
      })));
    if (!tracks.length) throw new Error('MIDI 中没有可读取的完整音符，请导出含有旋律音符及结束时间的 MIDI 文件。');
    if (tracks.every(track => track.isPercussion)) warnings.push('文件只包含打击乐通道，没有可用于卡林巴转谱的旋律音轨。');
    else if (tracks.some(track => track.isPercussion)) warnings.push('检测到打击乐通道，转谱时请选择旋律音轨。');
    if (meta.conflictingTempo) warnings.push('起点包含不同的速度设置，已使用文件中首个起始速度。');
    if (meta.laterTempo) warnings.push(meta.tempo === null
      ? '文件未在起点设置速度，已使用默认 120 BPM；后续速度事件未应用。'
      : '文件包含途中速度事件，练习统一使用起始速度，未应用后续变速。');
    if (meta.conflictingMeter) warnings.push('起点包含不同的拍号设置，已使用文件中首个起始拍号。');
    if (meta.laterMeter) warnings.push(meta.meter === null
      ? '文件未在起点设置拍号，已使用默认 4/4 拍；后续拍号事件未应用。'
      : '文件包含途中拍号事件，转谱统一使用起始拍号，未应用后续变化。');
    if (sustainUsed) warnings.push('检测到延音踏板事件；已按按键松开时间计算时值，未延长延音。');
    if (programChanged) warnings.push('部分通道包含途中音色变化，音轨信息仅记录首个音符使用的音色。');
    if (counts.orphanOffs) warnings.push(`源文件有 ${counts.orphanOffs} 个没有对应起音的结束事件，无法判断是否缺失原始音符；这些孤立事件未转为音符，结果不能保证与完整原谱一致，请核对源文件。`);
    if (unknownChunks) warnings.push('已忽略 MIDI 中的非音轨扩展数据块。');

    return {
      format,
      ppq,
      title: sources.find(source => source.name)?.name || '未命名 MIDI',
      tempo: meta.tempo === null ? 120 : 60000000 / meta.tempo,
      timeSignature: meta.meter || [4, 4],
      totalBeats,
      tracks,
      warnings,
    };
  }

  return { parseMidi };
});
