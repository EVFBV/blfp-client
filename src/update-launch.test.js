/*
 * 拉起安装器的测试。
 *
 * 这里盯着的是最坏的一个失败模式：**客户端关掉之后再也回不来**。
 * 触发条件很隐蔽 —— 客户端自己没提权时，spawn 一个 requireAdministrator 的 exe
 * 不会弹 UAC，而是异步抛 ERROR_ELEVATION_REQUIRED，同步 try/catch 抓不到。
 */
const test = require('node:test');
const assert = require('node:assert');

const ul = require('./update-launch.js');

/* ---------------- 参数拼装 ---------------- */

test('静默参数与安装器的约定一致（含 --target / --relaunch）', () => {
  const core = require('../installer/install-core.js');
  assert.equal(ul.DEFAULT_SILENT_FLAG, core.SILENT_FLAG,
    '客户端与安装器的隐藏参数不一致 —— 安装器会当成"用户双击"，直接弹界面');
  const args = ul.buildSilentArgs({ targetDir: 'C:\\App\\BLFP' });
  assert.deepEqual(args, [core.SILENT_FLAG, '--target', 'C:\\App\\BLFP', '--relaunch']);
  /* 拼出来的参数必须能被安装器自己解析出正确的意思 */
  const parsed = core.parseSilentArgs(['electron.exe'].concat(args));
  assert.equal(parsed.silent, true);
  assert.equal(parsed.target, require('path').resolve('C:\\App\\BLFP'));
  assert.equal(parsed.relaunch, true);
});

test('--no-shortcuts 只在明确要求时才加', () => {
  assert.ok(!ul.buildSilentArgs({ targetDir: 'x' }).includes('--no-shortcuts'));
  assert.ok(ul.buildSilentArgs({ targetDir: 'x', shortcuts: false }).includes('--no-shortcuts'));
});

/* ---------------- spawn 观察窗口 ---------------- */

function fakeChild() {
  const handlers = {};
  return {
    pid: 4321,
    unref() { this.unreffed = true; },
    on(evt, cb) { (handlers[evt] = handlers[evt] || []).push(cb); return this; },
    emit(evt, arg) { (handlers[evt] || []).forEach((cb) => cb(arg)); },
  };
}

test('spawnAndObserve：进程活着撑过观察窗口 → ok', async () => {
  const child = fakeChild();
  const out = await ul.spawnAndObserve({
    spawnImpl: () => child, command: 'x.exe', args: [],
    sleep: async () => {}, observeMs: 1,
  });
  assert.equal(out.ok, true);
  assert.equal(out.pid, 4321);
  assert.equal(child.unreffed, true, '成功了要 unref，否则客户端退不干净');
});

test('spawnAndObserve：异步抛 error（提权失败的形态）→ 必须被判为失败', async () => {
  const child = fakeChild();
  const out = await ul.spawnAndObserve({
    spawnImpl: () => child, command: 'x.exe', args: [],
    /* 模拟 EACCES：下一个 tick 就报错 */
    sleep: async () => { child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })); },
    observeMs: 1,
  });
  assert.equal(out.ok, false,
    '异步 error 没被当成失败 —— 这正是"启动没成功但客户端照样退出"的根因');
  assert.match(out.error, /EACCES/);
});

test('spawnAndObserve：spawn 同步抛异常也要兜住', async () => {
  const out = await ul.spawnAndObserve({
    spawnImpl: () => { throw new Error('同步就炸了'); },
    command: 'x.exe', args: [], sleep: async () => {},
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /同步就炸了/);
});

/* ---------------- 两条路：直接 / 提权 ---------------- */

test('直接 spawn 成功时不再走 UAC（不打扰用户）', async () => {
  let elevatedCalled = false;
  const out = await ul.startSilentInstaller({
    installerPath: 'setup.exe', targetDir: 'C:\\App',
    spawnImpl: () => fakeChild(),
    sleep: async () => {},
    runElevated: async () => { elevatedCalled = true; return { ok: true }; },
  });
  assert.equal(out.ok, true);
  assert.equal(out.method, 'direct');
  assert.equal(elevatedCalled, false, '直接成功就不该弹 UAC');
});

test('直接 spawn 失败（客户端没提权）→ 自动退回 UAC 提权', async () => {
  const child = fakeChild();
  const out = await ul.startSilentInstaller({
    installerPath: 'setup.exe', targetDir: 'C:\\App',
    spawnImpl: () => child,
    sleep: async () => { child.emit('error', new Error('spawn EACCES')); },
    runElevated: async (cmd, args) => {
      assert.equal(cmd, 'setup.exe');
      assert.ok(args.includes(ul.DEFAULT_SILENT_FLAG));
      assert.ok(args.includes('--target'));
      return { ok: true };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(out.method, 'elevated');
});

test('UAC 被用户点"否" → 如实返回失败（调用方据此不退出客户端）', async () => {
  const child = fakeChild();
  const out = await ul.startSilentInstaller({
    installerPath: 'setup.exe', targetDir: 'C:\\App',
    spawnImpl: () => child,
    sleep: async () => { child.emit('error', new Error('spawn EACCES')); },
    runElevated: async () => ({ ok: false, error: '用户取消了 UAC 授权' }),
  });
  assert.equal(out.ok, false, 'UAC 被拒必须报失败，否则客户端会退出、软件再也回不来');
  assert.match(out.error, /UAC/);
});

test('没有安装程序路径时直接失败，不做无用功', async () => {
  const out = await ul.startSilentInstaller({ installerPath: '' });
  assert.equal(out.ok, false);
});

test('两条路都失败时，错误信息要能看懂（不是一串 exit code）', async () => {
  const child = fakeChild();
  const out = await ul.startSilentInstaller({
    installerPath: 'setup.exe', targetDir: 'C:\\App',
    spawnImpl: () => child,
    sleep: async () => { child.emit('error', new Error('spawn EACCES')); },
    runElevated: async () => ({ ok: false, error: '你取消了管理员授权，更新没有开始' }),
  });
  assert.match(out.error, /取消/);
});

/* ---------------- 真实 defaultRunElevated 的取消识别 ---------------- */

test('真实提权函数：把 PowerShell 的"被用户取消"翻译成人话', async () => {
  /* 不真的起进程：只验证它对错误文案的识别 */
  const src = require('fs').readFileSync(require('path').join(__dirname, 'update-launch.js'), 'utf8');
  assert.ok(/cancelled|canceled|被用户取消/i.test(src), '没有识别 UAC 取消的情况');
  assert.ok(/-Verb RunAs/.test(src), '没有用 RunAs 提权');
  assert.ok(/-ArgumentList/.test(src),
    '提权时必须带参数，否则安装器会当成"用户双击"，弹出安装界面');
});
