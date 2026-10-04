/*
 * Minecraft Java 版「服务器列表探测」(Server List Ping) 的最小实现。
 *
 * 目的：房客在 MC 里直接连 FRP 地址时，服务器列表里显示的是**房主那个存档**的
 * MOTD 和默认图标 —— 看起来像"连错了"。BLFP 在房主侧挡一层，把探测包拦下来
 * 回一段 BLFP 自己的 MOTD + 图标，真正的游戏流量照常转发给 MC。
 *
 * 协议（跨版本稳定，多年没变）：
 *   握手包  = [长度][0x00][VarInt 协议版本][String 地址][UShort 端口][VarInt 下一状态]
 *   下一状态 = 1 状态查询 / 2 登录
 *   状态查询 = [长度][0x00]                 → 回 [长度][0x00][String JSON]
 *   延迟探测 = [长度][0x01][8 字节 payload] → 原样回 [长度][0x01][同样 8 字节]
 *
 * 这里只做纯函数（解析/构造），不碰 socket —— 这样能被真正跑起来测，
 * 而不是只断言字符串（HANDOFF 5.5 记过这个坑）。
 */

function readVarInt(buf, offset = 0) {
  let value = 0;
  let size = 0;
  let byte;
  do {
    if (offset + size >= buf.length) return null; /* 数据还不够，等更多 */
    byte = buf[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if (size > 5) return null; /* 非法 */
  } while (byte & 0x80);
  return { value: value >>> 0, size };
}

function writeVarInt(value) {
  let v = value >>> 0;
  const out = [];
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    out.push(temp);
  } while (v !== 0);
  return Buffer.from(out);
}

function readString(buf, offset) {
  const len = readVarInt(buf, offset);
  if (!len) return null;
  const start = offset + len.size;
  if (start + len.value > buf.length) return null;
  return { value: buf.toString('utf8', start, start + len.value), size: len.size + len.value };
}

function writeString(str) {
  const body = Buffer.from(str, 'utf8');
  return Buffer.concat([writeVarInt(body.length), body]);
}

/* 把一段 payload 包成 MC 数据包（前面加 VarInt 长度） */
function frame(payload) {
  return Buffer.concat([writeVarInt(payload.length), payload]);
}

/*
 * 解析握手包。返回 null 表示"数据不完整或不是握手包" ——
 * 调用方遇到 null 应当**放行透传**，绝不能因为解析不了就把人挡在门外。
 */
function parseHandshake(buf) {
  const packetLen = readVarInt(buf, 0);
  if (!packetLen) return null;
  if (buf.length < packetLen.size + packetLen.value) return null;
  let off = packetLen.size;
  const packetId = readVarInt(buf, off);
  if (!packetId || packetId.value !== 0x00) return null;
  off += packetId.size;
  const protocol = readVarInt(buf, off);
  if (!protocol) return null;
  off += protocol.size;
  const addr = readString(buf, off);
  if (!addr) return null;
  off += addr.size;
  if (off + 2 > buf.length) return null;
  const port = buf.readUInt16BE(off);
  off += 2;
  const nextState = readVarInt(buf, off);
  if (!nextState) return null;
  return {
    protocolVersion: protocol.value,
    serverAddress: addr.value,
    serverPort: port,
    nextState: nextState.value,
    bytesConsumed: packetLen.size + packetLen.value,
  };
}

/* 状态查询的响应体。favicon 必须是 data:image/png;base64,... 且图片为 64×64，
   否则 MC 会直接忽略图标。 */
function buildStatusJson({ motd, favicon, online = 1, max = 8, version = 'BLFP' }) {
  const body = {
    version: { name: version, protocol: 0 },
    players: { max, online, sample: [] },
    description: { text: motd },
  };
  if (favicon) body.favicon = favicon;
  return JSON.stringify(body);
}

function statusResponsePacket(json) {
  return frame(Buffer.concat([Buffer.from([0x00]), writeString(json)]));
}

/* 延迟探测：把收到的 8 字节原样回过去，MC 才算得出延迟 */
function pongPacket(payload) {
  return frame(Buffer.concat([Buffer.from([0x01]), payload]));
}

/* 状态请求包是 [长度=1][0x00]；用来判断"握手之后该回状态了" */
function isStatusRequest(buf) {
  return buf.length >= 2 && buf[0] === 0x01 && buf[1] === 0x00;
}

module.exports = {
  readVarInt, writeVarInt, readString, writeString, frame,
  parseHandshake, buildStatusJson, statusResponsePacket, pongPacket, isStatusRequest,
};
