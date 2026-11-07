(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ScoreExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  'use strict';

  const MAX_FILES = 2048;
  const MAX_BYTES = 256 * 1024 * 1024;
  const UTF8_FLAG = 0x0800;
  const DOS_DATE = 0x0021; // 1980-01-01: valid ZIP timestamp, deterministic exports.
  const encoder = new TextEncoder();
  const crcTable = new Uint32Array(256);
  for (let value = 0; value < 256; value++) {
    let crc = value;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    crcTable[value] = crc >>> 0;
  }

  function tooLarge() {
    return new Error('完整压缩包超过 256 MiB 的本地导出资源上限，已停止整份导出，没有省略任何页面。请改用体积较小的完整 SVG 导出。');
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index++) crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function validName(name) {
    if (typeof name !== 'string' || !name.length) throw new Error('每个导出文件都需要非空文件名。');
    if (/[\\\u0000-\u001f\u007f<>:"|?*]/.test(name)) throw new Error(`导出文件名含有不安全的字符：${name}`);
    const segments = name.split('/');
    if (segments.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
      throw new Error(`导出文件名必须是安全的相对路径，不能包含上级目录或空目录：${name}`);
    }
    if (segments.some(part => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      throw new Error(`导出文件名包含系统保留名称：${name}`);
    }
    for (const character of name) {
      const code = character.charCodeAt(0);
      if (character.length === 1 && code >= 0xd800 && code <= 0xdfff) throw new Error('导出文件名包含无效的 Unicode 字符。');
    }
    // Different spellings that overwrite each other on common filesystems must
    // not silently remove a page when the complete archive is extracted.
    return name.normalize('NFC').toLowerCase();
  }

  function utf8Length(text, budget) {
    if (text.length > budget) throw tooLarge();
    let length = 0;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      if (code < 0x80) length++;
      else if (code < 0x800) length += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
        length += 4; index++;
      } else length += 3; // TextEncoder replaces an unpaired surrogate with U+FFFD.
      if (length > budget) throw tooLarge();
    }
    return length;
  }

  function record(length) {
    const bytes = new Uint8Array(length);
    return { bytes, view: new DataView(bytes.buffer) };
  }

  function zip(files) {
    if (!Array.isArray(files) || !files.length) throw new Error('没有可导出的页面，请先生成完整曲谱。');
    if (files.length > MAX_FILES) throw new Error(`完整导出包含的文件超过 ${MAX_FILES} 个资源上限，已停止整份导出，没有省略任何文件。`);
    const usedNames = new Set();
    const prepared = [];
    let archiveSize = 22; // End-of-central-directory record.

    // Validate the whole archive before copying image data or producing output.
    // Reusing a buffer in many pages cannot bypass the final archive-size limit.
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error(`第 ${index + 1} 个导出文件格式无效。`);
      const name = file.name;
      const key = validName(name);
      if (usedNames.has(key)) throw new Error(`导出文件名重复或在常用文件系统上存在冲突：${name}`);
      usedNames.add(key);
      if (name.length > 65535) throw new Error('导出文件名过长，UTF-8 编码不能超过 65535 字节。');
      const nameBytes = encoder.encode(name);
      if (nameBytes.length > 65535) throw new Error('导出文件名过长，UTF-8 编码不能超过 65535 字节。');
      const overhead = 30 + 46 + 2 * nameBytes.length;
      if (archiveSize + overhead > MAX_BYTES) throw tooLarge();
      const data = file.data;
      let size;
      if (typeof data === 'string') size = utf8Length(data, MAX_BYTES - archiveSize - overhead);
      else if (data instanceof Uint8Array || data instanceof ArrayBuffer) size = data.byteLength;
      else throw new Error(`第 ${index + 1} 个导出文件的数据必须是文本、Uint8Array 或 ArrayBuffer。`);
      archiveSize += overhead + size;
      if (archiveSize > MAX_BYTES) throw tooLarge();
      prepared.push({ nameBytes, data, size });
    }

    const localRecords = [];
    const centralRecords = [];
    let offset = 0;
    let centralSize = 0;
    for (const file of prepared) {
      // Snapshot precisely the provided view, preserving neither neighboring
      // buffer bytes nor later mutations to the caller's source data.
      const data = typeof file.data === 'string' ? encoder.encode(file.data)
        : file.data instanceof Uint8Array ? file.data.slice()
          : new Uint8Array(file.data.slice(0));
      if (data.byteLength !== file.size) throw new Error('导出文件的数据在生成期间发生变化，已停止整份导出，请重新尝试。');
      const checksum = crc32(data);
      const local = record(30 + file.nameBytes.length);
      local.view.setUint32(0, 0x04034b50, true);
      local.view.setUint16(4, 20, true);
      local.view.setUint16(6, UTF8_FLAG, true);
      local.view.setUint16(10, 0, true);
      local.view.setUint16(12, DOS_DATE, true);
      local.view.setUint32(14, checksum, true);
      local.view.setUint32(18, file.size, true);
      local.view.setUint32(22, file.size, true);
      local.view.setUint16(26, file.nameBytes.length, true);
      local.bytes.set(file.nameBytes, 30);

      const central = record(46 + file.nameBytes.length);
      central.view.setUint32(0, 0x02014b50, true);
      central.view.setUint16(4, 20, true);
      central.view.setUint16(6, 20, true);
      central.view.setUint16(8, UTF8_FLAG, true);
      central.view.setUint16(12, 0, true);
      central.view.setUint16(14, DOS_DATE, true);
      central.view.setUint32(16, checksum, true);
      central.view.setUint32(20, file.size, true);
      central.view.setUint32(24, file.size, true);
      central.view.setUint16(28, file.nameBytes.length, true);
      central.view.setUint32(38, 0x20, true);
      central.view.setUint32(42, offset, true);
      central.bytes.set(file.nameBytes, 46);

      localRecords.push(local.bytes, data);
      centralRecords.push(central.bytes);
      offset += local.bytes.length + data.length;
      centralSize += central.bytes.length;
    }

    const end = record(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, prepared.length, true);
    end.view.setUint16(10, prepared.length, true);
    end.view.setUint32(12, centralSize, true);
    end.view.setUint32(16, offset, true);
    const archive = new Blob([...localRecords, ...centralRecords, end.bytes], { type: 'application/zip' });
    if (archive.size !== archiveSize) throw new Error('完整压缩包大小校验失败，已停止整份导出，请重新尝试。');
    return archive;
  }

  return { zip };
});
