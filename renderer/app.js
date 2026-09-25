/* ============ 全局状态 ============ */
const DEFAULT_SERVER = 'http://154.40.43.136:4000';   /* 主服务器：登录/房间/好友/设置 */
const DEFAULT_CHAT_SERVER = 'http://154.40.43.136:4001'; /* 聊天公告专用服务器 */
/* 主服务器候选：启动时自动探测，哪个能通用哪个 */
const SERVER_CANDIDATES = [
  'http://154.40.43.136:4000',
  'https://p.blfp.cn',
];
/* 聊天/公告服务器候选：探测失败时回退到主服务器（主服务器同样带聊天+公告能力） */
const CHAT_SERVER_CANDIDATES = [
  'http://154.40.43.136:4001',
];
const GITHUB_REPO_URL = 'https://github.com/EVFBV/BLFP-client';
const state = {
  server: DEFAULT_SERVER,
  chatServer: DEFAULT_CHAT_SERVER,   // 聊天/公告专用服务器
  chatWs: null,        // 聊天室独立 WebSocket
  publicRooms: [],     // 最近一次获取的公开房间列表（详情降级用）
  joinTimer: null,     // 加入房间超时计时器
  roomInfo: null,      // 房间信息（加入后由服务端下发）
  geetestValidate: null, // 极验验证回调
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
  const time = new Date().toLocaleTimeString();
  /* 先写日志文件（界面日志框不存在时也不丢日志，PowerShell 才能看到内容） */
  writeLogFile('[' + time + '] ' + msg);
  const box = $('log-box');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${time}] ${msg}`;
  box.appendChild(line);
  const maxLines = state.debugMode ? 2000 : 500;
  while (box.childElementCount > maxLines) box.firstElementChild.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}
/* 日志同时写入文件（%APPDATA%\\BLFP\\logs\\blfp.log），供"在 PowerShell 中查看日志"实时跟随 */
let logFileBuffer = [];
let logFileFlushTimer = null;
function flushLogFile() {
  logFileFlushTimer = null;
  if (!logFileBuffer.length) return;
  const lines = logFileBuffer;
  logFileBuffer = [];
  try {
    if (window.mclink && window.mclink.appendLog) window.mclink.appendLog(lines);
  } catch (e) {}
}
function writeLogFile(line) {
  logFileBuffer.push(line);
  if (logFileBuffer.length >= 20) { flushLogFile(); return; }
  if (!logFileFlushTimer) logFileFlushTimer = setTimeout(flushLogFile, 400);
}
window.addEventListener('beforeunload', flushLogFile);


function debugLog(msg) {
  if (state.debugMode) logLine('[调试] ' + msg);
}


/* ====== 服务器自动探测：按候选顺序试 /api/health，取第一个可用的 ====== */
async function probeServer(url, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 4000);
    const res = await fetch(url + '/api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) return false;
    /* 必须数据库就绪（ready:true）——否则会选到"服务活着但数据库没连上"的实例，报"数据库尚未就绪" */
    const data = await res.json().catch(() => ({}));
    return data.ok !== false && data.ready === true;
  } catch (e) { return false; }
}

/* ====== 应用内日志窗口（始终可用，不依赖 PowerShell）====== */
let logViewerTimer = null;
async function refreshLogViewer() {
  const pre = document.querySelector('.log-viewer-pre');
  if (!pre) return;
  try {
    const res = await window.mclink.readLog(500);
    if (res && res.ok) {
      pre.textContent = res.text || '（日志为空）';
      pre.scrollTop = pre.scrollHeight;
    } else {
      pre.textContent = '读取日志失败：' + ((res && res.error) || '未知错误');
    }
  } catch (e) {
    pre.textContent = '读取日志失败：' + e.message;
  }
}
async function openLogViewer() {
  let res = null;
  try { res = await window.mclink.readLog(500); } catch (e) {}
  showModal('log-viewer-modal',
    '<h3>运行日志</h3>' +
    '<p style="font-size:.75rem;color:var(--text2);margin-bottom:8px">' +
      escapeHtml((res && res.logPath) || '') +
    '</p>' +
    '<pre class="log-viewer-pre diag-pre" style="max-height:52vh">正在读取…</pre>' +
    '<div class="modal-actions">' +
      '<button class="btn btn-outline btn-sm" onclick="openLogFolder()">打开日志文件夹</button>' +
      '<button class="btn btn-outline btn-sm" onclick="exportDiagnostics()">导出诊断</button>' +
      '<button class="btn btn-primary btn-sm" onclick="closeModal(\'log-viewer-modal\')">关闭</button>' +
    '</div>');
  refreshLogViewer();
  if (logViewerTimer) clearInterval(logViewerTimer);
  logViewerTimer = setInterval(() => {
    if (!document.querySelector('.log-viewer-pre')) { clearInterval(logViewerTimer); logViewerTimer = null; return; }
    refreshLogViewer();
  }, 2000);
}
async function openLogFolder() {
  try {
    const res = await window.mclink.openLogFolder();
    if (res && res.ok) toast('已打开日志文件夹', 'success');
    else notify('打开失败：' + ((res && res.error) || '未知错误'), 'error');
  } catch (e) { notify('打开失败：' + e.message, 'error'); }
}

/* ====== EasyTier 需要管理员权限：不再默认提权，需要时提示用户以管理员重启 ====== */
async function isElevated() {
  try {
    if (!window.mclink || !window.mclink.isElevated) return true;
    return !!(await window.mclink.isElevated());
  } catch (e) { return false; }
}

function askElevation(what) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    $('confirm-title').textContent = '需要管理员权限';
    $('confirm-msg').textContent = what + ' 需要创建虚拟网卡，必须以管理员身份运行。\n\n点「确定」以管理员身份重启客户端（重启后请重新操作）；点「取消」则保持当前权限（EasyTier 无法使用，可改用 frp 中转模式）。';
    $('confirm-modal').classList.remove('hidden');
    $('confirm-ok').__handler = () => finish('elevate');
    $('confirm-cancel').__handler = () => finish('cancel');
  });
}

/* 返回 true 表示可以继续启动 EasyTier；false 表示已中断（正在提权重启或用户取消） */
async function ensureElevatedForEasyTier(what) {
  if (await isElevated()) return true;
  const choice = await askElevation(what);
  if (choice === 'elevate') {
    notify('正在以管理员身份重启客户端…');
    try { await window.mclink.relaunchElevated(); } catch (e) { notify('提权重启失败：' + e.message, 'error'); }
    return false;
  }
  notify('已取消：EasyTier 需要管理员权限，可改用 frp 中转模式', 'warn');
  return false;
}

/* ====== 登录过期统一处理（JWT 7天到期 / 服务器换密钥 / 改密码 → 所有请求 401）====== */
let sessionExpiredHandling = false;
async function handleSessionExpired(message) {
  if (sessionExpiredHandling) return;
  sessionExpiredHandling = true;
  try {
    notify(message || '登录已过期，请重新登录', 'error');
    /* 清理房间与隧道，避免留下孤儿进程 */
    try { if (state.role === 'guest') await leaveRoom(); else if (state.role === 'host') await closeRoom(); } catch (e) {}
    try { await stopEasyTier(); } catch (e) {}
    try { await window.mclink.frpcStop(); } catch (e) {}
    if (state.presenceTimer) { clearInterval(state.presenceTimer); state.presenceTimer = null; }
    if (state.joinTimer) { clearTimeout(state.joinTimer); state.joinTimer = null; }
    try { if (state.ws) { state.closingSignaling = true; state.ws.onclose = null; state.ws.close(); } } catch (e) {}
    try { if (state.chatWs) { state.chatWs.onclose = null; state.chatWs.close(); } } catch (e) {}
    state.ws = null;
    state.chatWs = null;
    state.token = null;
    state.user = null;
    state.signingKey = null;
    state.signingKeyToken = null;
    state.role = null;
    state.roomCode = null;
    state.roomInfo = null;
    try { localStorage.removeItem('mclink_token'); } catch (e) {}
    const main = $('main-app'); if (main) main.classList.add('hidden');
    const auth = $('auth-page'); if (auth) auth.classList.remove('hidden');
    showAuthErr(message || '登录已过期，请重新登录');
  } finally {
    setTimeout(() => { sessionExpiredHandling = false; }, 3000);
  }
}

/* 聊天/公告专用请求：走 chatServer，失败自动回退主服务器 */
async function apiChat(path, opts) {
  try {
    return await api(path, opts || {}, state.chatServer);
  } catch (e) {
    /* 聊天服务器不可用/密钥不一致（401/403）时回退主服务器——主服务器同样能读写公告 */
    if (state.chatServer !== state.server && /数据库尚未就绪|请求失败|无法连接|超时|未登录|登录已过期|权限/.test(e.message || '')) {
      logLine('聊天/公告服务器请求失败（' + e.message + '），已回退主服务器');
      state.chatServer = state.server;
      return api(path, opts || {}, state.server);
    }
    throw e;
  }
}

/* 探测聊天/公告服务器；不可用则回退到主服务器 */
async function resolveChatServer() {
  for (const url of CHAT_SERVER_CANDIDATES) {
    if (await probeServer(url)) {
      state.chatServer = url;
      logLine('聊天/公告服务器: ' + url);
      return url;
    }
    logLine('聊天/公告服务器不可用，回退主服务器: ' + url);
  }
  state.chatServer = state.server;
  logLine('聊天/公告使用主服务器: ' + state.server);
  return state.chatServer;
}

async function resolveServer() {
  for (const url of SERVER_CANDIDATES) {
    if (await probeServer(url)) {
      if (url !== state.server) logLine('已选择服务器: ' + url);
      state.server = url;
      const a = $('a-server'); if (a) a.value = url;
      const s = $('s-server'); if (s) s.value = url;
      return url;
    }
    logLine('服务器不可用，尝试下一个: ' + url);
  }
  logLine('警告：所有候选服务器均不可达，使用默认地址 ' + DEFAULT_SERVER);
  state.server = DEFAULT_SERVER;
  return DEFAULT_SERVER;
}

function assertSecureServer(server) {
  const url = new URL(server);
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !local) {
    /* 允许 http（自建服务器无证书场景），仅在日志中提醒 */
    logLine('警告：服务器使用 HTTP 明文传输，登录密码未加密，建议尽快配置 HTTPS');
  }
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

function isAuthEndpoint(path) {
  return /^\/auth\/(login|register|send-code|tfa)/.test(String(path || ''));
}

async function api(path, opts = {}, baseServer) {
  const base = baseServer || state.server;
  assertSecureServer(base);
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
    const res = await fetch(base + '/api' + path, { ...opts, method, headers, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && state.token && !isAuthEndpoint(path)) {
      /* token 失效：统一退回登录页，而不是让用户面对"点什么都没反应" */
      handleSessionExpired(data.error || '登录已过期，请重新登录');
    }
    if (!res.ok) throw new Error(data.error || '请求失败 (' + res.status + ')');
    return data;
  } catch (e) {
    if (e.name === 'AbortError') {
      /* 超时：换一个候选服务器再试一次 */
      const next = await switchServerCandidate();
      if (next) return api(path, opts);
      throw new Error('请求超时，请检查网络后重试');
    }
    /* 网络层失败（Failed to fetch 等）：多半是当前地址被代理/防火墙挡住，换候选重试 */
    if (e instanceof TypeError && base === state.server) {
      const next = await switchServerCandidate();
      if (next) {
        logLine('当前服务器不可达，已切换到 ' + next + ' 并重试');
        return api(path, opts);
      }
      throw new Error('无法连接服务器（' + state.server + '）。可能是本机代理未放行该地址，请尝试关闭系统代理后重试');
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

/* 切换到下一个可用候选服务器；没有可切换的返回 null */
let serverSwitchLock = false;
async function switchServerCandidate() {
  if (serverSwitchLock) return null;
  serverSwitchLock = true;
  try {
    const others = SERVER_CANDIDATES.filter((u) => u !== state.server);
    for (const url of others) {
      if (await probeServer(url)) {
        state.server = url;
        const a = $('a-server'); if (a) a.value = url;
        const s = $('s-server'); if (s) s.value = url;
        return url;
      }
    }
    return null;
  } finally { serverSwitchLock = false; }
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
  if (!requireGeetest()) return showAuthErr('请先完成人机验证');

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
  // 二次确认弹窗
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
  $('confirm-ok').__handler = null;
  $('confirm-cancel').__handler = null;
  $('confirm-modal').classList.add('hidden');
  if (handler) handler();
}
function confirmCancel() {
  $('confirm-modal').classList.add('hidden');
  const handler = $('confirm-cancel').__handler;
  $('confirm-cancel').__handler = null;
  $('confirm-ok').__handler = null;
  if (handler) handler();
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
  const title = user.title || ({ admin: '管理员', dev: '开发者', sponsor: '赞助用户', user: '普通用户' }[user.role] || '普通用户');
  const cls = resolveUserThemeClass(user.theme, user.role);
  $('s-role').textContent = title;
  $('s-role').className = `user-role ${cls}`.trim();
  $('s-role').dataset.userTheme = safeUserTheme(user.theme) || 'role';
}

function enterApp() {
  setTimeout(applyPrivilegeUI, 100);
  $('auth-page').classList.add('hidden');
  $('main-app').classList.remove('hidden');
  $('s-username').textContent = state.user.username;
  // Also update sidebar user area
  if ($('s-username')) $('s-username').textContent = state.user.username;
  if ($('s-avatar-initials')) $('s-avatar-initials').textContent = state.user.username.charAt(0).toUpperCase();
  applyUserAppearance(state.user);
  fillUserPanel();
  const welcome = state.user.role === 'sponsor' ? `感谢赞助，${state.user.username}！欢迎回到 BLFP。` : `欢迎回来，${state.user.username}。`;
  if ($('home-welcome')) $('home-welcome').textContent = welcome;
  if ($('us-logged-in-as')) $('us-logged-in-as').textContent = '登录为: ' + state.user.username;
  logLine(welcome);
  const home = $('page-home');
  home.classList.add('enter-from-right');
  setTimeout(() => home.classList.remove('enter-from-right'), 230);
  loadFrpNodes();
  loadEtNodes();
  loadPublicRooms(true);
  loadFriends(true);
  loadAnnouncements();
  if (state.user.role === 'sponsor' && !sessionStorage.getItem('blfp_sponsor_welcome')) { sessionStorage.setItem('blfp_sponsor_welcome', '1'); toast(`感谢赞助，${state.user.username}，欢迎回来！`, 'success'); }
  syncPresence(true).catch((e) => logLine('在线状态同步失败: ' + e.message));
  if (state.presenceTimer) clearInterval(state.presenceTimer);
  state.presenceTimer = setInterval(() => syncPresence(true).catch((e) => debugLog('在线状态同步失败: ' + e.message)), 60000);
  loadAnnouncement();
}

/* ============ 导航 ============ */
const NAV_ORDER = ['home', 'host', 'rooms', 'friends', 'chat'];
let currentPage = 'home';
let navTimer = null;
let navLock = false;
function navTo(page, btn) {
  if (page === 'user-settings') { setTimeout(applyPrivilegeUI, 50); setTimeout(fillUserPanel, 30); }
  // When navigating to any page other than settings, remove .active from gear-btn
  if (page !== 'settings' && page !== 'user-settings') {
    const gearBtn = $('sidebar-gear-btn');
    if (gearBtn) gearBtn.classList.remove('active');
  }
  if (page === currentPage) {
    // 重复点当前选项卡 → 回主页（设置/用户页除外）
    if (page !== 'home' && page !== 'settings' && page !== 'user-settings') {
      navTo('home');
      return;
    }
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n === (btn || document.querySelector(`.nav-item[data-page="${page}"]`))));
    return;
  }
  if (navLock) return;
  const oldPage = $('page-' + currentPage);
  const nextPage = $('page-' + page);
  if (!oldPage || !nextPage) return;
  // 'log' is no longer a page, but keep the perf check for compatibility
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
    // Handle pages not in NAV_ORDER for animation direction
    const idx = NAV_ORDER.indexOf(page);
    const currentIdx = NAV_ORDER.indexOf(currentPage);
    const forward = (idx !== -1 && currentIdx !== -1) ? idx > currentIdx : true;
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
  if (page === 'rooms' && state.token) loadPublicRooms(true);
  if (page === 'friends' && state.token) loadFriends(true);
  if (page === 'chat') { initChat(); ensureChatConnection(); }
}

/* ============ 设置齿轮动画 ============ */
function toggleSettingsGear() {
  const gearBtn = $('sidebar-gear-btn');
  if (!gearBtn) return;
  if (currentPage === 'settings') {
    // 已在设置页 → 回主页
    gearBtn.classList.remove('active');
    navTo('home');
  } else {
    // 其他任何页面（含用户面板）→ 进设置
    navTo('settings');
    gearBtn.classList.add('active');
  }
}

/* ============ 模式选择 ============ */
function selectMode(mode) {
  state.mode = mode;
  $('mode-easytier').classList.toggle('active', mode === 'easytier');
  $('mode-frp').classList.toggle('active', mode === 'frp');
  // 伸长动画展开/收起节点选择
  const sec = $('frp-node-section');
  if (sec) {
    if (mode === 'frp') {
      sec.classList.remove('collapsed');
      loadFrpNodes({ force: false }).catch(() => {});
    } else {
      sec.classList.add('collapsed');
    }
  }
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

/* ============ EasyTier 节点选择 ============ */
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

let lastPingError = '';
async function pingPeerUrl(peer) {
  const target = parsePeerTarget(peer);
  if (!target || !window.mclink || !window.mclink.pingNode) {
    lastPingError = '客户端接口不可用';
    return null;
  }
  try {
    const res = await window.mclink.pingNode({ host: target.host, port: target.port });
    if (res && res.ok) { lastPingError = ''; return Number(res.latency); }
    lastPingError = (res && res.error) || '未知错误';
    logLine('测速失败 ' + target.host + ':' + target.port + ' → ' + lastPingError);
    return null;
  } catch (e) {
    lastPingError = e.message || '调用失败';
    logLine('测速异常 ' + target.host + ':' + target.port + ' → ' + lastPingError);
    return null;
  }
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
      const text = r.latency === null ? ('不可达 ' + (lastPingError || '')) : `${r.latency} ms`;
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
    /* 已有连接先关闭，避免残留 socket 干扰加入流程 */
    try {
      if (state.ws && state.ws.readyState !== WebSocket.CLOSED) {
        state.closingSignaling = true;
        state.ws.onclose = null;
        state.ws.close();
      }
    } catch (e) {}
    state.ws = null;
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
      if (currentPage === 'chat') {
        if (chatReconnectTimer) clearTimeout(chatReconnectTimer);
        chatReconnectTimer = setTimeout(() => { if (currentPage === 'chat') ensureChatConnection(); }, 3000);
      }
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
        logLine('房主代理端口已更新为: ' + msg.port);
      }
      break;
    case 'chat':
      // Handle chat messages from signaling
      if (msg.text && msg.username) {
        renderChatMessage(msg);
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

// Alias for backward compatibility with onSignal references
function onSignal(msg) {
  return handleSignal(msg);
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

  /* EasyTier 需要管理员权限（虚拟网卡） */
  if (!(await ensureElevatedForEasyTier('创建 EasyTier 房间'))) return;

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
    notify('frp 中转已启动', 'success');
    $('host-lan-addr').textContent = host + ':' + port;
    logLine('frp 房间已创建: ' + code + '，访客连接地址: ' + host + ':' + port);
    state.frpEndpoint = { host, port };
    reportFrpSession(code, port).catch((e) => logLine('frp 端口上报失败: ' + e.message));
    return;
  }

  if (!msg.easytier) throw new Error('服务端未返回 EasyTier 配置');
  notify('正在启动 EasyTier...');
  const etConfig = { ...msg.easytier, mode: 'host', mcPort: state.mcPort };
  etConfig.peers = await resolveEtPeers(etConfig.peers);
  const result = await window.mclink.easytierStart(etConfig);
  if (!result?.ok) throw new Error(result?.error || 'EasyTier 启动失败');
  state.easytier = result.status;
  const hostVirtualIp = msg.easytier.hostVirtualIp || state.easytier.virtualIp;
  if (!hostVirtualIp) throw new Error('未获取到房主虚拟 IP');
  state.easytier.hostVirtualIp = hostVirtualIp;
  notify('EasyTier 已启动，等待好友加入...', 'success');
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
  notify('好友已加入，EasyTier 正在自动组网', 'success');
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
  return `<div class="peer-item"><span class="peer-name">${name}${hostBadge}</span>${showIp ? '<span class="peer-ip">${ip}</span>' : '<span></span>'}<span class="peer-ping">${ping}</span></div>`;
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
    notify('EasyTier 已启动，等待好友加入...', 'success');
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
/* 快捷创建：直接打开真实起始弹窗并预选模式（旧的 quick-host-modal 是空 div，会弹出黑遮罩） */
function openQuickHost(mode) {
  quickHostMode = mode;
  try { selectStartMode(mode === 'frp' ? 'frp' : 'easytier'); } catch (e) {}
  const modal = $('start-host-modal');
  if (modal) modal.classList.remove('hidden');
  else navTo('host');
}
async function confirmQuickHost() {
  const button = $('quick-host-confirm');
  button.disabled = true;
  quickHostPending = true;
  $('mc-port').value = $('quick-mc-port').value;
  if (quickHostMode === 'frp') selectFrpNode($('quick-frp-node-select').value);
  await createRoom({ inputId: 'quick-mc-port', mode: quickHostMode, buttonId: 'quick-host-confirm', isPublic: !!($('quick-public')?.checked) });
  if (state.role !== 'host') {
    quickHostPending = false;
    button.disabled = false;
  }
}

/* ============ 开始联机对话框（新） ============ */
let startHostDialogMode = 'easytier';
let startHostDialogPortMode = 'auto';

function openStartHostDialog() {
  $('start-host-modal').classList.remove('hidden');
  startHostDialogMode = 'easytier';
  startHostDialogPortMode = 'auto';
  selectStartMode('easytier');
  selectHostPortOption('auto');
}

function selectHostPortOption(mode) {
  startHostDialogPortMode = mode;
  const autoCard = $('host-port-auto');
  const manualCard = $('host-port-manual');
  const portInput = $('start-custom-port');
  if (autoCard) autoCard.classList.toggle('selected', mode === 'auto');
  if (manualCard) manualCard.classList.toggle('selected', mode === 'manual');
  if (portInput) {
    portInput.disabled = mode !== 'manual';
    if (mode === 'manual') portInput.value = state.mcPort || 25565;
  }
}

function selectStartMode(mode) {
  startHostDialogMode = mode;
  const et = $('start-mode-easytier');
  const frp = $('start-mode-frp');
  if (et) et.classList.toggle('active', mode === 'easytier');
  if (frp) frp.classList.toggle('active', mode === 'frp');
  // frp 模式：伸长展开节点选择；easytier：收起
  const section = $('modal-frp-node-section');
  if (section) {
    if (mode === 'frp') {
      section.classList.remove('collapsed');
      loadStartDialogFrpNodes();
    } else {
      section.classList.add('collapsed');
    }
  }
}

/* 开始联机弹窗的 frp 节点选择（卡片式） */
let startDialogNodesLoaded = false;
async function loadStartDialogFrpNodes(force = false) {
  const list = $('frp-node-list');
  const status = $('frp-node-status');
  if (!list) return;
  if (startDialogNodesLoaded && !force) return;
  try {
    if (status) status.textContent = '加载中...';
    const result = await api('/nodes');
    const nodes = Array.isArray(result) ? result : [];
    state.frpNodes = nodes;
    if (!nodes.length) {
      list.innerHTML = '<div class="frp-node-empty">暂无可用节点</div>';
      if (status) status.textContent = '暂无节点';
      return;
    }
    if (status) status.textContent = nodes.length + ' 个节点可用';
    // 默认选第一个
    if (!state.frpNodeId || !nodes.find(n => n.id === state.frpNodeId)) {
      state.frpNodeId = nodes[0].id;
    }
    list.innerHTML = nodes.map((n, i) => `
      <div class="frp-node-item ${n.id === state.frpNodeId ? 'selected' : ''}" style="animation-delay:${Math.min(i * 0.07, 0.5)}s" onclick="selectStartDialogNode(${n.id})">
        <div>
          <div class="frp-node-name">${escapeHtml(n.name)}</div>
          <div class="frp-node-location">${escapeHtml(n.region || '未知')} · ${escapeHtml(n.bandwidth || '')}</div>
        </div>
        <div class="frp-node-latency mid" id="start-node-latency-${n.id}">测速中</div>
      </div>`).join('');
    startDialogNodesLoaded = true;
    // 后台测速（不阻塞）
    nodes.forEach((n) => {
      pingStartNode(n).catch(() => {});
    });
  } catch (e) {
    list.innerHTML = '<div class="frp-node-empty">节点获取失败，<a href="#" onclick="loadStartDialogFrpNodes(true);return false" style="color:var(--accent2)">重试</a></div>';
    if (status) status.textContent = '加载失败';
  }
}
function selectStartDialogNode(id) {
  state.frpNodeId = id;
  document.querySelectorAll('.frp-node-item').forEach((el) => {
    el.classList.toggle('selected', el.onclick.toString().includes(String(id)));
  });
  // 更精确的选中态
  document.querySelectorAll('#frp-node-list .frp-node-item').forEach((el, i) => {
    if (state.frpNodes[i]) el.classList.toggle('selected', state.frpNodes[i].id === id);
  });
}
async function pingStartNode(node) {
  const el = $('start-node-latency-' + node.id);
  if (!el) return;
  try {
    const t0 = performance.now();
    const res = await window.mclink.pingNode({ host: node.host || node.addr, port: Number(node.port || 443) });
    if (!res || !res.ok) { el.textContent = '本机不可达'; el.className = 'frp-node-latency bad'; return; }
    const ms = Number(res.latency) || Math.round(performance.now() - t0);
    el.textContent = ms + ' ms';
    el.className = 'frp-node-latency ' + (ms < 80 ? 'good' : ms < 200 ? 'mid' : 'bad');
  } catch (e) {
    el.textContent = '超时';
    el.className = 'frp-node-latency bad';
  }
}

function confirmStartHost() {
  const portEl = $('start-custom-port');
  let port;
  if (startHostDialogPortMode === 'auto') {
    port = state.mcPort || 25565;
    if ($('mc-port')) $('mc-port').value = port;
  } else {
    port = parseInt(portEl ? portEl.value : state.mcPort, 10);
    if (!port || port < 1 || port > 65535) {
      toast('请输入有效的端口号 (1-65535)', 'error');
      return;
    }
    if ($('mc-port')) $('mc-port').value = port;
  }
  state.mcPort = port;
  closeModal('start-host-modal');
  // 直接创建房间（原来调 openQuickHost() 会弹出一个空的 quick-host-modal，
  // 那是个遗留空 div → 全屏黑遮罩盖住界面，看起来像卡死）
  navTo('host');
  const mode = startHostDialogMode || state.mode || 'easytier';
  if (mode === 'frp') {
    createRoom({ inputId: 'mc-port', mode: 'frp', buttonId: 'btn-create', isPublic: !!($('host-public') && $('host-public').checked) });
  } else {
    createRoom({ inputId: 'mc-port', mode: 'easytier', buttonId: 'btn-create', isPublic: !!($('host-public') && $('host-public').checked) });
  }
}

/* ============ 加入房间对话框（从房间列表弹出） ============ */
function confirmJoinRoom() {
  const input = $('join-room-input');
  if (!input) return;
  const code = input.value.trim();
  if (!/^\d{6}$/.test(code)) {
    toast('请输入 6 位纯数字房间号', 'error');
    return;
  }
  closeModal('join-room-modal');
  // 直接设置兼容输入框并加入（不再跳页）
  const originalInput = $('room-input');
  if (originalInput) originalInput.value = code;
  joinRoom();
}

/* ============ Guest 侧：加入房间 ============ */
/* 取房间号：优先弹窗输入框，其次兼容元素（历史代码读的是隐藏 div，值为 undefined 会抛错） */
function currentJoinCode() {
  const modalInput = $('join-room-input');
  const compat = $('room-input');
  const raw = (modalInput && modalInput.value) || (compat && compat.value) || '';
  return String(raw).replace(/\D/g, '').slice(0, 6);
}

async function joinRoom() {
  if (state.role) return toast('当前已在房间中，请先退出当前房间', 'warn');
  const code = currentJoinCode();
  if (!/^\d{6}$/.test(code)) return toast('请输入 6 位纯数字房间号', 'error');

  $('btn-join').disabled = true;
  notify('正在查询房间...');

  try {
    // 通过信令连接加入，服务端 joined 消息会携带模式信息
    notify('正在连接信令服务器...');
    await connectSignaling();
    state.role = 'guest';
    state.roomCode = code;
    sendSignal({ type: 'join', room: code });

    /* 超时保护：15 秒内没收到 joined/error 就判定失败并恢复界面 */
    if (state.joinTimer) clearTimeout(state.joinTimer);
    state.joinTimer = setTimeout(() => {
      if (state.role === 'guest' && !state.roomInfo) {
        failGuestConnection('加入房间超时，请重试（房间可能已关闭或网络不稳定）');
      }
      state.joinTimer = null;
    }, 15000);
  } catch (e) {
    toast(e.message, 'error');
    notify('连接失败: ' + e.message, 'error');
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
  if (state.joinTimer) { clearTimeout(state.joinTimer); state.joinTimer = null; }
  if (state.role !== 'guest') return;
  await cleanupGuestConnection();
  $('join-active').classList.add('hidden');
  $('join-form').classList.remove('hidden');
  
  notify(message, 'error');
  $('btn-join').disabled = false;
  toast(message, 'error');
}

async function onRoomJoined(msg) {
  if (state.joinTimer) { clearTimeout(state.joinTimer); state.joinTimer = null; }
  logLine('已加入房间 ' + msg.room + '，模式: ' + (msg.mode || 'easytier'));
  state.roomInfo = { room: msg.room, hostUser: msg.hostUser };
  if (Array.isArray(msg.members)) onMembers(msg);

  if (msg.mode === 'frp') {
    
    $('btn-join').disabled = false;
    joinFrpRoom(msg);
    return;
  }

  if (!msg.easytier?.hostVirtualIp) throw new Error('服务端未返回 EasyTier 房主地址');
  /* 访客接入 EasyTier 同样需要管理员权限 */
  if (!(await ensureElevatedForEasyTier('加入 EasyTier 房间'))) {
    await failGuestConnection('EasyTier 需要管理员权限，请以管理员身份重启客户端后重试（或让房主改用 frp 模式）');
    return;
  }
  const address = msg.easytier.hostVirtualIp + ':' + (msg.easytier.port || 25565);
  notify('正在启动 EasyTier...');
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
    logLine('EasyTier 连通性测试未通过: ' + (test?.error || '未知原因') + '（重试中）');
    notify('正在等待 EasyTier 网络连通... (' + (test?.error || '重试中') + ')');
    const retryDelay = Math.min(Math.max(0, 1000 - (Date.now() - attemptStarted)), deadline - Date.now());
    if (retryDelay > 0) await new Promise((resolve) => setTimeout(resolve, retryDelay));
  }
  if (!test?.ok) throw new Error('无法连接房主 Minecraft 端口: ' + (test?.error || '未知原因'));

  
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
    
    notify(reason, 'error');
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
    if (state.role === 'host') notify('EasyTier: ' + text);
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

// 房主：复制局域网连接地址
function copyHostAddr() {
  const addr = $('host-lan-addr').textContent;
  navigator.clipboard.writeText(addr).then(() => toast('已复制连接地址: ' + addr, 'success'));
}

// 访客：复制连接地址
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
    const announcement = await apiChat('/settings/announcement');
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
    if (!silent) notify('正在检查更新…');
    const info = await window.mclink.checkGithubUpdate();
    state.updateInfo = info;
    if (info.latestVersion && compareVersions(info.latestVersion, state.appInfo.version) > 0) {
      notify(`GitHub Releases 发现新版本 ${info.latestVersion}`);
      $('update-title').textContent = `发现新版本 ${info.latestVersion}`;
      $('update-notes').textContent = info.releaseNotes || '暂无更新说明';
      $('update-download').textContent = info.downloadUrl ? `下载 ${info.assetName || '安装程序'}` : '打开发布页';
      $('update-modal').classList.remove('hidden');
    } else {
      notify('当前已是最新版本');
      if (!silent) toast('当前已是最新版本', 'success');
    }
  } catch (e) {
    notify('检查失败：' + e.message, 'error');
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

/* ============ 退出软件 ============ */
function doExitApp() {
  showConfirm('确认退出软件？', '将停止所有连接并关闭 BLFP。', async () => {
    await stopEasyTier();
    try { await window.mclink.frpcStop(); } catch {}
    try { await window.mclink.exitApp(); } catch { window.close(); }
  });
}

/* ============ 设置 ============ */
const SETTINGS_KEY = 'blfp_settings';

/* 安全读取设置（localStorage 损坏时不崩） */
function readSettingsSafe() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) {
    try { localStorage.removeItem(SETTINGS_KEY); } catch (e2) {}
    return {};
  }
}

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
  const s = readSettingsSafe();
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
    const s = readSettingsSafe();
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
    const s = readSettingsSafe();
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
    const s = readSettingsSafe();
    s.perf = value; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

function setCursorTrail(on) {
  if (on) enableCursorTrail(); else disableCursorTrail();
  const s = readSettingsSafe();
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && particleEnabled && !particleFrame) drawParticles();
});

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
  // 性能优化：仅在房间列表页可见时轮询，间隔30秒，失败静默（最多提示一次）
  let pollFailCount = 0;
  const fetchRooms = async () => {
    // 页面不可见时跳过请求
    if (document.hidden) return;
    // 不在房间列表页且非首次时跳过
    if (!initial && currentPage !== 'rooms') return;
    try {
      const rooms = await api('/rooms/public');
      renderPublicRooms(rooms);
      if (initial) logLine('已加载公开房间列表');
      pollFailCount = 0;
    } catch (e) {
      pollFailCount++;
      if (initial || pollFailCount === 1) logLine('加载公开房间失败: ' + e.message);
    }
  };
  fetchRooms();
  if (publicRoomsInterval) clearInterval(publicRoomsInterval);
  publicRoomsInterval = setInterval(fetchRooms, 30000);
}
function renderPublicRooms(rooms) {
  state.publicRooms = Array.isArray(rooms) ? rooms : [];
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
    const motd = String(room.motd || '').trim();
    const motdHtml = motd ? '<div class="pr-motd"><span class="pr-motd-inner">' + escapeHtml(motd) + '</span></div>' : '';
    return `
    <div class="public-room" onclick="showRoomDetail('${code}')">
      <div class="pr-code">${escapeHtml(code)}</div>
      <div class="pr-info">
        <div class="pr-host">${escapeHtml(room.host || '未知用户')}</div>
        <div class="pr-meta">
          <span class="tag ${room.mode === 'frp' ? 'tag-frp' : 'tag-p2p'}">${room.mode === 'frp' ? 'frp 中转' : 'EasyTier 智能组网'}</span>
          <span>${total}/${maxMembers} 人在线</span>
        </div>
        ${motdHtml}
      </div>
      <div class="pr-join" onclick="event.stopPropagation();quickJoinRoom('${code}')">加入</div>
    </div>`;
  }).join('');
}
async function quickJoinRoom(code) {
  const roomCode = String(code ?? '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(roomCode)) return toast('房间号无效', 'error');
  if (state.role) return toast('当前已在房间中，请先退出当前房间', 'warn');
  const modalInput = $('join-room-input');
  if (modalInput) modalInput.value = roomCode;
  const compat = $('room-input');
  if (compat) compat.value = roomCode;
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
      <div class="friend-item" data-friend-id="${f.id}">
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
/* 应用内确认弹窗（替代原生 confirm） */
function appConfirm(message, onOk, opts) {
  let dlg = $('app-confirm-modal');
  if (!dlg) {
    dlg = document.createElement('div');
    dlg.id = 'app-confirm-modal';
    dlg.className = 'modal-backdrop';
    dlg.innerHTML = '<div class="modal-card app-confirm-card" style="max-width:340px;padding:20px">' +
      '<div class="app-confirm-icon">⚠️</div>' +
      '<div class="app-confirm-text"></div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">' +
      '<button class="btn btn-outline btn-sm app-confirm-cancel">取消</button>' +
      '<button class="btn btn-danger btn-sm app-confirm-ok">确定</button>' +
      '</div></div>';
    document.body.appendChild(dlg);
  }
  const textEl = dlg.querySelector('.app-confirm-text');
  if (textEl) textEl.textContent = message;
  const okBtn = dlg.querySelector('.app-confirm-ok');
  const cancelBtn = dlg.querySelector('.app-confirm-cancel');
  if (okBtn && opts && opts.okText) okBtn.textContent = opts.okText;
  dlg.classList.remove('hidden');
  const close = () => { dlg.classList.add('hidden'); };
  const okHandler = () => { close(); onOk && onOk(); };
  okBtn.onclick = okHandler;
  cancelBtn.onclick = close;
  dlg.onclick = (e) => { if (e.target === dlg) close(); };
}

async function removeFriend(userId) {
  appConfirm('确认删除该好友？', async () => {
    /* 乐观删除：先从界面移除，失败再恢复 */
    const list = $('friends-list');
    const prevHtml = list ? list.innerHTML : '';
    if (list) {
      const item = list.querySelector('[data-friend-id="' + userId + '"]');
      if (item) item.remove();
      if (!list.children.length) list.innerHTML = '<div class="empty-state">暂无好友</div>';
    }
    try {
      await api(`/friends/${userId}`, { method: 'DELETE' });
      toast('已删除');
    } catch (e) {
      toast('删除失败：' + e.message + '，已恢复', 'error');
      if (list && prevHtml) list.innerHTML = prevHtml;
    }
  });
}

/* ============ 首页公告（新）============ */
/* 公告渲染：标题第一行，正文往下排 */
function announcementHtml(a) {
  const title = String((a && a.title) || '').trim();
  const content = String((a && a.content) || '').trim();
  return '<div class="announcement-item">' +
    (title ? '<div class="announcement-title">' + escapeHtml(title) + '</div>' : '') +
    (content ? '<div class="announcement-content">' + escapeHtml(content) + '</div>' : '') +
    '</div>';
}

async function loadAnnouncements() {
  if (!state.token) return;
  try {
    const data = await apiChat('/settings/announcement');
    const container = $('home-announcements');
    if (!container) return;
    if (Array.isArray(data) && data.length > 0) {
      container.innerHTML = data.map(announcementHtml).join('');
    } else if (data && (data.content || data.title)) {
      container.innerHTML = announcementHtml(data);
    } else {
      container.innerHTML = '<div class="announcement-item" style="opacity:.7">暂无公告。BLFP 联机助手——与好友畅玩 Minecraft，局域网穿透，零门槛联机。</div>';
    }
  } catch (e) {
    debugLog('首页公告加载失败: ' + e.message);
  }
}

/* ============ 聊天 ============ */
function initChat() {
  // Chat is initialized when the chat page becomes active
  // Clear existing messages
  const messages = $('chat-messages');
  if (messages) messages.innerHTML = '';
  // Scroll to bottom
  if (messages) messages.scrollTop = messages.scrollHeight;
}

let chatReconnectTimer = null;
/* 聊天室独立连接「聊天服务器」的 /ws（与房间信令分离） */
function connectChatSocket() {
  return new Promise((resolve, reject) => {
    const base = state.chatServer || state.server;
    const serverUrl = assertSecureServer(base);
    const wsProtocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = wsProtocol + '//' + serverUrl.host + '/ws?token=' + encodeURIComponent(state.token);
    try { if (state.chatWs) { state.chatWs.onclose = null; state.chatWs.close(); } } catch (e) {}
    const sock = new WebSocket(wsUrl);
    state.chatWs = sock;
    let settled = false;
    /* 握手成功不代表鉴权通过——必须等服务端 ready 帧；
       若 3 秒内没收到（老版本服务端不发 ready），按可用处理 */
    const readyTimer = setTimeout(() => {
      if (!settled && sock.readyState === WebSocket.OPEN) { settled = true; resolve(); }
    }, 3000);
    sock.onopen = () => { /* 等 ready 帧 */ };
    sock.onerror = () => {
      if (settled) return;
      settled = true; clearTimeout(readyTimer);
      reject(new Error('无法连接聊天服务器'));
    };
    sock.onclose = (ev) => {
      state.chatWs = null;
      if (!settled) { settled = true; clearTimeout(readyTimer); reject(new Error('聊天服务器拒绝连接（' + (ev.code || '?') + '）')); }
      if (currentPage === 'chat') {
        if (chatReconnectTimer) clearTimeout(chatReconnectTimer);
        chatReconnectTimer = setTimeout(() => { if (currentPage === 'chat') ensureChatConnection(); }, 3000);
      }
    };
    sock.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'ready') {
        if (!settled) { settled = true; clearTimeout(readyTimer); resolve(); }
        return;
      }
      if (msg.type === 'error') {
        logLine('聊天服务器: ' + (msg.error || '未知错误'));
        if (!settled) { settled = true; clearTimeout(readyTimer); reject(new Error(msg.error || '聊天服务器拒绝连接')); }
        else if (msg.error) toast(msg.error, 'warn');
        return;
      }
      if (msg.type === 'chat') renderChatMessage(msg);
    };
  });
}

function ensureChatConnection() {
  if (!state.token) return;
  if (state.chatWs && state.chatWs.readyState === WebSocket.OPEN) return;
  connectChatSocket().then(() => {
    const messages = $('chat-messages');
    if (messages) {
      messages.innerHTML = '';
      const sys = document.createElement('div');
      sys.className = 'chat-msg system';
      sys.innerHTML = '<div class="chat-msg-text">已连接到聊天室</div>';
      messages.appendChild(sys);
    }
  }).catch((e) => {
    /* 聊天服务器不可用 / 鉴权失败 → 回退主服务器（两者都带聊天能力） */
    if (state.chatServer !== state.server) {
      logLine('聊天服务器连接失败，回退主服务器：' + e.message);
      state.chatServer = state.server;
      return ensureChatConnection();
    }
    const messages = $('chat-messages');
    if (messages) {
      messages.innerHTML = '';
      const sys = document.createElement('div');
      sys.className = 'chat-msg system';
      sys.innerHTML = '<div class="chat-msg-text">连接失败，3 秒后重试...</div>';
      messages.appendChild(sys);
    }
    if (chatReconnectTimer) clearTimeout(chatReconnectTimer);
    chatReconnectTimer = setTimeout(() => { if (currentPage === 'chat') ensureChatConnection(); }, 3000);
  });
}

function sendChatMessage() {
  const input = $('chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  const sock = state.chatWs && state.chatWs.readyState === WebSocket.OPEN
    ? state.chatWs
    : (state.ws && state.ws.readyState === WebSocket.OPEN ? state.ws : null);
  if (!sock) {
    toast('未连接到聊天服务器，正在重连…', 'warn');
    ensureChatConnection();
    return;
  }
  const chatPayload = {
    type: 'chat',
    text: text,
    username: state.user ? state.user.username : 'Unknown',
    userId: state.user ? state.user.id : 0,
  };
  try { sock.send(JSON.stringify(chatPayload)); } catch (e) { toast('发送失败：' + e.message, 'error'); return; }
  /* 不再本地立即渲染——服务端会广播回自己的消息，本地渲染会导致显示两条 */
  input.value = '';
}

let chatDedupeMap = new Map();   /* key -> 时间戳，避免同一条广播被两个连接各渲染一次 */
function renderChatMessage(msg) {
  const container = $('chat-messages');
  if (!container) return;
  const key = String(msg.userId || '') + '|' + String(msg.username || '') + '|' + String(msg.text || '') + '|' + String(msg.at || '');
  const now = Date.now();
  const last = chatDedupeMap.get(key);
  if (last && now - last < 5000) return;      /* 5 秒内同一条消息只渲染一次 */
  chatDedupeMap.set(key, now);
  if (chatDedupeMap.size > 200) {
    for (const [k, t] of chatDedupeMap) { if (now - t > 10000) chatDedupeMap.delete(k); }
  }
  const isOwn = msg.local || (state.user && msg.userId === state.user.id);
  const el = document.createElement('div');
  el.className = 'chat-msg' + (isOwn ? ' self' : '') + (msg.system ? ' system' : '');
  const time = new Date().toLocaleTimeString().slice(0, 5);
  if (msg.system) {
    el.innerHTML = '<div class="chat-msg-text">' + escapeHtml(msg.text) + '</div>';
  } else {
    el.innerHTML = '<div class="chat-msg-header"><span class="chat-msg-author">' + escapeHtml(msg.username || '用户') + '</span><span class="chat-msg-time">' + time + '</span></div><div class="chat-msg-text">' + escapeHtml(msg.text) + '</div>';
  }
  container.appendChild(el);
  /* 上限 400 条：长时间挂机不会无限增长 */
  const MAX_CHAT_NODES = 400;
  while (container.childElementCount > MAX_CHAT_NODES) {
    container.removeChild(container.firstElementChild);
  }
  container.scrollTop = container.scrollHeight;
}

/* ============ 初始化 ============ */
/* ====== 后台久了黑屏的自愈：主进程通知时强制重排重绘 ====== */
if (window.mclink && window.mclink.onForceRepaint) {
  window.mclink.onForceRepaint(() => {
    try {
      /* 触发一次强制重排，清除合成层的黑帧 */
      const body = document.body;
      body.style.transform = 'translateZ(0)';
      void body.offsetHeight;
      body.style.transform = '';
      /* 恢复可能被暂停的视觉效果 */
      if (typeof particleEnabled !== 'undefined' && particleEnabled && !particleFrame && typeof drawParticles === 'function') {
        try { drawParticles(); } catch (e) {}
      }
      document.querySelectorAll('.page.active').forEach((p) => { void p.offsetHeight; });
    } catch (e) {}
  });
}

/* ====== 全局兜底：未处理的 Promise 拒绝不再静默失败 ======
   界面上有 15 处 onclick 直接调用 async 函数，任何一处抛错都会变成"点了没反应" */
window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  const msg = (reason && (reason.message || reason.toString())) || '未知错误';
  try { logLine('未处理的错误: ' + msg); } catch (e) {}
  try { toast('操作失败: ' + msg, 'error'); } catch (e) {}
  if (event && event.preventDefault) event.preventDefault();
});
window.addEventListener('error', (event) => {
  const msg = (event && event.message) || '未知脚本错误';
  try { logLine('脚本错误: ' + msg); } catch (e) {}
});

document.addEventListener('DOMContentLoaded', async () => {
  $('auth-page').classList.remove('hidden');
  $('main-app').classList.add('hidden');
  setLoginLoading(false);

  const showStartupError = (source, error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(source + '启动失败:', error);
    showAuthErr('启动错误：' + source + '失败：' + message);
  };

  try {
    loadSettings();
  } catch (error) {
    showStartupError('设置加载', error);
  }

  /* 自动探测可用服务器（有代理/防火墙时域名与 IP 哪个通用哪个） */
  try {
    await resolveServer();
    await resolveChatServer();
  } catch (error) {
    logLine('服务器探测失败: ' + error.message);
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


// ====== 鼠标光晕跟随 ======
(function initMouseGlow() {
  // 性能修复：rAF 节流 + 按钮缓存 + 近距离过滤
  // 旧版每次 mousemove 都 querySelectorAll + getBoundingClientRect（强制同步布局）导致鼠标卡顿
  let mx = -1, my = -1, pending = false;
  let btnCache = [];
  let btnCacheTime = 0;
  const BTN_CACHE_TTL = 2000;   /* 按钮列表缓存 2 秒 */
  const NEAR_DIST = 260;       /* 只更新鼠标 260px 内的按钮 */

  document.addEventListener('mousemove', (e) => {
    mx = e.clientX; my = e.clientY;
    if (!pending) {
      pending = true;
      requestAnimationFrame(flushGlow);
    }
  }, { passive: true });

  function flushGlow() {
    pending = false;
    if (document.hidden || mx < 0) return;
    const now = performance.now();
    /* body 光晕 */
    document.body.style.setProperty('--mouse-x', mx + 'px');
    document.body.style.setProperty('--mouse-y', my + 'px');
    /* 按钮列表缓存 */
    if (now - btnCacheTime > BTN_CACHE_TTL) {
      btnCache = Array.from(document.querySelectorAll('.btn-glow, .btn-primary, .btn-success, .btn-danger, .btn-outline'));
      btnCacheTime = now;
    }
    /* 只更新鼠标附近的按钮，跳过远处 */
    for (const btn of btnCache) {
      const r = btn.getBoundingClientRect();
      if (mx < r.left - NEAR_DIST || mx > r.right + NEAR_DIST ||
          my < r.top - NEAR_DIST || my > r.bottom + NEAR_DIST) continue;
      const x = ((mx - r.left) / Math.max(1, r.width)) * 100;
      const y = ((my - r.top) / Math.max(1, r.height)) * 100;
      btn.style.setProperty('--mouse-x', x + '%');
      btn.style.setProperty('--mouse-y', y + '%');
    }
  }
})();

// ====== 登录页 ======
/* 旧的 initAuth 死代码已删除（引用了不存在的 #auth-wrap 和未定义的 showToast，登录逻辑由 submitLogin 处理） */




/* ====== 主页欢迎语随时间切换 ====== */
function updateWelcomeText() {
  const el = document.querySelector('.home-welcome') || $('home-welcome');
  if (!el) return;
  const h = new Date().getHours();
  let greeting;
  if (h >= 5 && h < 9) greeting = '早上好';
  else if (h >= 9 && h < 12) greeting = '上午好';
  else if (h >= 12 && h < 14) greeting = '中午好';
  else if (h >= 14 && h < 18) greeting = '下午好';
  else if (h >= 18 && h < 23) greeting = '晚上好';
  else greeting = '夜深了';
  const username = state.user?.username || '';
  const week = ['日', '一', '二', '三', '四', '五', '六'][new Date().getDay()];
  const dateStr = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
  el.textContent = username
    ? greeting + '，' + username + ' · 今天是' + dateStr + ' 星期' + week + '，祝你游玩愉快'
    : greeting + ' · 今天是' + dateStr + ' 星期' + week;
}
// 每 60 秒刷新一次（跨时段自动切换）
setInterval(updateWelcomeText, 60000);

/* ====== 设置页「实时日志(PowerShell)」按钮 ====== */
async function toggleLiveLog() {
  /* 优先应用内日志（一定可用），并尝试同时呼出 PowerShell */
  openLogViewer();
  try {
    const res = await window.mclink.openLogExternal();
    if (res && res.ok === false) notify('PowerShell 不可用（' + (res.error || '未知') + '），已使用应用内日志', 'warn');
  } catch (e) {
    notify('PowerShell 不可用，已使用应用内日志', 'warn');
  }
}


/* ====== 按钮点击水波纹定位（CSS 的 .btn::after 使用 --ripple-x/y）====== */
document.addEventListener('mousedown', (e) => {
  const btn = e.target && e.target.closest && e.target.closest('.btn');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  btn.style.setProperty('--ripple-x', (((e.clientX - rect.left) / rect.width) * 100).toFixed(1) + '%');
  btn.style.setProperty('--ripple-y', (((e.clientY - rect.top) / rect.height) * 100).toFixed(1) + '%');
}, true);

/* ====== 一键导出诊断信息（对比不同机器差异）====== */
async function exportDiagnostics() {
  notify('正在收集诊断信息...');
  try {
    if (!window.mclink || !window.mclink.collectDiagnostics) {
      notify('当前版本不支持导出诊断信息', 'error');
      return;
    }
    const text = await window.mclink.collectDiagnostics();
    let copied = false;
    try { await navigator.clipboard.writeText(text); copied = true; } catch (e) {}
    showModal('diag-modal',
      '<h3>诊断信息' + (copied ? '（已复制到剪贴板）' : '') + '</h3>' +
      '<p style="font-size:.78rem;color:var(--text2);margin-bottom:10px">把下面内容整段发给开发者，即可定位这台机器与正常机器的差异。</p>' +
      '<pre class="diag-pre">' + escapeHtml(text) + '</pre>' +
      '<div class="modal-actions">' +
      '<button class="btn btn-outline btn-sm" onclick="closeModal(\'diag-modal\')">关闭</button>' +
      '<button class="btn btn-primary btn-sm" onclick="copyText(document.querySelector(\'.diag-pre\').textContent)">复制</button>' +
      '</div>');
    notify(copied ? '诊断信息已复制到剪贴板' : '诊断信息已生成', 'success');
  } catch (e) {
    notify('收集诊断信息失败: ' + e.message, 'error');
  }
}

/* ====== 统一状态消息：所有状态/进度/错误都走这里（提示条 + 运行日志）====== */
function notify(message, type = 'info') {
  const msg = String(message == null ? '' : message);
  if (!msg) return;
  try { logLine(msg); } catch (e) {}
  try { toast(msg, type); } catch (e) {}
}

/* ====== 复制到剪贴板（房间号/用户ID/日志等按钮调用）====== */
async function copyText(text) {
  const value = String(text ?? '').trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast('已复制：' + value, 'success');
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制：' + value, 'success');
    } catch (e2) {
      toast('复制失败，请手动选择复制', 'error');
    }
  }
}

/* ====== PowerShell 呼出日志 ====== */
async function openLogInPowerShell() {
  try {
    if (!window.mclink || !window.mclink.openLogExternal) {
      notify('当前版本不支持直接呼出 PowerShell，已改为应用内查看', 'warn');
      return openLogViewer();
    }
    const res = await window.mclink.openLogExternal();
    if (res && res.ok === false) {
      /* PowerShell 被组策略/AppLocker 禁用，或启动失败 → 自动降级 */
      notify('无法启动 PowerShell（' + (res.error || '未知原因') + '），已为你打开应用内日志', 'warn');
      openLogViewer();
      await openLogFolder();
      return;
    }
    toast('已打开 PowerShell 日志窗口；若没看到窗口，可用「查看日志」', 'success');
  } catch (e) {
    notify('打开日志失败：' + e.message + '，已改为应用内查看', 'error');
    openLogViewer();
  }
}


/* ====== 房间详情（点房间卡片显示详情弹窗） ====== */
async function showRoomDetail(code) {
  let fallbackUsed = false;
  let room;
  try {
    room = await api('/rooms/public/' + code + '/detail');
  } catch (e) {
    /* 服务器还没有详情接口（旧版本返回 404）时，用房间列表里已有的数据展示 */
    const cached = (state.publicRooms || []).find((r) => String(r.room_code ?? r.code ?? '') === String(code));
    if (!cached) {
      toast('获取房间详情失败: ' + e.message, 'error');
      return;
    }
    fallbackUsed = true;
    room = {
      room_code: code,
      host: cached.host,
      mode: cached.mode,
      total: cached.total,
      max_members: cached.max_members,
      members: [],
      latency: null,
      motd: cached.motd || '',
    };
  }
  try {
    const statsHtml = `
      <div class="room-detail-stat">
        <div class="stat-value ${room.latency < 80 ? 'latency-good' : room.latency < 200 ? 'latency-mid' : 'latency-bad'}">${room.latency ?? '--'} ms</div>
        <div class="stat-label">节点延迟</div>
      </div>
      <div class="room-detail-stat">
        <div class="stat-value">${room.members?.length ?? 0}/${room.max_members ?? 8}</div>
        <div class="stat-label">在线人数</div>
      </div>`;
    const membersHtml = (room.members || []).map((m) => `
      <div class="room-detail-member">
        <span class="fi-avatar" style="width:20px;height:20px;font-size:.6rem">${escapeHtml((m.username || '?')[0].toUpperCase())}</span>
        <span>${escapeHtml(m.username || '未知')}</span>
        ${m.title ? '<span class="user-title">' + escapeHtml(m.title) + '</span>' : ''}
      </div>`).join('');
    const motdHtml = room.motd
      ? `<div style="margin-top:10px"><div style="font-size:.78rem;color:var(--text3);margin-bottom:6px">服务器 MOTD（超过3行隐藏）</div><div class="room-detail-motd-full">${escapeHtml(room.motd)}</div></div>`
      : '';
    const iconHtml = room.icon
      ? `<img class="room-detail-server-icon" src="${escapeHtml(room.icon)}" onerror="this.style.display='none'">`
      : '';
    showModal('room-detail-modal', `<h3>房间 ${escapeHtml(code)} 详情</h3>` + iconHtml + (fallbackUsed ? '<div style="font-size:.75rem;color:var(--warn);margin-bottom:8px">服务器未提供详情接口，以下为房间列表数据（更新服务器后可显示成员与延迟）</div>' : '') + `<div class="room-detail-grid">` + statsHtml + `</div><div style="font-size:.78rem;color:var(--text3);margin-bottom:6px">在线成员</div><div class="room-detail-members">` + membersHtml + `</div>` + motdHtml + `<div class="modal-actions"><button class="btn btn-outline btn-sm" onclick="closeModal('room-detail-modal')">关闭</button><button class="btn btn-primary btn-sm" onclick="closeModal('room-detail-modal');quickJoinRoom('${code}')">加入房间</button></div>`);
  } catch (e) {
    toast('获取房间详情失败: ' + e.message, 'error');
  }
}


/* ====== Geetest 人机验证 ====== */
let geetestPassed = false;
let geetestLoading = false;
function initGeetest() {
  const box = $('geetest-captcha-box');
  if (!box || geetestPassed || geetestLoading) return;
  geetestLoading = true;
  box.innerHTML = '<span style="color:var(--accent2)">正在加载验证...</span>';
  // 尝试从服务器获取 geetest 配置；服务器未配置时使用滑块验证回退
  api('/auth/captcha-config').then((cfg) => {
    if (cfg && cfg.gt && cfg.challenge) {
      initGeetestGT(cfg);
    } else {
      fallbackSliderCaptcha(box);
    }
  }).catch(() => {
    fallbackSliderCaptcha(box);
  });
}
function initGeetestGT(cfg) {
  if (typeof initGeetest === 'function' && window.initGeetest) {
    window.initGeetest({
      gt: cfg.gt,
      challenge: cfg.challenge,
      offline: !cfg.success,
      new_captcha: true
    }, (captchaObj) => {
      captchaObj.appendTo('#geetest-captcha-box');
      captchaObj.onSuccess(() => {
        geetestPassed = true;
        const result = captchaObj.getValidate();
        state.geetestValidate = result;
        toast('验证通过', 'success');
      });
      captchaObj.onError(() => {
        geetestLoading = false;
        fallbackSliderCaptcha($('geetest-captcha-box'));
      });
    });
  } else {
    fallbackSliderCaptcha($('geetest-captcha-box'));
  }
}
function fallbackSliderCaptcha(box) {
  // 极验不可用时的滑块验证回退
  let dragging = false, startX = 0, currentX = 0;
  const trackW = () => box.clientWidth - 44;
  box.innerHTML = '<div class="slider-captcha"><div class="sc-track"><div class="sc-fill"></div><div class="sc-thumb">→</div><span class="sc-hint">按住滑块拖到最右侧</span></div></div>';
  const track = box.querySelector('.sc-track');
  const fill = box.querySelector('.sc-fill');
  const thumb = box.querySelector('.sc-thumb');
  const hint = box.querySelector('.sc-hint');
  const onDown = (e) => {
    dragging = true;
    startX = (e.touches ? e.touches[0] : e).clientX;
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!dragging) return;
    currentX = Math.max(0, Math.min(trackW(), (e.touches ? e.touches[0] : e).clientX - startX));
    thumb.style.transform = 'translateX(' + currentX + 'px)';
    fill.style.width = (currentX + 44) + 'px';
    hint.style.opacity = String(Math.max(0, 1 - currentX / (trackW() / 2)));
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    if (currentX >= trackW() - 4) {
      geetestPassed = true;
      track.style.borderColor = 'var(--success)';
      thumb.style.background = 'var(--success)';
      hint.textContent = '验证通过 ✓';
      hint.style.opacity = '1';
      hint.style.color = 'var(--success)';
      state.geetestValidate = { fallback: true };
    } else {
      thumb.style.transform = 'translateX(0)';
      fill.style.width = '44px';
      hint.style.opacity = '1';
    }
  };
  thumb.addEventListener('mousedown', onDown);
  thumb.addEventListener('touchstart', onDown, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup', onUp);
  document.addEventListener('touchend', onUp);
  geetestLoading = false;
}
function requireGeetest() {
  if (!geetestPassed) {
    toast('请先完成人机验证', 'warn');
    initGeetest();
    return false;
  }
  return true;
}

/* ====== 个性化：字体/标题栏/背景 ====== */
function setFontFamily(font) {
  localStorage.setItem('blfp_font', font);
  applyFontFamily();
}
function applyFontFamily() {
  const font = localStorage.getItem('blfp_font') || 'default';
  const stack = font === 'default'
    ? '"Segoe UI Variable Display", "Inter", "SF Pro Display", "Microsoft YaHei", system-ui, sans-serif'
    : font + ', "Microsoft YaHei", system-ui, sans-serif';
  document.body.style.fontFamily = stack;
  const sel = $('font-select');
  if (sel) sel.value = font;
}
function setCustomTitlebar(mode) {
  localStorage.setItem('blfp_titlebar_mode', mode);
  const textInput = $('titlebar-text-input');
  const imageInput = $('titlebar-image-input');
  const preview = $('titlebar-preview');
  if (textInput) textInput.style.display = (mode === 'text' || mode === 'mixed') ? 'block' : 'none';
  if (imageInput) imageInput.style.display = (mode === 'image' || mode === 'mixed') ? 'block' : 'none';
  if (preview) preview.style.display = mode === 'default' ? 'none' : 'flex';
  applyTitlebarPreview();
}
function applyTitlebarPreview() {
  const mode = localStorage.getItem('blfp_titlebar_mode') || 'default';
  const text = $('titlebar-text-input')?.value || localStorage.getItem('blfp_titlebar_text') || '';
  const image = $('titlebar-image-input')?.value || localStorage.getItem('blfp_titlebar_image') || '';
  if (mode === 'text' || mode === 'mixed') localStorage.setItem('blfp_titlebar_text', text);
  if (mode === 'image' || mode === 'mixed') localStorage.setItem('blfp_titlebar_image', image);
  // 更新实际标题栏
  const titleEl = document.querySelector('.titlebar-title');
  const preview = $('titlebar-preview');
  if (titleEl) {
    if (mode === 'text') titleEl.innerHTML = escapeHtml(text || 'BLFP');
    else if (mode === 'image') titleEl.innerHTML = image ? '<img src="' + escapeHtml(image) + '" style="height:18px;max-width:140px;object-fit:contain;border-radius:3px" onerror="this.outerHTML=\'BLFP\'">' : 'BLFP';
    else if (mode === 'mixed') titleEl.innerHTML = (image ? '<img src="' + escapeHtml(image) + '" style="height:18px;max-width:120px;object-fit:contain;border-radius:3px;margin-right:8px" onerror="this.remove()">' : '') + escapeHtml(text || 'BLFP');
    else titleEl.textContent = 'BLFP';
  }
  if (preview) {
    preview.style.alignItems = 'center';
    preview.style.gap = '8px';
    preview.innerHTML = titleEl ? titleEl.innerHTML : '';
  }
}
function setCustomBackground(mode) {
  localStorage.setItem('blfp_bg_mode', mode);
  const colorInput = $('bg-color-input');
  const imageInput = $('bg-image-input');
  if (colorInput) colorInput.style.display = mode === 'color' ? 'block' : 'none';
  const blocksHint = $('bg-blocks-hint');
  if (blocksHint) blocksHint.style.display = mode === 'blocks' ? 'block' : 'none';
  if (imageInput) imageInput.style.display = mode === 'image' ? 'block' : 'none';
  applyBackgroundPreview();
}
function applyBackgroundPreview() {
  /* 一次性迁移：老版本没背景时自动切到色块底 */
  if (localStorage.getItem('blfp_bg_v') !== '2') {
    localStorage.setItem('blfp_bg_v', '2');
    if (!localStorage.getItem('blfp_bg_mode') || localStorage.getItem('blfp_bg_mode') === 'default') {
      localStorage.setItem('blfp_bg_mode', 'blocks');
    }
  }
  const mode = localStorage.getItem('blfp_bg_mode') || 'blocks';
  const color = $('bg-color-input')?.value || localStorage.getItem('blfp_bg_color') || '#08080f';
  const image = $('bg-image-input')?.value || localStorage.getItem('blfp_bg_image') || '';
  const blur = Number($('bg-blur')?.value ?? localStorage.getItem('blfp_bg_blur') ?? 0);
  localStorage.setItem('blfp_bg_color', color);
  localStorage.setItem('blfp_bg_image', image);
  localStorage.setItem('blfp_bg_blur', String(blur));
  let bgEl = $('custom-bg-layer');
  if (!bgEl) {
    bgEl = document.createElement('div');
    bgEl.id = 'custom-bg-layer';
    bgEl.style.cssText = 'position:fixed;inset:0;z-index:0;pointer-events:none;';
    document.body.prepend(bgEl);
  }
  if (mode === 'blocks') {
    /* 多彩色块背景 */
    bgEl.style.background = '#080a14';
    bgEl.innerHTML = '';
    const palette = [
      'hsla(222, 90%, 62%, .95)', 'hsla(268, 85%, 65%, .9)', 'hsla(320, 80%, 62%, .85)',
      'hsla(190, 85%, 58%, .9)', 'hsla(160, 75%, 55%, .85)', 'hsla(38, 90%, 60%, .85)',
      'hsla(12, 85%, 60%, .9)', 'hsla(300, 75%, 60%, .8)', 'hsla(240, 80%, 68%, .85)',
      'hsla(175, 80%, 52%, .8)',
    ];
    const COLS = 6, ROWS = 5, N = COLS * ROWS;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:absolute;inset:-10%;filter:blur(' + (blur > 0 ? blur : 42) + 'px) saturate(1.25);';
    for (let i = 0; i < N; i++) {
      const col = i % COLS, row = Math.floor(i / COLS);
      /* 用固定伪随机（种子）保证每次渲染布局一致 */
      const seed = (i * 9301 + 49297) % 233280 / 233280;
      const seed2 = (i * 4801 + 9973) % 233280 / 233280;
      const b = document.createElement('span');
      const size = 26 + seed * 26;                     /* 块大小 % */
      const x = col * (100 / (COLS - 1)) - 10 + (seed - 0.5) * 14;
      const y = row * (100 / (ROWS - 1)) - 8 + (seed2 - 0.5) * 14;
      b.style.cssText =
        'position:absolute;left:' + x.toFixed(2) + '%;top:' + y.toFixed(2) + '%;' +
        'width:' + size.toFixed(1) + '%;height:' + (size * (0.7 + seed2 * 0.6)).toFixed(1) + '%;' +
        'background:' + palette[i % palette.length] + ';' +
        'border-radius:' + (20 + seed * 40).toFixed(0) + '%;' +
        'transform:rotate(' + ((seed - 0.5) * 50).toFixed(1) + 'deg);' +
        'opacity:' + (0.55 + seed2 * 0.4).toFixed(2) + ';' +
        'mix-blend-mode:screen;';
      wrap.appendChild(b);
    }
    bgEl.appendChild(wrap);
    bgEl.style.backdropFilter = 'none';
    bgEl.style.filter = 'none';
  } else if (mode === 'color') {
    bgEl.style.background = color;
    bgEl.style.backdropFilter = 'none';
    bgEl.innerHTML = '';
  } else if (mode === 'image') {
    bgEl.innerHTML = '';
    const img = document.createElement('img');
    img.src = image;
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;' + (blur > 0 ? 'filter:blur(' + blur + 'px);transform:scale(1.1);' : '');
    img.onerror = () => { bgEl.innerHTML = ''; };
    bgEl.appendChild(img);
  } else {
    bgEl.innerHTML = '';
    bgEl.style.background = 'transparent';
  }
}
// 启动时恢复个性化设置
function restorePersonalization() {
  applyFontFamily();
  const tbMode = localStorage.getItem('blfp_titlebar_mode');
  if (tbMode && tbMode !== 'default') {
    const sel = $('titlebar-mode');
    if (sel) sel.value = tbMode;
    setCustomTitlebar(tbMode);
  }
  const bgMode = localStorage.getItem('blfp_bg_mode');
  if (bgMode && bgMode !== 'default') {
    const sel = $('bg-mode');
    if (sel) sel.value = bgMode;
    setCustomBackground(bgMode);
  }
  updateWelcomeText();
}
document.addEventListener('DOMContentLoaded', () => {
  restorePersonalization();
  setTimeout(restorePersonalization, 500); // 主界面显示后再次应用
});


/* ====== 特殊头衔权限控制 ====== */
const PRIVILEGES = {
  admin: ['publish_announcement', 'manage_rooms', 'view_logs', 'manage_users', 'manage_nodes', 'ban_user', 'edit_motd', 'server_stats'],
  dev: ['publish_announcement', 'manage_rooms', 'view_logs', 'server_stats', 'edit_motd'],
  sponsor: ['custom_title', 'priority_nodes']
};
function getUserRole() {
  const u = state.user || {};
  if (u.role && PRIVILEGES[u.role]) return u.role;
  const t = String(u.title || '');
  if (t.includes('管理') || t === 'admin') return 'admin';
  if (t.includes('开发') || t === 'dev') return 'dev';
  if (t.includes('赞助') || t === 'sponsor') return 'sponsor';
  return 'user';
}
function hasPrivilege(priv) {
  const role = getUserRole();
  return (PRIVILEGES[role] || []).includes(priv);
}
function applyPrivilegeUI() {
  // 根据头衔显示/隐藏管理功能
  const isAdmin = hasPrivilege('publish_announcement');
  const annAdmin = document.querySelector('.announcement-admin-section');
  if (annAdmin) annAdmin.classList.toggle('hidden', !isAdmin);
}

/* ====== 用户面板数据填充 ====== */
function fillUserPanel() {
  const u = state.user;
  if (!u) return;
  const title = u.title || ({ admin: '管理员', dev: '开发者', sponsor: '赞助用户', user: '普通用户' }[u.role] || '普通用户');
  const initial = (u.username || 'U').charAt(0).toUpperCase();
  const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
  set('us-avatar-initials', initial);
  set('us-username', u.username || '用户');
  const roleEl = $('us-role');
  if (roleEl) {
    roleEl.textContent = title;
    const cls = resolveUserThemeClass(u.theme, u.role);
    roleEl.className = 'user-role ' + cls;
    roleEl.dataset.userTheme = safeUserTheme(u.theme) || 'role';
    roleEl.style.cssText = 'font-size:.82rem;margin-bottom:2px';
  }
  set('us-uid', String(u.id !== undefined && u.id !== null ? u.id : '-'));
  set('us-info-name', u.username || '-');
  set('us-info-role', title);
  set('us-info-id', String(u.id !== undefined && u.id !== null ? u.id : '-'));
  set('us-info-server', state.server || DEFAULT_SERVER);
  /* 好友数（异步拉取） */
  api('/friends').then((friends) => {
    set('us-info-friends', Array.isArray(friends) ? friends.length : 0);
  }).catch(() => set('us-info-friends', '-'));
}


async function publishAnnouncement() {
  const title = $('admin-ann-title')?.value?.trim();
  const content = $('admin-ann-content')?.value?.trim();
  if (!title || !content) return toast('请填写公告标题和内容', 'warn');
  try {
    await apiChat('/settings/announcement', { method: 'POST', body: JSON.stringify({ title, content }) });
    toast('公告发布成功', 'success');
    loadAnnouncements();
  } catch (e) {
    toast('公告发布失败: ' + e.message, 'error');
  }
}


/* ====== 用户页设置归类（部分设置移到主设置页提示） ====== */
function categorizeUserSettings() {
  // 用户页仅保留账户相关；界面类设置已在主设置页
  const userPage = $('page-user-settings');
  if (!userPage) return;
  // 给用户页的界面类设置加提示标记
  const items = userPage.querySelectorAll('.form-group');
  items.forEach((item) => {
    const label = item.querySelector('label');
    if (label && (label.textContent.includes('主题') || label.textContent.includes('字体') || label.textContent.includes('玻璃'))) {
      let badge = item.querySelector('.moved-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'moved-badge';
        badge.textContent = '已移至主设置页';
        badge.style.cssText = 'font-size:.66rem;color:var(--text3);margin-left:8px;padding:2px 8px;border-radius:8px;background:rgba(255,255,255,0.04)';
        label.appendChild(badge);
      }
    }
  });
}

function navToSettingsFromUser() { navTo('settings'); const g = $('sidebar-gear-btn'); if (g) g.classList.add('active'); }
