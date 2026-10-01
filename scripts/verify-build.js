/**
 * 校验打包产物是否完整、以及布局调试器的取舍是否正确。
 *
 * 为什么用 Node 而不是 PowerShell：
 *   workflow 原来是 PowerShell 内联脚本。往里面加中文提示后步骤开始失败 ——
 *   Windows PowerShell 5.1 读取无 BOM 的 .ps1 会按 ANSI 解码，UTF-8 的中文变成乱码，
 *   既可能把字符串解析搞坏，也读不出到底哪一步出错。Node 处理 UTF-8 没有这个问题，
 *   而且本地就能跑（容器里没有 PowerShell，之前只能靠猜，连错两轮）。
 *
 * 用法：
 *   node scripts/verify-build.js <unpacked 目录> <版本号>
 *   例：node scripts/verify-build.js build_v2.3.6-pre/win-unpacked 2.3.6-pre
 *
 * 退出码 0 = 通过；非 0 = 失败（并打印缺了什么）。
 */
const fs = require('fs');
const path = require('path');

/* 产物里必须存在的文件（相对 unpacked 根目录） */
/* 启动器名随平台变化，本地（Linux）也要能验证 */
const PLATFORM = (() => {
  const i = process.argv.indexOf('--platform');
  return i >= 0 ? String(process.argv[i + 1] || 'win32') : 'win32';
})();

const REQUIRED = [
  PLATFORM === 'linux' ? 'blfp-client' : 'BLFP.exe',
  path.join('resources', 'bin', 'easytier-core.exe'),
  path.join('resources', 'bin', 'easytier-cli.exe'),
  path.join('resources', 'bin', 'frpc.exe'),
  path.join('resources', 'bin', 'wintun.dll'),
  path.join('resources', 'app', 'main.js'),
  path.join('resources', 'app', 'renderer', 'index.html'),
  path.join('resources', 'app', 'renderer', 'app.js'),
  path.join('resources', 'app', 'renderer', 'style.css'),
  path.join('resources', 'app', 'src', 'easytier-manager.js'),
];

/* 布局调试器：PRE 必须有，正式版必须没有 */
const TUNER = [
  'layout-tuner.js',
  'layout-tuner.css',
  'layout-tuner-shared.js',
  'layout-tuner-window.html',
  'layout-tuner-window.css',
  'layout-tuner-window.js',
].map((f) => path.join('resources', 'app', 'renderer', f));

function main() {
  const root = process.argv[2];
  const version = String(process.argv[3] || '').trim();
  if (!root) { console.error('用法: node scripts/verify-build.js <unpacked 目录> <版本号>'); process.exit(2); }
  if (!version) { console.error('缺少版本号参数'); process.exit(2); }

  const problems = [];
  const rendererDir = path.join(root, 'resources', 'app', 'renderer');

  console.log('产物目录: ' + root);
  console.log('版本号  : ' + version);

  if (!fs.existsSync(root)) {
    console.error('✗ 产物目录不存在: ' + root);
    process.exit(1);
  }

  /* 1) 必需文件 */
  const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(root, f)));
  if (missing.length) {
    problems.push('缺少必需文件: ' + missing.join('、'));
  } else {
    console.log('✓ 必需文件齐全（' + REQUIRED.length + ' 项）');
  }

  /* 2) bin 体积（判断运行时是否被打进去，太小说明漏了） */
  const binDir = path.join(root, 'resources', 'bin');
  if (fs.existsSync(binDir)) {
    const sum = fs.readdirSync(binDir)
      .map((f) => { try { return fs.statSync(path.join(binDir, f)).size; } catch (e) { return 0; } })
      .reduce((a, b) => a + b, 0);
    console.log('  bin 总体积: ' + (sum / 1024 / 1024).toFixed(1) + ' MB');
  }

  /* 3) 布局调试器 */
  const present = TUNER.filter((f) => fs.existsSync(path.join(root, f)));
  const isPre = version.includes('-');
  if (isPre) {
    if (present.length !== TUNER.length) {
      const miss = TUNER.filter((f) => !fs.existsSync(path.join(root, f)));
      problems.push('PRE 版本 ' + version + ' 的产物缺少布局调试器: ' + miss.join('、'));
    } else {
      console.log('✓ PRE 版本包含布局调试器（' + TUNER.length + '/' + TUNER.length + '）');
    }
  } else {
    if (present.length) {
      problems.push('正式版本 ' + version + ' 的产物混入了布局调试器: ' + present.join('、'));
    } else {
      console.log('✓ 正式版本不含布局调试器');
    }
  }

  /* 4) index.html 的引用要与取舍一致（文件在但没引用 → 调试器打不开） */
  const indexPath = path.join(rendererDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    const html = fs.readFileSync(indexPath, 'utf8');
    const refs = (html.match(/layout-tuner/g) || []).length;
    if (isPre && refs === 0) {
      problems.push('PRE 版本的 index.html 没有引用布局调试器（文件在但打不开）');
    } else if (!isPre && refs > 0) {
      problems.push('正式版本的 index.html 仍有 ' + refs + ' 处布局调试器引用');
    } else {
      console.log('✓ index.html 引用数: ' + refs + '（与版本类型一致）');
    }
  } else {
    problems.push('找不到 index.html');
  }

  if (problems.length) {
    console.error('');
    console.error('✗ 校验失败：');
    problems.forEach((p) => console.error('   - ' + p));
    process.exit(1);
  }

  console.log('');
  console.log('注意：安装包体积检查在下一步单独做（这里不重复）。');
  console.log('OK - 产物校验通过');
}

if (require.main === module) main();
module.exports = { REQUIRED, TUNER, main };
