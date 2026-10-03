/**
 * 版本号规则（MMP = Major.Minor.Patch，即 主版本.次版本.修订号）。
 *
 * 规则（用户 2026-10-01 明确要求"按语义升位"）：
 *   1) 一个版本号只对应**一个待发布版本**；预发布是同一个号下的
 *      预发布形态，写成 `X.Y.Z-pre`、`X.Y.Z-pre.2` …（不再是每个预发布
 *      都往上加一个修订号 —— 之前 2.3.4-pre 一路涨到 2.3.21-pre，
 *      把新功能和修 bug 全塞进修订号里了，那是错的）。
 *   2) 升哪一位看改动的性质：
 *        有新功能            → 升**次版本**（minor）：2.3.19 → 2.4.0
 *        只修 bug / 只改工具  → 升**修订号**（patch）：2.3.19 → 2.3.20
 *        有不兼容改动        → 升**主版本**（major）：2.3.19 → 3.0.0
 *   3) 测好的预发布要转正式版时**号不变**，只去掉 `-pre` 后缀（promote）。
 *   4) 版本号必须**严格单调递增**：新号一定要大于所有已发布的 tag。
 *      已发布的 tag 永不重打（重打会让已装用户的版本号对不上）。
 *
 * 这个文件是**唯一**的规则实现，bump-version.js 和测试都用它 ——
 * 规则写两处一定会漂移。
 */

/* 预发布段：字母开头，后面可以跟 .数字 序号（pre、pre.2、beta.3）。
   明确不收尾的点，'2.3.22-pre.' 这种要判为非法。 */
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

/* 解析版本号；不合法返回 null */
function parseVersion(version) {
  const m = String(version || '').trim().match(VERSION_RE);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] || '',
    /* 预发布的序号（2.3.22-pre.3 → 3）；没有序号时为 0 */
    /* 没有序号的 'pre' 本身就是第 1 个，所以默认是 1 而不是 0 */
    preNumber: m[4] ? (/\.(\d+)$/.test(m[4]) ? Number(m[4].match(/\.(\d+)$/)[1]) : 1) : 0,
    preLabel: m[4] ? m[4].replace(/\.\d+$/, '') : '',
  };
}

function formatVersion(v) {
  return v.major + '.' + v.minor + '.' + v.patch + (v.pre ? '-' + v.pre : '');
}

/* 去掉预发布后缀，得到它所属的那个正式版本号 */
function releaseOf(version) {
  const v = parseVersion(version);
  if (!v) return null;
  return v.major + '.' + v.minor + '.' + v.patch;
}

function isPrerelease(version) {
  const v = parseVersion(version);
  return Boolean(v && v.pre);
}

/* 与 renderer/app.js 里的 compareVersions 语义必须完全一致（有测试盯着两边） */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;
  /* 同号时：正式版 > 预发布（semver：预发布小于它对应的正式版） */
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  if (pa.preLabel !== pb.preLabel) return pa.preLabel > pb.preLabel ? 1 : -1;
  if (pa.preNumber !== pb.preNumber) return pa.preNumber > pb.preNumber ? 1 : -1;
  return 0;
}

const LEVELS = ['major', 'minor', 'patch'];

/**
 * 按语义算出下一个版本号。
 *   level: 'major' | 'minor' | 'patch'
 *   pre:   true  → 返回该版本的预发布形态 X.Y.Z-pre
 *          false → 直接返回正式版 X.Y.Z
 *   withPreNumber: true 时返回 X.Y.Z-pre.N（同一版本下的第 N 个预发布）
 *
 * 注意 level 的语义：它描述的是**这次改动**的性质，
 * 而"下一个号"是在当前号的基础上往上走一位，所以从 2.3.21-pre
 * 走 patch 会得到 2.3.22（预发布用的号不会被正式版重复占用）。
 */
function nextVersion(current, level, options = {}) {
  const v = parseVersion(current);
  if (!v) throw new Error('当前版本号不合法: ' + current);
  if (!LEVELS.includes(level)) throw new Error('未知的升位方式: ' + level);
  let next;
  if (level === 'major') next = { major: v.major + 1, minor: 0, patch: 0 };
  else if (level === 'minor') next = { major: v.major, minor: v.minor + 1, patch: 0 };
  else next = { major: v.major, minor: v.minor, patch: v.patch + 1 };
  next.pre = '';
  next.preNumber = 0;
  next.preLabel = '';

  if (options.pre) {
    next.pre = 'pre';
    next.preLabel = 'pre';
    if (options.withPreNumber) next.pre = 'pre.1';
    if (options.withPreNumber) next.preNumber = 1;
  }
  return formatVersion(next);
}

/* 把当前预发布转成它对应的正式版（号不变，只去掉 -pre）。不是预发布则返回 null */
function promoteVersion(current) {
  const v = parseVersion(current);
  if (!v || !v.pre) return null;
  return v.major + '.' + v.minor + '.' + v.patch;
}

/**
 * 同一个待发布版本的下一个预发布号：2.3.22-pre → 2.3.22-pre.2
 * 当前不是预发布时返回 null（应当用 --patch/--minor/--major --pre 起第一个）。
 */
function nextPreVersion(current) {
  const v = parseVersion(current);
  if (!v || !v.pre) return null;
  const label = v.preLabel || 'pre';
  return v.major + '.' + v.minor + '.' + v.patch + '-' + label + '.' + (v.preNumber + 1);
}

module.exports = {
  VERSION_RE, LEVELS,
  parseVersion, formatVersion, releaseOf, isPrerelease,
  compareVersions, nextVersion, promoteVersion, nextPreVersion,
};
