const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FrpcManager = require('./frpc-manager');

test('builds TOML with normalized values and escaped strings', () => {
  const manager = new FrpcManager();
  const toml = manager._buildToml({
    serverAddr: 'frp.example.com"\\node',
    serverPort: '7443',
    token: 'secret"\\token',
    tls: true,
    localPort: '25570',
    remotePort: '31000',
  });

  assert.equal(toml, [
    'serverAddr = "frp.example.com\\"\\\\node"',
    'serverPort = 7443',
    'auth.token = "secret\\"\\\\token"',
    'transport.tls.enable = true',
    '',
    '[[proxies]]',
    'name = "blfp_tcp"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = 25570',
    'remotePort = 31000',
  ].join('\n'));
});

test('builds TOML defaults and omits an empty token', () => {
  const manager = new FrpcManager();
  const toml = manager._buildToml({
    serverAddr: '127.0.0.1',
    serverPort: 'invalid',
    token: '',
    tls: false,
    localPort: 0,
    remotePort: undefined,
  });

  assert.match(toml, /^serverAddr = "127\.0\.0\.1"$/m);
  assert.match(toml, /^serverPort = 7000$/m);
  assert.match(toml, /^transport\.tls\.enable = false$/m);
  assert.match(toml, /^localPort = 25565$/m);
  assert.match(toml, /^remotePort = 0$/m);
  assert.doesNotMatch(toml, /^auth\.token/m);
});

test('reports running only for a live child in running state', () => {
  const manager = new FrpcManager();
  const liveChild = { exitCode: null, signalCode: null };

  manager._proc = liveChild;
  manager._state = 'starting';
  assert.deepEqual(manager.getStatus(), { state: 'starting', running: false });

  manager._state = 'running';
  assert.deepEqual(manager.getStatus(), { state: 'running', running: true });

  liveChild.exitCode = 0;
  assert.deepEqual(manager.getStatus(), { state: 'running', running: false });
});

test('emits the updated status when state changes', () => {
  const manager = new FrpcManager();
  const statuses = [];
  manager.on('status', (status) => statuses.push(status));

  manager._setState('starting');
  manager._setState('stopped');

  assert.deepEqual(statuses, [
    { state: 'starting', running: false },
    { state: 'stopped', running: false },
  ]);
});

test('removes a temporary config and ignores repeated cleanup', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blfp-frpc-test-'));
  const configPath = path.join(tempDir, 'frpc.toml');
  fs.writeFileSync(configPath, 'serverPort = 7000', 'utf8');
  const manager = new FrpcManager();
  const logs = [];
  manager.on('log', (line) => logs.push(line));

  try {
    manager._cleanupConfig(configPath);
    manager._cleanupConfig(configPath);

    assert.equal(fs.existsSync(configPath), false);
    assert.deepEqual(logs, []);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('logs non-ENOENT config cleanup failures', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blfp-frpc-test-'));
  const manager = new FrpcManager();
  const logs = [];
  manager.on('log', (line) => logs.push(line));

  try {
    manager._cleanupConfig(tempDir);

    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[stderr\] 清理 frpc 配置失败: /);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
