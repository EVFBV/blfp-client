/**
 * 构建前检查 payload.zip 是否存在且完整。
 * 缺失时直接中止并给出解决办法——避免产出一个装不起来的安装包。
 */
const fs = require('fs');
const path = require('path');

const zipPath = path.join(__dirname, 'payload', 'payload.zip');
if (!fs.existsSync(zipPath)) {
  console.error('');
  console.error('[BLFP] 安装包数据缺失：installer/payload/payload.zip 不存在');
  console.error('');
  console.error('本地构建请按顺序执行（在仓库根目录）：');
  console.error('  1) npm run dist            生成 build_v<版本>/win-unpacked');
  console.error('  2) node scripts/build-payload.js   组装 installer/payload/payload.zip');
  console.error('  3) cd installer && npm run dist    再打安装包');
  console.error('');
  console.error('（CI 会自动完成 1、2 两步）');
  console.error('');
  process.exit(1);
}
const mb = fs.statSync(zipPath).size / 1048576;
if (mb < 80) {
  console.error('[BLFP] payload.zip 仅 ' + mb.toFixed(1) + ' MB，客户端构建可能不完整，已中止');
  process.exit(1);
}
console.log('[BLFP] payload.zip 就绪（' + mb.toFixed(1) + ' MB）');
