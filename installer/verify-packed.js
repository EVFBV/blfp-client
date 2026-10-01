/*
 * 校验**打包结果**里真的带着隐藏触发接口。
 *
 * 为什么需要这个：electron-builder 的 files 列表漏掉一个文件时，
 * 本地 `npm test` 全绿、CI 的体积检查也照过（exe 还是 250MB），
 * 但用户那句"点更新没反应"就来了 —— 而且是运行时才炸，我们看不到现场。
 * 所以直接翻开打好的 app.asar 看内容。
 *
 * asar 的格式是「JSON 头 + 原样拼接的文件内容」，没有压缩，
 * 所以对整块内容做字符串包含判断是可靠的。
 *
 * 用法：node verify-packed.js [asar路径或它所在目录]
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* 这些字符串必须真的出现在打包产物里 —— 每一个都对应一个用户可见的行为 */
const MUST_CONTAIN = [
  ['--blfp-silent-update', '隐藏的静默安装触发参数'],
  ['--blfp-silent-install', '隐藏参数的兼容别名'],
  ['parseSilentArgs', '静默参数解析（装不上说明 install-core.js 没打进包）'],
  ['planInstall', '跳过未变化文件（秒装的核心）'],
  ['crc32File', 'CRC32 比对（只比大小会把没变的文件误判成变了）'],
  ['runSilentInstall', '无头安装入口'],
  ['runInstall', '安装主流程'],
  ['taskkillViaUac', 'UAC 兜底（正常走不到，但必须有）'],
  ['launchAndExit', '启动客户端后立刻退出（秒退）'],
];

/* 这些是"反例"：出现就说明用户抱怨过的慢路径又回来了。
   注意必须用**调用形式**（带左括号）来判定 ——
   main.js 的注释里为了说明"旧实现慢在哪"仍然会提到这个函数名，
   按裸函数名判会误报，把注释改成散文就再也发不了版。

   这里**不检查** UAC 提权（Start-Process cmd.exe）：它是刻意保留的兜底，
   正常路径走不到。要保证它只是兜底、不在快路径上，
   由 silent-mode.test.js 里的顺序断言负责（快路径 4 秒超时必须排在它前面）。 */
const MUST_NOT_CONTAIN = [
  ['waitForProcess(', '等客户端进程起来（实测最慢要 45 秒，用户明确抱怨过）'],
];

function findAsar(target) {
  const resolved = path.resolve(target || '.');
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  /* 在 out_v*-final 这类目录里找 win-unpacked/resources/app.asar */
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === 'app.asar') candidates.push(full);
      else if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(resolved, 0);
  if (!candidates.length) return null;
  /* 有多个就取最大的（真正的那个 app.asar） */
  return candidates.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
}

function main() {
  const target = process.argv[2] || path.join(__dirname);
  const asarPath = findAsar(target);
  if (!asarPath) {
    console.error(`✗ 找不到 app.asar（在 ${path.resolve(target)} 下最多找 4 层）`);
    console.error('  安装器可能没有真正打包出 win-unpacked —— 体积检查是发现不了这种情况的。');
    process.exit(1);
  }

  const buf = fs.readFileSync(asarPath);
  const text = buf.toString('latin1'); /* 二进制安全：只做子串查找，不做解码 */
  console.log(`检查：${asarPath}（${(buf.length / 1048576).toFixed(1)} MB）`);

  const problems = [];
  for (const [needle, why] of MUST_CONTAIN) {
    if (text.includes(needle)) {
      console.log(`  ✓ ${needle} —— ${why}`);
    } else {
      console.log(`  ✗ ${needle} —— 缺失：${why}`);
      problems.push(`${needle}（${why}）`);
    }
  }
  for (const [needle, why] of MUST_NOT_CONTAIN) {
    if (text.includes(needle)) {
      console.log(`  ✗ ${needle} —— 不该出现：${why}`);
      problems.push(`${needle}（不该出现：${why}）`);
    } else {
      console.log(`  ✓ 不含 ${needle} —— ${why}`);
    }
  }

  if (problems.length) {
    console.error('');
    console.error('✗ 打包产物校验失败：');
    problems.forEach((p) => console.error('   - ' + p));
    process.exit(1);
  }
  console.log('');
  console.log('OK - 打包产物里确实带着隐藏触发接口与秒关秒装的实现');
}

if (require.main === module) main();
module.exports = { findAsar, MUST_CONTAIN, MUST_NOT_CONTAIN };
