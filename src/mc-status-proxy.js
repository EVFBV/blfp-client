/*
 * MC 状态探测代理。
 *
 * 房主开 FRP 房间时，frpc 的公网端口**不再直连 MC**，而是先连到这里：
 *   - 探测包（服务器列表刷新）→ 回 BLFP 自己的 MOTD + 图标
 *   - 登录/游戏流量            → 原样转发给真正的 MC 端口
 * 这样房客在 MC 服务器列表里看到的是 BLFP 的品牌，而不是房主存档的名字。
 *
 * 最重要的一条设计：**解析不出来就放行透传**。
 * 认不出的协议、别的客户端、将来 MC 改了握手格式 —— 都不该因此连不上游戏。
 */
const net = require('net');
const mc = require('./mc-status.js');

const HANDSHAKE_BUFFER_LIMIT = 8192; /* 超过这么多还没认出握手包，就不再猜了，直接透传 */

class McStatusProxy {
  constructor() {
    this.server = null;
    this.port = 0;
    this.targetPort = 0;
    this.statusPacket = null;
    this.connections = new Set();
  }

  /* listenPort 传 0 表示让系统分配一个空闲端口（推荐，避免和别的服务撞） */
  start({ listenPort = 0, targetPort, motd = 'BLFP', favicon = null, maxPlayers = 8 }) {
    return new Promise((resolve, reject) => {
      if (!targetPort) return reject(new Error('缺少 MC 目标端口'));
      this.stop();
      this.targetPort = Number(targetPort);
      this.statusPacket = mc.statusResponsePacket(mc.buildStatusJson({
        motd, favicon, online: 1, max: maxPlayers,
      }));

      this.server = net.createServer((sock) => this._onConnection(sock));
      this.server.once('error', reject);
      this.server.listen(listenPort, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve({ port: this.port, targetPort: this.targetPort });
      });
    });
  }

  stop() {
    for (const sock of this.connections) {
      try { sock.destroy(); } catch (e) { /* 已经断了 */ }
    }
    this.connections.clear();
    if (this.server) {
      try { this.server.close(); } catch (e) { /* 已经关了 */ }
      this.server = null;
    }
    this.port = 0;
  }

  _onConnection(sock) {
    this.connections.add(sock);
    sock.on('close', () => this.connections.delete(sock));
    sock.on('error', () => { /* 客户端断开是常态，不记日志刷屏 */ });

    let buf = Buffer.alloc(0);
    let settled = false;
    /* 兜底：认不出来又不能一直等（客户端可能在等我们回包），
       超过一小段时间就放弃猜测、整条连接透传。 */
    const fallback = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.removeListener('data', onData);
      this._pipe(sock, buf);
    }, 250);
    const onData = (chunk) => {
      if (settled) return;
      buf = Buffer.concat([buf, chunk]);
      const handshake = mc.parseHandshake(buf);
      if (!handshake) {
        /* 认不出来：等一会儿；数据量太大说明这根本不是 MC 握手包，直接透传 */
        if (buf.length >= HANDSHAKE_BUFFER_LIMIT) {
          settled = true;
          clearTimeout(fallback);
          sock.removeListener('data', onData);
          this._pipe(sock, buf);
        }
        return;
      }
      settled = true;
      clearTimeout(fallback);
      sock.removeListener('data', onData);
      if (handshake.nextState === 1) {
        this._serveStatus(sock, buf.subarray(handshake.bytesConsumed));
      } else {
        /* 登录/游戏流量：连 MC 时要把握手包原样带上，不能只转发后续数据 */
        this._pipe(sock, buf);
      }
    };
    sock.on('data', onData);
    sock.on('close', () => clearTimeout(fallback));
  }

  /* 状态查询：回状态 → 等延迟探测 → 回 pong → 关闭 */
  _serveStatus(sock, rest) {
    sock.write(this.statusPacket);
    let buf = rest;
    let done = false;

    /* 必须按包循环推进游标：客户端常把"状态请求"和"延迟探测"一起发过来，
       只读第一个包会一直卡在状态请求上，pong 永远发不出去。 */
    const process = () => {
      for (;;) {
        const len = mc.readVarInt(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const id = buf[len.size];
        const payload = buf.subarray(len.size + 1, len.size + len.value);
        buf = buf.subarray(len.size + len.value);
        if (id === 0x01) {
          /* 延迟探测：把 8 字节 payload 原样回过去 */
          done = true;
          sock.write(mc.pongPacket(payload));
          sock.removeListener('data', onData);
          setTimeout(() => { try { sock.end(); } catch (e) {} }, 60);
          return;
        }
        /* id 0x00 是状态请求，握手时已经回过状态了，继续看下一个包 */
      }
    };
    const onData = (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      process();
    };

    sock.on('data', onData);
    /* 关键：握手包里可能已经带着状态请求甚至延迟探测了，
       这些字节不会再触发 'data'，必须立刻处理一次。 */
    process();
    /* 客户端可能拿了状态就走，别把连接挂着 */
    sock.setTimeout(8000, () => { try { sock.destroy(); } catch (e) {} });
  }

  /* 透传：把已读到的字节补写进去，然后双向管道 */
  _pipe(sock, initial) {
    const upstream = net.connect(this.targetPort, '127.0.0.1');
    let connected = false;
    upstream.on('connect', () => {
      connected = true;
      if (initial && initial.length) upstream.write(initial);
      sock.pipe(upstream);
      upstream.pipe(sock);
    });
    const bail = () => {
      try { sock.destroy(); } catch (e) {}
      try { upstream.destroy(); } catch (e) {}
    };
    upstream.on('error', bail);
    upstream.on('close', () => { if (connected) bail(); });
    sock.on('close', () => { try { upstream.destroy(); } catch (e) {} });
  }
}

module.exports = McStatusProxy;
