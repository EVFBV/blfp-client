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


/* 把 playCaptchaDone 用到的时长常量抽出来，一起放进沙箱 */
function extractConsts() {
  const names = ['CAPTCHA_FADE_MS', 'CAPTCHA_COLLAPSE_MS', 'CAPTCHA_COLLAPSE_TRANSITION', 'CAPTCHA_FADE_TRANSITION', 'CAPTCHA_COLLAPSE_KEYS'];
  const out = [];
  for (const n of names) {
    const m = APP.match(new RegExp('const ' + n + '\\s*=\\s*([^;]+);'));
    assert.ok(m, 'app.js 里找不到常量 ' + n);
    out.push('const ' + n + ' = ' + m[1] + ';');
  }
  return out.join('\n');
}

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
    + extractFn('clearCaptchaCollapseStyles') + '\n'
    + extractFn('resetCaptchaBoxVisual') + '\n'
    + extractConsts() + '\n'
    + extractFn('playCaptchaDone') + '\n'
    + 'globalThis.__done = playCaptchaDone; globalThis.__resetVisual = resetCaptchaBoxVisual;'
    + ';globalThis.__fade = typeof CAPTCHA_FADE_MS === "number" ? CAPTCHA_FADE_MS : null;'
    + 'globalThis.__collapse = typeof CAPTCHA_COLLAPSE_MS === "number" ? CAPTCHA_COLLAPSE_MS : null;'
    + ';globalThis.__collapseTransition = CAPTCHA_COLLAPSE_TRANSITION;',
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

test('验证通过后容器里不能多出任何元素（用户要求：不出现任何中间的东西）', () => {
  const env = makeEnv();
  const before = env.box.children.length;
  env.sandbox.__done('login');
  env.flushTimers();
  assert.equal(env.box.children.length, before,
    '验证通过后往验证码容器里塞了新元素 —— 用户要的是"直接平滑关闭，不出现任何中间的东西"。'
    + '之前那个 "✓ 验证通过" 小方块就是被塞进来的，用户报的它的位置是'
    + ' #login-captcha-box > div:nth-of-type(3)');
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
  /* 下面几项是收起动画为了"真能收到 0"才写进去的：
     min-height/padding/边框都会在竖直方向托住高度，reset 必须一并清掉，
     否则下次渲染出来的验证码是压扁的、或者又收不动了。 */
  assert.equal(env.box.style.minHeight, '', '残留了 inline min-height —— 下次渲染会被它夹住收不动');
  assert.equal(env.box.style.paddingTop, '', '残留了 inline padding-top');
  assert.equal(env.box.style.borderTopWidth, '', '残留了 inline 上边框宽度');
  assert.equal(env.box.style.transition, '', '残留了 inline transition');
  assert.equal(env.label.style.display, '', 'label 仍然被 display:none —— "人机验证"几个字回不来');
  assert.equal(env.label.style.height, '', '残留了 label 的 inline 高度 —— 下次渲染 label 会被压扁');
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

/* ================= 收起动画不能慢（用户反馈过"有点慢了"） ================= */

test('收起动画总时长必须在 450ms 以内（原本 760ms，用户反馈太慢）', () => {
  const env = makeEnv();
  assert.equal(typeof env.sandbox.__fade, 'number', 'CAPTCHA_FADE_MS 没抽出来');
  assert.equal(typeof env.sandbox.__collapse, 'number', 'CAPTCHA_COLLAPSE_MS 没抽出来');
  const total = env.sandbox.__fade + env.sandbox.__collapse;
  assert.ok(total <= 450,
    '收起总时长 ' + total + 'ms 太慢了（用户明确反馈过慢）。'
    + '当前是淡出 ' + env.sandbox.__fade + ' + 收起 ' + env.sandbox.__collapse);
  assert.ok(total >= 200, '收起总时长 ' + total + 'ms 太快了，看不出是收起动画');
});

/*
 * 这一条是"中间会卡一下"的**根因守卫**。
 *
 * 极验控件是 iframe，装在 .captcha-box 里。如果一边改盒子的 height、
 * 一边让 iframe 留在布局里，iframe 每帧都要重新布局+重绘 —— 掉帧就是那个"卡一下"。
 * 所以顺序必须是：先把内容 display:none 移出布局，再改高度。
 */
test('必须先隐藏内容、再收高度（否则 iframe 每帧重排 = 中间卡一下）', () => {
  const body = extractFn('playCaptchaDone');
  const hideAt = body.indexOf("el.style.display = 'none'");
  const heightAt = body.indexOf('box.style.height = startHeight');
  assert.ok(hideAt > 0, '找不到"隐藏内容"那一步');
  assert.ok(heightAt > 0, '找不到"钉住起始高度"那一步');
  assert.ok(hideAt < heightAt,
    '先改了高度、之后才隐藏内容 —— 极验 iframe 会在整个收起过程里每帧重排，用户看到的就是"中间卡一下"。'
    + '必须先把内容 display:none 移出布局，再动盒子的 height。');

  /* 第一段（淡出）里绝不能出现高度/布局改动 */
  const fadePhase = body.slice(0, hideAt);
  assert.ok(!/box\.style\.height\s*=/.test(fadePhase),
    '淡出阶段就改了高度 —— 这一阶段必须只动 opacity，否则 iframe 在还没淡出时就开始被反复重排');
  assert.ok(/CAPTCHA_FADE_TRANSITION/.test(fadePhase), '淡出阶段没有用 CAPTCHA_FADE_TRANSITION 常量');
});

/*
 * 两段之间不能有"什么都不动"的空档 —— 那也是"卡一下"。
 * 第二段必须紧接第一段开始（由 CAPTCHA_FADE_MS 定时触发），而不是等一个额外的 settle。
 */
test('两段动画首尾相接，中间没有静止空档', () => {
  const body = extractFn('playCaptchaDone');
  assert.ok(/\}, CAPTCHA_FADE_MS\);\s*\}\s*$/.test(body.trim()),
    '第二段不是由 CAPTCHA_FADE_MS 紧接触发的 —— 中间会有一段什么都不动的等待，看起来就是卡一下');
  assert.ok(!/CAPTCHA_SETTLE_MS/.test(body), '还在用 CAPTCHA_SETTLE_MS 这个"空等"常量');
});

test('收起用同一份过渡常量，不允许各处写死的 magics 数字', () => {
  const body = extractFn('playCaptchaDone');
  assert.ok(/CAPTCHA_COLLAPSE_TRANSITION/.test(body),
    '收起过渡没有用 CAPTCHA_COLLAPSE_TRANSITION 常量');
  /* 定时也必须走常量，否则改了常量但定时没跟着变 */
  assert.ok(/CAPTCHA_FADE_MS/.test(body), '外层定时没有用 CAPTCHA_FADE_MS');
  assert.ok(/CAPTCHA_COLLAPSE_MS/.test(body), '内层定时没有用 CAPTCHA_COLLAPSE_MS');
});

/* ================= 收起动画必须"便宜"：不要虚线边框 ================= */

/*
 * 用户实测定位到的卡顿元凶（原话）：
 *   "把那个人机验证边缘的虚线删掉，他是导致卡顿的元凶"
 *
 * 原理：收起动画要改 .captcha-box 的 height，而**虚线边框**必须沿周长重新
 * 生成虚线图案再栅格化 —— 高度每变一帧周长就变一次，整圈边框都要重画；
 * 再加上 border-radius 要沿圆角对齐虚线相位，这是纯 CPU 的路径描边，
 * 没法交给合成层。虚线 + 圆角 + 尺寸动画是最贵的一种组合，掉帧就是"卡一下"。
 */
test('.captcha-box 不能用虚线/点线边框（尺寸动画里每帧都要重画整圈，是卡顿元凶）', () => {
  const css = stripCssLocal(readCss());
  /* 取出 .captcha-box 的规则体（不含 :empty / .captcha-done 那些派生选择器） */
  const m = css.match(/(^|\})\s*\.captcha-box\s*\{([^}]*)\}/);
  assert.ok(m, '找不到 .captcha-box 的规则');
  const body = m[2];
  assert.ok(!/dashed|dotted/i.test(body),
    '.captcha-box 又用上了虚线/点线边框 —— 收起动画期间它每帧都要重画整圈虚线，'
    + '这正是用户实测到的"卡一下"。要边框就用实线（solid），或者干脆不画。');
});

test('整个样式表里都不该有虚线边框（唯一那条已删除）', () => {
  const css = stripCssLocal(readCss());
  const hits = css.split('}').map((r) => r.split('{')[0]).filter((sel) => /dashed|dotted/i.test(sel));
  /* 只看声明体，不看选择器：上面拿到的其实是"声明体开头"，这里直接整体扫一遍更稳 */
  const all = css.match(/border[^;]*:\s*[^;]*(?:dashed|dotted)[^;]*;/gi) || [];
  assert.deepEqual(all, [],
    '样式表里还有虚线/点线边框：' + all.join(' | ')
    + '（人机验证那条是导致收起卡顿的元凶，已按用户要求删除）');
});

function stripCssLocal(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
function readCss() {
  return fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8');
}

/* ================= "还收会卡"：高度动画其实收不动 =================
 *
 * .captcha-box 上有 min-height:44px、padding:6px 8px，全局又是 box-sizing:border-box。
 * 只把 height 改成 0 是收不起来的：min-height 会把它夹在 44px，
 * 而 border-box 下高度也降不到 padding+border 以下。
 * 结果是高度过渡全程没有视觉变化，最后靠 display:none 一下弹走 ——
 * 用户原话："还是不顺，还收会卡""就下面那块整体往上移"。
 */

test('收起时必须把 min-height 归零（否则 height 改到 0 也收不起来）', () => {
  const body = extractFn('playCaptchaDone');
  assert.ok(/box\.style\.minHeight\s*=\s*'0(?:px)?'/.test(body),
    '收起时没有把 min-height 归零 —— .captcha-box 的 min-height:44px 会把高度夹住，'
    + 'height 从 44 改到 0 实际仍是 44，动画等于没做，最后一下 display:none 会突然跳走');
});

test('收起时必须把上下 padding 与上下边框也归零（border-box 下它们托着高度）', () => {
  const body = extractFn('playCaptchaDone');
  for (const [prop, why] of [
    ['paddingTop', 'padding:6px 8px'],
    ['paddingBottom', 'padding:6px 8px'],
    ['borderTopWidth', '上下边框'],
    ['borderBottomWidth', '上下边框'],
  ]) {
    assert.ok(new RegExp('box\\.style\\.' + prop + "\\s*=\\s*'0(?:px)?'").test(body),
      '收起时没有把 ' + prop + ' 归零 —— box-sizing:border-box 下高度降不到 ' + why + ' 以下，'
      + '盒子会停在 14px 收不下去');
  }
});

test('这些属性必须都在过渡列表里（瞬时归零就是一次跳变）', () => {
  const env = makeEnv();
  const t = env.sandbox.__collapseTransition;
  assert.equal(typeof t, 'string', 'CAPTCHA_COLLAPSE_TRANSITION 没抽出来');
  for (const prop of ['height', 'padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width']) {
    assert.ok(t.includes(prop), '过渡里没有 ' + prop + ' —— 它会被瞬时改掉，动画中就出现一次跳变');
  }
});

test('label 也要一起压高度（否则最后 display:none 会把下面整块跳一行）', () => {
  const body = extractFn('playCaptchaDone');
  assert.ok(/labelEl\.style\.height\s*=\s*labelEl\.offsetHeight/.test(body)
    || /labelEl\.style\.height\s*=\s*\d/.test(body)
    || /labelEl\.style\.height\s*=\s*[a-zA-Z]+\.offsetHeight/.test(body),
    'label 没有在收起时被压高度 —— 它带 margin-bottom:6px 占着一行，'
    + '最后 display:none 会让下面整块突然往上跳');
});

test('收起写进去的 inline 样式必须能全部清掉（设与清用同一份清单）', () => {
  const body = extractFn('clearCaptchaCollapseStyles');
  assert.ok(/CAPTCHA_COLLAPSE_KEYS/.test(body),
    'clearCaptchaCollapseStyles 没有用共用的 CAPTCHA_COLLAPSE_KEYS —— 设与清会漂移');
  /* 清单里必须覆盖收起时设过的每一项 */
  const keys = APP.match(/const CAPTCHA_COLLAPSE_KEYS = \[([\s\S]*?)\];/);
  assert.ok(keys, '找不到 CAPTCHA_COLLAPSE_KEYS');
  for (const k of ['height', 'minHeight', 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth', 'overflow', 'transition']) {
    assert.ok(keys[1].includes("'" + k + "'"),
      'CAPTCHA_COLLAPSE_KEYS 少了 ' + k + ' —— 收起时设了它却不清，验证码下次回来会是压扁/无边框的状态');
  }
});

test('CSS 里凡是会托住高度的属性，JS 都必须归零（两处必须一致）', () => {
  /* 这条是防漂移的关键：以后有人给 .captcha-box 再加 min-height/padding/border，
     JS 不跟着归零的话，就会重现"收不起来"的 bug。 */
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  const block = css.match(/\.captcha-box\s*\{([^}]*)\}/);
  assert.ok(block, '找不到 .captcha-box 规则');
  const body = block[1];
  const js = extractFn('playCaptchaDone');
  const pairs = [
    [/min-height\s*:\s*([^;]+)/, 'minHeight', 'min-height'],
    [/padding\s*:\s*([^;]+)/, 'paddingTop', 'padding'],
    [/border\s*:\s*[^;]*/, 'borderTopWidth', 'border'],
  ];
  for (const [re, prop, label] of pairs) {
    if (!re.test(body)) continue;
    /* 只有"竖直方向会占高度"的写法才要求归零 */
    const decl = body.match(re)[0];
    const vertical = /min-height/.test(decl)
      || /padding\s*:\s*(?!0(?:\s|;|$))/.test(decl)
      || /border\s*:\s*(?!0(?:\s|;|$))/.test(decl);
    if (!vertical) continue;
    assert.ok(new RegExp('box\\.style\\.' + prop + "\\s*=\\s*'0(?:px)?'").test(js),
      '.captcha-box 声明了 ' + label + '（' + decl.trim() + '，会在竖直方向托住高度），'
      + '但收起逻辑没有把 ' + prop + ' 归零 —— 高度动画会被它夹住收不动');
  }
});
