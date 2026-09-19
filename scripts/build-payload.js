/**
 * 本地组装安装包数据：build_v<版本>/win-unpacked  ->  installer/payload/payload.zip
 * 同时把卸载程序复制为 installer/payload/BLFP-Uninstaller.exe
 * CI 里由 workflow 用 PowerShell 完成同样的事，本地用这个脚本。
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'installer', 'payload');
const zipPath = path.join(outDir, 'payload.zip');

/* 找到 electron-builder 的输出目录 build_v<版本>/win-unpacked */
const candidates = fs.readdirSync(root)
  .filter((n) => n.startsWith('build_v'))
  .map((n) => path.join(root, n, 'win-unpacked'))
  .filter((p) => fs.existsSync(p));
if (!candidates.length) {
  console.error('未找到 build_v*/win-unpacked，请先在仓库根目录执行: npm run dist');
  process.exit(1);
}
const clientOut = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
console.log('客户端构建目录:', clientOut);

/* adm-zip 来自 installer 的依赖 */
let AdmZip;
try {
  AdmZip = require(path.join(root, 'installer', 'node_modules', 'adm-zip'));
} catch (e) {
  try { AdmZip = require('adm-zip'); } catch (e2) {
    console.error('缺少 adm-zip 依赖，请先执行: cd installer && npm ci');
    process.exit(1);
  }
}

fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

const zip = new AdmZip();
function addDir(dir, base) {
  fs.readdirSync(dir).forEach((name) => {
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) addDir(full, rel);
    else zip.addFile(rel, fs.readFileSync(full));
  });
}
addDir(clientOut, '');
zip.writeZip(zipPath);
const mb = fs.statSync(zipPath).size / 1048576;
console.log('已生成 ' + zipPath + '（' + mb.toFixed(1) + ' MB）');
if (mb < 80) { console.error('体积异常，客户端构建可能不完整'); process.exit(1); }

/* 卸载程序 */
const uninstaller = path.join(root, 'uninstaller', 'out_v' + pkg.version, 'BLFP-Uninstall.exe');
if (fs.existsSync(uninstaller)) {
  fs.copyFileSync(uninstaller, path.join(outDir, 'BLFP-Uninstaller.exe'));
  console.log('已复制卸载程序 BLFP-Uninstaller.exe');
} else {
  console.warn('未找到卸载程序（' + uninstaller + '），安装包将不含卸载器');
}
