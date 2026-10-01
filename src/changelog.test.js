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
  /* 断言逻辑现在在 scripts/verify-build.js 里（原先在 PowerShell 内联块，
     含中文时 PS 5.1 按 ANSI 解码会挂），所以这里查脚本而不是查 workflow。 */
  const vb = fs.readFileSync(VB, 'utf8');
  assert.ok(vb.includes('缺少布局调试器'), 'PRE 断言缺失');
  assert.ok(vb.includes('混入了布局调试器'), '正式版断言缺失');
  assert.ok(vb.includes('index.html 没有引用布局调试器'), '缺 index.html 引用校验');
  /* 且 workflow 确实调用了它 */
  assert.ok(fs.readFileSync(WF, 'utf8').includes('scripts/verify-build.js'), 'CI 没调用校验脚本');
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

/* ---------- 产物校验脚本（取代了易挂的 PowerShell 内联块） ---------- */

const VB = path.join(ROOT, 'scripts', 'verify-build.js');

test('产物校验用 Node 脚本，不用 PowerShell 内联块', () => {
  const yml = fs.readFileSync(WF, 'utf8');
  const i = yml.indexOf('- name: Verify client build');
  const j = yml.indexOf('- name: Assemble payload');
  assert.ok(i > 0 && j > i, '找不到 Verify 步骤');
  const block = yml.slice(i, j);
  assert.ok(block.includes('scripts/verify-build.js'), 'Verify 没调用 verify-build.js');
  assert.equal(block.includes('shell: powershell'), false,
    'Verify 仍用 PowerShell —— 含中文时 PS 5.1 按 ANSI 解码会挂，且本地无法验证');
});

test('产物校验脚本：PRE 有调试器则通过，缺了则失败', () => {
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vb-'));
  const R = path.join(tmp, 'resources');
  fs.mkdirSync(path.join(R, 'app', 'renderer'), { recursive: true });
  fs.mkdirSync(path.join(R, 'app', 'src'), { recursive: true });
  fs.mkdirSync(path.join(R, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'blfp-client'), '');
  for (const f of ['main.js']) fs.writeFileSync(path.join(R, 'app', f), '');
  for (const f of ['index.html', 'app.js', 'style.css']) fs.writeFileSync(path.join(R, 'app', 'renderer', f), '');
  fs.writeFileSync(path.join(R, 'app', 'src', 'easytier-manager.js'), '');
  for (const f of ['easytier-core.exe', 'easytier-cli.exe', 'frpc.exe', 'wintun.dll']) {
    fs.writeFileSync(path.join(R, 'bin', f), '');
  }

  const run = (ver) => {
    try {
      execFileSync('node', [VB, tmp, ver, '--platform', 'linux'], { stdio: 'pipe' });
      return 0;
    } catch (e) { return e.status || 1; }
  };

  /* 还没放调试器：PRE 应失败 */
  assert.equal(run('2.3.6-pre'), 1, 'PRE 缺调试器却没报错');

  /* 放上 6 个调试器文件 + index.html 引用 */
  const tunerNames = ['layout-tuner.js', 'layout-tuner.css', 'layout-tuner-shared.js',
    'layout-tuner-window.html', 'layout-tuner-window.css', 'layout-tuner-window.js'];
  tunerNames.forEach((f) => fs.writeFileSync(path.join(R, 'app', 'renderer', f), ''));
  fs.writeFileSync(path.join(R, 'app', 'renderer', 'index.html'), '<script src="layout-tuner.js"></script>');

  assert.equal(run('2.3.6-pre'), 0, 'PRE 有调试器却报错');
  /* 同一个产物当正式版跑：应失败（混入调试器） */
  assert.equal(run('2.3.6'), 1, '正式版混入调试器却没报错');
});

test('产物校验脚本：目录不存在时明确失败', () => {
  const { execFileSync } = require('child_process');
  const r = (() => {
    try { execFileSync('node', [VB, '/tmp/definitely-not-here-xyz', '2.3.6-pre'], { stdio: 'pipe' }); return 0; }
    catch (e) { return e.status || 1; }
  })();
  assert.equal(r, 1, '目录不存在却没报错');
});

/* ---------- 版本号一致性（三套 package.json 必须同步） ---------- */

const PKG_FILES = ['package.json', 'installer/package.json', 'uninstaller/package.json'];

test('三套 package.json 的版本号必须一致', () => {
  const versions = PKG_FILES.map((f) => ({
    f, v: JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')).version,
  }));
  const uniq = [...new Set(versions.map((x) => x.v))];
  assert.equal(uniq.length, 1,
    '版本号不一致：' + versions.map((x) => x.f + '=' + x.v).join('、')
    + '（发布流程用 tag 名找 installer/uninstaller 的产物，不一致就会构建失败）');
});

test('三套 package-lock.json 的版本也必须同步（否则 npm ci 装出来的版本号是旧的）', () => {
  /* 这一条是补的：以前只查 package.json，结果手改版本号时三套 package-lock.json
     留在旧版本上、测试照样全绿，直到打 tag 才发现产物目录名对不上。
     同一个事实写在六个地方，就必须六处都查。 */
  const lockFiles = ['package-lock.json', 'installer/package-lock.json', 'uninstaller/package-lock.json'];
  const want = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  for (const f of lockFiles) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) continue;
    const j = JSON.parse(fs.readFileSync(full, 'utf8'));
    assert.equal(j.version, want,
      f + ' 的 version 是 ' + j.version + '，应为 ' + want
      + '（请用 node scripts/bump-version.js <版本号> 统一改，别手改）');
    if (j.packages && j.packages['']) {
      assert.equal(j.packages[''].version, want,
        f + ' 的 packages[""].version 是 ' + j.packages[''].version + '，应为 ' + want);
    }
  }
});

test('三套 package.json 的输出目录都不写死版本号', () => {
  for (const f of PKG_FILES) {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    const out = j.build && j.build.directories && j.build.directories.output;
    assert.ok(out, f + ' 缺 build.directories.output');
    assert.equal(/\d+\.\d+\.\d+/.test(out), false,
      f + ' 的 output 写死了版本号（' + out + '），应用 ${version} 宏');
    assert.ok(out.includes('${version}'), f + ' 的 output 应用 ${version} 宏，实际：' + out);
  }
});

test('installer 产物名与 workflow 的下载路径一致', () => {
  const inst = JSON.parse(fs.readFileSync(path.join(ROOT, 'installer/package.json'), 'utf8'));
  const ver = inst.version;
  /* installer 用 ${version} 生成 BLFP-Setup-v<版本>.exe，展开后应是这个名字 */
  const name = inst.build.win.artifactName.replace('${version}', ver);
  assert.equal(name, 'BLFP-Setup-v' + ver + '.exe', '产物名不对：' + name);

  /* workflow 的 upload 路径必须能拼出同一个文件 */
  const yml = fs.readFileSync(WF, 'utf8');
  assert.ok(yml.includes('installer/out_v${{ steps.ver.outputs.v }}-final/BLFP-Setup-v${{ steps.ver.outputs.v }}.exe'),
    'workflow 的 Upload 路径与 installer 的实际输出不一致');
  /* 输出目录必须就是 out_v${version}-final，否则上面的路径找不到文件 */
  assert.equal(inst.build.directories.output, 'out_v${version}-final',
    'installer 输出目录应为 out_v${version}-final，实际：' + inst.build.directories.output);
});

test('uninstaller 产物路径与 workflow 的 Assemble 一致', () => {
  const un = JSON.parse(fs.readFileSync(path.join(ROOT, 'uninstaller/package.json'), 'utf8'));
  assert.equal(un.build.directories.output, 'out_v${version}',
    'uninstaller 输出目录应为 out_v${version}，实际：' + un.build.directories.output);
  const yml = fs.readFileSync(WF, 'utf8');
  /* workflow 里是：(Join-Path "uninstaller" "out_v$ver") */
  assert.ok(yml.includes('"uninstaller" "out_v$ver"'),
    'workflow 的 Assemble 没按 out_v$ver 找卸载器');
  assert.equal(un.build.win.artifactName, 'BLFP-Uninstall.exe',
    '卸载器产物名变了，workflow 找的是 BLFP-Uninstall.exe');
});

/* ---------- 更新日志需要完整 git 历史 ---------- */

test('checkout 必须拉全历史，否则算不出更新日志区间', () => {
  const yml = fs.readFileSync(WF, 'utf8');
  const i = yml.indexOf('actions/checkout@');
  assert.ok(i > 0, '找不到 checkout 步骤');
  const block = yml.slice(i, i + 300);
  /* CI 默认 fetch-depth: 1（浅克隆），此时连 HEAD 的父提交都不存在，
     git describe <tag>^ 直接 fatal，区间算空，发布失败（真踩过）。
     更新日志要遍历历史，所以必须 fetch-depth: 0。 */
  assert.ok(/fetch-depth:\s*0/.test(block),
    'checkout 缺 fetch-depth: 0 —— 浅克隆下生成更新日志会失败');
  assert.ok(/fetch-tags:\s*true/.test(block),
    'checkout 缺 fetch-tags: true —— 看不到旧 tag 同样算不出区间');
});

test('浅克隆下 changelog 会明确指出病因', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'changelog.js'), 'utf8');
  assert.ok(src.includes('is-shallow-repository'), '没有检测浅克隆');
  assert.ok(src.includes('fetch-depth: 0'), '报错里没有给出解决办法');
});
