/* ============ 全局状态 ============ */
const DEFAULT_SERVER = 'https://p.blfp.cn';
const GITHUB_REPO_URL = 'https://github.com/EVFBV/BLFP-client';
const state = {
  server: DEFAULT_SERVER,
  token: null,
  user: null,
  mode: 'easytier',
  ws: null,            // 信令 WebSocket
  role: null,          // 'host' | 'guest'
  roomCode: null,
  mcPort: 25565,
  easytier: { state: 'stopped', running: false, virtualIp: null, error: null },
  frpNodes: [],
  frpNodeId: null,
  frpNode: null,
  frpEndpoint: null,
  frpTunnelName: '',
  etNodes: [],
  etNodeMode: 'auto',
  hostResetPromise: null,
  members: [],
  maxMembers: 12,
  appInfo: null,
  updateInfo: null,
  signingKey: null,
  signingKeyToken: null,
  debugMode: false,
  isPublic: false,
  presenceTimer: null,
  closingSignaling: false,
  announcement: null,
  announcementTimer: null,
};

/* ============ 工具函数 ============ */
function $(id) { return document.getElementById(id); }

function toast(msg, type = '') {
  const wrap = $('toast-wrap');
  if (!wrap) return console.error('Toast 容器未准备:', msg);
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

function logLine(msg) {
  const box = $('log-box');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${time}] ${msg}`;
  box.appendChild(line);
  const maxLines = state.debugMode ? 2000 : 500;
  while (box.childElementCount > maxLines) box.firstElementChild.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function debugLog(msg) {
  if (state.debugMode) logLine('[调试] ' + msg);
}

function assertSecureServer(server) {
  const url = new URL(server);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !local) throw new Error('非本地服务器必须使用 HTTPS');
  return url;
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function getSigningKey() {
  if (state.signingKeyToken === state.token && state.signingKey) return state.signingKey;
  const res = await fetch(state.server + '/api/auth/signing-key', {
    headers: { Authorization: 'Bearer ' + state.token },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.key) throw new Error(data.error || '获取安全会话密钥失败');
  state.signingKeyToken = state.token;
  state.signingKey = data.key;
  return data.key;
}

async function api(path, opts = {}) {
  assertSecureServer(state.server);
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const method = (opts.method || 'GET').toUpperCase();
  if (state.token && method !== 'GET' && method !== 'HEAD') {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomUUID();
    const bodyHash = await sha256Hex(opts.body || '{}');
    const keyHex = await getSigningKey();
    const keyBytes = new Uint8Array(keyHex.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const payload = [method, '/api' + path.split('?')[0], timestamp, nonce, bodyHash].join('\n');
    const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
    headers['X-Timestamp'] = timestamp;
    headers['X-Nonce'] = nonce;
    headers['X-Signature'] = Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(state.server + '/api' + path, { ...opts, method, headers, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || '请求失败 (' + res.status + ')');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('请求超时，请检查网络后重试');
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

function setLoginLoading(show, text = '登录中…') {
  $('login-loading-text').textContent = text;
  $('login-loading').classList.toggle('hidden', !show);
  $('btn-login').disabled = show;
}

/* ============ 登录鉴权 ============ */
function showAuthTab(tab) {
  $('tab-login').classList.toggle('active', tab === 'login');
  $('tab-reg').classList.toggle('active', tab === 'reg');
  $('form-login').classList.toggle('hidden', tab !== 'login');
  $('form-reg').classList.toggle('hidden', tab !== 'reg');
  $('form-2fa').classList.add('hidden');
  $('auth-err').classList.add('hidden');
  tfaSession = null;
}

function showAuthErr(msg) {
  const el = $('auth-err');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// 登录方式：'pass' 密码 | 'code' 验证码
let loginMethod = 'pass';
function switchLoginMethod(m) {
  loginMethod = m;
  $('lm-pass').classList.toggle('active', m === 'pass');
  $('lm-code').classList.toggle('active', m === 'code');
  $('login-by-pass').classList.toggle('hidden', m !== 'pass');
  $('login-by-code').classList.toggle('hidden', m !== 'code');
  $('auth-err').classList.add('hidden');
}

// 发送邮箱验证码。scene: 'register' | 'login'
async function sendCode(scene) {
  state.server = DEFAULT_SERVER;
  const email = scene === 'register' ? $('r-email').value.trim() : $('l-user').value.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return showAuthErr(scene === 'register' ? '请填写正确的邮箱' : '验证码登录请在上方填写邮箱');
  }
  const btn = scene === 'register' ? $('r-send-code') : $('l-send-code');
  try {
    btn.disabled = true;
    const purpose = scene === 'register' ? 'register' : 'login';
    await api('/auth/send-code', { method: 'POST', body: JSON.stringify({ email, purpose }) });
    toast('验证码已发送，请查收邮箱', 'success');
    // 60秒倒计时
    let sec = 60;
    const timer = setInterval(() => {
      btn.textContent = sec + 's';
      if (--sec < 0) { clearInterval(timer); btn.disabled = false; btn.textContent = '获取验证码'; }
    }, 1000);
  } catch (e) {
    btn.disabled = false;
    showAuthErr(e.message);
  }
}

let tfaSession = null;

async function doLogin() {
  state.server = DEFAULT_SERVER;
  const username = $('l-user').value.trim();
  if (!username) return showAuthErr('请输入用户名或邮箱');

  let body;
  if (loginMethod === 'code') {
    const code = $('l-code').value.trim();
    if (!code) return showAuthErr('请输入邮箱验证码');
    body = { email: username, code };
  } else {
    const password = $('l-pass').value;
    if (!password) return showAuthErr('请输入密码');
    body = { username, password };
  }

  try {
    setLoginLoading(true, '登录中…');
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify(body) });

    if (data.tfa_required) {
      tfaSession = { tfaToken: data.tfa_token, methods: data.tfa_methods || {} };
      $('form-login').classList.add('hidden');
      $('form-reg').classList.add('hidden');
      $('form-2fa').classList.remove('hidden');
      $('tfa-btn-email').classList.toggle('hidden', !tfaSession.methods.email);
      $('tfa-btn-qq').classList.toggle('hidden', !tfaSession.methods.qq);
      setLoginLoading(false);
      return;
    }

    state.token = data.token;
    state.user = data.user;
    state.server = DEFAULT_SERVER;
    localStorage.setItem('mclink_token', data.token);
    localStorage.removeItem('mclink_server');
    enterApp();
  } catch (e) {
    showAuthErr(e.message);
  } finally {
    setLoginLoading(false);
  }
}

async function requestTfaCode(method) {
  if (!tfaSession) return;
  try {
    const emailEl = $('l-user');
    await api('/auth/tfa/send', { method: 'POST', body: JSON.stringify({ tfa_token: tfaSession.tfaToken, method }) });
    $('tfa-method').value = method;
    toast('验证码已发送，请查收邮箱', 'success');
  } catch (e) { showAuthErr(e.message); }
}

function showTfaQqTip() {
  $('tfa-method').value = 'qq';
  toast('请在QQ机器人发送 /verify [验证码]，再将验证码填入下方输入框', 'info');
}

async function submitTfa() {
  if (!tfaSession) return;
  const code = $('tfa-code').value.trim();
  const method = $('tfa-method').value;
  if (!code) return showAuthErr('请输入验证码');
  try {
    setLoginLoading(true, '验证中…');
    const data = await api('/auth/tfa/verify', { method: 'POST', body: JSON.stringify({ tfa_token: tfaSession.tfaToken, code, method }) });
    tfaSession = null;
    state.token = data.token;
    state.user = data.user;
    state.server = DEFAULT_SERVER;
    localStorage.setItem('mclink_token', data.token);
    localStorage.removeItem('mclink_server');
    cancelTfa(true);
    enterApp();
  } catch (e) {
    showAuthErr(e.message);
  } finally {
    setLoginLoading(false);
  }
}

function cancelTfa(silent) {
  tfaSession = null;
  $('form-2fa').classList.add('hidden');
  $('tfa-code').value = '';
  if (!silent) showAuthTab('login');
}

async function doRegister() {
  state.server = DEFAULT_SERVER;
  const username = $('r-user').value.trim();
  const email = $('r-email').value.trim();
  const code = $('r-code').value.trim();
  const password = $('r-pass').value;
  if (!username || !password) return showAuthErr('请输入用户名和密码');
  if (!email) return showAuthErr('请填写邮箱');
  if (!code) return showAuthErr('请填写邮箱验证码');

  try {
    await api('/auth/register', { method: 'POST', body: JSON.stringify({ username, email, code, password }) });
    toast('注册成功，请登录', 'success');
    showAuthTab('login');
    $('l-user').value = username;
  } catch (e) {
    showAuthErr(e.message);
  }
}

function doLogout() {
  // 二次确认弹窗（任务7）
  showConfirm('确认退出登录？', '退出后需重新登录才能使用联机功能。', async () => {
    if (state.role === 'guest') await leaveRoom();
    else if (state.role === 'host') await closeRoom();
    await stopEasyTier();
    try { await window.mclink.frpcStop(); } catch {}
    try { await syncPresence(false); } catch {}
    if (state.presenceTimer) clearInterval(state.presenceTimer);
    state.presenceTimer = null;
    state.token = null;
    state.user = null;
    state.signingKey = null;
    state.signingKeyToken = null;
    localStorage.removeItem('mclink_token');
    $('main-app').classList.add('hidden');
    $('auth-page').classList.remove('hidden');
  });
}

// 通用二次确认弹窗
function showConfirm(title, msg, onConfirm) {
  $('confirm-title').textContent = title;
  $('confirm-msg').textContent = msg;
  $('confirm-modal').classList.remove('hidden');
  $('confirm-ok').__handler = onConfirm;
}
function confirmOk() {
  const handler = $('confirm-ok').__handler;
  $('confirm-modal').classList.add('hidden');
  if (handler) handler();
}
function confirmCancel() {
  $('confirm-modal').classList.add('hidden');
}

function syncPresence(online = true) {
  return api('/auth/presence', { method: 'POST', body: JSON.stringify({ online }) });
}

function safeUserTheme(theme) {
  return ['light', 'dark', 'gold', 'violet', 'ice', 'emerald', 'blue', 'green', 'role'].includes(theme) ? theme : null;
}

function resolveUserThemeClass(theme, role) {
  const t = safeUserTheme(theme) || (role === 'admin' ? 'gold' : role === 'sponsor' ? 'blue' : 'dark');
  if (t === 'role') return `theme-role role-${role || 'user'}`;
  const map = { violet: 'violet', emerald: 'emerald' };
  return `theme-${map[t] || t}`;
}

function applyUserAppearance(user) {
  const title = user.title || ({ admin: '管理员', sponsor: '赞助用户', user: '普通用户' }[user.role] || '普通用户');
  const cls = resolveUserThemeClass(user.theme, user.role);
  $('s-role').textContent = title;
  $('s-role').className = `user-role ${cls}`.trim();
  $('s-role').dataset.userTheme = safeUserTheme(user.theme) || 'role';
}

function enterApp() {
  $('auth-page').classList.add('hidden');
  $('main-app').classList.remove('hidden');
  $('s-username').textContent = state.user.username;
  applyUserAppearance(state.user);
  const welcome = state.user.role === 'sponsor' ? `感谢赞助，${state.user.username}！欢迎回到 BLFP。` : `欢迎回来，${state.user.username}。`;
  $('home-welcome').textContent = welcome;
  logLine(welcome);
  const home = $('page-home');
  home.classList.add('enter-from-right');
  setTimeout(() => home.classList.remove('enter-from-right'), 230);
  loadFrpNodes();
  loadEtNodes();
  loadPublicRooms(true);
  loadFriends(true);
  if (state.user.role === 'sponsor' && !sessionStorage.getItem('blfp_sponsor_welcome')) { sessionStorage.setItem('blfp_sponsor_welcome', '1'); toast(`感谢赞助，${state.user.username}，欢迎回来！`, 'success'); }
  syncPresence(true).catch((e) => logLine('在线状态同步失败: ' + e.message));
  if (state.presenceTimer) clearInterval(state.presenceTimer);
  state.presenceTimer = setInterval(() => syncPresence(true).catch((e) => debugLog('在线状态同步失败: ' + e.message)), 60000);
  loadAnnouncement();
}

/* ============ 导航 ============ */
const NAV_ORDER = ['home', 'host', 'join', 'square', 'friends', 'log', 'settings'];
let currentPage = 'home';
let navTimer = null;
let navLock = false;
function navTo(page, btn) {
  if (page === currentPage) {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n === (btn || document.querySelector(`.nav-item[data-page="${page}"]`))));
    return;
  }
  if (navLock) return;
  const oldPage = $('page-' + currentPage);
  const nextPage = $('page-' + page);
  if (!oldPage || !nextPage) return;
  const noAnimation = page === 'log' || currentPage === 'log' || document.body.classList.contains('perf-off');
  clearTimeout(navTimer);
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('page-entering', 'page-leaving', 'enter-from-left', 'enter-from-right', 'leave-to-left', 'leave-to-right'));
  document.querySelector('.content').scrollTop = 0;
  if (noAnimation) {
    oldPage.classList.remove('active');
    nextPage.classList.add('active');
    currentPage = page;
  } else {
    navLock = true;
    const forward = NAV_ORDER.indexOf(page) > NAV_ORDER.indexOf(currentPage);
    oldPage.classList.add('page-leaving', forward ? 'leave-to-left' : 'leave-to-right');
    nextPage.classList.add('active', 'page-entering', forward ? 'enter-from-right' : 'enter-from-left');
    currentPage = page;
    navTimer = setTimeout(() => {
      oldPage.classList.remove('active', 'page-leaving', 'leave-to-left', 'leave-to-right');
      nextPage.classList.remove('page-entering', 'enter-from-left', 'enter-from-right');
      navLock = false;
    }, 225);
  }
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  (btn || document.querySelector(`.nav-item[data-page="${page}"]`))?.classList.add('active');
  if (page === 'host' && state.token) loadFrpNodes({ silent: true, preserveSelection: true });
  if (page === 'square' && state.token) loadPublicRooms(true);
  if (page === 'friends' && state.token) loadFriends(true);
}

/* ============ 模式选择 ============ */
function selectMode(mode) {
  state.mode = mode;
  $('mode-easytier').classList.toggle('active', mode === 'easytier');
  $('mode-frp').classList.toggle('active', mode === 'frp');
  $('frp-node-section').classList.toggle('hidden', mode !== 'frp');
}

let frpLoadPromise = null;
let frpPingSequence = 0;
async function loadFrpNodes(options = {}) {
  if (frpLoadPromise && !options.force) return frpLoadPromise;
  const selects = [$('frp-node-select'), $('quick-frp-node-select')].filter(Boolean);
  const previousId = options.preserveSelection ? state.frpNodeId : null;
  selects.forEach((sel) => { sel.disabled = true; sel.innerHTML = '<option value="">正在获取节点...</option>'; });
  frpLoadPromise = (async () => {
    try {
      const result = await api('/nodes');
      const nodes = Array.isArray(result) ? result : [];
      state.frpNodes = nodes;
      if (!nodes.length) {
        state.frpNodeId = null;
        selects.forEach((sel) => { sel.innerHTML = '<option value="">暂无可用节点</option>'; });
        return [];
      }
      const optionsHtml = nodes.map((n) =>
        `<option value="${n.id}">${escapeHtml(n.name)} (${escapeHtml(n.region || '未知')} · ${escapeHtml(n.bandwidth || '未知')})</option>`
      ).join('');
      selects.forEach((sel) => { sel.innerHTML = optionsHtml; sel.disabled = false; });
      const selected = nodes.find((n) => n.id === previousId) || nodes[0];
      state.frpNodeId = selected.id;
      selects.forEach((sel) => { sel.value = String(selected.id); });
      await pingSelectedNode(selected);
      debugLog(`已刷新 ${nodes.length} 个 frp 节点`);
      return nodes;
    } catch (e) {
      state.frpNodes = [];
      state.frpNodeId = null;
      selects.forEach((sel) => { sel.innerHTML = '<option value="">节点获取失败，请重试</option>'; sel.disabled = false; });
      logLine('加载 frp 节点失败: ' + e.message);
      if (!options.silent) toast('frp 节点获取失败：' + e.message, 'error');
      return [];
    } finally {
      frpLoadPromise = null;
    }
  })();
  return frpLoadPromise;
}

function refreshFrpNodes() {
  return loadFrpNodes({ force: true, preserveSelection: true });
}

/* ============ EasyTier 节点选择（任务2/3）============ */
let etLoadPromise = null;
function parsePeerTarget(peer) {
  try {
    const u = new URL(String(peer));
    if (!u.hostname) return null;
    let port = Number(u.port);
    if (!port) port = (u.protocol === 'wss:' || u.protocol === 'https:') ? 443 : 11010;
    return { host: u.hostname, port };
  } catch { return null; }
}

async function pingPeerUrl(peer) {
  const target = parsePeerTarget(peer);
  if (!target || !window.mclink || !window.mclink.pingNode) return null;
  try {
    const res = await window.mclink.pingNode({ host: target.host, port: target.port });
    return res && res.ok ? Number(res.latency) : null;
  } catch { return null; }
}

async function loadEtNodes(options = {}) {
  if (etLoadPromise && !options.force) return etLoadPromise;
  const sel = $('s-et-node');
  etLoadPromise = (async () => {
    try {
      const nodes = await api('/easytier-nodes/client');
      state.etNodes = Array.isArray(nodes) ? nodes : [];
      if (sel) {
        const opts = ['<option value="auto">自动（选择延迟最低的节点）</option>'];
        state.etNodes.forEach((n) => {
          const kind = n.kind === 'signaling' ? '信令' : '中继';
          opts.push(`<option value="${n.id}">${escapeHtml(n.name)}（${kind}）</option>`);
        });
        sel.innerHTML = opts.join('');
        const saved = String(state.etNodeMode || 'auto');
        sel.value = saved !== 'auto' && state.etNodes.some((n) => String(n.id) === saved) ? saved : 'auto';
      }
      return state.etNodes;
    } catch (e) {
      debugLog('加载 EasyTier 节点失败: ' + e.message);
      return [];
    } finally {
      etLoadPromise = null;
    }
  })();
  return etLoadPromise;
}

async function testEtNodes() {
  const results = $('s-et-results');
  const badge = $('s-et-latency');
  let nodes = state.etNodes;
  if (!nodes.length) nodes = await loadEtNodes({ force: true });
  if (!nodes.length) return toast('没有可用的 EasyTier 节点', 'warn');
  if (results) { results.classList.remove('hidden'); results.textContent = '正在测速…'; }
  if (badge) { badge.classList.remove('hidden'); badge.textContent = '测速中...'; }
  const rows = await Promise.all(nodes.map(async (n) => ({ node: n, latency: await pingPeerUrl(n.peer) })));
  rows.sort((a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity));
  if (results) {
    results.innerHTML = rows.map((r) => {
      const text = r.latency === null ? '不可达' : `${r.latency} ms`;
      const cls = r.latency === null ? 'et-node-bad' : 'et-node-good';
      return `<div class="et-result-row"><span>${escapeHtml(r.node.name)}</span><span class="${cls}">${text}</span></div>`;
    }).join('');
  }
  const best = rows.find((r) => r.latency !== null);
  if (badge) badge.textContent = best ? `最低延迟：${best.node.name} ${best.latency} ms` : '无可用节点';
  if (best) logLine(`EasyTier 测速完成，最低延迟节点: ${best.node.name} (${best.latency} ms)`);
}

async function pickBestEtPeer(peers) {
  if (!Array.isArray(peers) || peers.length <= 1) return peers;
  const results = await Promise.all(peers.map(async (peer) => ({ peer, latency: await pingPeerUrl(peer) })));
  results.sort((a, b) => (a.latency ?? Infinity) - (b.latency ?? Infinity));
  if (results[0].latency === null) return peers;
  logLine(`自动选择最低延迟 EasyTier 节点: ${results[0].peer} (${results[0].latency} ms)`);
  return [results[0].peer];
}

async function resolveEtPeers(peers) {
  if (!Array.isArray(peers) || !peers.length) return peers;
  const mode = state.etNodeMode;
  if (mode && String(mode) !== 'auto') {
    const node = state.etNodes.find((n) => String(n.id) === String(mode));
    if (node) {
      const matched = peers.find((p) => p === node.peer);
      if (matched) {
        logLine(`使用指定 EasyTier 节点: ${node.name}`);
        return [matched];
      }
      logLine(`指定 EasyTier 节点 ${node.name} 当前不可用，改为自动选择`);
    }
  }
  return pickBestEtPeer(peers);
}

function selectFrpNode(value) {
  state.frpNodeId = parseInt(value, 10) || null;
  [$('frp-node-select'), $('quick-frp-node-select')].filter(Boolean).forEach((sel) => { sel.value = value; });
  const node = state.frpNodes.find((n) => n.id === state.frpNodeId);
  if (node) pingSelectedNode(node);
}

async function pingSelectedNode(node) {
  const sequence = ++frpPingSequence;
  const badges = [$('frp-node-latency'), $('quick-frp-latency')].filter(Boolean);
  badges.forEach((badge) => { badge.textContent = '测速中...'; badge.className = 'latency-badge'; });
  try {
    const res = await window.mclink.pingNode({ host: node.host, port: node.port || 7000 });
    if (sequence !== frpPingSequence || node.id !== state.frpNodeId) return;
    if (res.ok) {
      const ms = res.latency;
      badges.forEach((badge) => { badge.textContent = ms + ' ms'; badge.className = 'latency-badge ' + (ms < 80 ? 'good' : ms < 180 ? 'ok' : 'bad'); });
    } else {
      badges.forEach((badge) => { badge.textContent = '超时'; badge.className = 'latency-badge bad'; });
    }
  } catch (e) {
    if (sequence !== frpPingSequence) return;
    badges.forEach((badge) => { badge.textContent = '失败'; badge.className = 'latency-badge bad'; });
    debugLog('节点测速失败: ' + e.message);
  }
}

/* ============ 端口检测 ============ */
let portTargetId = 'mc-port';
async function detectPort(targetInputId = 'mc-port') {
  portTargetId = targetInputId;
  logLine('正在检测端口占用...');
  // 先检测 25565 是否被占用
  const occupied = await window.mclink.checkPort(25565);
  const javaPorts = await window.mclink.scanPorts();

  if (occupied && javaPorts.some((p) => p.port === 25565)) {
    $(portTargetId).value = 25565;
    toast('检测到 Minecraft 运行在默认端口 25565', 'success');
    logLine('默认端口 25565 已被 Java 进程占用，直接使用');
    return;
  }

  if (javaPorts.length === 0) {
    toast('未检测到运行中的 Java/Minecraft 进程', 'warn');
    logLine('未扫描到 Java 进程监听端口，请确保已开启局域网游戏');
    return;
  }

  if (javaPorts.length === 1) {
    $(portTargetId).value = javaPorts[0].port;
    toast('已选择端口 ' + javaPorts[0].port, 'success');
    logLine('检测到单个 Java 端口: ' + javaPorts[0].port);
    return;
  }

  // 多个端口，弹窗让用户选择
  showPortModal(javaPorts);
}

function showPortModal(ports) {
  const list = $('port-modal-list');
  list.innerHTML = ports.map((p) =>
    `<div class="port-option" onclick="pickPort(${p.port})">
      <span class="po-port">${p.port}</span>
      <span class="po-info">PID ${p.pid} · ${p.process}${p.port === 25565 ? ' · 默认端口' : ''}</span>
    </div>`
  ).join('');
  $('port-modal').classList.remove('hidden');
}

function pickPort(port) {
  $(portTargetId).value = port;
  closeModal('port-modal');
  toast('已选择端口 ' + port, 'success');
  logLine('用户选择映射端口: ' + port);
}

function closeModal(id) { $(id).classList.add('hidden'); }

/* ============ 信令 WebSocket ============ */
function connectSignaling() {
  return new Promise((resolve, reject) => {
    const serverUrl = assertSecureServer(state.server);
    const wsProtocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${serverUrl.host}/ws?token=${encodeURIComponent(state.token)}`;
    state.closingSignaling = false;
    state.ws = new WebSocket(wsUrl);
    state.ws.onopen = () => { logLine('信令服务器已连接'); resolve(); };
    state.ws.onerror = () => reject(new Error('无法连接信令服务器'));
    state.ws.onclose = async () => {
      state.ws = null;
      logLine('信令连接已关闭');
      if (state.closingSignaling) { state.closingSignaling = false; return; }
      if (state.role === 'guest') await failGuestConnection('服务端连接中断/房间已关闭');
      else if (state.role === 'host') await resetHostRoom('服务端连接中断/房间已关闭', true);
    };
    state.ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        logLine('忽略无效的信令消息: ' + e.message);
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string') {
        logLine('忽略格式错误的信令消息');
        return;
      }
      handleSignal(msg);
    };
  });
}

function sendSignal(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handleSignal(msg) {
  const safeAsync = (promise, label) => Promise.resolve(promise).catch((e) => {
    logLine(`${label}: ${e.message}`);
    toast(`${label}：${e.message}`, 'error');
    if (state.role === 'guest') safeAsync(failGuestConnection(label + '，请重试或改用 frp'), '清理访客连接失败');
  });
  switch (msg.type) {
    case 'created':
      Promise.resolve(onRoomCreated(msg)).catch(async (e) => {
        const detail = e instanceof Error ? e.message : String(e);
        logLine('创建房间失败: ' + detail);
        toast('创建房间失败：' + detail, 'error');
        sendSignal({ type: 'close', room: state.roomCode });
        await resetHostRoom('创建房间失败');
      });
      break;
    case 'joined': safeAsync(onRoomJoined(msg), '加入房间失败'); break;
    case 'peer-joined': onPeerJoined(msg); break;
    case 'peer-left': onPeerLeft(msg); break;
    case 'members': onMembers(msg); break;
    case 'closed': onRoomClosed(msg); break;
    case 'et-port':
      if (msg.port) {
        const newAddr = (state.easytier?.hostVirtualIp || '') + ':' + msg.port;
        if ($('host-lan-addr')) $('host-lan-addr').textContent = newAddr;
        if ($('join-status')?.classList?.contains('hidden')) {
          // 访客侧：更新已显示的地址
        }
        logLine('房主代理端口已更新为: ' + msg.port);
      }
      break;
    case 'error':
      toast(msg.error, 'error');
      logLine('信令错误: ' + msg.error);
      if (state.role === 'guest' && !state.roomInfo) safeAsync(failGuestConnection(msg.error || '加入房间失败'), '清理访客连接失败');
      if (!state.roomCode && state.role === 'host') state.role = null;
      $('btn-create').disabled = false;
      $('quick-host-confirm').disabled = false;
      $('btn-join').disabled = false;
      quickHostPending = false;
      break;
  }
}

/* ============ Host 侧：创建房间 ============ */
async function createRoom(options = {}) {
  if (state.role) return toast('当前已在房间中，请先退出当前房间', 'warn');
  const inputId = options.inputId || 'mc-port';
  const mode = options.mode || state.mode;
  const button = $(options.buttonId || 'btn-create');
  const port = parseInt($(inputId).value, 10);
  if (!port || port < 1 || port > 65535) return toast('端口无效', 'error');
  state.mcPort = port;
  selectMode(mode);

  if (mode === 'frp') return createFrpRoom(button);

  try {
    button.disabled = true;
    logLine('正在连接信令服务器...');
    await connectSignaling();
    state.role = 'host';
    state.isPublic = !!(options.isPublic ?? $('host-public')?.checked);
    sendSignal({ type: 'create', mode: 'easytier', username: state.user.username, userId: state.user.id, mcPort: port, isPublic: state.isPublic });
  } catch (e) {
    toast(e.message, 'error');
    button.disabled = false;
  }
}

async function onRoomCreated(msg) {
  const code = typeof msg === 'string' ? msg : msg.room || msg;
  const mode = typeof msg === 'object' ? (msg.mode || 'easytier') : 'easytier';
  state.roomCode = code;
  state.maxMembers = Number(msg.maxMembers) || state.maxMembers;
  $('btn-create').disabled = false;
  $('quick-host-confirm').disabled = false;
  if (quickHostPending) {
    quickHostPending = false;
    closeModal('quick-host-modal');
    navTo('host');
  }
  $('host-setup').classList.add('hidden');
  $('host-active').classList.remove('hidden');
  $('room-code-display').textContent = code;
  $('host-online-count').textContent = `1/${state.maxMembers}`;

  if (mode === 'frp' && typeof msg === 'object' && msg.frp) {
    const { host, port } = msg.frp;
    $('host-status').textContent = 'frp 中转已启动';
    $('host-lan-addr').textContent = host + ':' + port;
    logLine('frp 房间已创建: ' + code + '，访客连接地址: ' + host + ':' + port);
    state.frpEndpoint = { host, port };
    reportFrpSession(code, port).catch((e) => logLine('frp 端口上报失败: ' + e.message));
    return;
  }

  if (!msg.easytier) throw new Error('服务端未返回 EasyTier 配置');
  $('host-status').textContent = '正在启动 EasyTier...';
  const etConfig = { ...msg.easytier, mode: 'host', mcPort: state.mcPort };
  etConfig.peers = await resolveEtPeers(etConfig.peers);
  const result = await window.mclink.easytierStart(etConfig);
  if (!result?.ok) throw new Error(result?.error || 'EasyTier 启动失败');
  state.easytier = result.status;
  const hostVirtualIp = msg.easytier.hostVirtualIp || state.easytier.virtualIp;
  if (!hostVirtualIp) throw new Error('未获取到房主虚拟 IP');
  state.easytier.hostVirtualIp = hostVirtualIp;
  $('host-status').textContent = 'EasyTier 已启动，等待好友加入...';
  const etPort = result.status?.proxyPort || 25565;
  $('host-lan-addr').textContent = hostVirtualIp + ':' + etPort;
  logLine('EasyTier 房间已创建: ' + code + '，连接地址: ' + hostVirtualIp + ':' + etPort);
  if (etPort !== 25565) sendSignal({ type: 'et-port-update', port: etPort });

  try {
    const r = await window.mclink.motdStart({ port: state.mcPort, roomCode: code, hostName: state.user.username });
    if (r.ok) logLine('已开启局域网广播: ' + r.motd);
  } catch (e) {
    logLine('局域网广播启动失败: ' + e.message);
  }
}

function onPeerJoined(msg) {
  if (state.role !== 'host') return;
  if (typeof msg.members === 'number') $('host-online-count').textContent = String(msg.members);
  $('host-status').textContent = '好友已加入，EasyTier 正在自动组网';
  logLine((msg.username || '好友') + ' 已加入房间');
  updateHostPeers();
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function memberRow(member, showIp) {
  const name = escapeHtml(member.username || member.name || '未知用户');
  const hostBadge = member.isHost || member.role === 'host' ? '<span class="host-badge">房主</span>' : '';
  const ip = showIp ? escapeHtml(member.ip || '--') : '';
  const ping = Number.isFinite(Number(member.ping)) ? `${Number(member.ping)} ms` : '--';
  return `<div class="peer-item"><span class="peer-name">${name}${hostBadge}</span>${showIp ? `<span class="peer-ip">${ip}</span>` : '<span></span>'}<span class="peer-ping">${ping}</span></div>`;
}

function onMembers(msg) {
  state.members = Array.isArray(msg.members) ? msg.members : [];
  state.maxMembers = Number(msg.maxMembers) || state.maxMembers;
  updateHostPeers();
  if ($('guest-members')) $('guest-members').innerHTML = state.members.map((m) => memberRow(m, false)).join('');
}

function updateHostPeers() {
  const total = state.members.length || (state.role === 'host' ? 1 : 0);
  $('host-online-count').textContent = `${total}/${state.maxMembers}`;
  $('host-peers').innerHTML = state.members.map((m) => memberRow(m, true)).join('');
}

function onPeerLeft(msg) {
  logLine((msg.username || '好友') + ' 已离开房间');
  if (state.role === 'host') {
    $('host-status').textContent = 'EasyTier 已启动，等待好友加入...';
    updateHostPeers();
  } else if (state.role === 'guest') {
    $('j-status').textContent = '房间成员已离开';
  }
}

async function stopEasyTier() {
  try { await window.mclink.easytierStop(); } catch (e) { debugLog('停止 EasyTier 失败: ' + e.message); }
  state.easytier = { state: 'stopped', running: false, virtualIp: null, error: null };
}

async function resetHostRoom(reason = '房间已关闭', notify = false) {
  if (state.hostResetPromise) return state.hostResetPromise;
  state.hostResetPromise = (async () => {
    state.role = null;
    state.roomCode = null;
    state.members = [];
    state.isPublic = false;
    state.frpEndpoint = null;
    state.frpNode = null;
    state.frpTunnelName = '';
    const ws = state.ws;
    state.ws = null;
    if (ws) {
      state.closingSignaling = true;
      try { ws.close(); } catch {}
    }
    const cleanupResults = await Promise.allSettled([
      stopEasyTier(),
      Promise.resolve().then(() => window.mclink.frpcStop()),
      Promise.resolve().then(() => window.mclink.motdStop()),
    ]);
    const cleanupLabels = ['EasyTier', 'frpc', '局域网广播'];
    cleanupResults.forEach((result, index) => {
      if (result.status === 'rejected') debugLog(`停止 ${cleanupLabels[index]} 失败: ${result.reason?.message || result.reason}`);
    });
    $('host-active').classList.add('hidden');
    $('host-setup').classList.remove('hidden');
    $('btn-create').disabled = false;
    $('quick-host-confirm').disabled = false;
    quickHostPending = false;
    logLine(reason);
    if (notify) toast(reason, 'warn');
  })();
  try {
    await state.hostResetPromise;
  } finally {
    state.hostResetPromise = null;
  }
}

async function closeRoom() {
  if (state.role !== 'host') return;
  sendSignal({ type: 'close', room: state.roomCode });
  await new Promise((resolve) => setTimeout(resolve, 180));
  await resetHostRoom('房间已关闭', true);
}

/* ============ frp 中转模式（Host）=========== */
function randomFrpPort() {
  const min = 2000;
  const max = 5000;
  const range = max - min + 1;
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return min + (value[0] % range);
  }
  return min + Math.floor(Math.random() * range);
}

async function reportFrpSession(roomCode, remotePort) {
  if (!state.frpTunnelName || !roomCode) return;
  const body = {
    tunnelName: state.frpTunnelName,
    remotePort: Number(remotePort) || 0,
    roomCode: String(roomCode),
    nodeId: state.frpNode ? state.frpNode.id : null,
  };
  await api('/frp/report', { method: 'POST', body: JSON.stringify(body) });
  logLine('已向服务端上报 frp 端口: ' + remotePort + '（隧道 ' + state.frpTunnelName + '）');
}

async function createFrpRoom(button = $('btn-create')) {
  if (!state.frpNodes.length) await loadFrpNodes({ force: true });
  const node = state.frpNodes.find((n) => n.id === state.frpNodeId);
  if (!node) {
    button.disabled = false;
    return toast('没有可用的 frp 节点，请刷新节点后重试', 'error');
  }

  logLine('正在启动 frp 内网穿透: ' + node.name);
  toast('提示：frp 固定中转延迟通常高于 EasyTier', 'warn');

  try {
    button.disabled = true;

    // 1. 在 2000–5000 中随机选择公网端口；冲突时重新随机，不顺序递增
    let remotePort;
    let res;
    const attempted = new Set();
    for (let attempt = 0; attempt < 5; attempt++) {
      do { remotePort = randomFrpPort(); } while (attempted.has(remotePort));
      attempted.add(remotePort);
      res = await window.mclink.frpcStart({
        serverAddr: node.host,
        serverPort: node.port || 7000,
        token: node.token || undefined,
        tls: Boolean(node.tls_enabled),
        localPort: state.mcPort,
        remotePort,
      });
      if (res.ok) {
        remotePort = res.remotePort || remotePort;
        break;
      }
      const retryable = /端口|already|unavailable|占用/i.test(res.error || '');
      if (!retryable) throw new Error(res.error || 'frpc 启动失败');
      logLine('frp 端口 ' + remotePort + ' 不可用，正在重新随机...');
    }
    if (!res || !res.ok) throw new Error((res && res.error) || '未找到可用的随机公网端口');
    state.frpTunnelName = res.tunnelName || '';
    logLine('frpc 已启动，随机公网端口: ' + remotePort + (state.frpTunnelName ? '，隧道名: ' + state.frpTunnelName : ''));

    // 2. 通过 ws 信令创建房间（附带 frp 端点信息）
    await connectSignaling();
    state.role = 'host';
    state.frpNode = node;
    sendSignal({
      type: 'create',
      mode: 'frp',
      userId: state.user.id,
      username: state.user.username,
      mcPort: state.mcPort,
      frp: { host: node.host, port: remotePort, node: node.id },
      isPublic: !!($('host-public')?.checked),
    });
    // 等待 'created' 回调处理 UI
  } catch (e) {
    toast(e.message, 'error');
    logLine('frp 启动失败: ' + e.message);
    try { await window.mclink.frpcStop(); } catch {}
    state.role = null;
    state.frpNode = null;
    button.disabled = false;
  }
}

let quickHostMode = 'easytier';
let quickHostPending = false;
function quickHostKey(event, mode) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openQuickHost(mode);
  }
}
function openQuickHost(mode) {
  quickHostMode = mode;
  $('quick-host-mode').textContent = mode === 'frp' ? 'frp 中转' : 'EasyTier 智能组网';
  $('quick-frp-section').classList.toggle('hidden', mode !== 'frp');
  $('quick-mc-port').value = $('mc-port').value || 25565;
  if (state.frpNodeId) $('quick-frp-node-select').value = String(state.frpNodeId);
  if (mode === 'frp') loadFrpNodes({ force: true, preserveSelection: true, silent: true });
  $('quick-host-confirm').disabled = false;
  $('quick-host-modal').classList.remove('hidden');
}
async function confirmQuickHost() {
  const button = $('quick-host-confirm');
  button.disabled = true;
  quickHostPending = true;
  $('mc-port').value = $('quick-mc-port').value;
  if (quickHostMode === 'frp') selectFrpNode($('quick-frp-node-select').value);
  await createRoom({ inputId: 'quick-mc-port', mode: quickHostMode, buttonId: 'quick-host-confirm', isPublic: !!$('quick-public')?.checked });
  if (state.role !== 'host') {
    quickHostPending = false;
    button.disabled = false;
  }
}

/* ============ Guest 侧：加入房间 ============ */
async function joinRoom() {
  if (state.role) return toast('当前已在房间中，请先退出当前房间', 'warn');
  const code = $('room-input').value.trim();
  if (!/^\d{6}$/.test(code)) return toast('请输入 6 位纯数字房间号', 'error');

  $('btn-join').disabled = true;
  $('join-status').classList.remove('hidden');
  $('join-status').textContent = '正在查询房间...';

  try {
    // 通过信令连接加入，服务端 joined 消息会携带模式信息
    $('join-status').textContent = '正在连接信令服务器...';
    await connectSignaling();
    state.role = 'guest';
    state.roomCode = code;
    sendSignal({ type: 'join', room: code });
  } catch (e) {
    toast(e.message, 'error');
    $('join-status').textContent = '连接失败: ' + e.message;
    await cleanupGuestConnection();
    $('btn-join').disabled = false;
  }
}

async function cleanupGuestConnection() {
  state.role = null;
  state.roomCode = null;
  state.roomInfo = null;
  await stopEasyTier();
  if (state.ws) { state.closingSignaling = true; try { state.ws.close(); } catch {} state.ws = null; }
}

async function failGuestConnection(message) {
  if (state.role !== 'guest') return;
  await cleanupGuestConnection();
  $('join-active').classList.add('hidden');
  $('join-form').classList.remove('hidden');
  $('join-status').classList.remove('hidden');
  $('join-status').textContent = message;
  $('btn-join').disabled = false;
  toast(message, 'error');
}

async function onRoomJoined(msg) {
  logLine('已加入房间 ' + msg.room + '，模式: ' + (msg.mode || 'easytier'));
  state.roomInfo = { room: msg.room, hostUser: msg.hostUser };
  if (Array.isArray(msg.members)) onMembers(msg);

  if (msg.mode === 'frp') {
    $('join-status').classList.add('hidden');
    $('btn-join').disabled = false;
    joinFrpRoom(msg);
    return;
  }

  if (!msg.easytier?.hostVirtualIp) throw new Error('服务端未返回 EasyTier 房主地址');
  const address = msg.easytier.hostVirtualIp + ':' + (msg.easytier.port || 25565);
  $('join-status').textContent = '正在启动 EasyTier...';
  const etConfig = { ...msg.easytier, mode: 'guest' };
  etConfig.peers = await resolveEtPeers(etConfig.peers);
  const result = await window.mclink.easytierStart(etConfig);
  if (!result?.ok) throw new Error(result?.error || 'EasyTier 启动失败');
  state.easytier = result.status;

  const deadline = Date.now() + 30000;
  let test;
  while (Date.now() < deadline) {
    const attemptStarted = Date.now();
    const remaining = deadline - attemptStarted;
    test = await Promise.race([
      window.mclink.easytierTest({ hostVirtualIp: msg.easytier.hostVirtualIp, port: msg.easytier.port }),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: test?.error || '连接超时' }), remaining)),
    ]);
    if (test?.ok) break;
    $('join-status').textContent = '正在等待 EasyTier 网络连通...';
    const retryDelay = Math.min(Math.max(0, 1000 - (Date.now() - attemptStarted)), deadline - Date.now());
    if (retryDelay > 0) await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
  if (!test?.ok) throw new Error('无法连接房主 Minecraft 端口: ' + (test?.error || '未知原因'));

  $('join-status').classList.add('hidden');
  $('btn-join').disabled = false;
  $('join-form').classList.add('hidden');
  $('join-active').classList.remove('hidden');
  $('j-room').textContent = msg.room || state.roomCode || '--';
  $('j-host').textContent = msg.hostUser || '未知';
  $('j-mode').innerHTML = '<span class="tag tag-p2p">EasyTier 智能组网</span>';
  $('j-addr').textContent = address;
  $('j-status').textContent = 'EasyTier 连接已就绪';
  logLine('EasyTier 连通性测试成功: ' + address);
  toast('连接成功！请在 Minecraft 中连接 ' + address, 'success');
}

/* ============ frp 中转模式（Guest）=========== */
async function joinFrpRoom(room) {
  // room 来自信令 joined 消息（含 frp: {host, port}）或旧 REST 接口
  const frpHost = (room.frp && room.frp.host) || room.frp_host;
  const frpPort = (room.frp && room.frp.port) || room.frp_remote_port;
  if (!frpHost || !frpPort) {
    await failGuestConnection('frp 节点未返回可用连接地址，请让房主重新创建房间');
    return;
  }

  logLine('frp 中转房间，连接: ' + frpHost + ':' + frpPort);
  toast('提示：frp 固定中转延迟通常高于 EasyTier', 'warn');

  $('join-form').classList.add('hidden');
  $('join-active').classList.remove('hidden');
  $('j-room').textContent = room.room || state.roomCode || '--';
  $('j-host').textContent = room.hostUser || '未知';
  $('j-mode').innerHTML = '<span class="tag tag-frp">frp 中转</span>';
  $('j-addr').textContent = frpHost + ':' + (frpPort || '?');
  $('j-status').textContent = '请将上方地址填入 MC 多人游戏';
  $('btn-join').disabled = false;
  logLine('请在 MC 中直连: ' + frpHost + ':' + frpPort);
}

async function leaveRoom() {
  if (state.role === 'guest') {
    sendSignal({ type: 'leave', room: state.roomCode });
    await cleanupGuestConnection();
    $('join-active').classList.add('hidden');
    $('join-form').classList.remove('hidden');
    $('join-status').classList.add('hidden');
    $('btn-join').disabled = false;
    logLine('已断开连接');
  }
}

async function onRoomClosed(msg) {
  const reason = msg.reason || '房间已被服务端关闭';
  toast(reason, 'warn');
  logLine(reason);
  if (state.role === 'guest') {
    await cleanupGuestConnection();
    $('join-active').classList.add('hidden');
    $('join-form').classList.remove('hidden');
    $('join-status').classList.remove('hidden');
    $('join-status').textContent = reason;
    $('btn-join').disabled = false;
  } else if (state.role === 'host') {
    await resetHostRoom(reason);
  } else await cleanupGuestConnection();
}

/* ============ 运行时事件桥接 ============ */
function setupTunnelBridge() {
  window.mclink.onEasytierLog((line) => {
    if (state.debugMode) logLine('[EasyTier] ' + String(line).trim());
  });
  window.mclink.onEasytierStatus((status) => {
    state.easytier = { ...state.easytier, ...status };
    const text = status?.state || (status?.running ? 'running' : 'stopped');
    if (!['starting', 'stopping', 'error'].includes(text)) return;
    if (state.role === 'host' && $('host-status')) $('host-status').textContent = 'EasyTier 状态: ' + text;
    if (state.role === 'guest' && $('j-status')) $('j-status').textContent = 'EasyTier 状态: ' + text;
  });
  window.mclink.onEasytierError((err) => {
    const message = typeof err === 'string' ? err : err?.message || '未知错误';
    state.easytier = { ...state.easytier, state: 'error', running: false, error: message };
    logLine('[EasyTier错误] ' + message);
    toast('EasyTier: ' + message, 'error');
  });
  window.mclink.onFrpcLog((line) => {
    const KEY = ['start proxy', 'login to server', 'proxy added', 'proxy removed',
                 'reconnecting', 'disconnected', 'connected', 'error', 'failed'];
    const lower = line.toLowerCase();
    if (state.debugMode || KEY.some((k) => lower.includes(k))) logLine('[frpc] ' + line.trim());
  });
  window.mclink.onFrpcError((err) => {
    const detail = err instanceof Error ? err.message : String(err);
    logLine('[frpc错误] ' + detail);
    if (state.role === 'host' && state.roomCode && state.frpEndpoint) {
      const reason = 'frp 运行错误，房间已关闭：' + detail;
      sendSignal({ type: 'close', room: state.roomCode });
      void resetHostRoom(reason, true).catch((e) => debugLog('清理 frp 房间失败: ' + e.message));
      return;
    }
    toast('frp: ' + detail, 'error');
  });
}

/* ============ 其他 ============ */
function copyRoomCode() {
  navigator.clipboard.writeText(state.roomCode).then(() => toast('已复制房间号', 'success'));
}

// 房主：复制局域网连接地址（功能3）
function copyHostAddr() {
  const addr = $('host-lan-addr').textContent;
  navigator.clipboard.writeText(addr).then(() => toast('已复制连接地址: ' + addr, 'success'));
}

// 访客：复制连接地址（功能4）
function copyJoinAddr() {
  const addr = $('j-addr').textContent;
  navigator.clipboard.writeText(addr).then(() => toast('已复制连接地址: ' + addr, 'success'));
}

function clearLog() { $('log-box').innerHTML = ''; }
function copyQQGroup() { navigator.clipboard.writeText('229527551').then(() => toast('QQ群号已复制', 'success')); }

function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = String(value || '').trim().replace(/^v/i, '').split('-', 2);
    return { core: core.split('.').map((n) => parseInt(n, 10) || 0), pre: pre.split('.').filter(Boolean) };
  };
  const pa = parse(a), pb = parse(b);
  for (let i = 0; i < Math.max(pa.core.length, pb.core.length); i++) {
    if ((pa.core[i] || 0) !== (pb.core[i] || 0)) return (pa.core[i] || 0) > (pb.core[i] || 0) ? 1 : -1;
  }
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    if (pa.pre[i] === undefined || pb.pre[i] === undefined) return pa.pre[i] === undefined ? -1 : 1;
    if (pa.pre[i] === pb.pre[i]) continue;
    const an = /^\d+$/.test(pa.pre[i]), bn = /^\d+$/.test(pb.pre[i]);
    if (an && bn) return Number(pa.pre[i]) > Number(pb.pre[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return pa.pre[i].localeCompare(pb.pre[i]) > 0 ? 1 : -1;
  }
  return 0;
}
async function loadAppInfo() {
  state.appInfo = await window.mclink.getAppInfo();
  $('app-version').textContent = state.appInfo.version;
  $('app-platform').textContent = `${state.appInfo.platform} / ${state.appInfo.arch}`;
}
function announcementStorageKey(announcement) {
  return `blfp_announcement_${announcement.version || '1'}_${new Date().toISOString().slice(0, 10)}`;
}

async function loadAnnouncement() {
  try {
    const announcement = await api('/settings/announcement');
    state.announcement = announcement;
    if (!announcement.enabled || !announcement.content || localStorage.getItem(announcementStorageKey(announcement))) {
      checkForUpdates(true);
      return;
    }
    $('announcement-title').textContent = announcement.title || '公告';
    $('announcement-content').textContent = announcement.content;
    $('announcement-today').checked = false;
    const button = $('announcement-close');
    let remaining = Math.max(0, Number(announcement.forceSeconds) || 0);
    button.disabled = remaining > 0;
    button.textContent = remaining > 0 ? `请阅读（${remaining}s）` : '我知道了';
    $('announcement-modal').classList.remove('hidden');
    if (state.announcementTimer) clearInterval(state.announcementTimer);
    if (remaining > 0) {
      state.announcementTimer = setInterval(() => {
        remaining -= 1;
        button.disabled = remaining > 0;
        button.textContent = remaining > 0 ? `请阅读（${remaining}s）` : '我知道了';
        if (remaining <= 0) { clearInterval(state.announcementTimer); state.announcementTimer = null; }
      }, 1000);
    }
  } catch (e) {
    logLine('公告加载失败: ' + e.message);
    checkForUpdates(true);
  }
}

function closeAnnouncement() {
  if ($('announcement-close').disabled) return;
  if ($('announcement-today').checked && state.announcement) localStorage.setItem(announcementStorageKey(state.announcement), '1');
  if (state.announcementTimer) clearInterval(state.announcementTimer);
  state.announcementTimer = null;
  $('announcement-modal').classList.add('hidden');
  checkForUpdates(true);
}

async function checkForUpdates(silent = false) {
  try {
    if (!state.appInfo) await loadAppInfo();
    if (!silent) $('update-status').textContent = '正在检查更新…';
    const info = await window.mclink.checkGithubUpdate();
    state.updateInfo = info;
    if (info.latestVersion && compareVersions(info.latestVersion, state.appInfo.version) > 0) {
      $('update-status').textContent = `GitHub Releases 发现新版本 ${info.latestVersion}`;
      $('update-title').textContent = `发现新版本 ${info.latestVersion}`;
      $('update-notes').textContent = info.releaseNotes || '暂无更新说明';
      $('update-download').textContent = info.downloadUrl ? `下载 ${info.assetName || '安装程序'}` : '打开发布页';
      $('update-modal').classList.remove('hidden');
    } else {
      $('update-status').textContent = '当前已是最新版本';
      if (!silent) toast('当前已是最新版本', 'success');
    }
  } catch (e) {
    if ($('update-status')) $('update-status').textContent = '检查失败：' + e.message;
    if (!silent) toast('检查更新失败：' + e.message, 'error');
  }
}
function openUpdateDownload() {
  const url = state.updateInfo?.downloadUrl || state.updateInfo?.releaseUrl;
  if (!url) return toast('暂无可用下载地址', 'warn');
  window.mclink.openExternal(url).then((r) => { if (!r.ok) toast(r.error, 'error'); });
}
function openSourceRepo() {
  window.mclink.openExternal(GITHUB_REPO_URL);
}

/* ============ 退出软件（t5）=========== */
function doExitApp() {
  showConfirm('确认退出软件？', '将停止所有连接并关闭 BLFP。', async () => {
    await stopEasyTier();
    try { await window.mclink.frpcStop(); } catch {}
    try { await window.mclink.exitApp(); } catch { window.close(); }
  });
}

/* ============ 设置（t2）=========== */
const SETTINGS_KEY = 'blfp_settings';

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { localStorage.removeItem(SETTINGS_KEY); }
  const server = DEFAULT_SERVER;
  localStorage.removeItem('mclink_server');
  const mcPort = Number(s.mcPort) || 25565;
  state.server = server;
  state.mcPort = mcPort;
  state.debugMode = !!s.debugMode;
  state.etNodeMode = s.etNodeMode || 'auto';
  applyTheme(s.theme || 'dark', false);
  applySidebarMode(s.sidebarMode || 'normal', false);
  applyPerfLevel(s.perf || 'medium', false);
  if (s.cursorTrail) enableCursorTrail();
  if ($('s-server')) $('s-server').value = server;
  if ($('a-server')) $('a-server').value = server;
  if ($('s-mc-port')) $('s-mc-port').value = mcPort;
  if ($('mc-port')) $('mc-port').value = mcPort;
  if ($('quick-mc-port')) $('quick-mc-port').value = mcPort;
  if ($('s-launch-behavior')) $('s-launch-behavior').value = s.launchBehavior || 'ask';
  if ($('sidebar-mode')) $('sidebar-mode').value = s.sidebarMode || 'normal';
  if ($('perf-level')) $('perf-level').value = s.perf || 'medium';
  if ($('cursor-trail-toggle')) $('cursor-trail-toggle').checked = !!s.cursorTrail;
  if ($('debug-mode-toggle')) $('debug-mode-toggle').checked = state.debugMode;
  return s;
}

function saveSettings() {
  const server = DEFAULT_SERVER;
  const mcPort = parseInt($('s-mc-port').value) || 25565;
  const launchBehavior = $('s-launch-behavior').value;
  const sidebarMode = $('sidebar-mode').value;
  const perf = $('perf-level').value;
  const cursorTrail = $('cursor-trail-toggle').checked;
  const debugMode = $('debug-mode-toggle').checked;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  const etNodeMode = $('s-et-node') ? $('s-et-node').value : 'auto';

  const s = { server, mcPort, launchBehavior, sidebarMode, perf, cursorTrail, debugMode, theme, etNodeMode };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  localStorage.setItem('mclink_server', server);
  state.server = server;
  state.mcPort = mcPort;
  state.debugMode = debugMode;
  state.etNodeMode = etNodeMode;
  $('a-server').value = server;
  $('mc-port').value = mcPort;
  $('quick-mc-port').value = mcPort;
  applySidebarMode(sidebarMode, false);
  applyPerfLevel(perf, false);
  if (cursorTrail) enableCursorTrail(); else disableCursorTrail();
  toast('设置已保存', 'success');
}

function setDebugMode(on) {
  state.debugMode = !!on;
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  s.debugMode = state.debugMode;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  logLine(state.debugMode ? '开发者调试模式已开启，底层日志不再过滤' : '开发者调试模式已关闭');
}

function setSidebarMode(mode) { applySidebarMode(mode, true); }
function applySidebarMode(mode, save) {
  const value = ['normal', 'collapsed'].includes(mode) ? mode : 'normal';
  document.body.classList.remove('sidebar-normal', 'sidebar-collapsed');
  document.body.classList.add('sidebar-' + value);
  if ($('sidebar-mode')) $('sidebar-mode').value = value;
  if (save) {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    s.sidebarMode = value;
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

function setTheme(t) {
  applyTheme(t, true);
}

function applyTheme(t, save) {
  const theme = t === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-dark') && $('theme-dark').classList.toggle('active', t !== 'light');
  $('theme-light') && $('theme-light').classList.toggle('active', t === 'light');
  if (window.mclink && window.mclink.setTitlebarOverlay) {
    window.mclink.setTitlebarOverlay(theme).catch(() => {});
  }
  if (save) {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    s.theme = t; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

function setPerfLevel(level) { applyPerfLevel(level, true); }

function applyPerfLevel(level, save) {
  const value = ['off', 'low', 'medium', 'high'].includes(level) ? level : 'medium';
  document.body.classList.remove('perf-off', 'perf-low', 'perf-medium', 'perf-high');
  document.body.classList.add('perf-' + value);
  if ($('perf-level')) $('perf-level').value = value;
  if ($('cursor-trail-toggle')?.checked) {
    if (level === 'off') disableCursorTrail();
    else { if (!particleEnabled) enableCursorTrail(); else resetParticles(); }
  }
  if (save) {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    s.perf = value; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

function setCursorTrail(on) {
  if (on) enableCursorTrail(); else disableCursorTrail();
  const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  s.cursorTrail = on; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let particleEnabled = false;
let particleFrame = null;
let particles = [];
const particleMouse = { x: -1000, y: -1000, active: false, lastMove: 0 };
function particleCount() {
  const level = $('perf-level')?.value || 'medium';
  return { high: 96, medium: 64, low: 28, off: 0 }[level] || 64;
}
function resetParticles() {
  const canvas = $('particle-bg');
  const count = particleEnabled ? particleCount() : 0;
  particles = Array.from({ length: count }, () => ({
    x: Math.random() * innerWidth, y: Math.random() * innerHeight,
    vx: (Math.random() - 0.5) * 0.28, vy: (Math.random() - 0.5) * 0.28,
  }));
}
function drawParticles() {
  if (!particleEnabled) { particleFrame = null; return; }
  if (document.hidden) { particleFrame = null; return; }
  const canvas = $('particle-bg');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const mouseMoving = particleMouse.active && performance.now() - particleMouse.lastMove < 160;
  const perf = $('perf-level')?.value || 'medium';
  const repelParticles = ['high', 'medium'].includes(perf);
  const drawConnections = perf === 'high' || (perf === 'medium' && Math.floor(performance.now() / 16) % 2 === 0);
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (mouseMoving && repelParticles) {
      const dx = p.x - particleMouse.x, dy = p.y - particleMouse.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 190 && dist > 1) { const force = (1 - dist / 190) * 0.018; p.vx += dx / dist * force; p.vy += dy / dist * force; }
    }
    if (Math.hypot(p.vx, p.vy) < 0.055) { p.vx += (Math.random() - 0.5) * 0.006; p.vy += (Math.random() - 0.5) * 0.006; }
    p.vx *= 0.9985; p.vy *= 0.9985;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > 0.65) { p.vx = p.vx / speed * 0.65; p.vy = p.vy / speed * 0.65; }
    p.x += p.vx; p.y += p.vy;
    if (p.x < 0 || p.x > innerWidth) { p.x = Math.max(0, Math.min(innerWidth, p.x)); p.vx *= -1; }
    if (p.y < 0 || p.y > innerHeight) { p.y = Math.max(0, Math.min(innerHeight, p.y)); p.vy *= -1; }
    ctx.fillStyle = 'rgba(116,143,252,0.5)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2); ctx.fill();
    if (particleMouse.active) {
      const d = Math.hypot(particleMouse.x - p.x, particleMouse.y - p.y);
      if (d < 150) { ctx.strokeStyle = `rgba(116,143,252,${(1 - d / 150) * 0.28})`; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(particleMouse.x, particleMouse.y); ctx.stroke(); }
    }
    if (drawConnections) {
      for (let j = i + 1; j < particles.length; j++) {
        const q = particles[j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
        if (d < 85) {
          ctx.strokeStyle = `rgba(116,143,252,${(1 - d / 85) * 0.15})`;
          ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
        }
      }
    }
  }
  particleFrame = requestAnimationFrame(drawParticles);
}
function resizeParticles() {
  const canvas = $('particle-bg');
  if (!canvas) return;
  canvas.width = innerWidth;
  canvas.height = innerHeight;
}
function enableCursorTrail() {
  particleEnabled = true;
  const bg = $('particle-bg');
  if (!bg) return;
  bg.classList.remove('hidden');
  resizeParticles();
  resetParticles();
  drawParticles();
  window.addEventListener('resize', resizeParticles);
  bg.addEventListener('mousemove', (e) => {
    particleMouse.x = e.clientX;
    particleMouse.y = e.clientY;
    particleMouse.active = true;
    particleMouse.lastMove = performance.now();
  });
  bg.addEventListener('mouseleave', () => { particleMouse.active = false; });
}
function disableCursorTrail() {
  particleEnabled = false;
  const bg = $('particle-bg');
  if (!bg) return;
  bg.classList.add('hidden');
  window.removeEventListener('resize', resizeParticles);
  if (particleFrame) cancelAnimationFrame(particleFrame);
}

/* ============ 广场：公开房间 ============ */
let publicRoomsInterval = null;
function loadPublicRooms(initial = false) {
  if (!state.token) return;
  const fetchRooms = async () => {
    try {
      const rooms = await api('/rooms/public');
      renderPublicRooms(rooms);
      if (initial) logLine('已加载公开房间列表');
    } catch (e) {
      if (initial) logLine('加载公开房间失败: ' + e.message);
    }
  };
  fetchRooms();
  if (publicRoomsInterval) clearInterval(publicRoomsInterval);
  publicRoomsInterval = setInterval(fetchRooms, 5000);
}
function renderPublicRooms(rooms) {
  const list = $('public-rooms');
  if (!list) return;
  if (!rooms || !rooms.length) {
    list.innerHTML = '<div class="empty-state">暂无公开房间</div>';
    return;
  }
  list.innerHTML = rooms.map((room) => {
    const rawCode = String(room.room_code ?? room.code ?? '');
    const code = /^\d{6}$/.test(rawCode) ? rawCode : '';
    const total = Number(room.total ?? room.members ?? 1);
    const maxMembers = Number(room.max_members ?? room.maxMembers ?? 8);
    return `
    <div class="public-room" onclick="quickJoinRoom('${code}')">
      <div class="pr-code">${escapeHtml(code)}</div>
      <div class="pr-info">
        <div class="pr-host">${escapeHtml(room.host || '未知用户')}</div>
        <div class="pr-meta">
          <span class="tag ${room.mode === 'frp' ? 'tag-frp' : 'tag-p2p'}">${room.mode === 'frp' ? 'frp 中转' : 'EasyTier 智能组网'}</span>
          <span>${total}/${maxMembers} 人在线</span>
        </div>
      </div>
      <div class="pr-join">加入</div>
    </div>`;
  }).join('');
}
async function quickJoinRoom(code) {
  const roomCode = String(code ?? '').trim();
  if (!/^\d{6}$/.test(roomCode)) return toast('房间号无效', 'error');
  if (state.role) return toast('当前已在房间中，请先退出当前房间', 'warn');
  navTo('join');
  $('room-input').value = roomCode;
  await joinRoom();
}

/* ============ 好友 ============ */
async function searchFriends() {
  const q = ($('friend-search').value || '').trim();
  if (!q) return;
  const el = $('friend-search-results');
  try {
    const users = await api('/friends/search?q=' + encodeURIComponent(q));
    if (!users.length) { el.innerHTML = '<div class="empty-state">未找到用户</div>'; return; }
    el.innerHTML = users.map(u => `
      <div class="friend-item">
        <div class="fi-avatar">${escapeHtml(u.username.charAt(0).toUpperCase())}</div>
        <div class="fi-info">
          <div class="fi-name">${escapeHtml(u.username)}${u.title ? ` <span class="user-title theme-${escapeHtml(u.theme||'dark')}">${escapeHtml(u.title)}</span>` : ''}</div>
          <div class="fi-status ${u.online ? 'online' : ''}">${u.online ? '在线' : '离线'}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="sendFriendReq(${u.id})">添加好友</button>
      </div>`).join('');
  } catch (e) { toast(e.message, 'error'); }
}

async function sendFriendReq(id) {
  try { const r = await api(`/friends/${id}`, { method: 'POST' }); toast(r.message || '申请已发送'); } catch (e) { toast(e.message, 'error'); }
}

function switchFriendTab(tab) {
  ['list', 'requests', 'history'].forEach(t => {
    $('ftab-' + t).classList.toggle('active', t === tab);
    $('friends-panel-' + t).classList.toggle('hidden', t !== tab);
  });
  if (tab === 'requests') loadFriendRequests();
  if (tab === 'history') loadFriendHistory();
}

function loadFriends(initial = false) {
  if (!state.token) return;
  api('/friends').then((friends) => {
    renderFriends(friends);
    if (initial) logLine('已加载好友列表');
  }).catch((e) => {
    if (initial) logLine('加载好友失败: ' + e.message);
  });
  api('/friends/requests').then((reqs) => {
    const badge = $('ftab-requests-badge');
    if (badge) {
      if (reqs && reqs.length > 0) { badge.textContent = reqs.length; badge.classList.remove('hidden'); }
      else badge.classList.add('hidden');
    }
  }).catch(() => {});
}

function renderFriends(friends) {
  const list = $('friends-list');
  if (!list) return;
  if (!friends || !friends.length) { list.innerHTML = '<div class="empty-state">暂无好友</div>'; return; }
  list.innerHTML = friends.map((f) => `
    <div class="friend-item">
      <div class="fi-avatar">${escapeHtml(f.username.charAt(0).toUpperCase())}</div>
      <div class="fi-info">
        <div class="fi-name">${escapeHtml(f.username)}${f.title ? ` <span class="user-title theme-${escapeHtml(f.theme||'dark')}">${escapeHtml(f.title)}</span>` : ''}</div>
        <div class="fi-status ${f.online ? 'online' : ''}">${f.online ? '在线' : '离线'}${f.room ? ` · 房间 <span class="copy-link" onclick="copyText('${escapeHtml(f.room.code)}')">${escapeHtml(f.room.code)}</span>` : ''}</div>
      </div>
      <button class="btn btn-danger btn-sm" onclick="removeFriend(${f.id})">删除</button>
    </div>`).join('');
}

function loadFriendRequests() {
  if (!state.token) return;
  api('/friends/requests').then((reqs) => {
    const list = $('friends-requests-list');
    const badge = $('ftab-requests-badge');
    if (badge) { if (reqs.length) { badge.textContent = reqs.length; badge.classList.remove('hidden'); } else badge.classList.add('hidden'); }
    if (!list) return;
    if (!reqs.length) { list.innerHTML = '<div class="empty-state">暂无待处理申请</div>'; return; }
    list.innerHTML = reqs.map(r => `
      <div class="friend-item">
        <div class="fi-avatar">${escapeHtml(r.username.charAt(0).toUpperCase())}</div>
        <div class="fi-info">
          <div class="fi-name">${escapeHtml(r.username)}${r.title ? ` <span class="user-title theme-${escapeHtml(r.theme||'dark')}">${escapeHtml(r.title)}</span>` : ''}</div>
          <div class="fi-status" style="font-size:.75rem;color:var(--text2)">${new Date(r.requested_at*1000).toLocaleString()}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-primary btn-sm" onclick="acceptFriend(${r.id})">接受</button>
          <button class="btn btn-danger btn-sm" onclick="rejectFriend(${r.id})">拒绝</button>
        </div>
      </div>`).join('');
  }).catch(() => {});
}

function loadFriendHistory() {
  if (!state.token) return;
  api('/friends/history').then((rows) => {
    const list = $('friends-history-list');
    if (!list) return;
    if (!rows.length) { list.innerHTML = '<div class="empty-state">暂无记录</div>'; return; }
    const statusLabel = { pending: '等待确认', rejected: '已被拒绝' };
    list.innerHTML = rows.map(r => `
      <div class="friend-item">
        <div class="fi-avatar">${escapeHtml(r.username.charAt(0).toUpperCase())}</div>
        <div class="fi-info">
          <div class="fi-name">${escapeHtml(r.username)}</div>
          <div class="fi-status">${statusLabel[r.status] || r.status} · ${new Date(r.sent_at*1000).toLocaleDateString()}</div>
        </div>
      </div>`).join('');
  }).catch(() => {});
}

async function acceptFriend(userId) {
  try { await api(`/friends/${userId}/accept`, { method: 'POST' }); toast('已接受好友申请'); loadFriendRequests(); loadFriends(); } catch (e) { toast(e.message, 'error'); }
}
async function rejectFriend(userId) {
  try { await api(`/friends/${userId}/reject`, { method: 'POST' }); toast('已拒绝'); loadFriendRequests(); } catch (e) { toast(e.message, 'error'); }
}
async function removeFriend(userId) {
  if (!confirm('确认删除好友？')) return;
  try { await api(`/friends/${userId}`, { method: 'DELETE' }); toast('已删除'); loadFriends(); } catch (e) { toast(e.message, 'error'); }
}

/* ============ 初始化 ============ */
document.addEventListener('DOMContentLoaded', async () => {
  $('auth-page').classList.remove('hidden');
  $('main-app').classList.add('hidden');
  setLoginLoading(false);

  const showStartupError = (source, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${source}启动失败:`, error);
    showAuthErr(`启动错误：${source}失败：${message}`);
  };

  try {
    loadSettings();
  } catch (error) {
    showStartupError('设置加载', error);
  }

  if (!window.mclink) {
    showStartupError('客户端接口', new Error('预加载接口不可用，请重新启动客户端'));
    return;
  }

  try {
    setupTunnelBridge();
  } catch (error) {
    showStartupError('IPC 初始化', error);
  }

  Promise.resolve()
    .then(() => loadAppInfo())
    .catch((error) => showStartupError('应用信息加载', error));

  const savedToken = localStorage.getItem('mclink_token');
  if (!savedToken) return;

  state.token = savedToken;
  state.server = DEFAULT_SERVER;
  setLoginLoading(true, '正在恢复登录…');
  try {
    state.user = await api('/auth/me');
    enterApp();
  } catch (error) {
    state.token = null;
    state.user = null;
    state.signingKey = null;
    state.signingKeyToken = null;
    localStorage.removeItem('mclink_token');
    $('main-app').classList.add('hidden');
    $('auth-page').classList.remove('hidden');
    showAuthErr('登录状态已失效，请重新登录：' + error.message);
  } finally {
    setLoginLoading(false);
  }
});

