const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const net = require('net');
const path = require('path');
const platform = require('./platform');

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
    const binDirectory = platform.binDir(this._packed, this._resourcesPath);
    return platform.binaryPath(binDirectory, 'easytierCore');
  }

  getCliPath() {
    const binDirectory = platform.binDir(this._packed, this._resourcesPath);
    return platform.binaryPath(binDirectory, 'easytierCli');
  }

  ensureBinary() {
    const binDirectory = path.dirname(this.getBinaryPath());
    return platform.ensureBinaries(binDirectory, ['easytierCore', 'easytierCli']);
  }

  getStatus() {
    return {
      state: this._state,
      running: this._state === 'running' && this._isProcessAlive(),
      mode: this._mode,
      virtualIp: this._virtualIp,
      proxyPort: this._proxyPort ?? HOST_PORT,
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
      try { child.kill('SIGTERM'); } catch {}
      const exited = await this._waitForExit(child, 3000);
      if (!exited) {
        try { child.kill('SIGKILL'); } catch {}
        await this._waitForExit(child, 1000);
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
    const emitLines = (prefix, buffer) => {
      buffer.toString().split(/\r?\n/).filter(Boolean).forEach((line) => {
        const safeLine = networkSecret ? line.split(networkSecret).join('[REDACTED]') : line;
        this._log(`${prefix}${safeLine}`);
        if (platform.TUN_FATAL_RE.test(safeLine) && this._generation === generation && this._proc === child) {
          this._lastError = platform.TUN_FATAL_MSG;
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
    let proxyPort = HOST_PORT;
    while (Date.now() < deadline) {
      if (this._generation !== generation || this._proc !== child || !this._isChildAlive(child)) {
        throw new Error('EasyTier 进程在等待虚拟 IP 时退出');
      }
      try {
        const server = await this._listenProxy(virtualIp, mcPort, proxyPort);
        if (this._generation !== generation || this._proc !== child) {
          await new Promise((resolve) => server.close(() => resolve()));
          throw new Error('EasyTier 启动已取消');
        }
        this._proxyServer = server;
        this._proxyPort = proxyPort;
        this._log(`TCP 代理已监听 ${virtualIp}:${proxyPort} -> 127.0.0.1:${mcPort}`);
        return;
      } catch (error) {
        if (!['EADDRNOTAVAIL', 'EADDRINUSE'].includes(error.code)) throw error;
        if (error.code === 'EADDRINUSE' && proxyPort === HOST_PORT) {
          // 端口冲突：切换到随机空闲端口
          proxyPort = await this._findFreeTcpPort();
          this._log(`端口 ${HOST_PORT} 被占用，切换到代理端口 ${proxyPort}`);
          continue;
        }
        await this._delay(500);
      }
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

  _listenProxy(virtualIp, mcPort, port) {
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
      const bindPort = port ?? HOST_PORT;
      server.listen(bindPort, virtualIp, () => {
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
