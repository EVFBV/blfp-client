/*
 * 更新日志生成器的测试。
 *
 * 用户要求："更新日志按照实际来，别用原来的" ——
 * 原先 release.yml 里硬编码了一段 v2.3.3 时期的说明，之后每次发版都原样贴出去，
 * 所以这里守住两件事：
 *   1) 日志内容必须来自真实提交；
 *   2) CI 必须用生成的日志，而不是硬编码的 body。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CL = require(path.join(ROOT, 'scripts', 'changelog.js'));
const WF = path.join(ROOT, '.github', 'workflows', 'release.yml');

test('能从真实提交生成更新日志', () => {
  const { from, to } = CL.autoRange();
  assert.ok(from, '没能算出上一个 tag，区间会是空的');
  const res = CL.build(from, to, { withBuild: true, sha: 'abc1234' });
  assert.ok(res.total > 0, '一条改动都没提取到');
  assert.ok(res.markdown.includes('BLFP v'), '标题不对');
  assert.ok(res.markdown.includes('abc1234'), '缺少构建 commit');
});

test('生成的日志里带测试版提示（避免正式用户误会）', () => {
  const { from, to } = CL.autoRange();
  const res = CL.build(from, to, {});
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (String(pkg.version).includes('-')) {
    assert.ok(res.markdown.includes('测试版'), 'PRE 版没标注测试版');
  } else {
    assert.ok(!res.markdown.includes('这是**测试版'), '正式版不该写测试版提示');
  }
});

test('区间算的是 HEAD 可达的 tag（分叉 tag 会导致空日志）', () => {
  const { from } = CL.autoRange();
  /* 用 git 验证这个 tag 确实可达，否则 log 区间会是空 */
  const { execFileSync } = require('child_process');
  const ok = (() => {
    try { execFileSync('git', ['merge-base', '--is-ancestor', from, 'HEAD'], { cwd: ROOT }); return true; }
    catch (e) { return false; }
  })();
  assert.ok(ok, from + ' 不是 HEAD 的祖先，区间会算空');
});

test('提交标题会去掉 conventional 前缀，读起来像人话', () => {
  assert.equal(CL.cleanSubject('fix(captcha): 极验 3.0 的 product 改为 float'), '极验 3.0 的 product 改为 float');
  assert.equal(CL.cleanSubject('feat(tuner): 布局调试器改为独立窗口'), '布局调试器改为独立窗口');
  assert.equal(CL.cleanSubject('docs: 更新说明'), '更新说明');
});

test('备份/合并/纯版本号提交不进更新日志', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'changelog.js'), 'utf8');
  assert.ok(src.includes('backup:'), '没有过滤备份提交');
  assert.ok(src.includes('Merge '), '没有过滤合并提交');
});

test('补充说明不会把标题重复贴一遍', () => {
  const { from, to } = CL.autoRange();
  const md = CL.build(from, to, {}).markdown;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const a = lines[i], b = lines[i + 1];
    if (!a.startsWith('- ') || !b.startsWith('  - ')) continue;
    const norm = (x) => x.replace(/^[-\s]+/, '').replace(/^(feat|fix|perf|style|docs|refactor|chore|build|ci|test)(\([^)]*\))?!?:\s*/i, '').trim();
    assert.notEqual(norm(a), norm(b), '第 ' + (i + 1) + ' 行标题与补充说明重复：' + a);
  }
});

test('CI 用生成的更新日志，不再硬编码发布说明', () => {
  const yml = fs.readFileSync(WF, 'utf8');
  assert.ok(yml.includes('body_path: CHANGELOG_RELEASE.md'), '没有改用 body_path');
  assert.ok(yml.includes('scripts/changelog.js'), 'CI 没调用 changelog.js');
  /* 硬编码的老说明必须消失 */
  assert.equal(yml.includes('设置页新增「更新渠道」：正式版只拉取最新正式版本'), false,
    '旧的硬编码更新日志还在');
  assert.equal(/^\s+body: \|/m.test(yml), false, '还有内联硬编码的 body');
});

test('生成失败时拒绝发布，不静默发空日志', () => {
  const yml = fs.readFileSync(WF, 'utf8');
  assert.ok(yml.includes('发布说明为空，拒绝发布'), '缺少空日志拦截');
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'changelog.js'), 'utf8');
  assert.ok(src.includes('拒绝生成空日志'), '脚本本身没有空区间保护');
});

test('CI 里调试器的删除清单与校验清单都是 6 个文件', () => {
  const yml = fs.readFileSync(WF, 'utf8');
  const need = [
    'renderer/layout-tuner.js', 'renderer/layout-tuner.css', 'renderer/layout-tuner-shared.js',
    'renderer/layout-tuner-window.html', 'renderer/layout-tuner-window.css', 'renderer/layout-tuner-window.js',
  ];
  const missing = need.filter((f) => !yml.includes(f.replace(/\//g, '/')) && !yml.includes(f.replace(/\//g, '\\')));
  assert.deepEqual(missing, [], 'CI 清单里漏了：' + missing.join('、'));
});

test('CI 会在产物里断言 PRE 有调试器、正式版没有', () => {
  const yml = fs.readFileSync(WF, 'utf8');
  assert.ok(yml.includes('PRE 版本') && yml.includes('缺少布局调试器'), 'PRE 断言缺失');
  assert.ok(yml.includes('正式版本') && yml.includes('混入了布局调试器'), '正式版断言缺失');
});

/* ---------- 打包输出目录：工作流与 package.json 必须一致 ---------- */

test('package.json 的输出目录跟随版本号，不写死', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = pkg.build && pkg.build.directories && pkg.build.directories.output;
  assert.ok(out, '缺少 build.directories.output');
  /* 曾经写死成 build_v2.3.5-pre，与工作流的 build_v$ver 靠"碰巧同名"才对上，
     换版本号就构建失败。这里禁止再出现硬编码的版本号。 */
  assert.equal(/\d+\.\d+\.\d+/.test(out), false,
    '输出目录里写死了版本号（' + out + '），应为 build_v${version}');
  /* 必须是 electron-builder 的 ${version} 宏，或完全不含版本占位 */
  assert.ok(out.includes('${version}'), '输出目录应使用 ${version} 宏，实际：' + out);
});

test('工作流的目录名规则与 package.json 一致', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const out = pkg.build.directories.output;
  const yml = fs.readFileSync(WF, 'utf8');

  /* package.json 用 build_v${version} → 展开后就是 build_v<版本号>，
     工作流用 "build_v$ver"（$ver 来自 tag 名）。两者必须等价。 */
  const expected = out.replace('${version}', '\\d+\\.\\d+\\.\\d+[^"]*');
  assert.ok(/^build_v/.test(out), '输出目录前缀变了，工作流会找不到产物：' + out);
  assert.ok(yml.includes('"build_v$ver"'),
    '工作流没使用 build_v$ver，与 package.json 的 ' + out + ' 不一致');

  /* 工作流里不能再用 node 解析 package.json 的模板串：
     PowerShell 会把双引号里的 ${version} 当变量展开成空串，导致目录名是垃圾。 */
  assert.equal(/node\s+-(p|e)\s+"[^"]*\$\{/.test(yml), false,
    '工作流里在 PowerShell 字符串中出现了 ${...}，会被 PowerShell 展开成空串');
  assert.equal(yml.includes('$outDir'), false, '还有残留的 $outDir 变量');
});
