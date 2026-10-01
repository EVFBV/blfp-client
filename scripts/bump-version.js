/**
 * 统一更新版本号。
 *
 * 为什么需要这个脚本：
 *   客户端有**三套** package.json（主程序 / installer / uninstaller），
 *   发布流程用 tag 名当版本号，但 installer/uninstaller 的 electron-builder
 *   输出目录名（out_v<版本>）与产物文件名都来自它们自己的 version 字段。
 *   只改主 package.json 会出现：CI 的 Assemble 步骤按 tag 找
 *   uninstaller/out_v2.3.6-pre/BLFP-Uninstall.exe，而 uninstaller 实际输出在
 *   out_v2.3.5-pre/ → 构建失败（真踩过，v2.3.6-pre 的第四次失败就是这个）。
 *
 * 用法：
 *   node scripts/bump-version.js 2.3.6-pre
 *   node scripts/bump-version.js 2.3.6        # 正式版
 *
 * 做的事：
 *   1) 三处 package.json 的 version
 *   2) 三处 package-lock.json 的 version 与 packages[""].version
 *   3) installer / uninstaller 的 build.directories.output 改成 ${version} 宏形式，
 *      以后换版本号不用再手改目录名
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const PKGS = [
  { file: 'package.json', output: 'build_v${version}' },
  { file: 'installer/package.json', output: 'out_v${version}-final' },
  { file: 'uninstaller/package.json', output: 'out_v${version}' },
];

function main() {
  const version = String(process.argv[2] || '').trim();
  if (!version) {
    console.error('用法: node scripts/bump-version.js <版本号>   例: 2.3.6-pre');
    process.exit(2);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    console.error('版本号格式不对（应形如 2.3.6 或 2.3.6-pre）：' + version);
    process.exit(2);
  }

  const changed = [];

  /* 1) 三处 package.json */
  for (const spec of PKGS) {
    const p = path.join(ROOT, spec.file);
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const before = j.version;
    j.version = version;
    j.build = j.build || {};
    j.build.directories = j.build.directories || {};
    const outBefore = j.build.directories.output;
    j.build.directories.output = spec.output;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
    changed.push(spec.file + ': ' + before + ' → ' + version
      + '（output: ' + outBefore + ' → ' + spec.output + '）');
  }

  /* 2) 三处 package-lock.json（只改顶层 version，依赖树不动） */
  for (const spec of PKGS) {
    const lockRel = spec.file.replace(/package\.json$/, 'package-lock.json');
    const p = path.join(ROOT, lockRel);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    const before = j.version;
    let touched = false;
    if (j.version) { j.version = version; touched = true; }
    if (j.packages && j.packages[''] && j.packages[''].version) {
      j.packages[''].version = version;
      touched = true;
    }
    if (touched) {
      fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
      changed.push(lockRel + ': ' + before + ' → ' + version);
    }
  }

  console.log('版本号已更新为 ' + version + '：');
  changed.forEach((c) => console.log('  - ' + c));
  console.log('');
  console.log('提醒：installer 的产物名是 BLFP-Setup-v' + version + '.exe，');
  console.log('      workflow 的 Upload 步骤按 tag 名拼这个路径，两者必须一致。');
}

if (require.main === module) main();
module.exports = { PKGS };
