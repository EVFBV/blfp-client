const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const os = require('os');

/**
 * 管理内置 frpc.exe 的生命周期
 * - 生成临时 frpc.ini 配置文件
 * - 启动/停止 frpc 进程
 * - 解析日志，提取分配的公网端口
 * - 发射事件：log / port / error
 */
class FrpcManager extends EventEmitter {
  constructor() {
    super();
    this._proc = null;
    this._configPath = null;
  }

  /**
   * 启动 frpc
   * @param {Object} cfg
   * @param {string} cfg.serverAddr   frps 服务器地址
   * @param {number} cfg.serverPort   frps 端口 (默认7000)
   * @param {string} cfg.token        frps token (可选)
   * @param {number} cfg.localPort    本地 Minecraft 端口
   * @param {string} cfg.type         tcp (默认)
   * @param {number} cfg.remotePort   指定远端端口，0 则自动分配 (默认0)
   */
  async start(cfg) {
    if (this._proc) this.stop();

    const frpcPath = this._getFrpcPath();
    if (!fs.existsSync(frpcPath)) {
      throw new Error(`未找到 frpc 可执行文件: ${frpcPath}\n请将 frpc.exe 放入 client/bin/ 目录`);
    }

    this._configPath = path.join(os.tmpdir(), `blfp_frpc_${Date.now()}.toml`);
    const config = this._buildToml(cfg);
    fs.writeFileSync(this._configPath, config, 'utf8');

    return new Promise((resolve, reject) => {
      this._proc = spawn(frpcPath, ['-c', this._configPath], {
        windowsHide: true,
      });

      let resolved = false;

      this._proc.stdout.on('data', (buf) => {
        const line = buf.toString().trim();
        line.split('\n').forEach((l) => {
          this.emit('log', l);

          // 指定端口时必须等到 frpc 明确报告启动成功，避免把冲突端口误判为可用
          const success = /start proxy success|proxy added|proxy started|start proxy.*success/i.test(l);
          const portMatch = l.match(/remotePort[=:]\s*(\d+)|remote_port\s*=\s*(\d+)|start proxy success.*:(\d+)/i);
          if (success && !resolved) {
            const port = parseInt((portMatch && (portMatch[1] || portMatch[2] || portMatch[3])) || cfg.remotePort);
            if (port) {
              resolved = true;
              this.emit('port', port);
              resolve({ remotePort: port });
            }
          }
          if (!resolved && /start error|port.*already|proxy.*error|port unavailable/i.test(l)) {
            resolved = true;
            this.stop();
            reject(new Error('随机公网端口不可用'));
          }
        });
      });

      this._proc.stderr.on('data', (buf) => {
        const line = buf.toString().trim();
        this.emit('log', '[stderr] ' + line);

        const success = /start proxy success|proxy added/i.test(line);
        const portMatch = line.match(/remotePort=(\d+)|remote_port\s*=\s*(\d+)|start proxy.*:(\d+)/i);
        if (success && !resolved) {
          const port = parseInt((portMatch && (portMatch[1] || portMatch[2] || portMatch[3])) || cfg.remotePort);
          if (port) { resolved = true; this.emit('port', port); resolve({ remotePort: port }); }
        }
        if (!resolved && /start error|port.*already|proxy.*error|port unavailable/i.test(line)) {
          resolved = true;
          this.stop();
          reject(new Error('随机公网端口不可用'));
        }
      });

      this._proc.on('close', (code) => {
        this._cleanup();
        if (!resolved) {
          this.emit('error', `frpc 进程退出 (code ${code})`);
          reject(new Error(`frpc 进程意外退出，退出码: ${code}`));
        }
      });

      this._proc.on('error', (e) => {
        this._cleanup();
        if (!resolved) { resolved = true; reject(e); }
        this.emit('error', e.message);
      });

      // 10s 内未确认代理启动则视为失败，交由调用方重新随机端口
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.stop();
          reject(new Error('frpc 启动超时'));
        }
      }, 10000);
    });
  }

  stop() {
    if (this._proc) {
      this._proc.kill();
      this._proc = null;
    }
    this._cleanup();
  }

  _cleanup() {
    if (this._configPath && fs.existsSync(this._configPath)) {
      try { fs.unlinkSync(this._configPath); } catch {}
      this._configPath = null;
    }
  }

  _getFrpcPath() {
    // 打包后从 resources/bin 找，开发时从 client/bin 找
    const devPath = path.join(__dirname, '..', 'bin', 'frpc.exe');
    if (fs.existsSync(devPath)) return devPath;
    // Electron 打包后
    const prodPath = path.join(process.resourcesPath || '', 'bin', 'frpc.exe');
    return prodPath;
  }

  _buildToml(cfg) {
    const quote = (value) => JSON.stringify(String(value));
    const lines = [
      `serverAddr = ${quote(cfg.serverAddr)}`,
      `serverPort = ${Number(cfg.serverPort) || 7000}`,
    ];
    if (cfg.token) lines.push(`auth.token = ${quote(cfg.token)}`);
    lines.push(
      '',
      '[[proxies]]',
      'name = "blfp_tcp"',
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      `localPort = ${Number(cfg.localPort) || 25565}`,
      `remotePort = ${Number(cfg.remotePort) || 0}`,
    );
    return lines.join('\n');
  }
}

module.exports = FrpcManager;
