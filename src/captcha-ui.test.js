/*
 * Electron 客户端的人机验证行为测试。
 *
 * 对应三个用户实测反馈的 bug：
 *   1. "客户端没有 geetest，网页登陆是可以用的"
 *      → gt.js 的协议取自 window.location.protocol，Electron 页面是 file://，
 *        于是它去加载 file://static.geetest.com/…，必然失败。
 *        必须显式传 https: true 把它掰回 https://。
 *   2. "默认的图片验证完后还是会有人机验证的字，这个应该是要随着动画一起消失的"
 *      → 收起动画只压验证码容器的身高，同级那个 <label>人机验证</label> 留在原地。
 *   3. "验证完还不能正常登录，显示验证没过"
 *      → 动画结束后容器被清空、输入框消失，提交时从 DOM 读答案只能拿到空串。
 *
 * 用 node:vm 跑 renderer/app.js 里的验证码模块，配最小 DOM 桩，不需要 Electron。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'renderer', 'app.js');

/* 按标记切片，不依赖行号（行号会随改动漂移，一切就误报） */
function extract() {
  const src = fs.readFileSync(APP, 'utf8');
  const s = src.indexOf('const captchaSlots');
  const e = src.indexOf('/* ====== 个性化');
  assert.ok(s > 0 && e > s, '找不到验证码模块的起止标记');
  return { block: src.slice(s, e), src };
}

function makeEl(id, tag, parent) {
  const el = {
    id, tagName: tag || 'DIV', innerHTML: '', value: '', textContent: '',
    style: {}, dataset: {}, children: [], offsetHeight: 42, onclick: null,
    parentElement: parent || null,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    _q: {},
    _l: {},
    addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    removeEventListener() {},
    fire(t, ev) { (this._l[t] || []).slice().forEach((f) => f(ev || {})); },
    appendChild(c) { c.parentElement = this; this.children.push(c); return c; },
    /* 容器被清空（innerHTML 设为空串）后，里面的元素在真实 DOM 里已经不存在了。
       这里如实模拟，测试才能真正证明"答案是从状态里回退取的"。 */
    querySelector(sel) { return el._filled ? (el._q[sel] !== undefined ? el._q[sel] : null) : null; },
  };
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    set(v) { _html = String(v); el._filled = _html.length > 0; },
  });
  return el;
}

/* 造一个"表单组"：label + 验证码容器同级，跟真实 index.html 的结构一致 */
function makeGroup(boxId) {
  const group = makeEl('group-' + boxId, 'DIV');
  const label = makeEl('label-' + boxId, 'LABEL', group);
  const box = makeEl(boxId, 'DIV', group);
  group.children.push(label, box);
  return { group, label, box };
}

function makeEnv(captchaResp) {
  const groups = { login: makeGroup('login-captcha-box'), reg: makeGroup('reg-captcha-box') };
  const inputs = { 'login-captcha-input': makeEl('login-captcha-input', 'INPUT'), 'reg-captcha-input': makeEl('reg-captcha-input', 'INPUT') };
  inputs['login-captcha-input'].parentElement = groups.login.box;
  inputs['reg-captcha-input'].parentElement = groups.reg.box;
  /* renderBuiltinCaptcha 是"先写 innerHTML，再 querySelector 取回元素"。
     桩里没法解析 HTML，所以把元素预先挂到容器的 _q 上；
     容器一旦被清空，querySelector 就返回 null（与真实 DOM 一致）。 */
  groups.login.box._q['.captcha-input'] = inputs['login-captcha-input'];
  groups.reg.box._q['.captcha-input'] = inputs['reg-captcha-input'];
  groups.login.box._q['.captcha-img'] = makeEl('login-captcha-img', 'IMG', groups.login.box);
  groups.reg.box._q['.captcha-img'] = makeEl('reg-captcha-img', 'IMG', groups.reg.box);
  const scripts = [];
  const logs = [];
  const toasts = [];
  let initConfig = null;

  const sandbox = {
    console, Promise, Date, Math, JSON, String, Boolean, Object, Array, RegExp, Error,
    setTimeout, clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame() {},
    getComputedStyle: () => ({ position: 'static' }),
    logLine: (m) => logs.push(String(m)),
    toast: (m) => toasts.push(String(m)),
    api: async () => captchaResp,
    window: {
      _l: {},
      addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
      removeEventListener() {},
      /* 主窗口页面是 file:// 加载的 —— 这一点正是 bug 1 的根源 */
      location: { protocol: 'file:', href: 'file:///app/renderer/index.html' },
    },
    document: {
      head: { appendChild(el) { scripts.push(el); } },
      createElement: (tag) => makeEl('', tag),
      getElementById: (id) => {
        for (const k of Object.keys(groups)) {
          if (groups[k].box.id === id) return groups[k].box;
          if (groups[k].label.id === id) return groups[k].label;
        }
        return inputs[id] || null;
      },
      querySelector: () => null,
      addEventListener() {},
    },
  };
  sandbox.window.document = sandbox.document;

  /* 客户端的 $() 辅助函数 */
  const dollars = `function $(id){ return document.getElementById(id); }`;

  const { block } = extract();
  vm.createContext(sandbox);
  vm.runInContext(
    dollars + block +
    ';globalThis.__slots=captchaSlots; globalThis.__load=loadCaptcha; globalThis.__ensure=ensureCaptcha;' +
    ' globalThis.__reset=resetCaptchaState; globalThis.__done=playCaptchaDone; globalThis.__fields=captchaFields;' +
    ' globalThis.__resetCap=resetCaptcha; globalThis.__switch=switchToBuiltinCaptcha;',
    sandbox
  );
  return { sandbox, groups, inputs, scripts, logs, toasts, getInitConfig: () => initConfig };
}

const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BUILTIN = { enabled: true, provider: 'builtin', token: 'tok-1', image: 'data:image/svg+xml;base64,AAA' };

/* ---------- bug 1：客户端拿不到极验 ---------- */

test('bug1 极验初始化必须显式传 https:true（页面是 file://，否则 SDK 会去加载 file://…）', () => {
  const { src } = extract();
  const i = src.indexOf('window.initGeetest({');
  assert.ok(i > 0, '找不到 initGeetest 调用');
  const call = src.slice(i, i + 700);
  assert.ok(/https:\s*true/.test(call),
    'initGeetest 没传 https:true —— gt.js 会用 window.location.protocol 拼 URL，'
    + '在 Electron 的 file:// 页面下会变成 file://static.geetest.com/… 而必然失败');
});

test('bug1 gt.js 的协议确实取自 window.location.protocol（记录根因）', () => {
  /* 这条不改产品代码，只把根因固定在测试里：
     一旦哪天有人"优化"掉 https:true，上面那条会失败，这里说明为什么不能删。 */
  const { src } = extract();
  const i = src.indexOf('window.initGeetest({');
  const call = src.slice(i, i + 700);
  assert.equal(call.includes('protocol:'), false,
    '同时传 https 与 protocol 容易互相覆盖，只保留 https:true 即可');
});

/* ---------- bug 3：验证完却登录失败 ---------- */

test('bug3 图形码填满 4 位后，答案必须留存下来（容器随后会被清空）', async () => {
  const { sandbox, inputs } = makeEnv(BUILTIN);
  await sandbox.__load('login');
  await settle();
  const input = inputs['login-captcha-input'];
  input.value = 'AB12';
  input.fire('input');
  assert.equal(sandbox.__slots.login.answer, 'AB12', '答案没有存进状态');
});

test('bug3 收起动画把容器清空后，提交仍能带上正确答案（核心回归）', async () => {
  const { sandbox, inputs, groups } = makeEnv(BUILTIN);
  await sandbox.__load('login');
  await settle();
  const input = inputs['login-captcha-input'];
  input.value = 'AB12';
  input.fire('input');
  /* 等收起动画走完：420ms 后开始收，再过 340ms 清空容器 */
  await sleep(900);
  assert.equal(groups.login.box.innerHTML, '', '前提：动画结束后容器应已清空（输入框随之消失）');
  assert.equal(sandbox.__slots.login.answer, 'AB12', '答案应仍在状态里');

  const f = sandbox.__fields('login');
  assert.equal(f.captcha_token, 'tok-1', 'token 丢了');
  assert.equal(f.captcha_answer, 'AB12', '提交时答案变空 —— 服务端必然判"验证没过"');
  assert.equal(sandbox.__ensure('login'), true, '本地前置校验把已填好的验证码拦下了');
});

test('bug3 答案缺失时不能把用户锁死，要能重新拉一张验证码（防死胡同）', async () => {
  const { sandbox, groups, toasts } = makeEnv(BUILTIN);
  await sandbox.__load('login');
  await settle();
  /* 人为模拟"已收起且没有留存答案"的状态 */
  groups.login.box.innerHTML = '';
  sandbox.__slots.login.answer = '';
  const blocked = sandbox.__ensure('login');
  assert.equal(blocked, false, '没答案却放行了');
  assert.ok(toasts.length > 0, '没有任何提示');
  await settle();
  /* 关键：必须重新加载出可再次验证的图形码，而不是留一个空容器让用户无路可走 */
  assert.equal(sandbox.__slots.login.mode, 'builtin', '没有重新加载验证码，用户被卡死');
});

test('bug3 退出登录/换一张都要清掉留存答案，避免旧答案被当成已填', async () => {
  const { sandbox, inputs } = makeEnv(BUILTIN);
  await sandbox.__load('login');
  await settle();
  inputs['login-captcha-input'].value = 'AB12';
  inputs['login-captcha-input'].fire('input');
  assert.equal(sandbox.__slots.login.answer, 'AB12');
  sandbox.__reset('login');
  assert.equal(sandbox.__slots.login.answer, '', '退出登录后答案没清 —— 再登录会被当成已填');
});

/* ---------- bug 2：验证完了还剩"人机验证"几个字 ---------- */

test('bug2 收起动画要把同级的 label 一起淡出', async () => {
  const { sandbox, groups } = makeEnv(BUILTIN);
  await sandbox.__load('login');
  await settle();
  sandbox.__done('login');
  await settle(2);
  assert.equal(groups.login.label.style.opacity, '0', 'label 没有跟着淡出');
});

test('bug2 动画结束要把 label 移出布局（只透明仍会占一行）', async () => {
  const { sandbox, groups } = makeEnv(BUILTIN);
  await sandbox.__load('login');
  await settle();
  sandbox.__done('login');
  await sleep(900);
  assert.equal(groups.login.label.style.display, 'none', 'label 仍占着位置');
});

test('bug2 重置后 label 必须还原，否则下次验证码没有标题', async () => {
  const { sandbox, groups } = makeEnv(BUILTIN);
  await sandbox.__load('login');
  await settle();
  sandbox.__done('login');
  await sleep(900);
  assert.equal(groups.login.label.style.display, 'none');
  sandbox.__reset('login');
  assert.equal(groups.login.label.style.display, '', 'label 没有被还原');
  assert.equal(groups.login.label.style.opacity, '', 'label 的透明度没有还原');
});

/* ---------- 界面里不该再有"点击/正在加载"这类占位文字 ---------- */

test('客户端 HTML 不显示"点击加载人机验证"占位（进页面就自动加载）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.equal(html.includes('点击加载人机验证'), false,
    '还有"点击加载人机验证"占位文字 —— 用户已明确要求自动加载、不要提示要点');
  assert.equal(html.includes('正在加载人机验证'), false, '还有"正在加载"占位文字');
});

test('两个验证码容器前面都有同级 label（收起动画要能一起处理）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const id of ['login-captcha-box', 'reg-captcha-box']) {
    const i = html.indexOf('id="' + id + '"');
    assert.ok(i > 0, '找不到 ' + id);
    const before = html.slice(Math.max(0, i - 120), i);
    assert.ok(before.includes('<label>'), id + ' 前面没有 label，收起动画会剩下一行字');
  }
});

test("回退路径不能调用本端不存在的函数（会直接把回退打断）", () => {
  const { src } = extract();
  const i = src.indexOf("function switchToBuiltinCaptcha");
  assert.ok(i > 0, "找不到 switchToBuiltinCaptcha");
  const body = src.slice(i, i + 700);
  /* 服务端控制台没有 logLine，客户端有；调用不存在的函数会在运行时抛
     ReferenceError，把"极验挂了→切图片验证码"这条路直接打断 */
  if (!/function logLine/.test(src)) {
    assert.equal(/\blogLine\(/.test(body), false,
      "switchToBuiltinCaptcha 调用了本端不存在的 logLine，回退会抛错");
  }
});

test("重置极验时不能调 captcha.reset()（会拿同一个一次性 challenge 再请求，极验报 old challenge → 网络不给力）", () => {
  const { src } = extract();
  const i = src.indexOf("function resetCaptcha(slot)");
  assert.ok(i > 0, "找不到 resetCaptcha");
  const body = src.slice(i, src.indexOf("\n}", src.indexOf("loadCaptcha(slot, true)", i)) + 2);
  const code = body.replace(/\/\*[\s\S]*?\*\//g, "");   /* 先去掉注释，注释里提到不算 */
  assert.equal(/\.reset\(\s*\)/.test(code), false,
    "resetCaptcha 里仍在调 captcha.reset()：challenge 是一次性的，"
    + "reset 会用同一个已消费的 challenge 再请求，极验返回 error_02 old challenge，"
    + "widget 上显示\"网络不给力\"且无法恢复");
  assert.ok(code.includes("loadCaptcha(slot, true)"),
    "极验重置没有重新签发 challenge，而是复用了旧的");
});

/* ---------- 极验"网络不给力"时必须能自救 ---------- */

const GEETEST3 = {
  enabled: true, provider: 'geetest3', gt: '3d3089824403f018354a4901ce23a7c8',
  challenge: 'abc123', offline: false,
  fallback_token: 'fb-1', fallback_image: 'data:image/svg+xml;base64,AAA',
};

test('极验模式下必须给出"刷新验证码"入口，且刷新的仍是极验（不是换掉它）', () => {
  const { src } = extract();
  assert.ok(src.includes('renderCaptchaRefreshLink'), '没有刷新入口');
  assert.ok(src.includes('刷新验证码'), '没有可点击的文案');
  /* 用户明确要求"让极验能用，而不是把它替换掉" */
  assert.equal(/textContent\s*=\s*'[^']*改用图片验证码/.test(src), false,
    '界面上又出现了"改用图片验证码"的入口 —— 那是替换掉极验，用户明确不要');
  const i = src.indexOf('function renderCaptchaRefreshLink');
  const body = src.slice(i, i + 700);
  assert.ok(body.includes('resetCaptcha(slot)'),
    '刷新入口没有走 resetCaptcha，点了不会重新签发 challenge 并重渲染极验');
});

test('极验 onError 不能把极验换成内置图形码（保持极验在场，让用户刷新重来）', () => {
  const { src } = extract();
  const i = src.indexOf('captcha.onError(');
  assert.ok(i > 0, '找不到 onError');
  const body = src.slice(i, i + 500);
  const code = body.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(code.includes('switchToBuiltinCaptcha'), false,
    'onError 里把极验换成了内置图形码 —— 用户要的是极验可用，不是被替换');
  assert.ok(/st\.validate\s*=\s*null/.test(code), 'onError 没有清掉上一次的 validate');
});

test('切换用的图片来自签到接口一并下发的 fallback，不用再请求一次', () => {
  const { src } = extract();
  assert.ok(src.includes('fallbackToken: data.fallback_token'),
    'loadCaptcha 没把 fallback 透传给 renderGeetest3，切换时无图可用');
  assert.ok(/st\.fallback\s*=/.test(src), '没有把 fallback 存进槽位');
});

/* switchToBuiltinCaptcha 现在只用于"极验彻底起不来"的兜底（SDK 加载失败/初始化超时），
   正常出错不会走到它 —— 所以这个能力必须保留且可用。 */
test('极验彻底起不来时，兜底的内置图形码要能真的用起来（端到端）', async () => {
  const { sandbox, groups } = makeEnv(GEETEST3);
  /* 直接走"极验挂了 → 切换"这条路径 */
  await sandbox.__load('login');
  await settle();
  sandbox.__slots.login.fallback = { token: 'fb-1', image: 'data:image/svg+xml;base64,AAA' };
  assert.equal(sandbox.__switch('login'), true, '切换失败');
  assert.equal(sandbox.__slots.login.mode, 'builtin', '没有切到内置图形码');
  assert.equal(sandbox.__slots.login.token, 'fb-1', '没有用上签到时的 fallback 图片');
  /* 切换后必须能正常填、正常通过校验 */
  const input = groups.login.box._q['.captcha-input'];
  input.value = 'ZX99';
  input.fire('input');
  assert.equal(sandbox.__ensure('login'), true, '切换后仍然登录不了');
  assert.equal(sandbox.__fields('login').captcha_answer, 'ZX99');
});

test('刷新链接真的挂到了容器上并且绑定点击', () => {
  const { src } = extract();
  const i = src.indexOf('function renderCaptchaRefreshLink');
  assert.ok(i > 0, '找不到 renderCaptchaRefreshLink');
  const body = src.slice(i, i + 700);
  assert.ok(body.includes('appendChild'), '链接没有挂到容器上');
  assert.ok(body.includes('onclick'), '链接没有绑定点击行为');
});


/* ---------- CSP：必须放行极验用到的全部域名 ---------- */

test('CSP 必须放行 geevisit.com 与 qbox.me（极验会用这两套域名）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const m = html.match(/Content-Security-Policy" content="([^"]*)"/);
  assert.ok(m, '找不到 CSP');
  const csp = m[1];
  const dirs = {};
  csp.split(';').forEach((d) => { const [k, ...v] = d.trim().split(/\s+/); if (k) dirs[k] = v; });
  const allows = (dir, host) => (dirs[dir] || []).some((p) => {
    if (p === host || p === '*' || p === 'https:') return true;
    if (p.startsWith('https://*.') && host.startsWith('https://')) {
      return host.endsWith(p.slice('https://*'.length));
    }
    return false;
  });
  /* 极验 gettype.php/get.php 实测会返回：
     static_servers: [static.geetest.com, static.geevisit.com]
     api_server: api.geevisit.com
     gt.js 的 fallback_config 里还有 dn-staticdown.qbox.me
     只放行 *.geetest.com 会把另一套域名整个拦掉 —— 这就是客户端"网络不给力"的原因。 */
  for (const [dir, host] of [
    ['script-src', 'https://static.geevisit.com'],
    ['script-src', 'https://dn-staticdown.qbox.me'],
    ['frame-src', 'https://static.geevisit.com'],
    ['img-src', 'https://static.geevisit.com'],
    ['style-src', 'https://static.geevisit.com'],
  ]) {
    assert.ok(allows(dir, host), dir + ' 没有放行 ' + host + '（极验会报"网络不给力"）');
  }
  for (const dir of ['default-src', 'script-src', 'style-src', 'img-src']) {
    assert.equal((dirs[dir] || []).includes('self'), false,
      dir + ' 里出现了裸 self（少了引号）—— 会被当成主机名 self，等于什么都没允许');
  }
});

test('极验域名清单与实测一致（防止有人"顺手精简"掉 geevisit）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  for (const host of ['geetest.com', 'geevisit.com', 'qbox.me']) {
    assert.ok(html.includes(host), 'CSP 里少了 ' + host);
  }
});
