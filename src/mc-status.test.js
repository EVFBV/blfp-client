/*
 * MC 状态探测的测试。
 * 全部是"真的构造字节、真的解析回来"，不是断言源码字符串 ——
 * 这段逻辑一旦算错，房客在 MC 里就会看到空白服务器列表或者连不上。
 */
const test = require('node:test');
const assert = require('node:assert');
const mc = require('./mc-status.js');

/* 按 MC 协议手工拼一个握手包 */
function makeHandshake({ protocol = 765, address = 'relay.example', port = 2001, nextState = 1 } = {}) {
  const body = Buffer.concat([
    Buffer.from([0x00]),            // packet id
    mc.writeVarInt(protocol),
    mc.writeString(address),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b; })(),
    mc.writeVarInt(nextState),
  ]);
  return mc.frame(body);
}

test('VarInt 编解码往返（含跨字节边界）', () => {
  for (const v of [0, 1, 127, 128, 255, 300, 16383, 16384, 2097151, 765, 25565]) {
    const enc = mc.writeVarInt(v);
    const dec = mc.readVarInt(enc, 0);
    assert.equal(dec.value, v, v + ' 往返失败');
    assert.equal(dec.size, enc.length);
  }
});

test('数据不完整时返回 null，而不是猜一个值', () => {
  const full = makeHandshake();
  /* 截断到任意长度都不能崩，也不能返回半截结果 */
  for (let cut = 1; cut < full.length; cut++) {
    assert.equal(mc.parseHandshake(full.subarray(0, cut)), null, '截断到 ' + cut + ' 字节时应返回 null');
  }
});

test('解析握手包：状态查询与登录两种下一状态', () => {
  const status = mc.parseHandshake(makeHandshake({ nextState: 1 }));
  assert.equal(status.nextState, 1);
  assert.equal(status.serverAddress, 'relay.example');
  assert.equal(status.serverPort, 2001);
  assert.equal(status.protocolVersion, 765);

  const login = mc.parseHandshake(makeHandshake({ nextState: 2, address: '1.2.3.4', port: 65535 }));
  assert.equal(login.nextState, 2);
  assert.equal(login.serverAddress, '1.2.3.4');
  assert.equal(login.serverPort, 65535);
});

test('不是握手包（packet id 不对）时返回 null —— 调用方据此放行透传', () => {
  const bad = mc.frame(Buffer.concat([Buffer.from([0x07]), mc.writeString('x')]));
  assert.equal(mc.parseHandshake(bad), null);
  assert.equal(mc.parseHandshake(Buffer.alloc(0)), null);
});

test('状态响应：包结构正确且能被解析回来', () => {
  const json = mc.buildStatusJson({ motd: 'BLFP 房间 123456', favicon: 'data:image/png;base64,AAA', online: 3, max: 8 });
  const packet = mc.statusResponsePacket(json);

  /* [VarInt 长度][0x00][VarInt 字符串长度][JSON] */
  const len = mc.readVarInt(packet, 0);
  assert.ok(len, '包长度可解析');
  assert.equal(len.value, packet.length - len.size, '长度字段必须等于剩余字节数');
  assert.equal(packet[len.size], 0x00, '状态响应包 id 必须是 0x00');
  const str = mc.readString(packet, len.size + 1);
  assert.equal(str.value, json);

  const parsed = JSON.parse(str.value);
  assert.equal(parsed.description.text, 'BLFP 房间 123456');
  assert.equal(parsed.favicon, 'data:image/png;base64,AAA');
  assert.equal(parsed.players.online, 3);
  assert.equal(parsed.players.max, 8);
});

test('没图标时不该塞一个空 favicon 字段（MC 会显示成裂图）', () => {
  const parsed = JSON.parse(mc.buildStatusJson({ motd: 'x' }));
  assert.equal(Object.hasOwn(parsed, 'favicon'), false);
});

test('延迟探测：8 字节 payload 原样回传', () => {
  const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
  const packet = mc.pongPacket(payload);
  const len = mc.readVarInt(packet, 0);
  assert.equal(packet[len.size], 0x01, 'pong 包 id 必须是 0x01');
  assert.deepEqual(packet.subarray(len.size + 1), payload, 'payload 必须逐字节一致，否则 MC 算不出延迟');
});

test('识别状态请求包', () => {
  assert.equal(mc.isStatusRequest(Buffer.from([0x01, 0x00])), true);
  assert.equal(mc.isStatusRequest(Buffer.from([0x01, 0x01])), false);
  assert.equal(mc.isStatusRequest(Buffer.from([0x01])), false);
});
