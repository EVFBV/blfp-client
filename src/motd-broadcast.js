const dgram = require('dgram');

// Minecraft 局域网服务发现：向组播地址 224.0.2.60:4445 定时广播
// 报文格式固定为 "[MOTD]<描述>[/MOTD][AD]<端口>[/AD]"
// 游戏「多人游戏」页会自动发现并显示这条局域网服务器
const MULTICAST_ADDR = '224.0.2.60';
const MULTICAST_PORT = 4445;
const BROADCAST_INTERVAL = 1500;

class MotdBroadcaster {
  constructor() {
    this.socket = null;
    this.timer = null;
    this.motd = '';
    this.port = 0;
  }

  // 开始广播。motd 为显示文案，port 为游戏实际连接的本地端口
  start(motd, port) {
    this.stop();
    this.motd = motd;
    this.port = port;

    this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket.on('error', () => this.stop());

    this.socket.bind(() => {
      try {
        this.socket.setBroadcast(true);
        this.socket.setMulticastTTL(1);
      } catch {}
      this._tick();
      this.timer = setInterval(() => this._tick(), BROADCAST_INTERVAL);
    });
  }

  _tick() {
    if (!this.socket) return;
    const payload = `[MOTD]${this.motd}[/MOTD][AD]${this.port}[/AD]`;
    const buf = Buffer.from(payload, 'utf8');
    this.socket.send(buf, 0, buf.length, MULTICAST_PORT, MULTICAST_ADDR, () => {});
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this.socket) {
      try { this.socket.close(); } catch {}
      this.socket = null;
    }
  }
}

module.exports = MotdBroadcaster;
