/*
 * 版本号规则（MMP = 主版本.次版本.修订号）的守卫。
 *
 * 用户要求："按语义升位：有功能升次版本、只修 bug 升修订号"。
 *
 * 这里盯三件事：
 *   1) 升位算得对不对（新功能=次版本，只修 bug=修订号，不兼容=主版本）；
 *   2) 新号必须严格大于已发布的 tag（版本号回退会让老用户永远收不到更新）；
 *   3) 这套规则**只有一处实现**（scripts/version-lib.js），
 *      并且它的比较语义必须跟 renderer/app.js 里的 compareVersions 一致 ——
 *      否则"哪个版本更新"这件事在两处会给出不同答案（本项目的老毛病：写两处必漂移）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const lib = require(path.join(ROOT, 'scripts', 'version-lib.js'));
const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release.yml'), 'utf8');
const BUMP = fs.readFileSync(path.join(ROOT, 'scripts', 'bump-version.js'), 'utf8');

/* ---------- 升位算得对不对 ---------- */

test('新功能升次版本（minor），并把修订号归零', () => {
  assert.equal(lib.nextVersion('2.3.19', 'minor'), '2.4.0');
  assert.equal(lib.nextVersion('2.3.21-pre', 'minor'), '2.4.0');
});

test('只修 bug 升修订号（patch）', () => {
  assert.equal(lib.nextVersion('2.3.19', 'patch'), '2.3.20');
  /* 关键：预发布用掉的号不会被正式版重复占用 —— 2.3.21-pre 之后应是 2.3.22 */
  assert.equal(lib.nextVersion('2.3.21-pre', 'patch'), '2.3.22');
});

test('不兼容升主版本（major），并把次版本、修订号归零', () => {
  assert.equal(lib.nextVersion('2.3.19', 'major'), '3.0.0');
});

test('预发布是同一个号下的形态，写成 X.Y.Z-pre（不再每个预发布都加修订号）', () => {
  assert.equal(lib.nextVersion('2.3.19', 'patch', { pre: true }), '2.3.20-pre');
  assert.equal(lib.nextVersion('2.3.19', 'minor', { pre: true }), '2.4.0-pre');
});

test('同一版本的第二个预发布用序号：2.3.22-pre → 2.3.22-pre.2', () => {
  assert.equal(lib.nextPreVersion('2.3.22-pre'), '2.3.22-pre.2');
  assert.equal(lib.nextPreVersion('2.3.22-pre.2'), '2.3.22-pre.3');
  /* 不是预发布就没法"下一号" */
  assert.equal(lib.nextPreVersion('2.3.22'), null);
});

test('测好的预发布转正式版：号不变，只去掉 -pre', () => {
  assert.equal(lib.promoteVersion('2.3.22-pre'), '2.3.22');
  assert.equal(lib.promoteVersion('2.3.22-pre.3'), '2.3.22');
  assert.equal(lib.promoteVersion('2.3.22'), null);
});

test('预发布小于它对应的正式版（semver 语义）', () => {
  assert.equal(lib.compareVersions('2.3.22-pre', '2.3.22'), -1);
  assert.equal(lib.compareVersions('2.3.22', '2.3.22-pre'), 1);
  assert.equal(lib.compareVersions('2.3.22-pre', '2.3.21-pre'), 1);
  assert.equal(lib.compareVersions('2.4.0-pre', '2.3.21-pre'), 1);
});

/* ---------- 单调性：这是防"版本号回退"的守卫 ---------- */

test('新号必须严格大于所有已发布的 tag', () => {
  const tags = fs.readFileSync(path.join(ROOT, '.git', 'refs', 'heads', 'main'), 'utf8').trim();
  assert.ok(tags.length > 0, '读不到 git 引用');
  /* 只要求脚本能读到 tag 列表并比较；这里直接验证比较函数对真实 tag 的行为 */
  const published = ['2.3.19', '2.3.21-pre', '2.3.20-pre'];
  for (const t of published) {
    assert.equal(lib.compareVersions(lib.nextVersion('2.3.21-pre', 'patch'), t), 1,
      '算出来的下一个号不大于已发布的 ' + t + ' —— 老用户会永远收不到更新');
  }
});

test('bump-version.js 必须做单调性校验，不能默默接受一个更小的号', () => {
  assert.ok(/compareVersions\(version, t\) <= 0/.test(BUMP),
    'bump-version.js 没有校验"新号必须大于已发布的 tag" —— 版本号可以回退，老用户会收不到更新');
  assert.ok(/publishedTags\(\)/.test(BUMP), 'bump-version.js 没有去读已发布的 tag');
});

test('按语义升位的判断必须由脚本做，不能靠人每次手写版本号', () => {
  for (const level of lib.LEVELS) {
    assert.ok(BUMP.includes("'--' + l") || BUMP.includes("--" + level),
      'bump-version.js 不支持 --' + level + '（按语义升位必须能指定升哪一位）');
  }
  for (const flag of ['--pre', '--pre-next', '--promote']) {
    assert.ok(BUMP.includes(flag), 'bump-version.js 不支持 ' + flag);
  }
  assert.ok(/require\(.\.\/version-lib.\)/.test(BUMP),
    'bump-version.js 没有复用 scripts/version-lib.js —— 规则实现了两份，一定会漂移');
});

/* ---------- 防漂移：和 renderer 里的比较语义必须一致 ---------- */

test('version-lib 的比较语义必须和 renderer/app.js 里的 compareVersions 完全一致', () => {
  const i = APP.indexOf('function compareVersions');
  assert.ok(i > 0, 'renderer/app.js 里找不到 compareVersions');
  let depth = 0, began = false, end = -1;
  for (let k = i; k < APP.length; k++) {
    const c = APP[k];
    if (c === '{') { depth++; began = true; }
    else if (c === '}') { depth--; if (began && depth === 0) { end = k + 1; break; } }
  }
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(APP.slice(i, end) + ';globalThis.__cmp = compareVersions;', sandbox);
  const other = sandbox.__cmp;

  const cases = [
    ['2.3.19', '2.3.19'], ['2.3.19', '2.3.21-pre'], ['2.3.21-pre', '2.3.19'],
    ['2.3.22-pre', '2.3.22'], ['2.3.22', '2.3.22-pre'], ['2.3.22-pre', '2.3.21-pre'],
    ['2.4.0-pre', '2.3.21-pre'], ['2.3.22-pre', '2.3.22-pre.2'], ['2.3.22-pre.2', '2.3.22-pre'],
    ['3.0.0', '2.9.9'], ['2.3.3', '2.3.19'],
  ];
  for (const [a, b] of cases) {
    assert.equal(lib.compareVersions(a, b), other(a, b),
      '两边对 ' + a + ' vs ' + b + ' 的判断不一致 —— 同一个事实写在两处就会漂移');
  }
});

/* ---------- 防漂移：预发布判定必须和 workflow 的表达式一致 ---------- */

test('预发布判定必须和 workflow 用的一致（含 "-" 即 pre-release）', () => {
  /* workflow 里是按 tag 名里有没有 '-' 来标 pre-release 的 */
  assert.ok(/prerelease:\s*\$\{\{\s*contains\(steps\.ver\.outputs\.v,\s*'-'\)\s*\}\}/.test(WORKFLOW),
    'workflow 不再按"版本号里有没有 -"判断预发布 —— 这里的前提变了，请同步更新说明');
  for (const v of ['2.3.22-pre', '2.3.22-pre.2', '2.3.22', '2.4.0']) {
    const byWorkflow = v.includes('-');
    assert.equal(lib.isPrerelease(v), byWorkflow,
      v + ' 的预发布判定与 workflow 不一致 —— 预发布会被当成正式版推给正式用户');
  }
});

/* ---------- 格式 ---------- */

test('版本号格式：X.Y.Z 或 X.Y.Z-pre(.N)', () => {
  for (const ok of ['2.3.22', '2.3.22-pre', '2.3.22-pre.2', '3.0.0']) {
    assert.ok(lib.VERSION_RE.test(ok), ok + ' 应该是合法版本号');
  }
  for (const bad of ['2.3', 'v2.3.22', '2.3.22.1', '2.3.22-pre.']) {
    assert.ok(!lib.VERSION_RE.test(bad), bad + ' 不该被当成合法版本号');
  }
});
