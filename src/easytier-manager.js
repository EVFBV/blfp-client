const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');

const HOST_PORT = 25565;

class EasyTierManager extends EventEmitter {
  constructor(appOrOptions = {}) {
    super();
    const isApp = typeof appOrOptions.getAppPath === 'function';
    this._packed = isApp ? appOrOptions.isPackaged : Boolean(appOrOptions.packed ?? appOrOptions.isPackaged);
    this._resourcesPath = isApp
      ? process.resourcesPath
      : (appOrOptions.resourcesPath || process.resourcesPath);
    this._proc = null;
    this._proxyServer = null;
    this._proxySockets = new Set();
    this._state = 'stopped';
    this._mode = null;
    this._virtualIp = null;
    this._lastError = null;
    this._stopping = false;
    this._operationQueue = Promise.resolve();
    this._stopOperation = null;
    this._generation = 0;
    this._rpcPortal = null;
  }

  getBinaryPath() {
    if (this._packed) return path.join(this._resourcesPath, 'bin', 'easytier-core.exe');
    return path.join(__dirname, '..', 'bin', 'easytier-core.exe');
  }

  getCliPath() {
    return path.join(path.dirname(this.getBinaryPath()), 'easytier-cli.exe');
  }

  ensureBinary() {
    const binaryDir = path.dirname(this.getBinaryPath());
    const requiredFiles = [
      this.getBinaryPath(),
      this.getCliPath(),
      path.join(binaryDir, 'wintun.dll'),
      path.join(binaryDir, 'Packet.dll'),
    ];
    const missingFile = requiredFiles.find((file) => !fs.existsSync(file));
    if (missingFile) throw new Error(`未找到 EasyTier 运行文件: ${missingFile}`);
    return true;
  }

  getStatus() {
    return {
      state: this._state,
      running: this._state === 'running' && this._isProcessAlive(),
      mode: this._mode,
      virtualIp: this._virtualIp,
      proxyListening: Boolean(this._proxyServer?.listening),
      error: this._lastError,
    };
  }

  start(config = {}) {
    this._stopOperation = null;
    return this._enqueueOperation(() => this._start(config));
  }

  stop() {
    if (this._stopOperation) return this._stopOperation;
    const operation = this._enqueueOperation(() => this._stop());
    this._stopOperation = operation;
    const clear = () => {
      if (this._stopOperation === operation) this._stopOperation = null;
    };
    operation.then(clear, clear);
    return operation;
  }

  async _start(config = {}) {
    if (this._state !== 'stopped') await this._stop();
    const generation = ++this._generation;

    const mode = config.mode || config.role || (config.hostMode ? 'host' : 'guest');
    const virtualIp = String(config.virtualIp || '').trim();
    const [proxyIp, prefixLength, ...extraParts] = virtualIp.split('/');
    const networkName = String(config.networkName || '').trim();
    const networkSecret = String(config.networkSecret || '').trim();
    const peers = Array.isArray(config.peers) ? config.peers : (config.peer ? [config.peer] : []);
    const mcPort = Number(config.mcPort);

    if (!['host', 'guest'].includes(mode)) throw new Error('EasyTier 模式必须为 host 或 guest');
    if (!net.isIPv4(proxyIp)
      || extraParts.length
      || (prefixLength !== undefined && (!/^\d+$/.test(prefixLength) || Number(prefixLength) > 32))) {
      throw new Error('EasyTier 虚拟 IP 无效');
    }
    if (!networkName) throw new Error('EasyTier 网络名称不能为空');
    if (!networkSecret) throw new Error('EasyTier 网络密钥不能为空');
    if (mode === 'host' && (!Number.isInteger(mcPort) || mcPort < 1 || mcPort > 65535)) {
      throw new Error('Minecraft 端口无效');
    }

    this.ensureBinary();
    const binaryPath = this.getBinaryPath();
    const cliPath = this.getCliPath();
    const rpcPortal = `127.0.0.1:${await this._findFreeTcpPort()}`;

    const easyTierIp = prefixLength === undefined ? `${proxyIp}/24` : virtualIp;
    const instanceName = `${networkName}-${mode}`
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 63)
      .replace(/-$/, '') || `blfp-${mode}`;
    const args = [
      '--ipv4', easyTierIp,
      '--network-name', networkName,
      '--network-secret', networkSecret,
      '--hostname', instanceName,
      '--instance-name', instanceName,
      '--latency-first',
      '--rpc-portal', rpcPortal,
    ];
    peers.map((peer) => String(peer).trim()).filter(Boolean).forEach((peer) => args.push('-p', peer));

    this._mode = mode;
    this._virtualIp = virtualIp;
    this._rpcPortal = rpcPortal;
    this._lastError = null;
    this._stopping = false;
    this._setState('starting');
    this._log(`正在启动 EasyTier（${mode} 模式）`);

    try {
      const child = spawn(binaryPath, args, {
        cwd: path.dirname(binaryPath),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this._proc = child;
      this._attachProcess(child, generation, networkSecret);

      await this._waitForPeerReady(child, generation, cliPath, rpcPortal);
      if (mode === 'host') await this._startHostProxy(child, generation, proxyIp, mcPort);

      if (this._generation !== generation || this._proc !== child || !this._isChildAlive(child)) {
        throw new Error('EasyTier 进程在启动期间退出');
      }
      this._setState('running');
      this._log('EasyTier 启动成功');
      return this.getStatus();
    } catch (error) {
      this._lastError = error.message;
      this._setState('error');
      this._emitError(error.message);
      await this._stop();
      throw error;
    }
  }

  async _stop() {
    this._generation += 1;
    this._stopping = true;
    if (this._state !== 'stopped') this._setState('stopping');

    await this._closeProxy();
    const child = this._proc;
    if (child && child.exitCode === null && child.signalCode === null) {
      this._log('正在停止 EasyTier');
      try { child.kill(); } catch {}
      let exited = await this._waitForExit(child, 3000);
      if (!exited && process.platform === 'win32' && child.pid) {
        this._log('常规停止超时，使用 taskkill 清理进程树');
        await this._taskkill(child.pid);
        exited = await this._waitForExit(child, 3000);
      }
      if (!exited) {
        try { child.kill('SIGKILL'); } catch {}
      }
    }

    if (this._proc === child) this._proc = null;
    this._mode = null;
    this._virtualIp = null;
    this._rpcPortal = null;
    this._stopping = false;
    this._setState('stopped');
    return this.getStatus();
  }

  testConnectivity(hostVirtualIp, port = HOST_PORT, timeout = 3000) {
    return new Promise((resolve) => {
      const host = String(hostVirtualIp || '').trim();
      const targetPort = Number(port);
      if (!net.isIPv4(host) || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        resolve({ ok: false, error: '连接地址或端口无效' });
        return;
      }

      const socket = new net.Socket();
      const startedAt = Date.now();
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(timeout);
      socket.once('connect', () => finish({ ok: true, latency: Date.now() - startedAt }));
      socket.once('timeout', () => finish({ ok: false, error: '连接超时' }));
      socket.once('error', (error) => finish({ ok: false, error: error.message }));
      socket.connect(targetPort, host);
    });
  }

  _enqueueOperation(operation) {
    const result = this._operationQueue.then(operation, operation);
    this._operationQueue = result.catch(() => {});
    return result;
  }

  _attachProcess(child, generation, networkSecret) {
    const WINTUN_FATAL_RE = /Failed to create (private namespace|adapter)|Failed to take device installation mutex|rust tun error|os error 5/i;
    const WINTUN_MSG = 'WinTun 虚拟网卡创建失败（权限不足或被安全软件拦截），请确认以管理员身份运行，并在安全软件中允许 easytier-core.exe 安装驱动';

    const emitLines = (prefix, buffer) => {
      buffer.toString().split(/\r?\n/).filter(Boolean).forEach((line) => {
        const safeLine = networkSecret ? line.split(networkSecret).join('[REDACTED]') : line;
        this._log(`${prefix}${safeLine}`);
        if (WINTUN_FATAL_RE.test(safeLine) && this._generation === generation && this._proc === child) {
          this._lastError = WINTUN_MSG;
        }
      });
    };
    child.stdout.on('data', (buffer) => emitLines('', buffer));
    child.stderr.on('data', (buffer) => emitLines('[stderr] ', buffer));
    child.once('error', (error) => {
      if (this._generation !== generation || this._proc !== child) return;
      this._lastError = error.message;
      this._emitError(error.message);
    });
    child.once('close', (code, signal) => {
      this._log(`EasyTier 进程退出（code=${code}, signal=${signal || 'none'}）`);
      if (this._generation !== generation || this._proc !== child) return;
      this._proc = null;
      this._closeProxy();
      if (!this._stopping) {
        this._lastError = `EasyTier 进程意外退出（退出码 ${code}）`;
        this._setState('error');
        this._emitError(this._lastError);
      }
    });
  }

  _findFreeTcpPort() {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address();
        server.close((error) => {
          if (error) reject(error);
          else resolve(port);
        });
      });
    });
  }

  async _waitForPeerReady(child, generation, cliPath, rpcPortal, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this._generation !== generation || this._proc !== child || !this._isChildAlive(child)) {
        throw new Error('EasyTier 进程在启动期间退出');
      }

      const attemptStartedAt = Date.now();
      try {
        const peers = await this._queryPeers(cliPath, rpcPortal, child);
        if (Array.isArray(peers) && peers.some((peer) => peer?.cost !== 'Local')) {
          this._log('EasyTier 共享节点连接成功');
          return;
        }
      } catch (error) {
        if (!this._isChildAlive(child)) throw new Error('EasyTier 进程在启动期间退出');
      }

      const delay = Math.min(1000 - (Date.now() - attemptStartedAt), deadline - Date.now());
      if (delay > 0) await this._waitForProcess(child, delay);
    }
    throw new Error('无法连接 EasyTier 共享节点');
  }

  _queryPeers(cliPath, rpcPortal, child) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        child.removeListener('close', onClose);
        callback(value);
      };
      const onClose = () => finish(reject, new Error('EasyTier 进程在启动期间退出'));
      child.once('close', onClose);
      execFile(cliPath, ['-p', rpcPortal, '-o', 'json', 'peer'], {
        cwd: path.dirname(cliPath),
        windowsHide: true,
        timeout: 900,
      }, (error, stdout) => {
        if (error) {
          finish(reject, error);
          return;
        }
        try {
          finish(resolve, JSON.parse(stdout));
        } catch (parseError) {
          finish(reject, parseError);
        }
      });
    });
  }

  async _startHostProxy(child, generation, virtualIp, mcPort, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this._generation !== generation || this._proc !== child || !this._isChildAlive(child)) {
        throw new Error('EasyTier 进程在等待虚拟 IP 时退出');
      }
      try {
        const server = await this._listenProxy(virtualIp, mcPort);
        if (this._generation !== generation || this._proc !== child) {
          await new Promise((resolve) => server.close(() => resolve()));
          throw new Error('EasyTier 启动已取消');
        }
        this._proxyServer = server;
        this._log(`TCP 代理已监听 ${virtualIp}:${HOST_PORT} -> 127.0.0.1:${mcPort}`);
        return;
      } catch (error) {
        if (!['EADDRNOTAVAIL', 'EADDRINUSE'].includes(error.code)) throw error;
        if (error.code === 'EADDRINUSE') {
          // 虚拟地址端口被本机物理栈占用：若游戏恰好以同一端口（默认 25565）对局域网开放，
          // 访客经虚拟网卡即可直达游戏监听，无需代理 —— 直通模式
          this._lastProxyConflict = true;
          if (mcPort === HOST_PORT && await this._probeTcp('127.0.0.1', HOST_PORT)) {
            this._log(`端口 ${HOST_PORT} 已被本机占用且与 mcPort 相同：启用直通模式（访客直连虚拟地址，不经代理）`);
            return;
          }
        }
        await this._delay(500);
      }
    }
    if (this._lastProxyConflict && mcPort !== HOST_PORT) {
      throw new Error(`虚拟地址端口 ${HOST_PORT} 被本机其他程序占用：请先释放该端口（检查是否有别的程序或另一局游戏正以 25565 对局域网开放），或将「对局域网开放」的端口改为其他值后重试`);
    }
    throw new Error(`等待虚拟 IP ${virtualIp} 可绑定超时`);
  }

  _probeTcp(host, port, timeout = 800) {
    return new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const done = (result) => { socket.destroy(); resolve(result); };
      socket.setTimeout(timeout, () => done(false));
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
    });
  }

  _listenProxy(virtualIp, mcPort) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((client) => {
        const upstream = net.createConnection({ host: '127.0.0.1', port: mcPort });
        this._proxySockets.add(client);
        this._proxySockets.add(upstream);
        const forget = (socket) => this._proxySockets.delete(socket);
        client.once('close', () => forget(client));
        upstream.once('close', () => forget(upstream));
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      });
      server.once('error', reject);
      server.listen(HOST_PORT, virtualIp, () => {
        server.removeListener('error', reject);
        server.on('error', (error) => this._emitError(`EasyTier 代理错误: ${error.message}`));
        resolve(server);
      });
    });
  }

  _closeProxy() {
    const server = this._proxyServer;
    this._proxyServer = null;
    for (const socket of this._proxySockets) socket.destroy();
    this._proxySockets.clear();
    if (!server) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  _waitForProcess(child, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this._isChildAlive(child) ? resolve() : reject(new Error('EasyTier 进程未能保持运行'));
      }, milliseconds);
      const onClose = () => {
        cleanup();
        reject(new Error('EasyTier 进程在启动期间退出'));
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child?.removeListener('close', onClose);
        child?.removeListener('error', onError);
      };
      child?.once('close', onClose);
      child?.once('error', onError);
    });
  }

  _waitForExit(child, timeout) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.removeListener('close', onClose);
        resolve(false);
      }, timeout);
      const onClose = () => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once('close', onClose);
    });
  }

  _taskkill(pid) {
    return new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('error', () => resolve());
      killer.once('close', () => resolve());
    });
  }

  _isChildAlive(child) {
    return Boolean(child && child.exitCode === null && child.signalCode === null);
  }

  _isProcessAlive() {
    return this._isChildAlive(this._proc);
  }

  _setState(state) {
    this._state = state;
    this.emit('status', this.getStatus());
  }

  _emitError(message) {
    this.emit('manager-error', message);
  }

  _log(message) {
    this.emit('log', `[EasyTier] ${message}`);
  }

  _delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}

module.exports = EasyTierManager;
