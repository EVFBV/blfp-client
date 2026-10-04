/*
 * 主页「当前状态」面板的守卫。
 *
 * 背景：主页原来只有一句欢迎语 + 两个按钮，用户打开软件第一眼要回答的
 * "我现在能不能玩、房间号多少、通没通" 一个都答不上来。
 * 改成状态面板后，最容易出的问题是"状态变了但面板没跟着重画" —— 那会显示假信息，
 * 比没有更糟。所以这里把几个必须重画的时机钉住。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'style.css'), 'utf8');

test('主页保留公告容器（这是用户明确要求保留的）', () => {
  assert.match(HTML, /id="home-announcements"/, '主页的公告容器不见了 —— 用户要求公告必须保留');
  assert.match(APP, /loadAnnouncements|renderAnnouncements/, '公告加载逻辑不见了');
});

test('主页有状态面板容器，且两种状态都有渲染分支', () => {
  assert.match(HTML, /id="home-status"/, '主页没有状态面板容器');
  const i = APP.indexOf('function renderHomeStatus');
  assert.ok(i > 0, '找不到 renderHomeStatus');
  const body = APP.slice(i, APP.indexOf('\n}\n', i));
  assert.match(body, /hs-idle/, '没有"未联机"状态的渲染');
  assert.match(body, /hs-live/, '没有"在房间里"状态的渲染');
  assert.match(body, /state\.roomCode/, '状态面板没有读房间号');
});

test('状态变化时必须重画面板（显示假状态比不显示更糟）', () => {
  /* 进主页时刷新 */
  const nav = APP.slice(APP.indexOf('function navTo'), APP.indexOf('function navTo') + 400);
  assert.match(nav, /renderHomeStatus\(\)/, '进主页时没有刷新状态面板');

  /* 人数变化 */
  const members = APP.slice(APP.indexOf('function onMembers'), APP.indexOf('function onMembers') + 400);
  assert.match(members, /renderHomeStatus\(\)/, '人数变化时没有刷新（面板会显示旧人数）');

  /* 建房成功 */
  assert.match(APP, /setHostPhase\('active'\);\s*\n[^\n]*\n[^\n]*\n\s*renderHomeStatus\(\)/,
    '建房成功后没有刷新状态面板');

  /* 退出 / 房间被关 */
  const leave = APP.slice(APP.indexOf('async function leaveRoom'), APP.indexOf('async function leaveRoom') + 600);
  assert.match(leave, /renderHomeStatus\(\)/, '退出房间后没有刷新');
  const closed = APP.slice(APP.indexOf('async function onRoomClosed'), APP.indexOf('async function onRoomClosed') + 700);
  assert.match(closed, /renderHomeStatus\(\)/, '房间被关闭后没有刷新');
});

test('状态面板的样式存在且走主题变量（浅色下也要对）', () => {
  for (const cls of ['.home-status', '.hs-idle', '.hs-live', '.hs-code', '.hs-actions']) {
    assert.ok(CSS.includes(cls), '缺少样式 ' + cls);
  }
  const i = CSS.indexOf('.hs-idle, .hs-live');
  const body = CSS.slice(i, CSS.indexOf('}', i));
  assert.match(body, /var\(--surface-rgb\)|var\(--ov-rgb\)/,
    '状态面板背景是硬编码色 —— 浅色主题下会变成黑块');
});

test('旧主页那套死代码已清掉（避免改样式时改到没人用的规则）', () => {
  for (const dead of ['home-action-btn', 'action-desc', 'home-welcome']) {
    assert.equal(CSS.includes(dead), false, '样式表里还留着没人用的 .' + dead);
    assert.equal(HTML.includes(dead), false, 'index.html 里还留着 ' + dead);
  }
});
