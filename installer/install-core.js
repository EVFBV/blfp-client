/*
 * 安装核心逻辑（纯逻辑，不依赖 electron）。
 *
 * 单独抽出来的目的：这里是最容易出错、也最值得测的部分（隐藏触发参数解析、
 * "跳过未变化文件"的判定、CRC32）。抽成纯模块后可以在 Linux/CI 上直接跑测试，
 * 不必真去 Windows 上装一遍才知道对不对。
 *
 * 安装器 main.js 和客户端的自更新都用到它。
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * 隐藏的静默触发接口
 *
 * 客户端下载完更新后会带着这个参数把安装器拉起来，此时安装器：
 *   - 不创建任何窗口（完全后台，像无头浏览器）
 *   - 直接秒关客户端 → 秒装 → 需要的话把客户端拉起来 → 立刻退出
 * 这个参数不在界面上暴露，属于内部约定。
 * ------------------------------------------------------------------ */
const SILENT_FLAG = '--blfp-silent-update';
/* 兼容旧写法 */
const SILENT_ALIASES = [SILENT_FLAG, '--blfp-silent-install'];

/**
 * 解析命令行参数。必须能在 app ready 之前就调用（静默模式下根本不该创建窗口，
 * 所以判断要在创建窗口之前完成）。
 * @param {string[]} argv
 * @returns {{silent:boolean,target:string,relaunch:boolean,shortcuts:boolean,statusFile:string}}
 */
function parseSilentArgs(argv) {
  const out = { silent: false, target: '', relaunch: false, shortcuts: true, statusFile: '' };
  const list = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < list.length; i++) {
    const arg = String(list[i] == null ? '' : list[i]);
    const lower = arg.toLowerCase();
    if (SILENT_ALIASES.indexOf(lower) !== -1) { out.silent = true; continue; }
    /* 支持 --target=X 与 --target X 两种写法 */
    const eq = arg.indexOf('=');
    const key = (eq === -1 ? arg : arg.slice(0, eq)).toLowerCase();
    const inlineValue = eq === -1 ? null : arg.slice(eq + 1);
    const take = () => (inlineValue === null ? String(list[++i] == null ? '' : list[i]) : inlineValue);
    if (key === '--target' || key === '--dir' || key === '--installdir') { out.target = take(); continue; }
    if (key === '--status-file') { out.statusFile = take(); continue; }
    if (key === '--relaunch') { out.relaunch = inlineValue === null ? true : inlineValue !== '0'; continue; }
    if (key === '--no-shortcuts') { out.shortcuts = false; continue; }
  }
  /* 静默模式下不接受相对路径/空路径：写错目录比装失败更危险 */
  if (out.target) out.target = path.resolve(out.target);
  return out;
}

/* ------------------------------------------------------------------ *
 * CRC32：用来判断磁盘上的文件是否和压缩包里那条完全一致
 *
 * 为什么非要比 CRC 而不是只比大小：
 *   只比大小时，两个内容不同但长度相同的文件会被误判成"没变"而跳过，
 *   装完就是坏的 —— 这种 bug 极难排查。zip 头里本来就带 CRC32，
 *   不需要解压就能拿到，所以直接比 CRC 既准确又便宜。
 * ------------------------------------------------------------------ */
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  CRC_TABLE = table;
  return table;
}

/** 计算 Buffer 的 CRC32，返回无符号 32 位整数 */
function crc32(buf) {
  const table = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 流式计算文件 CRC32（分块读，不把整个文件读进内存） */
function crc32File(filePath, chunkSize) {
  const size = chunkSize || 1 << 20;
  return new Promise((resolve, reject) => {
    let c = 0xffffffff;
    const table = crcTable();
    const stream = fs.createReadStream(filePath, { highWaterMark: size });
    stream.on('data', (chunk) => {
      for (let i = 0; i < chunk.length; i++) c = table[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
    });
    stream.on('error', reject);
    stream.on('end', () => resolve((c ^ 0xffffffff) >>> 0));
  });
}

/** zip 头里的 CRC 有时是有符号的，统一转成无符号再比 */
function normalizeCrc(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n >>> 0;
}

/* ------------------------------------------------------------------ *
 * 安装计划：哪些要写、哪些可以跳过
 * ------------------------------------------------------------------ */

/**
 * 判断某一条能不能直接跳过（磁盘上已经是同一个文件）。
 * @param {{size:number,crc32:number}} entry 压缩包条目（只需 header 信息，无需解压）
 * @param {{isFile:function():boolean,size:number}|null} diskStat
 * @param {number|null} diskCrc 磁盘文件的 CRC32
 */
function canSkipEntry(entry, diskStat, diskCrc) {
  if (!entry || !diskStat) return false;
  if (typeof diskStat.isFile === 'function' && !diskStat.isFile()) return false;
  if (typeof entry.size !== 'number' || entry.size !== diskStat.size) return false;
  const zipCrc = normalizeCrc(entry.crc32);
  const localCrc = normalizeCrc(diskCrc);
  /* 拿不到 CRC 就不敢跳：宁可多写一次，也不能漏更新 */
  if (zipCrc === null || localCrc === null) return false;
  return zipCrc === localCrc;
}

/**
 * 生成安装计划。
 * @param {Array<{entryName:string,isDirectory:boolean,size:number,crc32:number}>} entries
 * @param {string} targetDir
 * @param {{safeOutputPath:function(string):string, statSync:function, crc32File:function}} io
 * @returns {Promise<{items:Array,total:number,toWrite:number,skipped:number,bytesToWrite:number}>}
 */
async function planInstall(entries, targetDir, io) {
  const items = [];
  let toWrite = 0;
  let skipped = 0;
  let bytesToWrite = 0;
  for (const entry of entries) {
    const outPath = io.safeOutputPath(entry.entryName);
    if (entry.isDirectory) {
      items.push({ entry, outPath, action: 'mkdir' });
      continue;
    }
    let diskStat = null;
    try { diskStat = io.statSync(outPath); } catch (e) { diskStat = null; }
    let diskCrc = null;
    if (diskStat && typeof entry.size === 'number' && entry.size === diskStat.size) {
      try { diskCrc = await io.crc32File(outPath); } catch (e) { diskCrc = null; }
    }
    if (canSkipEntry(entry, diskStat, diskCrc)) {
      skipped++;
      items.push({ entry, outPath, action: 'skip' });
    } else {
      toWrite++;
      if (typeof entry.size === 'number') bytesToWrite += entry.size;
      items.push({ entry, outPath, action: 'write' });
    }
  }
  return { items, total: entries.length, toWrite, skipped, bytesToWrite };
}

/* ------------------------------------------------------------------ *
 * 关客户端：必须"秒关"
 *
 * 旧实现是 先优雅等 5 秒 → 提权弹 cmd + UAC → 再最多等 120 秒，
 * 用户看到的就是"关客户端时间太长了"。
 * 现在安装器本身就以管理员权限运行，直接强杀即可，不需要提权、不需要弹窗。
 * ------------------------------------------------------------------ */
const CLIENT_IMAGES = ['BLFP.exe', 'easytier-core.exe', 'frpc.exe'];

/** 计算强杀命令（纯函数，便于测试） */
function killCommands(images) {
  const list = Array.isArray(images) && images.length ? images : CLIENT_IMAGES;
  return list.map((image) => ({ file: 'taskkill.exe', args: ['/F', '/IM', image, '/T'] }));
}

/**
 * 等待文件解锁。轮询间隔从 500ms 降到 100ms —— 客户端被强杀后句柄通常
 * 几十毫秒内就释放了，500ms 一次会白等好几个周期。
 */
async function waitUnlocked(filePath, opts) {
  const o = opts || {};
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 15000;
  const intervalMs = typeof o.intervalMs === 'number' ? o.intervalMs : 100;
  const isUnlocked = o.isUnlocked;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = Date.now();
  for (;;) {
    if (isUnlocked(filePath)) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

module.exports = {
  SILENT_FLAG,
  SILENT_ALIASES,
  CLIENT_IMAGES,
  parseSilentArgs,
  crc32,
  crc32File,
  normalizeCrc,
  canSkipEntry,
  planInstall,
  killCommands,
  waitUnlocked,
};
