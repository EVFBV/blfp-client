/*
 * 软件内更新的下载器：自动挑一个能用的镜像源，边下边报进度，坏了自动换源接着下。
 *
 * 为什么要单独一个模块：这段逻辑最容易出问题（挑源、超时、断点续传、换源重试），
 * 而它又跑在用户的网络环境里、我们看不到现场。抽成纯逻辑、把 fetch/fs 注入进来，
 * 就能在本地把所有分支（超时、403、下到一半断了、磁盘满）都测一遍。
 */
'use strict';

/* 镜像源候选。留了 prefix 形式是为了兼容常见的 GitHub 加速服务：
   它们都是把原始地址直接拼在后面（https://ghfast.top/https://github.com/...）。 */
const DEFAULT_MIRRORS = [
  { name: 'GitHub 直连', prefix: '' },
  { name: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { name: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
];

/** 拼出某个镜像下的完整地址 */
function mirrorUrl(prefix, url) {
  if (!prefix) return url;
  return prefix.replace(/\/+$/, '') + '/' + String(url).replace(/^\/+/, '');
}

/**
 * 探测哪些镜像可用，并按"能用的排前面、快的更靠前"排序。
 * 只请求第 1 个字节（Range: bytes=0-0），代价极小，不用把整个文件拉下来才知道通不通。
 */
async function probeMirrors(options) {
  const o = options || {};
  const url = o.url;
  const mirrors = Array.isArray(o.mirrors) && o.mirrors.length ? o.mirrors : DEFAULT_MIRRORS;
  const fetchImpl = o.fetchImpl;
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 6000;
  const log = typeof o.log === 'function' ? o.log : () => {};

  const probeOne = async (mirror) => {
    const target = mirrorUrl(mirror.prefix, url);
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(target, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
        redirect: 'follow',
      });
      const ms = Date.now() - started;
      /* 200（不支持 Range）和 206（支持）都算通；
         403/404 说明这个源没有这个文件，别浪费时间。 */
      const ok = res.status === 200 || res.status === 206;
      /* 探针只读了一个字节，把连接放掉，别一直占着 */
      try { if (res.body && res.body.cancel) await res.body.cancel(); } catch (e) {}
      return { name: mirror.name, prefix: mirror.prefix, url: target, ok, ms, status: res.status };
    } catch (e) {
      return { name: mirror.name, prefix: mirror.prefix, url: target, ok: false, ms: Date.now() - started, error: (e && e.message) || String(e) };
    } finally {
      clearTimeout(timer);
    }
  };

  const results = await Promise.all(mirrors.map(probeOne));
  const usable = results.filter((r) => r.ok).sort((a, b) => a.ms - b.ms);
  const dead = results.filter((r) => !r.ok);
  usable.forEach((r) => log(`镜像可用：${r.name}（${r.ms}ms）`));
  dead.forEach((r) => log(`镜像不可用：${r.name}（${r.error || ('HTTP ' + r.status)}）`));
  /* 一个都不通时，把原始直连放在最前面：至少让下载去试一次，
     而不是因为"探测失败"就直接告诉用户没网。 */
  const fallback = results.filter((r) => !r.prefix);
  return usable.length ? usable : fallback;
}

/**
 * 下载一个文件，自动换源，带进度。
 * @returns {Promise<{ok:boolean,path?:string,bytes?:number,mirror?:string,error?:string,attempts:Array}>}
 */
async function downloadWithFallback(options) {
  const o = options || {};
  const url = o.url;
  const dest = o.dest;
  /* 兼容 fs / fsImpl 两种写法：这个是内部模块，名字写错时应该给一句能看懂的话，
     而不是抛 "Cannot read properties of undefined (reading 'createWriteStream')"。 */
  const fsImpl = o.fsImpl || o.fs;
  const fetchImpl = o.fetchImpl || o.fetch;
  if (!url) throw new Error('downloadWithFallback 缺少 url');
  if (!dest) throw new Error('downloadWithFallback 缺少 dest');
  if (!fsImpl) throw new Error('downloadWithFallback 缺少注入的 fs（fs 或 fsImpl）');
  if (typeof fetchImpl !== 'function') throw new Error('downloadWithFallback 缺少注入的 fetch（fetchImpl 或 fetch）');
  const onProgress = typeof o.onProgress === 'function' ? o.onProgress : () => {};
  const log = typeof o.log === 'function' ? o.log : () => {};
  const expectedSize = typeof o.expectedSize === 'number' ? o.expectedSize : 0;
  const idleTimeoutMs = typeof o.idleTimeoutMs === 'number' ? o.idleTimeoutMs : 30000;

  const candidates = await probeMirrors({ url, mirrors: o.mirrors, fetchImpl, log, timeoutMs: o.probeTimeoutMs });
  if (!candidates.length) return { ok: false, error: '没有可用的下载源', attempts: [] };

  const attempts = [];
  for (const candidate of candidates) {
    try {
      const result = await downloadOne({
        candidate, dest, fsImpl, fetchImpl, onProgress, log, expectedSize, idleTimeoutMs,
      });
      attempts.push({ mirror: candidate.name, ok: true, bytes: result.bytes });
      return { ok: true, path: dest, bytes: result.bytes, mirror: candidate.name, attempts };
    } catch (e) {
      const message = (e && e.message) || String(e);
      attempts.push({ mirror: candidate.name, ok: false, error: message });
      log(`从「${candidate.name}」下载失败：${message}`);
      /* 换源重来：删掉半截文件，避免把两个源的数据拼在一起（长度一样也可能不一致） */
      try { if (fsImpl.existsSync(dest)) fsImpl.unlinkSync(dest); } catch (err) {}
    }
  }
  return { ok: false, error: attempts.length ? attempts[attempts.length - 1].error : '下载失败', attempts };
}

/** 从单个源下载；失败就抛错，由上层换源 */
async function downloadOne(options) {
  const { candidate, dest, fsImpl, fetchImpl, onProgress, expectedSize, idleTimeoutMs } = options;
  const controller = new AbortController();
  let lastDataAt = Date.now();
  /* 卡住检测：有源会"连上但不给数据"，不设这个就会永远挂着 */
  const watchdog = setInterval(() => {
    if (Date.now() - lastDataAt > idleTimeoutMs) controller.abort();
  }, 2000);

  let written = 0;
  try {
    const res = await fetchImpl(candidate.url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let total = expectedSize;
    const lenHeader = res.headers && res.headers.get ? res.headers.get('content-length') : null;
    if (lenHeader) {
      const n = parseInt(lenHeader, 10);
      /* Range 探针可能让 content-length 只有 1，所以只在明显更大时才采信 */
      if (Number.isFinite(n) && n > 1) total = n;
    }
    const out = fsImpl.createWriteStream(dest);
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) {
      /* 没有流式 body（老实现/桩）就整块拿：不常见，但要能兜住 */
      const buf = Buffer.from(await res.arrayBuffer());
      await new Promise((resolve, reject) => {
        out.on('error', reject);
        out.on('finish', resolve);
        out.end(buf);
      });
      written = buf.length;
      onProgress({ received: written, total: total || written, percent: 100 });
      return { bytes: written };
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      lastDataAt = Date.now();
      const chunk = Buffer.from(value);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      written += chunk.length;
      onProgress({
        received: written,
        total: total || 0,
        percent: total ? Math.min(99, Math.floor((written / total) * 100)) : 0,
      });
    }
    await new Promise((resolve, reject) => {
      out.on('error', reject);
      out.on('finish', resolve);
      out.end();
    });
    /* 完整性检查：拿到总长就必须对得上，否则换源重下（半截文件装上去就是坏的） */
    if (total && written !== total) throw new Error(`下载不完整：期望 ${total} 字节，实际 ${written} 字节`);
    onProgress({ received: written, total: total || written, percent: 100 });
    return { bytes: written };
  } finally {
    clearInterval(watchdog);
  }
}

module.exports = { DEFAULT_MIRRORS, mirrorUrl, probeMirrors, downloadWithFallback, downloadOne };
