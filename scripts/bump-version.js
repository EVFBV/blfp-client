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
 * 用法（**按语义升位**，别手写版本号）：
 *   node scripts/bump-version.js --patch           # 只修 bug → 升修订号
 *   node scripts/bump-version.js --minor           # 有新功能 → 升次版本
 *   node scripts/bump-version.js --major           # 有不兼容 → 升主版本
 *   node scripts/bump-version.js --patch --pre      # 上面任一个加 --pre = 出该版本的预发布
 *   node scripts/bump-version.js --pre-next         # 同一版本的第二个预发布（-pre → -pre.2）
 *   node scripts/bump-version.js --promote          # 预发布转正式版（号不变，只去掉 -pre）
 *   node scripts/bump-version.js 2.4.0              # 也可以直接给版本号（会校验单调递增）
 *
 * 规则实现只在 scripts/version-lib.js 一处，这里只负责写文件。
 * 做的事：
 *   1) 三处 package.json 的 version
 *   2) 三处 package-lock.json 的 version 与 packages[""].version
 *   3) installer / uninstaller 的 build.directories.output 改成 ${version} 宏形式，
 *      以后换版本号不用再手改目录名
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./version-lib');

const ROOT = path.resolve(__dirname, '..');

const PKGS = [
  { file: 'package.json', output: 'build_v${version}' },
  { file: 'installer/package.json', output: 'out_v${version}-final' },
  { file: 'uninstaller/package.json', output: 'out_v${version}' },
];

/* 已发布的 tag（版本号部分）。用于保证新号严格大于所有已发布的号。 */
function publishedTags() {
  try {
    return execFileSync('git', ['tag'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((t) => t.trim().replace(/^v/i, ''))
      .filter((t) => lib.VERSION_RE.test(t));
  } catch (e) {
    return [];
  }
}

function resolveVersion(argv) {
  const flags = argv.filter((a) => a.startsWith('--'));
  const explicit = argv.filter((a) => !a.startsWith('--'));
  const wantPre = flags.includes('--pre');
  const level = lib.LEVELS.find((l) => flags.includes('--' + l));

  if (flags.includes('--promote')) {
    const cur = require(path.join(ROOT, 'package.json')).version;
    const promoted = lib.promoteVersion(cur);
    if (!promoted) {
      console.error('当前版本 ' + cur + ' 不是预发布，无法转正式版。');
      process.exit(2);
    }
    return { version: promoted, why: '预发布转正式版（号不变：' + cur + ' → ' + promoted + '）' };
  }

  if (flags.includes('--pre-next')) {
    const cur = require(path.join(ROOT, 'package.json')).version;
    const nxt = lib.nextPreVersion(cur);
    if (!nxt) {
      console.error('当前版本 ' + cur + ' 不是预发布，请用 --minor --pre 起第一个预发布。');
      process.exit(2);
    }
    return { version: nxt, why: '同一版本的下一号预发布（' + cur + ' → ' + nxt + '）' };
  }

  if (level) {
    const cur = require(path.join(ROOT, 'package.json')).version;
    const nxt = lib.nextVersion(cur, level, { pre: wantPre });
    const names = { major: '主版本（有不兼容改动）', minor: '次版本（有新功能）', patch: '修订号（只修 bug）' };
    return { version: nxt, why: names[level] + (wantPre ? ' 的预发布' : ' 正式版') + '（' + cur + ' → ' + nxt + '）' };
  }

  if (explicit.length === 1) {
    return { version: explicit[0].trim(), why: '手动指定' };
  }

  console.error('用法: node scripts/bump-version.js --patch|--minor|--major [--pre]');
  console.error('      node scripts/bump-version.js --pre-next | --promote');
  console.error('      node scripts/bump-version.js <版本号>');
  console.error('按语义升位：有新功能用 --minor，只修 bug 用 --patch，不兼容用 --major。');
  process.exit(2);
  return null;
}

function main() {
  const picked = resolveVersion(process.argv.slice(2));
  if (!picked) return;
  const version = picked.version;
  if (!lib.VERSION_RE.test(version)) {
    console.error('版本号格式不对（应形如 2.3.6 或 2.3.6-pre）：' + version);
    process.exit(2);
  }

  /* 单调性守卫：新号必须大于所有已发布的 tag。
     这条拦的是"版本号回退"—— 用户装过 2.3.21-pre 之后，
     再发一个 2.3.20 他就永远收不到更新了。 */
  const tags = publishedTags();
  const behind = tags.filter((t) => lib.compareVersions(version, t) <= 0);
  if (behind.length) {
    console.error('版本号没有递增：' + version + ' 不大于已发布的 tag：' + behind.join('、'));
    console.error('已发布的 tag 永不重打（重打会让已装用户的版本号对不上）。请换一个更大的号。');
    process.exit(1);
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

  console.log('版本号已更新为 ' + version + '（' + picked.why + '）：');
  changed.forEach((c) => console.log('  - ' + c));
  console.log('');
  console.log('提醒：installer 的产物名是 BLFP-Setup-v' + version + '.exe，');
  console.log('      workflow 的 Upload 步骤按 tag 名拼这个路径，两者必须一致。');
  console.log('      预发布形态（含 "-"）会被 workflow 判为 pre-release，正式版才会进 /releases/latest。');
}

if (require.main === module) main();
module.exports = { PKGS, publishedTags };
