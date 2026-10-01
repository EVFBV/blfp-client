/**
 * 打包前处理：布局调试器（layout-tuner）的取舍。
 *
 * 规则：PRE 版本（版本号含 '-'，如 2.3.5-pre）必须带调试器；正式版本必须不带。
 *
 * 为什么需要这个脚本：
 *   CI（release.yml 的 "Strip dev-only files" 步骤）会无条件删除 renderer/layout-tuner.*，
 *   于是连 -pre 的预发布包也被剥掉了调试器，和「PRE 都带调试器」的规则冲突。
 *   本脚本在 electron-builder 之前执行，按版本号恢复或剔除调试器，
 *   使本地打包与 CI 打包行为一致，且不依赖对 CI workflow 文件的改动。
 *
 * 恢复来源是 git（HEAD），不额外维护第二份副本，避免两份调试器代码漂移。
 * 本地用法：npm run dist（已挂在本脚本后）会按当前 package.json 版本自动处理。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '');
const isPre = version.includes('-');

const TUNER_FILES = [
  'renderer/layout-tuner.js',
  'renderer/layout-tuner.css',
  /* 独立窗口版新增：共享定义 + 调试器窗口自己的 html/css/js。
     漏掉任何一个都会让 PRE 包里的调试器打不开（窗口白屏或属性列表为空），
     所以必须一并纳入"恢复/剔除 + 校验"。 */
  'renderer/layout-tuner-shared.js',
  'renderer/layout-tuner-window.html',
  'renderer/layout-tuner-window.css',
  'renderer/layout-tuner-window.js',
];
const INDEX_REL = 'renderer/index.html';
const TUNER_TAGS = [
  '<!-- layout-tuner: 仅开发调试用，正式发布版由构建脚本剔除，见 scripts/prepare-release.js -->',
  '<link rel="stylesheet" href="layout-tuner.css">',
  '<script src="layout-tuner-shared.js"></script>',
  '<script src="layout-tuner.js"></script>',
];

function log(msg) {
  console.log('[prepare-release] ' + msg);
}

/* 从 git HEAD 取回文件内容（CI 的 Strip 步骤只删工作区，git 里还有） */
function restoreFromGit(rel) {
  const content = execFileSync('git', ['show', 'HEAD:' + rel], { cwd: root, encoding: 'buffer' });
  fs.writeFileSync(path.join(root, rel), content);
}

function indexHasTuner() {
  const html = fs.readFileSync(path.join(root, INDEX_REL), 'utf8');
  return html.includes('layout-tuner');
}

function addTunerTags() {
  const file = path.join(root, INDEX_REL);
  const html = fs.readFileSync(file, 'utf8');
  if (html.includes('layout-tuner')) return false;
  const idx = html.lastIndexOf('</body>');
  const block = '  ' + TUNER_TAGS.join('\n  ') + '\n';
  fs.writeFileSync(file, idx === -1 ? html + '\n' + block : html.slice(0, idx) + block + html.slice(idx));
  return true;
}

function stripTunerTags() {
  const file = path.join(root, INDEX_REL);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const kept = lines.filter((line) => !line.includes('layout-tuner'));
  if (kept.length !== lines.length) fs.writeFileSync(file, kept.join('\n'));
  return kept.length !== lines.length;
}

function restoreTuner() {
  /* 1) 文件被 CI 删掉的话从 git 取回；本地已存在则不动 */
  for (const rel of TUNER_FILES) {
    if (fs.existsSync(path.join(root, rel))) continue;
    try {
      restoreFromGit(rel);
      log('已从 git 恢复 ' + rel);
    } catch (e) {
      log('恢复 ' + rel + ' 失败：' + ((e && e.message) || e));
    }
  }
  /* 2) 确保 index.html 引用了调试器 */
  if (addTunerTags()) log('已在 ' + INDEX_REL + ' 重新插入调试器引用');
}

function stripTuner() {
  let removed = false;
  for (const rel of TUNER_FILES) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      removed = true;
      log('已剔除 ' + rel);
    }
  }
  if (stripTunerTags()) removed = true;
  if (!removed) log('调试器本就不存在，无需剔除');
}

function verify() {
  const missing = TUNER_FILES.filter((rel) => !fs.existsSync(path.join(root, rel)));
  if (isPre) {
    /* PRE 版必须带调试器：宁可构建失败，也不要悄悄发布一个缺调试器的测试包 */
    if (missing.length || !indexHasTuner()) {
      console.error('[prepare-release] 错误：PRE 版本 ' + version + ' 必须包含布局调试器，但 ' +
        (missing.length ? '缺少 ' + missing.join('、') : 'index.html 未引用调试器'));
      process.exit(1);
    }
    log('PRE 版本 ' + version + '：已确认包含布局调试器');
  } else {
    if (missing.length !== TUNER_FILES.length || indexHasTuner()) {
      console.error('[prepare-release] 错误：正式版本 ' + version + ' 不能包含布局调试器，但仍有残留');
      process.exit(1);
    }
    log('正式版本 ' + version + '：已确认不含布局调试器');
  }
}

if (isPre) restoreTuner();
else stripTuner();
verify();
