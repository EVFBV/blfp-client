/*
 * 布局调试器的测试。
 *
 * 用户明确要求：
 *   1) "布局调试器要独立窗口"        → 必须真的开独立窗口，不是浮层面板
 *   2) "所有界面都能更改，包括公告界面" → 隐藏的弹窗也必须能选中、能改
 *   3) PRE 版必须带调试器，正式版必须不带
 *
 * 这里尽量做"行为级"验证，而不只是 grep 字符串 ——
 * 用最小 DOM 桩把主窗口代理真的跑起来，检查它算出来的界面清单和部件清单。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const R = path.join(__dirname, '..', 'renderer');
const SHARED = path.join(R, 'layout-tuner-shared.js');
const AGENT = path.join(R, 'layout-tuner.js');
const WIN_JS = path.join(R, 'layout-tuner-window.js');
const WIN_HTML = path.join(R, 'layout-tuner-window.html');
const INDEX = path.join(R, 'index.html');
const PREP = path.join(__dirname, '..', 'scripts', 'prepare-release.js');

/* ---------- 最小 DOM 桩 ---------- */
function makeEl(tag, opts) {
  opts = opts || {};
  const el = {
    nodeType: 1,
    tagName: (tag || 'div').toUpperCase(),
    id: opts.id || '',
    className: opts.className || '',
    children: [],
    parentElement: null,
    /* 记录写入的样式，测试才能断言"改动真的落到元素上了" */
    style: {
      _p: {},
      setProperty(k, v) { this._p[k] = v; },
      removeProperty(k) { delete this._p[k]; },
    },
    dataset: {},
    classList: {
      _s: new Set((opts.className || '').split(/\s+/).filter(Boolean)),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    textContent: opts.text || '',
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 100, height: 20 }; },
    setPointerCapture() {},
    appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
  };
  return el;
}

/* 造一棵包含"页面 + 隐藏弹窗"的树，模拟真实 index.html 的结构 */
function buildTree() {
  const body = makeEl('body');
  const docEl = makeEl('html');

  function attach(parent, child) { parent.appendChild(child); return child; }

  const authPage = attach(body, makeEl('div', { id: 'auth-page', className: 'auth-wrap' }));
  attach(authPage, makeEl('h1', { text: '登录 BLFP' }));
  attach(authPage, makeEl('button', { className: 'btn', text: '登录' }));

  const main = attach(body, makeEl('div', { id: 'main-app', className: 'hidden' }));
  const pageHome = attach(main, makeEl('div', { id: 'page-home', className: 'page active' }));
  attach(pageHome, makeEl('h1', { text: '欢迎使用 BLFP' }));

  /* 公告弹窗：默认带 hidden —— 这正是用户说"改不了"的那个界面 */
  const ann = attach(body, makeEl('div', { id: 'announcement-modal', className: 'modal-backdrop hidden' }));
  const annInner = attach(ann, makeEl('div', { className: 'modal announcement-modal' }));
  attach(annInner, makeEl('h3', { id: 'announcement-title', text: '公告' }));
  attach(annInner, makeEl('p', { id: 'announcement-content', text: '服务器维护通知' }));
  attach(annInner, makeEl('button', { id: 'announcement-close', text: '我知道了' }));

  const upd = attach(body, makeEl('div', { id: 'update-modal', className: 'modal-backdrop hidden' }));
  attach(upd, makeEl('h3', { id: 'update-title', text: '发现新版本' }));

  return { body, docEl, authPage, ann, pageHome, main };
}

function makeDoc(tree) {
  const all = [];
  (function walk(el) { all.push(el); el.children.forEach(walk); })(tree.body);

  function matches(el, sel) {
    if (sel.startsWith('#')) return el.id === sel.slice(1);
    if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
    return el.tagName.toLowerCase() === sel.toLowerCase();
  }

  const document = {
    body: tree.body,
    documentElement: tree.docEl,
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: (id) => all.find((e) => e.id === id) || null,
    querySelector: (sel) => all.find((e) => matches(e, sel.trim())) || null,
    querySelectorAll: (sel) => all.filter((e) => matches(e, sel.trim())),
    addEventListener() {},
  };
  return { document, all };
}

/* 在沙箱里跑共享定义 + 主窗口代理 */
function runAgent(tree) {
  const { document, all } = makeDoc(tree);
  const sent = [];
  const sandbox = {
    console,
    setTimeout, clearTimeout, Promise, Date, Math, JSON, Number, Object, Array, String, RegExp,
    localStorage: { _d: {}, getItem(k) { return this._d[k] || null; }, setItem(k, v) { this._d[k] = v; } },
    document,
    window: null,
    navigator: {},
    mclink: {
      toTuner: (ch, p) => sent.push({ channel: ch, payload: p }),
      tunerOpen: async () => ({ ok: true }),
      tunerClose: async () => ({ ok: true }),
      tunerIsOpen: async () => false,
      onTunerCmd: (cb) => { sandbox.__cmd = cb; },
      onTunerWindowClosed: (cb) => { sandbox.__closed = cb; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.LT_SHARED = undefined;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SHARED, 'utf8'), sandbox, { filename: 'layout-tuner-shared.js' });
  vm.runInContext(fs.readFileSync(AGENT, 'utf8'), sandbox, { filename: 'layout-tuner.js' });
  return { sandbox, sent, all, document };
}

/* ---------- 1. 独立窗口 ---------- */
test('布局调试器是独立窗口，不是主窗口里的浮层面板', () => {
  const agent = fs.readFileSync(AGENT, 'utf8');
  const idx = fs.readFileSync(INDEX, 'utf8');
  /* 主窗口里不该再有那个浮层面板 */
  assert.equal(agent.includes("id = 'lt-panel'"), false, '主窗口里还在创建浮层面板');
  /* 必须通过 IPC 让主进程开独立窗口 */
  assert.ok(agent.includes('tunerOpen'), '没有让主进程开独立窗口');
  assert.ok(idx.includes('layout-tuner-window.html') === false, 'index.html 不该内嵌调试器窗口');
});

test('主进程真的会创建独立 BrowserWindow', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(main.includes('function openTunerWindow'), '缺少 openTunerWindow');
  const i = main.indexOf('function openTunerWindow');
  const body = main.slice(i, i + 1200);
  assert.ok(body.includes('new BrowserWindow'), '没有创建新窗口');
  assert.ok(body.includes("loadFile(TUNER_HTML)"), '没有加载调试器窗口页面');
  assert.ok(main.includes("ipcMain.handle('tuner-open'"), '缺少 tuner-open 处理');
  assert.ok(main.includes("ipcMain.handle('tuner-close'"), '缺少 tuner-close 处理');
});

test('preload 暴露了调试器窗口需要的通道', () => {
  const pre = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  ['tunerOpen', 'tunerClose', 'tunerIsOpen', 'tunerToMain', 'onTunerCmd', 'ontunerData'.replace('ontunerData', 'onTunerData'), 'toTuner']
    .forEach((k) => assert.ok(pre.includes(k), 'preload 缺少 ' + k));
});

/* ---------- 2. 所有界面都能改 ---------- */
test('界面清单包含公告弹窗等隐藏界面', () => {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SHARED, 'utf8'), sandbox);
  const S = sandbox.window.LT_SHARED;
  const names = S.SCREENS.map((s) => s.name);
  assert.ok(names.some((n) => n.includes('公告')), '界面清单里没有公告界面');
  assert.ok(names.some((n) => n.includes('更新')), '没有更新弹窗');
  const modals = S.SCREENS.filter((s) => s.modal);
  assert.ok(modals.length >= 8, '弹窗数量太少，只有 ' + modals.length + ' 个');
});

test('自动发现：没写进清单的弹窗也能被找到', () => {
  const tree = buildTree();
  const { document } = makeDoc(tree);
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SHARED, 'utf8'), sandbox);
  const list = sandbox.window.LT_SHARED.discoverScreens(document);
  const sels = list.map((s) => s.sel);
  assert.ok(sels.includes('#announcement-modal'), '自动发现漏掉了公告弹窗');
  assert.ok(sels.includes('#update-modal'), '自动发现漏掉了更新弹窗');
  assert.ok(sels.includes('#page-home'), '自动发现漏掉了页面');
});

test('选中隐藏界面时会临时揭开 hidden（否则看不到效果）', () => {
  const tree = buildTree();
  const { sandbox, sent } = runAgent(tree);
  assert.equal(tree.ann.classList.contains('hidden'), true, '前提：公告弹窗本来是隐藏的');

  /* 调试器窗口发来"切到公告界面"，并勾了临时显示 */
  sandbox.__cmd({ channel: 'select-screen', payload: { sel: '#announcement-modal', reveal: true } });
  assert.equal(tree.ann.classList.contains('hidden'), false, '公告弹窗没被揭开，看不到效果');
});

test('关闭调试器时会把临时揭开的界面还原（不留下乱弹的公告）', () => {
  const tree = buildTree();
  const { sandbox } = runAgent(tree);
  sandbox.__cmd({ channel: 'select-screen', payload: { sel: '#announcement-modal', reveal: true } });
  assert.equal(tree.ann.classList.contains('hidden'), false);
  /* 调试器窗口关闭 */
  sandbox.__closed();
  assert.equal(tree.ann.classList.contains('hidden'), true, '关掉调试器后公告还开着，容易被当成 bug');
});

test('隐藏界面里的部件也能被列出来并单独选中', () => {
  const tree = buildTree();
  const { sandbox, sent } = runAgent(tree);
  sandbox.__cmd({ channel: 'select-screen', payload: { sel: '#announcement-modal', reveal: true } });

  const ev = sent.filter((m) => m.channel === 'elements').pop();
  assert.ok(ev, '没有上报部件清单');
  const sels = ev.payload.elements.map((e) => e.sel);
  assert.ok(sels.includes('#announcement-title'), '公告标题没进部件清单');
  assert.ok(sels.includes('#announcement-content'), '公告正文没进部件清单');
  assert.ok(sels.includes('#announcement-close'), '公告按钮没进部件清单');

  /* 选中公告标题并改字号，应该真的落到它的 style 上 */
  sandbox.__cmd({ channel: 'select-element', payload: { sel: '#announcement-title' } });
  sandbox.__cmd({ channel: 'set-style', payload: { sel: '#announcement-title', patch: { virt: {}, styles: { 'font-size': '22px' } } } });
  assert.equal(tree.ann.children[0].children[0].style._p['font-size'], '22px', '改动没落到公告标题上');
});

test('改动会持久化（重开调试器还在）', () => {
  const tree = buildTree();
  const { sandbox } = runAgent(tree);
  sandbox.__cmd({ channel: 'set-style', payload: { sel: '#announcement-title', patch: { virt: {}, styles: { color: '#ff0000' } } } });
  const saved = sandbox.localStorage.getItem('blfp_layout_tuner');
  assert.ok(saved && saved.includes('#ff0000'), '没写进 localStorage：' + saved);
});

test('「全部重置」会清掉所有改动', () => {
  const tree = buildTree();
  const { sandbox } = runAgent(tree);
  sandbox.__cmd({ channel: 'set-style', payload: { sel: '#announcement-title', patch: { virt: {}, styles: { color: '#ff0000' } } } });
  sandbox.__cmd({ channel: 'reset-all', payload: {} });
  const saved = sandbox.localStorage.getItem('blfp_layout_tuner');
  assert.equal(saved, '{}', '重置后还有残留：' + saved);
});

/* ---------- 3. 调试器窗口自身 ---------- */
test('调试器窗口引用的元素 id 都存在', () => {
  const html = fs.readFileSync(WIN_HTML, 'utf8');
  const js = fs.readFileSync(WIN_JS, 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...js.matchAll(/\$\(['"]([a-z0-9-]+)['"]\)/gi)].map((m) => m[1]));
  const missing = [...used].filter((u) => !ids.has(u));
  assert.deepEqual(missing, [], '调试器窗口引用了不存在的 id：' + missing.join('、'));
});

test('调试器窗口引入了共享定义（否则属性列表是空的）', () => {
  const html = fs.readFileSync(WIN_HTML, 'utf8');
  assert.ok(html.includes('layout-tuner-shared.js'), '没引入 layout-tuner-shared.js');
  assert.ok(html.includes('layout-tuner-window.js'), '没引入 layout-tuner-window.js');
});

test('连不上主窗口时给出明确提示，而不是静默空白', () => {
  const js = fs.readFileSync(WIN_JS, 'utf8');
  assert.ok(js.includes('未连接到主窗口'), '缺少断连提示');
});

/* ---------- 4. 发布规则 ---------- */
test('PRE 版必须带调试器，正式版必须不带', () => {
  const prep = fs.readFileSync(PREP, 'utf8');
  assert.ok(prep.includes("version.includes('-')"), '没有按版本号判断 PRE');
  assert.ok(prep.includes('必须包含布局调试器'), 'PRE 缺少断言');
  assert.ok(prep.includes('不能包含布局调试器'), '正式版缺少断言');
});

test('新增的 4 个调试器文件都纳入了恢复/剔除清单', () => {
  const prep = fs.readFileSync(PREP, 'utf8');
  const need = [
    'renderer/layout-tuner.js',
    'renderer/layout-tuner.css',
    'renderer/layout-tuner-shared.js',
    'renderer/layout-tuner-window.html',
    'renderer/layout-tuner-window.css',
    'renderer/layout-tuner-window.js',
  ];
  const missing = need.filter((f) => !prep.includes(f));
  assert.deepEqual(missing, [], '遗漏了：' + missing.join('、'));
});
