/*
 * "登录一次后人机验证就没了" —— 复发守卫。
 *
 * 用户反馈（原话）：
 *   "登录一次后人机验证会失效，如果登录失败应该再出现GEETEST，而不是啥都没有，
 *    然后人机验证后不要出现验证成功的一个小方块，这个移除掉并改为通知，
 *    直接就是平滑动画关闭，不出现任何中间的东西"
 *
 * 这是一个**两个 bug 叠加**造成的结果，单独修任何一个都不够：
 *
 *   bug A（服务端行为）：登录/注册路由都是先 requireCaptcha 再校验账号密码
 *     （见 blfp-server/routes/auth.js：requireCaptcha 排在密码校验前面），
 *     而极验 challenge 是一次性的 —— 于是**任何一次登录失败**（包括"账号或密码错误"）
 *     都会把这次的 challenge 作废。客户端原来只在服务端明确回 captcha:true 时才换新的，
 *     所以失败一次之后，下次提交必然被判"验证码无效"。
 *
 *   bug B（客户端状态）：验证通过时 playCaptchaDone 会给容器加 .captcha-done，
 *     CSS 里那是 display:none；而重新渲染时**没人把它去掉**。
 *     于是"验证过一次之后"，极验再怎么重新渲染都画在一个 display:none 的容器里
 *     —— 用户看到的就是"啥都没有"。
 *
 * 所以这里同时盯住三件事：失败要 reset、reset 后要能看见、通过后不要小方块。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8');

/* ---------- 按大括号配对抽出真实函数（不重写一份，否则改了也测不出来） ---------- */
function extractFn(name) {
  const i = APP.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `app.js 里找不到 ${name}`);
  let depth = 0;
  let started = false;
  for (let k = i; k < APP.length; k++) {
    const c = APP[k];
    if (c === '{') { depth++; started = true; }
    else if (c === '}') {
      depth--;
      if (started && depth === 0) return APP.slice(i, k + 1);
    }
  }
  throw new Error(`抽不出 ${name} 的函数体`);
}

/* ---------- 够用的假 DOM 元素 ---------- */
function fakeEl(tag, id) {
  const classes = new Set();
  const style = {};
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: id || '',
    style,
    children: [],
    textContent: '',
    offsetHeight: 40,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
    },
    _classes: classes,
    appendChild(child) { this.children.push(child); child.parentElement = this; return child; },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  return el;
}

/* ---------- 在沙箱里跑真实的 playCaptchaDone / resetCaptchaBoxVisual ---------- */
function makeEnv() {
  const box = fakeEl('div', 'login-captcha-box');
  const label = fakeEl('label', 'login-captcha-label');
  const parent = fakeEl('div', 'form-login');
  parent.appendChild(label);
  parent.appendChild(box);

  const toasts = [];
  const timers = [];
  let rafQueue = [];

  const sandbox = {
    document: { getElementById: (id) => (id === box.id ? box : null) },
    console: { log() {}, error() {} },
    captchaDoneTimers: { login: null, reg: null },
    captchaSlots: { login: {}, reg: {} },
    toast: (msg, type) => toasts.push({ msg, type: type || '' }),
    getComputedStyle: () => ({ position: 'static' }),
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return 1; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(
    'function $(id){ return document.getElementById(id); }\n'
    + extractFn('captchaBoxId') + '\n'
    + extractFn('captchaLabelEl') + '\n'
    + extractFn('resetCaptchaBoxVisual') + '\n'
    + extractFn('playCaptchaDone') + '\n'
    + 'globalThis.__done = playCaptchaDone; globalThis.__resetVisual = resetCaptchaBoxVisual;',
    sandbox
  );
  /* playCaptchaDone 分两段收尾：420ms 后起动画、340ms 后收尾（加 .captcha-done）。
     桩里的 setTimeout 只记录回调，所以要手动把它们跑完，否则断言的是"动画还没结束"的中间态。 */
  const flushTimers = (rounds = 4) => {
    for (let r = 0; r < rounds; r++) {
      const pending = timers.filter((t) => !t.cancelled && !t.ran);
      if (!pending.length) break;
      pending.forEach((t) => { t.ran = true; t.fn(); });
      const q = rafQueue; rafQueue = []; q.forEach((f) => f());
    }
  };
  return {
    sandbox, box, label, toasts, timers, flushTimers,
    flushRaf: () => { const q = rafQueue; rafQueue = []; q.forEach((f) => f()); },
  };
}

/* ================= CSS 是"藏起来"的那一半 ================= */

test('.captcha-done 确实是 display:none（这就是"啥都没有"的机制）', () => {
  assert.match(CSS, /\.captcha-box\.captcha-done\s*\{\s*display:\s*none/,
    '.captcha-done 不再是 display:none —— 这条测试的前提变了，请同步更新说明');
});

test('重新渲染必须能把这个"藏起来"的状态去掉（否则修了 reset 也看不见）', () => {
  const env = makeEnv();
  env.box.classList.add('captcha-done');
  assert.equal(env.box.classList.contains('captcha-done'), true);
  env.sandbox.__resetVisual('login');
  assert.equal(env.box.classList.contains('captcha-done'), false,
    'resetCaptchaBoxVisual 没有去掉 captcha-done —— 重新渲染的验证码会被 CSS 藏掉，用户看到"啥都没有"');
});

/* ================= 真实行为：验证通过 → 再渲染 ================= */

test('验证通过：加 .captcha-done，并把 inline 高度/透明度清干净', () => {
  const env = makeEnv();
  env.sandbox.__done('login');
  env.flushTimers();
  assert.equal(env.box.classList.contains('captcha-done'), true,
    '动画收尾后应该加上 .captcha-done（先把容器藏起来，等重新渲染时再复原）');
  assert.equal(env.box.classList.contains('captcha-playing'), false, '动画结束后不该还留着 playing');
});

test('验证通过后不再出现"✓ 验证通过"小方块，改成一条通知', () => {
  const env = makeEnv();
  env.sandbox.__done('login');
  env.flushTimers();
  const created = env.box.children.map((c) => c._classes && [...c._classes].join(' '));
  assert.ok(!created.some((c) => c && c.includes('captcha-ok')),
    '还在往容器里塞 .captcha-ok 小方块 —— 用户明确要求移除并改成通知');
  assert.equal(env.toasts.length, 1, '应该发一条通知说明验证通过');
  assert.equal(env.toasts[0].type, 'success', '通知应该是绿色的');
  assert.match(env.toasts[0].msg, /通过/);
});

test('验证通过 → 登录失败 → 重新渲染：容器必须是"看得见"的状态', () => {
  const env = makeEnv();
  /* 1) 先验证通过（这一步把容器加上了 display:none） */
  env.sandbox.__done('login');
  env.flushTimers();
  assert.equal(env.box.classList.contains('captcha-done'), true);
  /* 2) 登录失败后重新渲染（渲染入口会先调 resetCaptchaBoxVisual） */
  env.sandbox.__resetVisual('login');
  /* 3) 断言：藏起来的类没了，inline 样式也清干净了，label 也回来了 */
  assert.equal(env.box.classList.contains('captcha-done'), false, '容器仍然是 display:none，验证码看不见');
  assert.equal(env.box.style.height, '', '残留了 inline 高度，容器会被压成 0');
  assert.equal(env.box.style.opacity, '', '残留了 inline 透明度');
  assert.equal(env.label.style.display, '', 'label 仍然被 display:none —— "人机验证"几个字回不来');
});

test('所有渲染入口都必须在画之前先复原视觉状态', () => {
  for (const fn of ['renderGeetest3', 'renderBuiltinCaptcha']) {
    const body = extractFn(fn);
    assert.ok(/resetCaptchaBoxVisual\(/.test(body),
      `${fn} 没有先调 resetCaptchaBoxVisual —— 验证过一次之后它渲染出来的东西是看不见的`);
  }
});

/* ================= 失败必须换新挑战（bug A） ================= */

test('登录失败一定要重置人机验证，不能只在服务端明说 captcha 错误时才重置', () => {
  const i = APP.indexOf('async function doLogin()');
  const body = APP.slice(i, APP.indexOf('\nasync function requestTfaCode', i));
  const catchAt = body.indexOf('} catch (e) {');
  assert.ok(catchAt > 0, '找不到 doLogin 的 catch');
  const handler = body.slice(catchAt);
  assert.ok(/resetCaptcha\('login'\)/.test(handler),
    'doLogin 失败时没有重置人机验证 —— 服务端是先消耗验证码再校验密码的，' +
    '任何一次登录失败都会让 challenge 作废，不换新的下次必然失败');
});

test('注册失败同样要重置', () => {
  const i = APP.indexOf('async function doRegister()');
  const body = APP.slice(i, i + 4000);
  const catchAt = body.indexOf('} catch (e) {');
  assert.ok(catchAt > 0, '找不到 doRegister 的 catch');
  const handler = body.slice(catchAt);
  assert.ok(/resetCaptcha\('reg'\)/.test(handler), 'doRegister 失败时没有重置人机验证');
});

test('不能因为重置而重复加载两次（handleCaptchaError 内部已经 reset 过一次）', () => {
  const i = APP.indexOf('async function doLogin()');
  const body = APP.slice(i, APP.indexOf('\nasync function requestTfaCode', i));
  assert.ok(/if \(!handleCaptchaError\('login', e\)\) resetCaptcha\('login'\)/.test(body),
    '应该用 handleCaptchaError 的返回值判断要不要再 reset 一次，否则同一次失败会加载两遍');
});

/* ================= 顺带确认没有把小方块样式留在 CSS 里 ================= */

test('.captcha-ok 样式已删除（不再存在"验证通过"的小方块）', () => {
  const codeOnly = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/\.captcha-ok\s*\{/.test(codeOnly), 'CSS 里还留着 .captcha-ok 的规则');
  assert.ok(!/captchaOkIn/.test(codeOnly), 'CSS 里还留着 captchaOkIn 动画');
});
