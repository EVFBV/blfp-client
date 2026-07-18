const net = require('net');

/**
 * TCP <-> DataChannel 桥接管理器
 *
 * Host 侧：每当 DataChannel 有新客户端连接通知时，
 *   调用 hostConnect(connId, mcPort, onData, onClose) 建立到本地MC的 TCP 连接
 *
 * Guest 侧：启动一个本地 TCP 服务器（监听 proxyPort），
 *   MC 客户端连到这个端口，对每个连接分配 connId，
 *   通过 onData/onNewConn/onClose 回调通知 main.js 再转发给渲染器
 */
class TunnelManager {
  constructor() {
    // connId -> net.Socket
    this._sockets = new Map();
    // guest 模式下的代理服务器
    this._server = null;
    this._nextConnId = 1;
  }

  // ---- Host 侧 ----
  /**
   * 为某个 DataChannel 连接建立到 MC 服务器的 TCP 连接
   * @param {string} connId
   * @param {number} mcPort
   * @param {(data: Buffer) => void} onData   收到 MC 数据时回调（发给渲染器 -> DataChannel）
   * @param {() => void} onClose
   */
  hostConnect(connId, mcPort, onData, onClose) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port: mcPort });

      socket.once('connect', () => {
        this._sockets.set(connId, socket);
        resolve();
      });

      socket.once('error', (e) => {
        this._sockets.delete(connId);
        reject(e);
        onClose();
      });

      socket.on('data', (buf) => onData(buf));

      socket.on('close', () => {
        this._sockets.delete(connId);
        onClose();
      });
    });
  }

  // ---- Guest 侧 ----
  /**
   * 启动本地代理服务器
   * @param {number} proxyPort  优先使用此端口，0 则随机
   * @param {(connId, data: Buffer) => void} onData
   * @param {(connId) => void} onNewConn
   * @param {(connId) => void} onClose
   * @returns {Promise<number>} 实际监听的端口
   */
  guestListen(proxyPort, onData, onNewConn, onClose) {
    return new Promise((resolve, reject) => {
      if (this._server) {
        this._server.close();
        this._server = null;
      }

      this._server = net.createServer((socket) => {
        const connId = String(this._nextConnId++);
        this._sockets.set(connId, socket);
        onNewConn(connId);

        socket.on('data', (buf) => onData(connId, buf));

        socket.on('close', () => {
          this._sockets.delete(connId);
          onClose(connId);
        });

        socket.on('error', () => {
          this._sockets.delete(connId);
          onClose(connId);
        });
      });

      this._server.once('error', reject);
      this._server.listen(proxyPort || 0, '127.0.0.1', () => {
        resolve(this._server.address().port);
      });
    });
  }

  /**
   * 将来自 DataChannel 的数据写入对应 TCP socket
   */
  send(connId, data) {
    const sock = this._sockets.get(connId);
    if (sock && !sock.destroyed) sock.write(data);
  }

  closeConn(connId) {
    const sock = this._sockets.get(connId);
    if (sock) { sock.destroy(); this._sockets.delete(connId); }
  }

  stopAll() {
    this._sockets.forEach((s) => { try { s.destroy(); } catch {} });
    this._sockets.clear();
    if (this._server) { this._server.close(); this._server = null; }
  }
}

module.exports = TunnelManager;
