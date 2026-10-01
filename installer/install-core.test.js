/*
 * 安装核心逻辑测试。
 *
 * 这些是"秒关秒装"里最容易出错的部分，而且一旦错了后果很严重
 * （跳过判定错 → 装完是坏的；参数解析错 → 静默模式跑到用户目录上）。
 * 所以都在这里用纯逻辑测掉，不必真上 Windows 装一遍。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('./install-core.js');

/* ================= 隐藏的静默触发接口 ================= */

test('默认（不带参数）不是静默模式：正常双击安装仍然出界面', () => {
  const a = core.parseSilentArgs(['BLFP-Setup.exe']);
  assert.equal(a.silent, false);
  assert.equal(a.shortcuts, true, '默认应该创建快捷方式');
});

test('识别隐藏的静默触发参数', () => {
  const a = core.parseSilentArgs(['BLFP-Setup.exe', core.SILENT_FLAG]);
  assert.equal(a.silent, true);
});

test('兼容旧别名 --blfp-silent-install', () => {
  assert.equal(core.parseSilentArgs([core.SILENT_FLAG.replace('update', 'install')]).silent, true);
});

test('参数大小写不敏感', () => {
  assert.equal(core.parseSilentArgs(['--BLFP-SILENT-UPDATE']).silent, true);
});

test('--target 支持空格与等号两种写法', () => {
  assert.equal(core.parseSilentArgs(['--target', 'C:\\App\\BLFP']).target, path.resolve('C:\\App\\BLFP'));
  assert.equal(core.parseSilentArgs(['--target=C:\\App\\BLFP']).target, path.resolve('C:\\App\\BLFP'));
});

test('静默模式的目标目录会被规范化成绝对路径（防止装到意外位置）', () => {
  const a = core.parseSilentArgs(['--target', 'relative/dir']);
  assert.ok(path.isAbsolute(a.target), '相对路径必须被解析成绝对路径');
});

test('--no-shortcuts 关掉快捷方式，--relaunch 打开自动重启', () => {
  const a = core.parseSilentArgs(['--no-shortcuts', '--relaunch']);
  assert.equal(a.shortcuts, false);
  assert.equal(a.relaunch, true);
});

test('参数乱序也能正确解析', () => {
  const a = core.parseSilentArgs(['--relaunch', '--target', 'D:\\x', core.SILENT_FLAG, '--no-shortcuts']);
  assert.equal(a.silent, true);
  assert.equal(a.relaunch, true);
  assert.equal(a.shortcuts, false);
  assert.equal(a.target, path.resolve('D:\\x'));
});

test('不认识的参数不会让解析崩掉，也不会被误当成目标目录', () => {
  const a = core.parseSilentArgs(['--whatever', '--target', 'D:\\y', '--squirrel-firstrun']);
  assert.equal(a.target, path.resolve('D:\\y'));
});

test('空/非数组 argv 不崩', () => {
  assert.equal(core.parseSilentArgs(null).silent, false);
  assert.equal(core.parseSilentArgs([]).silent, false);
  assert.equal(core.parseSilentArgs([null, undefined]).silent, false);
});

/* ================= CRC32 ================= */

test('crc32 与已知值一致', () => {
  /* "123456789" 的标准 CRC32 是 0xCBF43926 */
  assert.equal(core.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(core.crc32(Buffer.alloc(0)), 0);
});

test('crc32 能区分内容不同但长度相同的文件（这正是"只比大小"会漏掉的情况）', async () => {
  const a = Buffer.from('AAAAAAAAAA');
  const b = Buffer.from('AAAAAAAAAB');
  assert.equal(a.length, b.length, '两个样本必须等长，否则测不到点子上');
  assert.notEqual(core.crc32(a), core.crc32(b), '长度相同但内容不同必须得到不同 CRC');
});

test('crc32File 与 crc32 结果一致（分块读不能算出不同结果）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blfp-crc-'));
  const file = path.join(dir, 'f.bin');
  const data = Buffer.alloc(300000);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  fs.writeFileSync(file, data);
  /* 故意用很小的分块，检验跨块边界时的算法正确性 */
  assert.equal(await core.crc32File(file, 1024), core.crc32(data));
  assert.equal(await core.crc32File(file, 1 << 20), core.crc32(data));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('normalizeCrc 把有符号的 zip CRC 转成无符号', () => {
  assert.equal(core.normalizeCrc(-1), 4294967295);
  assert.equal(core.normalizeCrc(-19088744), 4275878552);
  assert.equal(core.normalizeCrc(null), null);
  assert.equal(core.normalizeCrc('x'), null);
});

/* ================= 跳过未变化文件（秒装的关键） ================= */

const stat = (size, isFile = true) => ({ size, isFile: () => isFile });

test('大小与 CRC 都一致 → 跳过（不解压不写盘）', () => {
  const crc = core.crc32(Buffer.from('hello'));
  const entry = { size: 5, crc32: crc };
  assert.equal(core.canSkipEntry(entry, stat(5), crc), true);
});

test('大小一致但 CRC 不同 → 必须重写（不能只比大小）', () => {
  const entry = { size: 5, crc32: core.crc32(Buffer.from('hello')) };
  const diskCrc = core.crc32(Buffer.from('world'));
  assert.equal(core.canSkipEntry(entry, stat(5), diskCrc), false,
    '只比大小时这个文件会被漏更新，装完就是坏的');
});

test('有符号 CRC 与无符号 CRC 表示同一个值时要能跳过', () => {
  const buf = Buffer.from('BLFP');
  const unsigned = core.crc32(buf);
  const signed = unsigned > 0x7fffffff ? unsigned - 0x100000000 : unsigned;
  const entry = { size: 4, crc32: signed };
  assert.equal(core.canSkipEntry(entry, stat(4), unsigned), true);
});

test('拿不到磁盘 CRC 时不跳过（宁可多写一次也不能漏更新）', () => {
  const entry = { size: 5, crc32: core.crc32(Buffer.from('hello')) };
  assert.equal(core.canSkipEntry(entry, stat(5), null), false);
});

test('磁盘上不存在 / 是目录 → 不跳过', () => {
  const entry = { size: 5, crc32: core.crc32(Buffer.from('hello')) };
  assert.equal(core.canSkipEntry(entry, null, 123), false);
  assert.equal(core.canSkipEntry(entry, stat(5, false), 123), false);
});

test('大小不同 → 不跳过（也不去读 CRC，省一次磁盘读）', async () => {
  let crcReads = 0;
  const entries = [{ entryName: 'a.dll', isDirectory: false, size: 100, crc32: 1 }];
  const io = {
    safeOutputPath: (n) => '/x/' + n,
    statSync: () => stat(200),
    crc32File: async () => { crcReads++; return 1; },
  };
  const plan = await core.planInstall(entries, '/x', io);
  assert.equal(plan.toWrite, 1);
  assert.equal(crcReads, 0, '大小都不同还去读 CRC 是白费一次磁盘读');
});

/* ================= 安装计划 ================= */

test('planInstall：区分 新建/更新/跳过，并算出要写多少字节', async () => {
  const sameCrc = core.crc32(Buffer.from('same'));
  const entries = [
    { entryName: 'resources/app/main.js', isDirectory: false, size: 100, crc32: 111 },
    { entryName: 'resources/app/big.dll', isDirectory: false, size: 500, crc32: sameCrc },
    { entryName: 'resources', isDirectory: true, size: 0, crc32: 0 },
  ];
  const io = {
    safeOutputPath: (n) => '/x/' + n,
    statSync: (p) => (p.endsWith('big.dll') ? stat(500) : null),
    crc32File: async () => sameCrc,
  };
  const plan = await core.planInstall(entries, '/x', io);
  assert.equal(plan.total, 3);
  assert.equal(plan.skipped, 1, 'big.dll 内容一致，应该跳过');
  /* 目录不算"要写的文件"，它走 mkdir */
  assert.equal(plan.toWrite, 1);
  assert.equal(plan.bytesToWrite, 100);
  const actions = plan.items.map((i) => i.action);
  assert.deepEqual(actions, ['write', 'skip', 'mkdir']);
});

test('planInstall：读 CRC 失败时按"要写"处理，安装不会因此中断', async () => {
  const entries = [{ entryName: 'a', isDirectory: false, size: 10, crc32: 5 }];
  const io = {
    safeOutputPath: (n) => n,
    statSync: () => stat(10),
    crc32File: async () => { throw new Error('EACCES'); },
  };
  const plan = await core.planInstall(entries, '/x', io);
  assert.equal(plan.toWrite, 1);
});

test('planInstall：文件全都没变时写入量为 0（这就是"秒装"的来源）', async () => {
  const crc = core.crc32(Buffer.from('x'));
  const entries = Array.from({ length: 200 }, (_, i) => ({ entryName: 'f' + i, isDirectory: false, size: 1, crc32: crc }));
  const io = { safeOutputPath: (n) => n, statSync: () => stat(1), crc32File: async () => crc };
  const plan = await core.planInstall(entries, '/x', io);
  assert.equal(plan.skipped, 200);
  assert.equal(plan.bytesToWrite, 0);
});

/* ================= 秒关客户端 ================= */

test('强杀命令覆盖客户端本体与两个辅助进程', () => {
  const cmds = core.killCommands();
  const images = cmds.map((c) => c.args[c.args.length - 2]);
  assert.ok(images.includes('BLFP.exe'), '必须关掉客户端本体');
  assert.ok(images.includes('easytier-core.exe'), '不关掉 easytier 会占着文件');
  assert.ok(images.includes('frpc.exe'), '不关掉 frpc 会占着文件');
  cmds.forEach((c) => assert.ok(c.args.includes('/F'), '必须是强杀，不能等它自己退'));
});

test('waitUnlocked：已解锁立刻返回，不空等', async () => {
  let slept = 0;
  const ok = await core.waitUnlocked('/x', {
    isUnlocked: () => true, sleep: async () => { slept++; }, timeoutMs: 1000,
  });
  assert.equal(ok, true);
  assert.equal(slept, 0, '已经解锁了还在等，就是"关客户端/装完迟迟不动"的原因');
});

test('waitUnlocked：等不到就按超时返回 false，不会永久卡住', async () => {
  let now = 0;
  const ok = await core.waitUnlocked('/x', {
    isUnlocked: () => false,
    sleep: async (ms) => { now += ms; },
    timeoutMs: 300, intervalMs: 100,
  });
  assert.equal(ok, false);
  assert.ok(now >= 300, '应该一直等到超时');
});

test('waitUnlocked：轮询间隔必须远小于旧的 500ms（否则白等几百毫秒）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'install-core.js'), 'utf8');
  assert.ok(/intervalMs\s*=\s*typeof o\.intervalMs === 'number' \? o\.intervalMs : 100/.test(src),
    '默认轮询间隔应该是 100ms');
});
