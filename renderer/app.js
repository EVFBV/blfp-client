/* ============ 全局状态 ============ */
const DEFAULT_SERVER = 'https://p.blfp.cn';
const GITHUB_REPO_URL = 'https://github.com/EVFBV/BLFP-client';
const state = {
  server: DEFAULT_SERVER,
  token: null,
  user: null,
  mode: 'p2p',
  ws: null,            // 信令 WebSocket
  pc: null,            // RTCPeerConnection (guest 侧单个；host 侧见 hostPeers)
  role: null,          // 'host' | 'guest'
  roomCode: null,
  mcPort: 25565,
  // host 侧：guestId -> { pc, channel, tcpConnId }
  hostPeers: new Map(),
  // guest 侧
  dataChannel: null,
  proxyPort: 25565,
  frpNodes: [],
  frpNodeId: null,
  members: [],
  maxMembers: 12,
  appInfo: null,
  updateInfo: null,
  signingKey: null,
  signingKeyToken: null,
};

// WebRTC ICE 配置（公共 STUN）
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

/* ============ 工具函数 ============ */
function $(id) { return document.getElementById(id); }

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('toast-wrap').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

function logLine(msg) {
  const box = $('log-box');
  if (!box) return;
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${time}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
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
  $('auth-err').classList.add('hidden');
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
  state.server = $('a-server').value.trim().replace(/\/$/, '');
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

async function doLogin() {
  state.server = $('a-server').value.trim().replace(/\/$/, '');
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
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('mclink_token', data.token);
    localStorage.setItem('mclink_server', state.server);
    enterApp();
  } catch (e) {
    showAuthErr(e.message);
  } finally {
    setLoginLoading(false);
  }
}

async function doRegister() {
  state.server = $('a-server').value.trim().replace(/\/$/, '');
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

function enterApp() {
  $('auth-page').classList.add('hidden');
  $('main-app').classList.remove('hidden');
  $('s-username').textContent = state.user.username;
  const roleLabels = { admin: '管理员', sponsor: '赞助用户', user: '普通用户' };
  $('s-role').textContent = roleLabels[state.user.role] || '普通用户';
  $('s-role').className = 'user-role ' + (state.user.role === 'admin' ? 'admin' : state.user.role === 'sponsor' ? 'sponsor' : '');
  const welcome = state.user.role === 'sponsor' ? `感谢赞助，${state.user.username}！欢迎回到 BLFP。` : `欢迎回来，${state.user.username}。`;
  $('home-welcome').textContent = welcome;
  logLine(welcome);
  const home = $('page-home');
  home.classList.add('enter-from-right');
  setTimeout(() => home.classList.remove('enter-from-right'), 230);
  loadFrpNodes();
  checkForUpdates(true);
}

/* ============ 导航 ============ */
const NAV_ORDER = ['home', 'host', 'join', 'log', 'settings'];
let currentPage = 'home';
let navTimer = null;
function navTo(page, btn) {
  if (page === currentPage) {
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n === (btn || document.querySelector(`.nav-item[data-page="${page}"]`))));
    return;
  }
  const oldPage = $('page-' + currentPage);
  const nextPage = $('page-' + page);
  const noAnimation = page === 'log' || currentPage === 'log' || document.body.classList.contains('perf-off');
  clearTimeout(navTimer);
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('page-entering', 'page-leaving', 'enter-from-left', 'enter-from-right', 'leave-to-left', 'leave-to-right'));
  if (noAnimation) {
    oldPage.classList.remove('active');
    nextPage.classList.add('active');
  } else {
    const forward = NAV_ORDER.indexOf(page) > NAV_ORDER.indexOf(currentPage);
    oldPage.classList.add('page-leaving', forward ? 'leave-to-left' : 'leave-to-right');
    nextPage.classList.add('active', 'page-entering', forward ? 'enter-from-right' : 'enter-from-left');
    navTimer = setTimeout(() => {
      oldPage.classList.remove('active', 'page-leaving', 'leave-to-left', 'leave-to-right');
      nextPage.classList.remove('page-entering', 'enter-from-left', 'enter-from-right');
    }, 225);
  }
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
  (btn || document.querySelector(`.nav-item[data-page="${page}"]`))?.classList.add('active');
}

/* ============ 模式选择 ============ */
function selectMode(mode) {
  state.mode = mode;
  $('mode-p2p').classList.toggle('active', mode === 'p2p');
  $('mode-frp').classList.toggle('active', mode === 'frp');
  $('frp-node-section').classList.toggle('hidden', mode !== 'frp');
}

async function loadFrpNodes() {
  try {
    const nodes = await api('/nodes');
    state.frpNodes = nodes;
    const selects = [$('frp-node-select'), $('quick-frp-node-select')].filter(Boolean);
    if (!nodes.length) {
      selects.forEach((sel) => { sel.innerHTML = '<option value="">暂无可用节点</option>'; });
      return;
    }
    const options = nodes.map((n) =>
      `<option value="${n.id}">${n.name} (${n.region} · ${n.bandwidth})</option>`
    ).join('');
    selects.forEach((sel) => { sel.innerHTML = options; });
    state.frpNodeId = nodes[0].id;
    selects.forEach((sel) => { sel.value = String(state.frpNodeId); });
    pingSelectedNode(nodes[0]);

    $('frp-node-select').onchange = () => selectFrpNode($('frp-node-select').value);
  } catch (e) {
    logLine('加载 frp 节点失败: ' + e.message);
  }
}

function selectFrpNode(value) {
  state.frpNodeId = parseInt(value, 10) || null;
  [$('frp-node-select'), $('quick-frp-node-select')].filter(Boolean).forEach((sel) => { sel.value = value; });
  const node = state.frpNodes.find((n) => n.id === state.frpNodeId);
  if (node) pingSelectedNode(node);
}

async function pingSelectedNode(node) {
  const badges = [$('frp-node-latency'), $('quick-frp-latency')].filter(Boolean);
  badges.forEach((badge) => { badge.textContent = '测速中...'; badge.className = 'latency-badge'; });
  try {
    const res = await window.mclink.pingNode({ host: node.host, port: node.port || 7000 });
    if (res.ok) {
      const ms = res.latency;
      badges.forEach((badge) => { badge.textContent = ms + ' ms'; badge.className = 'latency-badge ' + (ms < 80 ? 'good' : ms < 180 ? 'ok' : 'bad'); });
    } else {
      badges.forEach((badge) => { badge.textContent = '超时'; badge.className = 'latency-badge bad'; });
    }
  } catch {
    badges.forEach((badge) => { badge.textContent = '失败'; badge.className = 'latency-badge bad'; });
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
    state.ws = new WebSocket(wsUrl);
    state.ws.onopen = () => { logLine('信令服务器已连接'); resolve(); };
    state.ws.onerror = () => reject(new Error('无法连接信令服务器'));
    state.ws.onclose = () => logLine('信令连接已关闭');
    state.ws.onmessage = (ev) => handleSignal(JSON.parse(ev.data));
  });
}

function sendSignal(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

function handleSignal(msg) {
  switch (msg.type) {
    case 'created': onRoomCreated(msg); break;
    case 'joined': onRoomJoined(msg); break;
    case 'peer-joined': onPeerJoined(msg); break;
    case 'peer-left': onPeerLeft(msg); break;
    case 'members': onMembers(msg); break;
    case 'signal': onRemoteSignal(msg); break;
    case 'closed': onRoomClosed(msg); break;
    case 'error':
      toast(msg.error, 'error');
      logLine('信令错误: ' + msg.error);
      if (!state.roomCode && state.role === 'host') state.role = null;
      $('btn-create').disabled = false;
      $('quick-host-confirm').disabled = false;
      quickHostPending = false;
      break;
  }
}

/* ============ Host 侧：创建房间 ============ */
async function createRoom(options = {}) {
  const inputId = options.inputId || 'mc-port';
  const mode = options.mode || state.mode;
  const button = $(options.buttonId || 'btn-create');
  const port = parseInt($(inputId).value, 10);
  if (!port || port < 1 || port > 65535) return toast('端口无效', 'error');
  state.mcPort = port;
  selectMode(mode);

  if (mode === 'frp') {
    if (!state.frpNodeId) return toast('请选择 frp 节点', 'error');
    return createFrpRoom(button);
  }

  try {
    button.disabled = true;
    await connectSignaling();
    state.role = 'host';
    sendSignal({ type: 'create', mode: 'p2p', username: state.user.username, userId: state.user.id, mcPort: port });
  } catch (e) {
    toast(e.message, 'error');
    button.disabled = false;
  }
}

async function onRoomCreated(msg) {
  // msg 可能是 string（P2P旧格式）或 object（新格式）
  const code = typeof msg === 'string' ? msg : msg.room || msg;
  const mode = typeof msg === 'object' ? (msg.mode || 'p2p') : 'p2p';
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
    return;
  }

  $('host-status').textContent = '房间已开启，等待好友加入... (P2P 模式)';
  logLine('P2P 房间已创建: ' + code + '，映射本地端口 ' + state.mcPort);

  try {
    const ip = await window.mclink.getLanIp();
    state.lanIp = ip;
    $('host-lan-addr').textContent = ip + ':' + state.mcPort;
  } catch {
    $('host-lan-addr').textContent = '127.0.0.1:' + state.mcPort;
  }

  try {
    const r = await window.mclink.motdStart({ port: state.mcPort, roomCode: code, hostName: state.user.username });
    if (r.ok) logLine('已开启局域网广播: ' + r.motd);
  } catch (e) {
    logLine('局域网广播启动失败: ' + e.message);
  }
}

// 有 guest 加入 -> host 为其创建 PeerConnection 并发起 offer
async function onPeerJoined(msg) {
  const guestId = msg.guestId;
  if (typeof msg.guests === 'number') $('host-online-count').textContent = String(msg.guests);
  logLine('好友加入 (guest ' + guestId + ')，正在建立 P2P 连接...');

  const pc = new RTCPeerConnection(RTC_CONFIG);
  const channel = pc.createDataChannel('mc-tunnel', { ordered: true });
  channel.binaryType = 'arraybuffer';

  const peer = { pc, channel, guestId };
  state.hostPeers.set(guestId, peer);

  channel.onopen = () => {
    logLine('好友 ' + guestId + ' 的数据通道已打开');
    updateHostPeers();
  };
  channel.onmessage = (ev) => handleHostChannelData(guestId, ev.data);
  channel.onclose = () => { logLine('好友 ' + guestId + ' 断开'); cleanupHostPeer(guestId); };

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ type: 'signal', to: guestId, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    logLine('P2P 状态 (' + guestId + '): ' + pc.connectionState);
    if (pc.connectionState === 'connected') {
      $('host-status').textContent = 'P2P 直连已建立';
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'signal', to: guestId, data: { sdp: pc.localDescription } });
}

// host 收到 guest 的 answer / candidate
async function onRemoteSignal(msg) {
  const data = msg.data;
  if (state.role === 'host') {
    const target = state.hostPeers.get(msg.from);
    if (!target) return;
    if (data.sdp) {
      await target.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      target.answered = true;
    } else if (data.candidate) {
      try { await target.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
    }
  } else {
    // guest 侧
    if (data.sdp) {
      await state.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      sendSignal({ type: 'signal', data: { sdp: state.pc.localDescription } });
    } else if (data.candidate) {
      try { await state.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
    }
  }
}

// host 收到 DataChannel 数据：控制帧或 TCP 数据
// 帧协议: {t:'open',c:connId} / {t:'data',c:connId,d:[...]} / {t:'close',c:connId}
async function handleHostChannelData(guestId, raw) {
  const msg = decodeFrame(raw);
  if (!msg) return;
  const connId = guestId + '_' + msg.c;

  if (msg.t === 'open') {
    // guest 的 MC 客户端发起新连接 -> host 连接本地 MC
    const res = await window.mclink.tunnelHostConnect({ connId, mcPort: state.mcPort });
    if (!res.ok) {
      logLine('连接本地 MC 失败: ' + res.error);
      sendHostFrame(guestId, { t: 'close', c: msg.c });
    }
  } else if (msg.t === 'data') {
    window.mclink.tunnelSend(connId, msg.d);
  } else if (msg.t === 'close') {
    window.mclink.tunnelClose(connId);
  }
}

function sendHostFrame(guestId, obj) {
  const peer = state.hostPeers.get(guestId);
  if (peer && peer.channel.readyState === 'open') {
    peer.channel.send(encodeFrame(obj));
  }
}

function memberRow(member, showIp) {
  const name = escapeHtml(member.username || member.name || '未知用户');
  const hostBadge = member.isHost || member.role === 'host' ? '<span class="host-badge">房主</span>' : '';
  const ip = showIp ? escapeHtml(member.ip || '--') : '';
  const ping = Number.isFinite(Number(member.ping)) ? `${Number(member.ping)} ms` : '--';
  return `<div class="peer-item"><span class="peer-name">${name}${hostBadge}</span>${showIp ? `<span class="peer-ip">${ip}</span>` : '<span></span>'}<span class="peer-ping">${ping}</span></div>`;
}

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = String(value);
  return div.innerHTML;
}

function onMembers(msg) {
  state.members = Array.isArray(msg.members) ? msg.members : [];
  state.maxMembers = Number(msg.maxMembers) || state.maxMembers;
  updateHostPeers();
  if ($('guest-members')) $('guest-members').innerHTML = state.members.map((m) => memberRow(m, false)).join('');
}

function updateHostPeers() {
  const total = state.members.length || (state.hostPeers.size + (state.role === 'host' ? 1 : 0));
  $('host-online-count').textContent = `${total}/${state.maxMembers}`;
  $('host-peers').innerHTML = state.members.map((m) => memberRow(m, true)).join('');
}

function cleanupHostPeer(guestId) {
  const peer = state.hostPeers.get(guestId);
  if (peer) {
    try { peer.pc.close(); } catch {}
    state.hostPeers.delete(guestId);
  }
  updateHostPeers();
}

function onPeerLeft(msg) {
  if (state.role === 'host' && msg.guestId) {
    cleanupHostPeer(msg.guestId);
    logLine('好友离开');
  } else if (state.role === 'guest') {
    toast('房主已断开连接', 'warn');
    leaveRoom();
  }
}

async function closeRoom() {
  if (state.role !== 'host') return;
  state.hostPeers.forEach((_, id) => cleanupHostPeer(id));
  await window.mclink.tunnelStopAll();
  try { await window.mclink.motdStop(); } catch {}
  // frp 模式：停止 frpc 并发信令 close
  if (state.frpEndpoint) {
    try { await window.mclink.frpcStop(); } catch {}
    state.frpEndpoint = null;
    sendSignal({ type: 'close' });
  }
  sendSignal({ type: 'leave', room: state.roomCode });
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.role = null;
  state.roomCode = null;
  $('host-active').classList.add('hidden');
  $('host-setup').classList.remove('hidden');
  logLine('房间已关闭');
}

/* ============ frp 中转模式（Host） ============ */
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

async function createFrpRoom(button = $('btn-create')) {
  const node = state.frpNodes.find((n) => n.id === state.frpNodeId);
  if (!node) return toast('节点无效', 'error');

  logLine('正在启动 frp 内网穿透: ' + node.name);
  toast('提示：中转模式延迟高于 P2P', 'warn');

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
        localPort: state.mcPort,
        remotePort,
      });
      if (res.ok) break;
      logLine('frp 端口 ' + remotePort + ' 不可用，正在重新随机...');
    }
    if (!res || !res.ok) throw new Error((res && res.error) || '未找到可用的随机公网端口');
    logLine('frpc 已启动，随机公网端口: ' + remotePort);

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

let quickHostMode = 'p2p';
let quickHostPending = false;
function quickHostKey(event, mode) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openQuickHost(mode);
  }
}
function openQuickHost(mode) {
  quickHostMode = mode;
  $('quick-host-mode').textContent = mode === 'frp' ? 'frp 中转' : 'P2P 端到端';
  $('quick-frp-section').classList.toggle('hidden', mode !== 'frp');
  $('quick-mc-port').value = $('mc-port').value || 25565;
  if (state.frpNodeId) $('quick-frp-node-select').value = String(state.frpNodeId);
  $('quick-host-confirm').disabled = false;
  $('quick-host-modal').classList.remove('hidden');
}
async function confirmQuickHost() {
  const button = $('quick-host-confirm');
  button.disabled = true;
  quickHostPending = true;
  $('mc-port').value = $('quick-mc-port').value;
  if (quickHostMode === 'frp') selectFrpNode($('quick-frp-node-select').value);
  await createRoom({ inputId: 'quick-mc-port', mode: quickHostMode, buttonId: 'quick-host-confirm' });
  if (state.role !== 'host') {
    quickHostPending = false;
    button.disabled = false;
  }
}

/* ============ Guest 侧：加入房间 ============ */
async function joinRoom() {
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
    setupGuestPeer();
    sendSignal({ type: 'join', room: code });
  } catch (e) {
    toast(e.message, 'error');
    $('join-status').textContent = '连接失败: ' + e.message;
    $('btn-join').disabled = false;
  }
}

function setupGuestPeer() {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.pc = pc;

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ type: 'signal', data: { candidate: e.candidate } });
  };

  pc.ondatachannel = (ev) => {
    const channel = ev.channel;
    channel.binaryType = 'arraybuffer';
    state.dataChannel = channel;

    channel.onopen = async () => {
      logLine('P2P 数据通道已打开，启动本地代理...');
      await startGuestProxy();
    };
    channel.onmessage = (e) => handleGuestChannelData(e.data);
    channel.onclose = () => { logLine('数据通道关闭'); };
  };

  pc.onconnectionstatechange = () => {
    logLine('P2P 状态: ' + pc.connectionState);
    $('j-status').textContent = pc.connectionState === 'connected' ? '已直连 (P2P)' : pc.connectionState;
  };
}

async function onRoomJoined(msg) {
  logLine('已加入房间 ' + msg.room + '，模式: ' + (msg.mode || 'p2p'));
  state.roomInfo = { room: msg.room, hostUser: msg.hostUser, hostId: msg.hostId };
  if (Array.isArray(msg.members)) onMembers(msg);

  // frp 模式：服务端在 joined 消息里直接给 frp 端点，无需 WebRTC
  if (msg.mode === 'frp') {
    $('join-status').classList.add('hidden');
    $('btn-join').disabled = false;
    joinFrpRoom(msg);
    return;
  }

  $('join-status').textContent = '已加入，等待 P2P 连接建立...';
}

// guest 启动本地 TCP 代理，MC 客户端连接它
async function startGuestProxy() {
  // 优先 25565，被占用则随机
  const occupied = await window.mclink.checkPort(25565);
  const preferPort = occupied ? 0 : 25565;

  const res = await window.mclink.tunnelGuestListen({ proxyPort: preferPort });
  if (!res.ok) { toast('本地代理启动失败: ' + res.error, 'error'); return; }

  state.proxyPort = res.port;
  $('join-form').classList.add('hidden');
  $('join-active').classList.remove('hidden');
  // 房间信息显示（功能4）
  const info = state.roomInfo || {};
  $('j-room').textContent = info.room || state.roomCode || '--';
  $('j-host').textContent = (info.hostUser || '未知') + (info.hostId ? ' (ID ' + info.hostId + ')' : '');
  $('j-mode').innerHTML = '<span class="tag tag-p2p">P2P 直连</span>';
  $('j-addr').textContent = '127.0.0.1:' + res.port;
  $('j-status').textContent = '已连接';
  logLine('本地代理已启动: 127.0.0.1:' + res.port + '，请在 MC 中连接此地址');
  toast('连接成功！请在 MC 中连接 127.0.0.1:' + res.port, 'success');
}

// guest 收到本地 TCP 事件（来自 main.js），转发到 DataChannel
function handleGuestChannelData(raw) {
  const msg = decodeFrame(raw);
  if (!msg) return;
  const connId = msg.c;

  if (msg.t === 'data') {
    window.mclink.tunnelSend(connId, msg.d);
  } else if (msg.t === 'close') {
    window.mclink.tunnelClose(connId);
  }
}

function sendGuestFrame(obj) {
  if (state.dataChannel && state.dataChannel.readyState === 'open') {
    state.dataChannel.send(encodeFrame(obj));
  }
}

/* ============ frp 中转模式（Guest） ============ */
async function joinFrpRoom(room) {
  // room 来自信令 joined 消息（含 frp: {host, port}）或旧 REST 接口
  const frpHost = (room.frp && room.frp.host) || room.frp_host;
  const frpPort = (room.frp && room.frp.port) || room.frp_remote_port;

  logLine('frp 中转房间，连接: ' + frpHost + ':' + frpPort);
  toast('提示：中转模式延迟高于 P2P', 'warn');

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

function leaveRoom() {
  if (state.role === 'guest') {
    if (state.pc) { try { state.pc.close(); } catch {} state.pc = null; }
    window.mclink.tunnelStopAll();
    sendSignal({ type: 'leave', room: state.roomCode });
    if (state.ws) { state.ws.close(); state.ws = null; }
    state.role = null;
    $('join-active').classList.add('hidden');
    $('join-form').classList.remove('hidden');
    $('btn-join').disabled = false;
    logLine('已断开连接');
  }
}

function onRoomClosed(msg) {
  toast(msg.reason || '房间已关闭', 'warn');
  if (state.role === 'guest') leaveRoom();
  else closeRoom();
}

/* ============ 帧编解码 (ArrayBuffer) ============ */
// 帧结构: 1字节类型 + 4字节connId长度 + connId + 数据
// 简化: 直接 JSON，data 用 Array。追求性能可换二进制，此处保证正确性。
function encodeFrame(obj) {
  const json = JSON.stringify(obj);
  return new TextEncoder().encode(json).buffer;
}

function decodeFrame(raw) {
  try {
    const text = raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : raw;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/* ============ 房间创建后的 IPC 隧道回调桥接 ============ */
function setupTunnelBridge() {
  // TCP -> DataChannel（数据流出）
  window.mclink.onTunnelData(({ connId, data }) => {
    if (state.role === 'host') {
      // connId 格式: guestId_localConnId
      const [guestId, localId] = connId.split('_');
      sendHostFrame(guestId, { t: 'data', c: localId, d: data });
    } else {
      sendGuestFrame({ t: 'data', c: connId, d: data });
    }
  });

  // guest 侧：MC 客户端发起新 TCP 连接
  window.mclink.onTunnelNewConn(({ connId }) => {
    logLine('MC 客户端发起连接 ' + connId);
    sendGuestFrame({ t: 'open', c: connId });
  });

  // TCP 连接关闭
  window.mclink.onTunnelClosed(({ connId }) => {
    if (state.role === 'host') {
      const [guestId, localId] = connId.split('_');
      sendHostFrame(guestId, { t: 'close', c: localId });
    } else {
      sendGuestFrame({ t: 'close', c: connId });
    }
  });

  // frpc 日志过滤（t12）：只显示关键状态行
  window.mclink.onFrpcLog((line) => {
    // 只显示 frpc 状态关键词，过滤无关调试输出
    const KEY = ['start proxy', 'login to server', 'proxy added', 'proxy removed',
                 'reconnecting', 'disconnected', 'connected', 'error', 'failed'];
    const lower = line.toLowerCase();
    if (KEY.some((k) => lower.includes(k))) {
      logLine('[frpc] ' + line.trim());
    }
  });
  window.mclink.onFrpcError((err) => { logLine('[frpc错误] ' + err); toast('frp: ' + err, 'error'); });
}

/* ============ 其它 ============ */
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

/* ============ 退出软件（t5） ============ */
function doExitApp() {
  showConfirm('确认退出软件？', '将停止所有连接并关闭 BLFP。', async () => {
    try { await window.mclink.exitApp(); } catch { window.close(); }
  });
}

/* ============ 设置（t2） ============ */
const SETTINGS_KEY = 'blfp_settings';

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    // 主题
    if (s.theme) applyTheme(s.theme, false);
    // 侧边栏与性能档位
    applySidebarMode(s.sidebarMode || 'normal', false);
    if (s.perf) applyPerfLevel(s.perf, false);
    // 鼠标拖尾
    if (s.cursorTrail) enableCursorTrail();
    // 设置页字段回填
    if ($('s-server')) $('s-server').value = s.server || DEFAULT_SERVER;
    if ($('s-mc-port')) $('s-mc-port').value = s.mcPort || 25565;
    if ($('s-launch-behavior')) $('s-launch-behavior').value = s.launchBehavior || 'ask';
    if ($('sidebar-mode')) $('sidebar-mode').value = s.sidebarMode || 'normal';
    if ($('perf-level')) $('perf-level').value = s.perf || 'medium';
    if ($('cursor-trail-toggle')) $('cursor-trail-toggle').checked = !!s.cursorTrail;
    return s;
  } catch { return {}; }
}

function saveSettings() {
  const server = $('s-server').value.trim().replace(/\/$/, '') || DEFAULT_SERVER;
  const mcPort = parseInt($('s-mc-port').value) || 25565;
  const launchBehavior = $('s-launch-behavior').value;
  const sidebarMode = $('sidebar-mode').value;
  const perf = $('perf-level').value;
  const cursorTrail = $('cursor-trail-toggle').checked;
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';

  const s = { server, mcPort, launchBehavior, sidebarMode, perf, cursorTrail, theme };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  // 更新服务器地址
  state.server = server;
  $('a-server').value = server;
  applySidebarMode(sidebarMode, false);
  applyPerfLevel(perf, false);
  if (cursorTrail) enableCursorTrail(); else disableCursorTrail();
  toast('设置已保存', 'success');
}

function setSidebarMode(mode) { applySidebarMode(mode, true); }
function applySidebarMode(mode, save) {
  const value = ['normal', 'collapsed', 'floating'].includes(mode) ? mode : 'normal';
  document.body.classList.remove('sidebar-normal', 'sidebar-collapsed', 'sidebar-floating');
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
  document.documentElement.setAttribute('data-theme', t === 'light' ? 'light' : '');
  $('theme-dark') && $('theme-dark').classList.toggle('active', t !== 'light');
  $('theme-light') && $('theme-light').classList.toggle('active', t === 'light');
  if (save) {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    s.theme = t; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }
}

function setPerfLevel(level) { applyPerfLevel(level, true); }

function applyPerfLevel(level, save) {
  document.body.classList.remove('perf-off', 'perf-low', 'perf-medium', 'perf-high');
  document.body.classList.add('perf-' + level);
  if ($('cursor-trail-toggle')?.checked) {
    if (level === 'off') disableCursorTrail();
    else { if (!particleEnabled) enableCursorTrail(); else resetParticles(); }
  }
  if (save) {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    s.perf = level; localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
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
    vx: (Math.random() - .5) * .28, vy: (Math.random() - .5) * .28,
  }));
}
function drawParticles() {
  const canvas = $('particle-bg');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const mouseMoving = particleMouse.active && performance.now() - particleMouse.lastMove < 160;
  const repelParticles = ['high', 'medium'].includes($('perf-level')?.value || 'medium');
  for (let i = 0; i < particles.length; i++) {
    const p = particles[i];
    if (mouseMoving) {
      const dx = p.x - particleMouse.x, dy = p.y - particleMouse.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 190 && dist > 1) { const force = (1 - dist / 190) * .018; p.vx += dx / dist * force; p.vy += dy / dist * force; }
    }
    if (Math.hypot(p.vx, p.vy) < .055) { p.vx += (Math.random() - .5) * .006; p.vy += (Math.random() - .5) * .006; }
    p.vx *= .9985; p.vy *= .9985;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > .65) { p.vx = p.vx / speed * .65; p.vy = p.vy / speed * .65; }
    p.x += p.vx; p.y += p.vy;
    if (p.x < 0 || p.x > innerWidth) { p.x = Math.max(0, Math.min(innerWidth, p.x)); p.vx *= -1; }
    if (p.y < 0 || p.y > innerHeight) { p.y = Math.max(0, Math.min(innerHeight, p.y)); p.vy *= -1; }
    ctx.fillStyle = 'rgba(116,143,252,.5)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2); ctx.fill();
    if (particleMouse.active) {
      const d = Math.hypot(particleMouse.x - p.x, particleMouse.y - p.y);
      if (d < 150) { ctx.strokeStyle = `rgba(116,143,252,${(1 - d / 150) * .28})`; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(particleMouse.x, particleMouse.y); ctx.stroke(); }
    }
    for (let j = i + 1; j < particles.length; j++) {
      const q = particles[j], dx = q.x - p.x, dy = q.y - p.y, d = Math.hypot(dx, dy);
      if (repelParticles && d < 24 && d > 1) { const force = (1 - d / 24) * .0008; p.vx -= dx / d * force; p.vy -= dy / d * force; q.vx += dx / d * force; q.vy += dy / d * force; }
      if (d < 85) { ctx.strokeStyle = `rgba(116,143,252,${(1 - d / 85) * .1})`; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
    }
  }
  particleFrame = requestAnimationFrame(drawParticles);
}
function resizeParticleCanvas() {
  const canvas = $('particle-bg');
  const ratio = Math.min(devicePixelRatio || 1, 1.5);
  canvas.width = Math.round(innerWidth * ratio); canvas.height = Math.round(innerHeight * ratio);
  canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px';
  canvas.getContext('2d').setTransform(ratio, 0, 0, ratio, 0, 0);
  resetParticles();
}
function enableCursorTrail() {
  if (particleEnabled) return;
  particleEnabled = true;
  resizeParticleCanvas();
  document.addEventListener('mousemove', updateParticleMouse, { passive: true });
  document.documentElement.addEventListener('mouseleave', clearParticleMouse);
  window.addEventListener('resize', resizeParticleCanvas);
  if (!particleFrame) drawParticles();
}
function updateParticleMouse(e) { particleMouse.x = e.clientX; particleMouse.y = e.clientY; particleMouse.active = true; particleMouse.lastMove = performance.now(); }
function clearParticleMouse() { particleMouse.active = false; }
function disableCursorTrail() {
  particleEnabled = false; particles = [];
  document.removeEventListener('mousemove', updateParticleMouse);
  document.documentElement.removeEventListener('mouseleave', clearParticleMouse);
  window.removeEventListener('resize', resizeParticleCanvas);
  if (particleFrame) cancelAnimationFrame(particleFrame);
  particleFrame = null;
  $('particle-bg').getContext('2d').clearRect(0, 0, $('particle-bg').width, $('particle-bg').height);
}

/* ============ 初始化 ============ */
window.addEventListener('DOMContentLoaded', async () => {
  setupTunnelBridge();
  loadSettings();

  // 尝试恢复登录
  const savedToken = localStorage.getItem('mclink_token');
  const savedServer = localStorage.getItem('mclink_server');
  if (savedServer) {
    $('a-server').value = savedServer;
    state.server = savedServer;
  }

  loadAppInfo().catch(() => { $('app-version').textContent = '未知'; });
  if (savedToken && savedServer) {
    state.token = savedToken;
    try {
      setLoginLoading(true, '正在进入 BLFP…');
      const me = await api('/auth/me');
      state.user = me;
      enterApp();
      return;
    } catch {
      localStorage.removeItem('mclink_token');
      state.token = null;
    } finally {
      setLoginLoading(false);
    }
  }
  $('auth-page').classList.remove('hidden');
});
