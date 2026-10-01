/*
 * "进到登录页就能看到人机验证" —— 生命周期与选择器安全守卫。
 *
 * 背景：用户反馈"要点一次登录才会出现 geetest，而不是打开就出现"。
 * 根因是启动时人机验证**发得太早**：那一刻 state.server 还是硬编码的默认地址
 * （DEFAULT_SERVER = http://154.40.43.136:4000），而服务器探测 resolveServer()
 * 是后台跑的、可能把它换成 https://p.blfp.cn。默认地址不可达时这次请求必然失败、
 * 验证码框就空着；等用户点一次登录，地址已经被探测修正，极验才出来。
 * 退出登录那条路同样有问题：resetCaptchaState() 会把框清空，回到登录页也是空的。
 *
 * 另外守一条安全底线：固化布局时**不允许**用位置选择器
 * `#login-captcha-box > div:nth-of-type(1) { display: none }` 去隐藏东西 ——
 * 同一个框里还挂着极验控件本身，渲染顺序一变就会把极验藏没，谁都登不进去。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'renderer', 'app.js');
const CSS = path.join(__dirname, '..', 'renderer', 'style.css');
const HTML = path.join(__dirname, '..', 'renderer', 'index.html');

const readApp = () => fs.readFileSync(APP, 'utf8');
const readCss = () => fs.readFileSync(CSS, 'utf8');

/* 去掉注释，避免注释里提到的东西造成误判 */
const stripCss = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/* ---------- 1. 启动顺序 ---------- */

test('服务器探测完成后必须**再**刷新一次人机验证（否则地址换了也没人补）', () => {
  const src = readApp();
  const i = src.indexOf("document.addEventListener('DOMContentLoaded'");
  assert.ok(i > 0, '找不到 DOMContentLoaded 初始化块');
  const block = src.slice(i, src.indexOf('\n});', i));

  const probe = block.indexOf('await resolveServer()');
  assert.ok(probe > 0, '初始化块里找不到 await resolveServer()');

  const after = block.slice(probe);
  assert.ok(/refreshCaptchaBox\(\s*'login'\s*\)/.test(after),
    '服务器探测完成后没有重新加载登录页的人机验证 —— ' +
    '如果启动时那次用的是不可达的默认地址，验证码框会一直空着，' +
    '表现就是"要先点一次登录才出现"（这正是用户报的 bug）');
  assert.ok(/refreshCaptchaBox\(\s*'reg'\s*\)/.test(after),
    '服务器探测完成后没有重新加载注册页的人机验证');
});

test('启动时不允许绕过 refreshCaptchaBox 直接 loadCaptcha（失败后没人重试）', () => {
  const src = readApp();
  const i = src.indexOf("document.addEventListener('DOMContentLoaded'");
  const block = src.slice(i, src.indexOf('\n});', i));
  const probe = block.indexOf('await resolveServer()');
  const before = block.slice(0, probe);
  const direct = before.match(/(?<!function\s)loadCaptcha\s*\(/g) || [];
  assert.equal(direct.length, 0,
    '启动阶段直接调了 loadCaptcha —— 它失败后不会重试，框就永远空着；' +
    '应该用 refreshCaptchaBox（自带重试）');
});

test('退出登录后要立刻把验证码补回来（resetCaptchaState 会清空框）', () => {
  const src = readApp();
  const i = src.indexOf('function doLogout()');
  assert.ok(i > 0, '找不到 doLogout');
  const body = src.slice(i, src.indexOf('\nfunction ', i + 10));
  const reset = body.indexOf("resetCaptchaState('login')");
  const refresh = body.indexOf("refreshCaptchaBox('login')");
  assert.ok(reset > 0, 'doLogout 里没有重置验证码状态');
  assert.ok(refresh > reset,
    'doLogout 重置了验证码状态却没重新加载 —— 退出后回到登录页会是空白的，' +
    '得先点一次登录才出现极验');
});

test('会话过期也要重置并重新加载验证码（旧 challenge 是一次性的）', () => {
  const src = readApp();
  const i = src.indexOf('async function handleSessionExpired');
  assert.ok(i > 0, '找不到 handleSessionExpired');
  const body = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.ok(/resetCaptchaState\('login'\)/.test(body),
    '会话过期没有重置验证码：旧控件留着已消耗的 challenge，再登录会报"网络不给力"');
  assert.ok(/refreshCaptchaBox\('login'\)/.test(body),
    '会话过期后没有重新加载验证码');
});

/* ---------- 2. refreshCaptchaBox 行为 ---------- */

function extractRefresh() {
  const src = readApp();
  const i = src.indexOf('function refreshCaptchaBox(');
  assert.ok(i > 0, 'app.js 里找不到 refreshCaptchaBox');
  const j = src.indexOf('\n}', i);
  assert.ok(j > i, 'refreshCaptchaBox 结尾没找到');
  return src.slice(i, j + 2);
}

function makeEnv(opts) {
  const o = opts || {};
  const log = [];
  const timers = [];
  const box = { childElementCount: o.children || 0 };
  const st = { disabled: false };
  const sandbox = {
    captchaSlots: { login: st },
    loadCaptcha: (slot, force) => {
      log.push('load:' + slot + ':' + !!force);
      /* 模拟一次加载的结果 */
      box.childElementCount = o.afterLoad === undefined ? 1 : o.afterLoad;
      return Promise.resolve();
    },
    $: () => box,
    captchaBoxId: () => 'login-captcha-box',
    logLine: (m) => log.push('log:' + m),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Math,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractRefresh(), sandbox);
  return { sandbox, log, timers, box, st };
}

test('框里已经有东西时不重复加载（不能把用户填好的验证码清掉）', async () => {
  const env = makeEnv({ children: 2 });
  await env.sandbox.refreshCaptchaBox('login');
  assert.deepEqual(env.log, [], '框里已有内容却重新加载了，会清掉用户已通过/已填写的验证码');
});

test('框是空的时候就加载，成功后不再重试', async () => {
  const env = makeEnv({ children: 0, afterLoad: 1 });
  await env.sandbox.refreshCaptchaBox('login');
  assert.ok(env.log.includes('load:login:true'), '空框时没有触加载');
  assert.equal(env.timers.length, 0, '已经加载成功了却还在排队重试');
});

test('加载完还是空的要退避重试（服务器刚起来时很常见）', async () => {
  const env = makeEnv({ children: 0, afterLoad: 0 });
  await env.sandbox.refreshCaptchaBox('login');
  assert.equal(env.timers.length, 1, '加载失败后没有安排重试');
  assert.ok(env.timers[0].ms >= 500, '重试间隔太短，会打爆服务器');
});

test('重试要有上限，不能无限循环', async () => {
  const env = makeEnv({ children: 0, afterLoad: 0 });
  let n = 0;
  let p = env.sandbox.refreshCaptchaBox('login', 0);
  await p;
  /* 一路把重试链走到底：每轮手动触发排队的定时器 */
  while (env.timers.length && n < 50) {
    const t = env.timers.shift();
    await t.fn();
    n++;
  }
  assert.ok(n <= 6, '重试次数没有上限，会一直打服务器（实际 ' + n + ' 次）');
  assert.ok(env.log.some((l) => l.includes('多次加载仍为空')),
    '重试用尽后应该记一条日志，方便用户/我们排查');
});

test('服务端关掉人机验证时空白是正常的，不要白白重试', async () => {
  const env = makeEnv({ children: 0, afterLoad: 0 });
  env.st.disabled = true;
  await env.sandbox.refreshCaptchaBox('login');
  assert.equal(env.timers.length, 0,
    '服务端已关闭人机验证，空白是预期行为，不该安排重试');
});

/* ---------- 3. 选择器安全底线 ---------- */

test('隐藏刷新入口必须用类选择器，绝不能用会误伤极验的位置选择器', () => {
  const css = stripCss(readCss());
  assert.ok(/\.captcha-switch\s*\{[^}]*display:\s*none/.test(css),
    '没有用 .captcha-switch 隐藏刷新入口');
  /* 危险写法：直接对验证码框里的第 n 个 div 下 display:none */
  const danger = /#(?:login|reg)-captcha-box\s*>\s*div:nth-of-type\(\d+\)\s*(?:,[^{]*)?\{[^}]*display:\s*none/;
  assert.ok(!danger.test(css),
    '用了 `#login-captcha-box > div:nth-of-type(n) { display:none }` 这种位置选择器 —— ' +
    '同一个框里还挂着极验控件，渲染顺序一变就会把极验藏没，导致所有人都登不进去');
});

test('验证码框在 HTML 里是空的（结构由 JS 渲染，不会被静态内容干扰）', () => {
  const html = fs.readFileSync(HTML, 'utf8');
  const m = html.match(/id="login-captcha-box"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(m, '找不到 #login-captcha-box');
  assert.equal(m[1].trim(), '',
    '登录验证码框里有静态内容。它是靠的位置选择器（div:nth-of-type(1)）定位的，' +
    '多加一个静态节点就会让选择器错位 —— 之前那个"藏掉第 1 个 div"的导出就是这种情况');
});
