/*
 * MC 状态探测代理的端到端测试：真的起 TCP 服务、真的发协议字节。
 * 这段逻辑只做字符串断言是测不出来的 —— 它错的表现是"房客连不上游戏"。
 */
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const mc = require('./mc-status.js');
const McStatusProxy = require('./mc-status-proxy.js');

/* 假 MC 服务器：记下收到的字节，方便验证"透传是否原样到达" */
function startFakeMc() {
  return new Promise((resolve) => {
    const received = [];
    const server = net.createServer((sock) => {
      sock.on('data', (c) => received.push(c));
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function handshake({ address = 'relay.example', port = 2001, nextState = 1 } = {}) {
  const body = Buffer.concat([
    Buffer.from([0x00]),
    mc.writeVarInt(765),
    mc.writeString(address),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b; })(),
    mc.writeVarInt(nextState),
  ]);
  return mc.frame(body);
}

/* 连上代理并收集回包；resolve 在收到足够数据或超时后 */
function talk(port, chunks, waitMs = 400) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    const got = [];
    sock.on('data', (c) => got.push(c));
    sock.on('error', reject);
    sock.on('connect', () => { for (const c of chunks) sock.write(c); });
    setTimeout(() => {
      try { sock.destroy(); } catch (e) {}
      resolve(Buffer.concat(got));
    }, waitMs);
  });
}

test('状态查询：回的是 BLFP 的 MOTD 和图标，不是房主存档的名字', async () => {
  const fake = await startFakeMc();
  const proxy = new McStatusProxy();
  const favicon = 'data:image/png;base64,AAAB';
  const { port } = await proxy.start({
    targetPort: fake.port,
    motd: 'BLFP 房间 123456',
    favicon,
  });
  try {
    const reply = await talk(port, [handshake({ nextState: 1 }), Buffer.from([0x01, 0x00])]);
    const len = mc.readVarInt(reply, 0);
    assert.ok(len, '代理必须回了包');
    assert.equal(reply[len.size], 0x00, '第一个包应是状态响应（id 0x00）');
    const str = mc.readString(reply, len.size + 1);
    const json = JSON.parse(str.value);
    assert.equal(json.description.text, 'BLFP 房间 123456');
    assert.equal(json.favicon, favicon);
    /* 关键：MC 自己没被叫醒（探测不该惊动游戏本体） */
    assert.equal(fake.received.length, 0, '状态查询不该转发给 MC');
  } finally {
    proxy.stop();
    await fake.close();
  }
});

test('延迟探测：8 字节 payload 原样回传', async () => {
  const fake = await startFakeMc();
  const proxy = new McStatusProxy();
  const { port } = await proxy.start({ targetPort: fake.port, motd: 'BLFP' });
  try {
    const payload = Buffer.from([9, 8, 7, 6, 5, 4, 3, 2]);
    const ping = mc.frame(Buffer.concat([Buffer.from([0x01]), payload]));
    const reply = await talk(port, [handshake({ nextState: 1 }), Buffer.from([0x01, 0x00]), ping], 600);
    /* 回复里应当能找到 pong（id 0x01 + 同样的 payload） */
    assert.ok(reply.includes(payload), 'pong 必须带回同样的 payload');
  } finally {
    proxy.stop();
    await fake.close();
  }
});

test('登录流量：原样透传给真正的 MC，包括握手包本身', async () => {
  const fake = await startFakeMc();
  const proxy = new McStatusProxy();
  const { port } = await proxy.start({ targetPort: fake.port, motd: 'BLFP' });
  try {
    const hs = handshake({ nextState: 2 });
    const marker = Buffer.from('LOGIN-DATA-1234');
    await talk(port, [hs, marker], 500);
    const all = Buffer.concat(fake.received);
    assert.ok(all.includes(marker), '登录数据必须到达 MC');
    assert.ok(all.includes(hs), '握手包本身也必须转发，否则 MC 认不出连接');
  } finally {
    proxy.stop();
    await fake.close();
  }
});

test('认不出的流量也放行（解析失败绝不能把人挡在门外）', async () => {
  const fake = await startFakeMc();
  const proxy = new McStatusProxy();
  const { port } = await proxy.start({ targetPort: fake.port, motd: 'BLFP' });
  try {
    const garbage = Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x11, 0x22]);
    await talk(port, [garbage], 400);
    const all = Buffer.concat(fake.received);
    assert.ok(all.includes(garbage), '认不出的数据也必须透传，不能静默丢弃');
  } finally {
    proxy.stop();
    await fake.close();
  }
});

test('stop 之后端口释放，不留后台监听', async () => {
  const fake = await startFakeMc();
  const proxy = new McStatusProxy();
  const { port } = await proxy.start({ targetPort: fake.port, motd: 'BLFP' });
  proxy.stop();
  await new Promise((r) => setTimeout(r, 100));
  const again = net.connect(port, '127.0.0.1');
  const failed = await new Promise((resolve) => {
    again.on('error', () => resolve(true));
    again.on('connect', () => { again.destroy(); resolve(false); });
  });
  assert.equal(failed, true, 'stop 后不该还能连上');
  await fake.close();
});

/* ===== 接线守卫 =====
   协议本身有上面的真测试兜底，但"忘了在 preload 暴露"这类接线错误
   跑起来只会表现为"调用 undefined"，很难定位，所以单独钉一下。 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const MAIN = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const PRELOAD = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');

test('主进程注册了代理的 IPC，preload 也暴露了对应方法', () => {
  assert.match(MAIN, /ipcMain\.handle\('mc-status-proxy-start'/, 'main.js 没有注册 mc-status-proxy-start');
  assert.match(MAIN, /ipcMain\.handle\('mc-status-proxy-stop'/, 'main.js 没有注册 mc-status-proxy-stop');
  assert.match(PRELOAD, /mcStatusProxyStart:\s*\(/, 'preload 没有暴露 mcStatusProxyStart');
  assert.match(PRELOAD, /mcStatusProxyStop:\s*\(/, 'preload 没有暴露 mcStatusProxyStop');
});

test('frpc 一停，探测代理必须跟着停（放在主进程一处，避免漏掉某个调用点）', () => {
  const i = MAIN.indexOf("ipcMain.handle('frpc-stop'");
  assert.ok(i > 0, '找不到 frpc-stop');
  const body = MAIN.slice(i, i + 600);
  assert.match(body, /mcStatusProxy/, 'frpc-stop 里没有停探测代理 —— 会留下一个没人管的监听端口');
});

test('房主建房时先起代理，再把 frpc 的 localPort 指向它；起不来要退回直连', () => {
  const i = APP.indexOf('mcStatusProxyStart');
  assert.ok(i > 0, 'app.js 没有调用 mcStatusProxyStart');
  const j = APP.indexOf('frpcStart', i);
  assert.ok(j > i, '代理必须在 frpcStart 之前启动（否则 frpc 会先指向 MC）');
  const body = APP.slice(i, j);
  assert.match(body, /localPort\s*=\s*proxy\.port/, '没有把 frpc 的目标端口改成代理端口');
  /* 代理失败必须退回 state.mcPort，否则等于把联机功能整个关掉 */
  assert.match(APP.slice(i - 800, j), /let localPort = state\.mcPort/, '缺少"代理起不来就直连 MC"的兜底');
});
