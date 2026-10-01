/*
 * 安装器接线测试。
 *
 * install-core.test.js 测的是纯逻辑；这里测的是"main.js 有没有真的把它们用上"。
 * 这些点全都是用户明确抱怨过的症状，而且很容易在后续改动里被悄悄改回去
 * （比如有人觉得"等进程起来再退出"更稳妥，又把 15 秒等待加回来），
 * 所以用测试把它们钉死。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const PKG = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

/** 去掉注释，避免注释里提到的旧实现造成误判 */
function stripJs(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const CODE = stripJs(MAIN);

/* ================= 隐藏的静默触发接口 ================= */

test('静默参数必须在创建窗口之前解析出来', () => {
  const parseAt = MAIN.indexOf('core.parseSilentArgs(process.argv)');
  const readyAt = MAIN.indexOf('app.whenReady()');
  assert.ok(parseAt > 0, '没有解析静默参数');
  assert.ok(readyAt > 0, '找不到 app.whenReady');
  assert.ok(parseAt < readyAt, '静默参数必须在 app ready 之前就解析，否则窗口已经建出来了');
});

test('静默模式下绝不创建窗口（这就是"不出现安装程序界面"）', () => {
  const i = MAIN.indexOf('app.whenReady()');
  const block = MAIN.slice(i, MAIN.indexOf('app.on(\'window-all-closed\'', i));
  assert.ok(/if \(SILENT\)\s*\{/.test(block), 'whenReady 里没有静默模式分支');
  const silentBranch = block.slice(block.indexOf('if (SILENT)'), block.indexOf('return;', block.indexOf('if (SILENT)')));
  assert.ok(!/createWindow\(\)/.test(silentBranch),
    '静默分支里调用了 createWindow —— 用户就会看到安装程序界面');
  assert.ok(/runSilentInstall\(\)/.test(silentBranch), '静默分支没有走静默安装');
  /* 正常分支仍然要有窗口 */
  const afterReturn = block.slice(block.indexOf('return;', block.indexOf('if (SILENT)')));
  assert.ok(/createWindow\(\)/.test(afterReturn), '非静默模式下仍然应该显示安装界面');
});

test('静默安装完成/失败都要立刻退出（不能留个后台进程赖着）', () => {
  const i = MAIN.indexOf('async function runSilentInstall');
  assert.ok(i > 0, '找不到 runSilentInstall');
  const body = MAIN.slice(i, MAIN.indexOf('\napp.whenReady()', i));
  assert.ok(/app\.exit\(0\)/.test(body), '成功路径没有立刻退出');
  assert.ok(/app\.exit\(1\)/.test(body), '失败路径没有立刻退出');
});

test('静默模式会把进度写到 stdout 与状态文件，供客户端显示进度', () => {
  assert.ok(/process\.stdout\.write/.test(MAIN), '静默模式没有输出进度，客户端无从得知安装到哪了');
  assert.ok(/statusFile/.test(MAIN), '没有写状态文件');
});

/* ================= 秒关客户端 ================= */

test('安装器保持 asInvoker：双击不该弹 UAC，也不该破坏 payload 查找', () => {
  /* 这里曾经为了"秒关客户端"改成 requireAdministrator，结果用户立刻反馈两件事：
       1) 安装程序一打开就要求管理员权限（双击就弹 UAC）
       2) portable 打包 + 提权后，安装器找不到自己的 payload
     所以退回 asInvoker。秒关并不依赖它：
       - 客户端带参拉起安装器时，子进程会**继承客户端的管理员令牌**，
         所以 taskkill 照样有效，也不需要弹 UAC；
       - 客户端自己没提权时，安装器同样没提权，杀的也是同样权限的客户端，一样能杀；
       - 真要提权才能杀（客户端是管理员、安装器不是）时，还有 taskkillViaUac 兜底。
     结论：用 asInvoker 才能既不打扰用户、又不牺牲秒关。 */
  assert.equal(PKG.build.win.requestedExecutionLevel, 'asInvoker',
    '安装器一旦要求管理员权限，用户双击就会弹 UAC，portable 下还可能导致找不到 payload');
});

test('秒关不能依赖安装器自身提权（靠继承客户端令牌 + UAC 兜底）', () => {
  /* 快路径就是普通 taskkill，不含有任何"先提权"的前置动作 */
  const fast = CODE.slice(CODE.indexOf('function taskkillElevated'), CODE.indexOf('function taskkillViaUac'));
  assert.ok(/taskkillAll\(\)/.test(fast), '快路径没有直接走强杀');
  assert.ok(!/RunAs/.test(fast), '快路径里不该有提权动作');
  /* 兜底必须存在，否则"客户端是管理员、安装器不是"时永远关不掉 */
  assert.ok(/function taskkillViaUac/.test(CODE), '缺少 UAC 兜底');
});

test('快路径不再无脑等待：强杀后只等 4 秒就该成功', () => {
  assert.ok(/waitForUnlock\(exeTarget, 4000\)/.test(CODE),
    '快路径的等待时间不是 4 秒 —— 太长会让"秒关"变成"等半天"');
});

test('老的 UAC 办法只能当兜底，不能出现在快路径上', () => {
  const i = CODE.indexOf('await taskkillElevated();');
  const j = CODE.indexOf('await taskkillViaUac();');
  assert.ok(i > 0, '快路径没有调用 taskkillElevated');
  assert.ok(j > i, 'taskkillViaUac 必须排在快路径之后（作为兜底）');
  /* 两者之间必须先有一次解锁检查，也就是"先试快的，不行才提权" */
  const between = CODE.slice(i, j);
  assert.ok(/waitForUnlock\(exeTarget, 4000\)/.test(between),
    '快路径失败后没有先做一次解锁检查就直接提权了');
  assert.ok(/unlocked\)\s*\{/.test(between) || /if \(unlocked\)/.test(between),
    '快路径成功后没有分支，会无条件继续走 UAC 兜底');
});

test('任何地方都不该再有 120 秒的等待', () => {
  assert.ok(!/120000/.test(CODE),
    '还有 120 秒的等待 —— 用户明确抱怨过"关闭客户端时间太长了"');
});

/* ================= 秒退 ================= */

test('启动客户端后立刻退出，不再等进程出现', () => {
  const i = CODE.indexOf("ipcMain.handle('launch'");
  assert.ok(i > 0, '找不到 launch 处理器');
  const body = CODE.slice(i);
  assert.ok(!/waitForProcess/.test(body),
    'launch 里还在等客户端进程起来 —— 最多要等 45 秒，' +
    '这正是"安装程序消失时间太长了"');
  assert.ok(/exitFast\(/.test(body), 'launch 结束后没有立刻退出');
});

test('主程序镜像名与核心模块里的强杀清单一致（漏一个就会 EBUSY）', () => {
  const core = require('./install-core.js');
  for (const image of ['BLFP.exe', 'easytier-core.exe', 'frpc.exe']) {
    assert.ok(core.CLIENT_IMAGES.includes(image), 'core 的强杀清单里缺少 ' + image);
  }
  assert.ok(/const EXE_NAME = 'BLFP.exe'/.test(MAIN), 'EXE_NAME 与强杀清单对不上');
});

/* ================= 秒装：跳过未变化文件 ================= */

test('安装走 core.planInstall，真的会跳过未变化的文件', () => {
  assert.ok(/core\.planInstall\(/.test(CODE),
    '安装流程没有用 planInstall —— 那就是无条件全量解压 230MB，' +
    '"秒装"不可能实现');
});

test('解压只对"要写"的文件做，跳过的文件绝不能被 getData()（否则还是全量解压）', () => {
  const i = CODE.indexOf('for (const item of plan.items)');
  assert.ok(i > 0, '找不到安装循环');
  const body = CODE.slice(i, CODE.indexOf('onProgress(92', i));
  assert.ok(/item\.action === 'write'/.test(body), '循环里没有区分 write 动作');
  assert.ok(/item\.action === 'mkdir'/.test(body), '循环里没有处理目录');
  const writeIdx = body.indexOf("item.action === 'write'");
  const getDataIdx = body.indexOf('.getData()');
  assert.ok(getDataIdx > writeIdx,
    'getData() 不在 write 分支里 —— 被跳过的文件也会被解压，省下来的时间全没了');
  /* skip 分支必须什么都不做（不 push、不写盘），即不能出现在 mkdir/write 之外 */
  const skipWrite = /action[^\n]*'skip'[^\n]*writeFileSync/.test(body);
  assert.ok(!skipWrite, 'skip 分支里居然在写盘');
});

test('跳过判定用的是 CRC 而不是只比大小（只比大小会漏更新）', () => {
  assert.ok(/crc32:\s*entry\.header\s*\?\s*entry\.header\.crc/.test(CODE),
    '没有把 zip 头的 CRC 传给跳过判定');
  assert.ok(/crc32File:\s*\(p\)\s*=>\s*core\.crc32File\(p\)/.test(CODE),
    '没有计算磁盘文件的 CRC');
});

test('进度提示会告诉用户跳过了多少、真正要写多少', () => {
  assert.ok(/无需改动 \$\{plan\.skipped\} 个文件/.test(MAIN),
    '安装时应该告诉用户跳过了多少文件，否则"怎么这么快"会让人以为没装');
});

/* ================= 打包内容 ================= */

test('新增的 install-core.js 必须被打进安装器（否则运行时报模块找不到）', () => {
  assert.ok(PKG.build.files.includes('install-core.js'),
    'install-core.js 不在 electron-builder 的 files 列表里');
});

test('静默安装失败也必须把客户端拉回来（不能让用户"软件关了再也没回来"）', () => {
  const body = MAIN.slice(MAIN.indexOf('async function runSilentInstall'));
  const catchAt = body.indexOf('} catch (e) {');
  assert.ok(catchAt > 0, '找不到 runSilentInstall 的 catch');
  const handler = body.slice(catchAt, body.indexOf('\n}', catchAt));
  assert.ok(/launchAndExit\(/.test(handler),
    '失败分支没有把客户端拉回来 —— payload 缺失这类错误以前就是这样被完全吞掉的，' +
    '用户只看到"点更新，软件关了，再也没回来"');
  assert.ok(/ARGS\.relaunch/.test(handler), '失败分支没有判断 --relaunch');
  /* 拉回来的必须是原来那个客户端（文件没被改动），所以失败时不能靠 result.exePath */
  assert.ok(/path\.join\(targetDir, EXE_NAME\)/.test(handler),
    '失败分支应该按安装目录推断原有客户端路径');
});

test('失败时会写下 ok:false 的状态，供客户端启动后显示原因', () => {
  const body = MAIN.slice(MAIN.indexOf('async function runSilentInstall'));
  const catchAt = body.indexOf('} catch (e) {');
  const handler = body.slice(catchAt, body.indexOf('\n}', catchAt));
  assert.ok(/ok:\s*false/.test(handler), '失败分支没有记录 ok:false');
  assert.ok(/silentStatus\(/.test(handler), '失败分支没有写状态');
});
