/*
 * 确认弹窗（#confirm-modal）的行为与结构守卫。
 *
 * 背景：用户反馈"退出登录点确认没反应，弹窗也不关，重启也没用"。
 * 根因是 index.html 里"取消"按钮漏写了 id="confirm-cancel"，
 * 而 confirmOk() 里有一句 `$('confirm-cancel').__handler = null`，
 * 它作用在 null 上直接抛 TypeError —— 抛在 closeModal() 和回调之前，
 * 于是弹窗不关、退出登录也不执行。
 *
 * 这里两条守卫：
 *   1) 结构：app.js 里字面量引用到的每个 id，index.html 里都必须真的有
 *      （这一条本来就能直接拦住上面那个 bug）
 *   2) 行为：即使按钮缺失也不能抛错，弹窗必须照常关闭、回调照常执行
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const APP = path.join(__dirname, '..', 'renderer', 'app.js');
const HTML = path.join(__dirname, '..', 'renderer', 'index.html');

const readApp = () => fs.readFileSync(APP, 'utf8');
const readHtml = () => fs.readFileSync(HTML, 'utf8');

/* ---------- 1. 结构守卫 ---------- */

test('app.js 里字面量引用的 id 必须真的存在于 index.html（或明确是动态创建）', () => {
  const js = readApp();
  const html = readHtml();

  const inHtml = new Set();
  let m;
  const reH = /\bid="([^"]+)"/g;
  while ((m = reH.exec(html))) inHtml.add(m[1]);

  /* 运行时动态创建的 id */
  const dyn = new Set();
  const reD = /\.id\s*=\s*['"]([^'"]+)['"]/g;
  while ((m = reD.exec(js))) dyn.add(m[1]);

  const refs = new Set();
  const reR = /(?:\$|getElementById)\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = reR.exec(js))) refs.add(m[1]);

  const missing = [...refs].filter((id) => !inHtml.has(id) && !dyn.has(id));
  assert.deepEqual(missing, [],
    'app.js 引用了不存在的元素 id：' + missing.join('、') +
    ' —— 对 null 取属性会抛 TypeError，可能像 #confirm-cancel 那样把整个弹窗卡死');
});

test('确认弹窗的两个按钮都有 id（#confirm-ok / #confirm-cancel）', () => {
  const html = readHtml();
  assert.ok(/id="confirm-ok"/.test(html), '缺少 #confirm-ok');
  assert.ok(/id="confirm-cancel"/.test(html),
    '缺少 #confirm-cancel —— 这正是"退出登录点确认没反应"的原因');
});

/* ---------- 2. 行为守卫 ---------- */

/* 把**真实**的确认弹窗函数从 app.js 里切出来跑，配上最小桩。
   刻意不在这里重写一份实现 —— 重写的话 app.js 改坏了测试也发现不了。 */
function extractConfirmCode() {
  const src = readApp();
  const i = src.indexOf("function confirmEls()");
  assert.ok(i > 0, "app.js 里找不到 confirmEls（确认弹窗实现被改名了？）");
  const j = src.indexOf("function confirmCancel()", i);
  assert.ok(j > i, "找不到 confirmCancel");
  /* 取到 confirmCancel 函数体结束（下一个顶格 "}" 之后） */
  const k = src.indexOf("\n}", j);
  assert.ok(k > j, "confirmCancel 的结尾没找到");
  return src.slice(i, k + 2);
}

function makeEnv(idsPresent) {
  const closed = [];
  const logs = [];
  const els = {};
  for (const id of idsPresent) els[id] = { id, __handler: null };
  const sandbox = {
    __els: els, __closed: closed, __logs: logs,
    console,
    $: (id) => els[id] || null,
    openModal: (id) => { sandbox.__opened.push(id); },
    closeModal: (id) => { closed.push(id); },
    logLine: (m) => logs.push(String(m)),
    toast: (m) => logs.push("toast:" + m),
    __opened: [],
  };
  vm.createContext(sandbox);
  vm.runInContext(extractConfirmCode(), sandbox);
  return { sandbox, els, closed, logs, opened: sandbox.__opened };
}

const ALL_IDS = ['confirm-modal', 'confirm-title', 'confirm-msg', 'confirm-ok', 'confirm-cancel'];

test('点"确认"会关掉弹窗并执行回调（退出登录的核心路径）', () => {
  const env = makeEnv(ALL_IDS);
  let ran = 0;
  env.sandbox.showConfirm('确认退出登录？', '退出后需重新登录', () => { ran++; });
  assert.equal(env.opened.includes('confirm-modal'), true, '弹窗没被打开');
  env.sandbox.confirmOk();
  assert.equal(ran, 1, '回调没有执行 —— 就是"点确认没反应"');
  assert.equal(env.closed.includes('confirm-modal'), true, '弹窗没有被关闭');
});

test('即使取消按钮缺失也不能抛错，弹窗必须照常关、回调必须照常跑（回归）', () => {
  /* 复现当初的现场：只有 #confirm-ok，没有 #confirm-cancel */
  const env = makeEnv(['confirm-modal', 'confirm-title', 'confirm-msg', 'confirm-ok']);
  let ran = 0;
  env.sandbox.showConfirm('确认退出登录？', 'x', () => { ran++; });
  assert.doesNotThrow(() => env.sandbox.confirmOk(),
    '按钮缺失时又抛错了 —— 这正是弹窗卡住、点确认没反应的根因');
  assert.equal(ran, 1, '按钮缺失时回调没有执行');
  assert.equal(env.closed.includes('confirm-modal'), true, '按钮缺失时弹窗没有被关闭');
  assert.ok(env.logs.some((l) => l.includes('confirm-cancel')),
    '缺少按钮时应该记一条日志，便于排查');
});

test('回调抛错也要先把弹窗关掉（不能把弹窗晾在界面上）', () => {
  const env = makeEnv(ALL_IDS);
  env.sandbox.showConfirm('t', 'm', () => { throw new Error('模拟失败'); });
  assert.doesNotThrow(() => env.sandbox.confirmOk());
  assert.equal(env.closed.includes('confirm-modal'), true, '回调抛错导致弹窗没关');
  assert.ok(env.logs.some((l) => l.includes('模拟失败')), '回调的错误没有被记录');
});

test('取消按钮走 confirmCancel：关弹窗，且不会误触发确认回调', () => {
  const env = makeEnv(ALL_IDS);
  let confirmed = 0;
  env.sandbox.showConfirm('t', 'm', () => { confirmed++; });
  env.sandbox.confirmCancel();
  assert.equal(confirmed, 0, '取消却触发了确认回调');
  assert.equal(env.closed.includes('confirm-modal'), true, '取消没有关闭弹窗');
});

test('确认后 __handler 必须清空，避免下次误触发上一次的回调', () => {
  const env = makeEnv(ALL_IDS);
  let first = 0;
  env.sandbox.showConfirm('t', 'm', () => { first++; });
  env.sandbox.confirmOk();
  env.sandbox.confirmOk(); /* 再点一次不应重复执行 */
  assert.equal(first, 1, '回调被执行了多次');
});
