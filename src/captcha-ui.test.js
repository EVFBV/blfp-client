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
    ' globalThis.__resetCap=resetCaptcha;',
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
