const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { zip } = require('../score/export.js');

async function bytes(blob) { return Buffer.from(await blob.arrayBuffer()); }

// Read using the central directory, independently of the writer's local-record
// order, then cross-check the corresponding local headers and payload bounds.
function inspect(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50);
  assert.equal(buffer.readUInt16LE(end + 4), 0);
  assert.equal(buffer.readUInt16LE(end + 6), 0);
  const count = buffer.readUInt16LE(end + 10);
  assert.equal(buffer.readUInt16LE(end + 8), count);
  let cursor = buffer.readUInt32LE(end + 16);
  const centralEnd = cursor + buffer.readUInt32LE(end + 12);
  assert.equal(centralEnd, end);
  const files = [];
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    assert.equal(buffer.readUInt16LE(cursor + 8), 0x0800);
    assert.equal(buffer.readUInt16LE(cursor + 10), 0);
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 24);
    assert.equal(buffer.readUInt32LE(cursor + 20), size);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const local = buffer.readUInt32LE(cursor + 42);
    assert.equal(buffer.readUInt32LE(local), 0x04034b50);
    assert.equal(buffer.readUInt16LE(local + 6), 0x0800);
    assert.equal(buffer.readUInt16LE(local + 8), 0);
    assert.equal(buffer.readUInt32LE(local + 14), crc);
    assert.equal(buffer.readUInt32LE(local + 18), size);
    assert.equal(buffer.readUInt32LE(local + 22), size);
    assert.equal(buffer.readUInt16LE(local + 26), nameLength);
    assert.equal(buffer.subarray(local + 30, local + 30 + nameLength).toString('utf8'), name);
    const dataStart = local + 30 + nameLength + buffer.readUInt16LE(local + 28);
    assert.ok(dataStart + size <= buffer.readUInt32LE(end + 16));
    files.push({ name, crc, data: buffer.subarray(dataStart, dataStart + size), dataStart });
    cursor += 46 + nameLength + buffer.readUInt16LE(cursor + 30) + buffer.readUInt16LE(cursor + 32);
  }
  assert.equal(cursor, centralEnd);
  return files;
}

function pythonZip(buffer, script, t) {
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', script], { input: buffer, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error?.code === 'ENOENT') { t.skip('Python is unavailable; independent ZIP structure tests still run.'); return null; }
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('UTF-8 Chinese names, binary views, strings and empty files survive exact complete export', async () => {
  const original = Uint8Array.from([77, 0, 255, 128, 42, 88]);
  const files = [
    { name: '完整曲谱/第一页.png', data: original.subarray(1, 5) },
    { name: '完整曲谱/第二页.svg', data: '<svg>卡林巴 🎵</svg>' },
    { name: '说明.txt', data: new ArrayBuffer(0) },
  ];
  const blob = zip(files);
  assert.equal(blob.type, 'application/zip');
  assert.deepEqual(Array.from(original), [77, 0, 255, 128, 42, 88]);
  original.fill(1);
  const decoded = inspect(await bytes(blob));
  assert.deepEqual(decoded.map(f => f.name), files.map(f => f.name));
  assert.deepEqual([...decoded[0].data], [0, 255, 128, 42]);
  assert.equal(decoded[1].data.toString('utf8'), files[1].data);
  assert.equal(decoded[2].data.length, 0);
});

test('CRC32 matches the standard check vector and empty-file checksum', async () => {
  const decoded = inspect(await bytes(zip([{ name: 'check.txt', data: '123456789' }, { name: 'empty.txt', data: '' }])));
  assert.equal(decoded[0].crc, 0xcbf43926);
  assert.equal(decoded[1].crc, 0);
});

test('Python zipfile reads every Unicode file and validates all CRCs', async t => {
  const buffer = await bytes(zip([
    { name: '卡林巴/第 001 页.png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 255]) },
    { name: '卡林巴/第 002 页.svg', data: '<svg>完整旋律</svg>' },
  ]));
  const result = pythonZip(buffer, 'import sys, io, zipfile, json\nz = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nprint(json.dumps({"bad": z.testzip(), "names": z.namelist(), "files": [z.read(n).hex() for n in z.namelist()], "methods": [i.compress_type for i in z.infolist()]}))', t);
  if (!result) return;
  assert.equal(result.bad, null);
  assert.deepEqual(result.names, ['卡林巴/第 001 页.png', '卡林巴/第 002 页.svg']);
  assert.deepEqual(result.files, ['89504e4700ff', Buffer.from('<svg>完整旋律</svg>').toString('hex')]);
  assert.deepEqual(result.methods, [0, 0]);
});

test('stored CRC enables an independent reader to detect corrupted page bytes', async t => {
  const buffer = await bytes(zip([{ name: '完整曲谱.png', data: Uint8Array.from([1, 2, 3, 4]) }]));
  const file = inspect(buffer)[0];
  buffer[file.dataStart + 1] ^= 0xff;
  const result = pythonZip(buffer, 'import sys, io, zipfile, json\nz = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))\nprint(json.dumps({"bad": z.testzip()}))', t);
  if (result) assert.equal(result.bad, '完整曲谱.png');
});

test('empty input, malformed files and unsupported data fail before output', () => {
  for (const value of [undefined, null, {}, []]) assert.throws(() => zip(value), /没有可导出/);
  for (const value of [null, [], 1]) assert.throws(() => zip([value]), /文件格式/);
  assert.throws(() => zip(new Array(1)), /文件格式/);
  assert.throws(() => zip([{ name: '', data: '' }]), /非空文件名/);
  assert.throws(() => zip([{ name: 'page.png', data: { length: 5 } }]), /数据必须/);
  assert.throws(() => zip([{ name: 'page.png', data: new DataView(new ArrayBuffer(4)) }]), /数据必须/);
});

test('path traversal, absolute names and extraction aliases are rejected', () => {
  const invalid = ['../page.png', '曲谱/../../page.svg', '/page.svg', 'C:/page.svg', 'C:page.svg', '\\\\server\\page.svg', '曲谱\\page.svg', './page.svg', '曲谱//page.svg', '曲谱/', 'page\0.svg', 'page\n.svg', 'CON.png', '曲谱/NUL', 'page.svg ', 'page.svg.', 'bad\ud800.svg'];
  for (const name of invalid) assert.throws(() => zip([{ name, data: '' }]), undefined, name);
  assert.throws(() => zip([{ name: '第1页.png', data: '' }, { name: '第1页.png', data: '' }]), /重复/);
  assert.throws(() => zip([{ name: 'Page.png', data: '' }, { name: 'page.png', data: '' }]), /冲突/);
  assert.throws(() => zip([{ name: 'é.png', data: '' }, { name: 'e\u0301.png', data: '' }]), /冲突/);
});

test('ZIP filename byte limits are checked for multibyte names', () => {
  assert.throws(() => zip([{ name: 'a'.repeat(65536), data: '' }]), /65535/);
  assert.throws(() => zip([{ name: '谱'.repeat(21846), data: '' }]), /65535/);
});

test('2048 pages are retained and a 2049th page rejects the entire archive', async () => {
  const files = Array.from({ length: 2048 }, (_, index) => ({ name: `曲谱/第${index + 1}页.svg`, data: String(index) }));
  const decoded = inspect(await bytes(zip(files)));
  assert.equal(decoded.length, 2048);
  assert.equal(decoded[0].data.toString(), '0');
  assert.equal(decoded.at(-1).data.toString(), '2047');
  assert.throws(() => zip([...files, { name: 'extra.svg', data: '' }]), /2048/);
});

test('256 MiB resource bound counts every reused payload plus ZIP overhead without partial output', () => {
  const shared = new Uint8Array(128 * 1024);
  const files = Array.from({ length: 2048 }, (_, index) => ({ name: `${index}.png`, data: shared }));
  assert.throws(() => zip(files), error => /256 MiB/.test(error.message) && /没有省略任何页面/.test(error.message));
  assert.equal(shared.length, 128 * 1024);
  assert.equal(shared[0], 0);
});

test('identical input produces deterministic complete archives', async () => {
  const files = [{ name: '完整.svg', data: '<svg>全曲</svg>' }];
  assert.deepEqual(await bytes(zip(files)), await bytes(zip(files)));
});
