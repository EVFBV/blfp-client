/*
 * 检查更新的通知行为守卫。
 *
 * 用户反馈："检查更新会出现两个通知，一个绿的一个正常的，正常的删掉，
 *            包括进入软件时的自动检查，也换成绿的"。
 *
 * 根因：checkForUpdates 的每个分支都同时发了 notify(...) 和 toast(..., 'success')，
 * 而 notify 内部就是 toast(msg, type) —— 所以是两条重复通知（一条无样式、一条绿色）。
 * 自动检查那条又被 if (!silent) 挡住绿色那条，只剩普通的。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'renderer', 'app.js');
const HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const readApp = () => fs.readFileSync(APP, 'utf8');

/** 抽出 checkForUpdates 的真实实现（不重写一份，否则改了也测不出来） */
function extractCheck() {
  const src = readApp();
  const i = src.indexOf('async function checkForUpdates()');
  assert.ok(i > 0, 'app.js 里找不到 checkForUpdates');
  const j = src.indexOf('\n}', i);
  assert.ok(j > i, '找不到函数结尾');
  return src.slice(i, j + 2);
}

function makeEnv(info, opts) {
  const o = opts || {};
  const toasts = [];
  const notifies = [];
  const sandbox = {
    state: { appInfo: { version: o.version || '2.0.0' }, updateChannel: o.channel || 'stable', updateInfo: null },
    loadAppInfo: async () => {},
    window: { mclink: { checkGithubUpdate: async () => info } },
    compareVersions: (a, b) => {
      const pa = String(a).split('.').map(Number);
      const pb = String(b).split('.').map(Number);
      for (let k = 0; k < 3; k++) { if ((pa[k] || 0) !== (pb[k] || 0)) return (pa[k] || 0) > (pb[k] || 0) ? 1 : -1; }
      return 0;
    },
    $: () => ({ textContent: '' }),
    openModal: () => { sandbox.__modal = true; },
    toast: (msg, type) => toasts.push({ msg, type: type || '' }),
    notify: (msg, type) => notifies.push({ msg, type: type || 'info' }),
  };
  vm.createContext(sandbox);
  vm.runInContext(extractCheck(), sandbox);
  return { sandbox, toasts, notifies };
}

/* ---------------- 结构守卫 ---------------- */

test('checkForUpdates 里不允许再出现 notify（它就是重复通知的来源）', () => {
  const body = extractCheck();
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.ok(!/\bnotify\s*\(/.test(code),
    'checkForUpdates 里还有 notify —— notify 内部就是 toast，会跟 toast 叠成两条通知');
});

test('成功路径统统用绿色的 toast（success）', () => {
  const code = extractCheck().replace(/\/\*[\s\S]*?\*\//g, '');
  const successToasts = code.match(/toast\([^)]*'success'\)/g) || [];
  assert.ok(successToasts.length >= 3,
    '"已是最新" / "发现新版本" / "忽略预发布" 三条成功路径都该是绿色 toast，实际只有 ' + successToasts.length);
});

test('自动检查不再被 if (!silent) 挡掉绿色通知', () => {
  const code = extractCheck();
  assert.ok(!/!\s*silent/.test(code),
    '还留着 if (!silent) —— 自动检查（进入软件时）就又只剩普通通知了');
  assert.ok(!/silent/.test(code), 'silent 参数已经没用了，应该彻底去掉');
});

test('函数不再接收 silent 参数，所有调用点也都统一', () => {
  const src = readApp();
  assert.ok(/async function checkForUpdates\(\)/.test(src), '函数签名里还有参数');
  const calls = src.match(/checkForUpdates\([^)]*\)/g) || [];
  calls.forEach((c) => assert.equal(c, 'checkForUpdates()', '调用点写法不统一：' + c));
  const html = fs.readFileSync(HTML, 'utf8');
  assert.ok(!/checkForUpdates\((true|false)\)/.test(html), 'index.html 里的按钮还在传参数');
});

/* ---------------- 行为守卫：每个分支只发一条 ---------------- */

test('已是最新：只发一条绿色通知', async () => {
  const env = makeEnv({ latestVersion: '2.0.0', prerelease: false });
  await env.sandbox.checkForUpdates();
  assert.equal(env.toasts.length, 1, '应当只发一条通知，实际 ' + env.toasts.length + ' 条');
  assert.equal(env.notifies.length, 0, '不该再有 notify');
  assert.equal(env.toasts[0].type, 'success', '这条必须是绿色的');
  assert.match(env.toasts[0].msg, /最新/);
});

test('发现新版本：打开弹窗 + 一条绿色通知', async () => {
  const env = makeEnv({ latestVersion: '9.9.9', prerelease: false, releaseNotes: 'x', downloadUrl: 'https://e.com/a.exe', assetName: 'a.exe' });
  await env.sandbox.checkForUpdates();
  assert.equal(env.toasts.length, 1);
  assert.equal(env.toasts[0].type, 'success');
  assert.match(env.toasts[0].msg, /9\.9\.9/);
  assert.equal(env.sandbox.__modal, true, '发现新版本应该弹出更新窗口');
});

test('正式渠道遇到预发布：忽略，并且只发一条绿色通知', async () => {
  const env = makeEnv({ latestVersion: '9.9.9-pre', prerelease: true }, { channel: 'stable' });
  await env.sandbox.checkForUpdates();
  assert.equal(env.toasts.length, 1);
  assert.equal(env.toasts[0].type, 'success');
  assert.match(env.toasts[0].msg, /最新/, '应该告诉用户当前已是最新，而不是只在日志里说忽略了预发布');
  assert.notEqual(env.sandbox.__modal, true, '预发布不该弹更新窗口');
});

test('测试渠道拿到预发布：正常提示发现新版本', async () => {
  const env = makeEnv({ latestVersion: '9.9.9-pre', prerelease: true, downloadUrl: 'https://e.com/a.exe' }, { channel: 'test' });
  await env.sandbox.checkForUpdates();
  assert.equal(env.toasts.length, 1);
  assert.equal(env.toasts[0].type, 'success');
  assert.match(env.toasts[0].msg, /测试版/);
});

test('检查失败：只发一条红色通知（不是红+红两条）', async () => {
  const env = makeEnv(null);
  env.sandbox.window.mclink.checkGithubUpdate = async () => { throw new Error('网络不通'); };
  await env.sandbox.checkForUpdates();
  assert.equal(env.toasts.length, 1, '失败也只该有一条通知');
  assert.equal(env.notifies.length, 0);
  assert.equal(env.toasts[0].type, 'error');
  assert.match(env.toasts[0].msg, /网络不通/);
});
