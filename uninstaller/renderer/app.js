const $ = (id) => document.getElementById(id);

window.uninstaller.getInstallDir().then((dir) => {
  $('install-dir').textContent = dir || '未找到安装目录';
});

$('cancel').addEventListener('click', () => window.uninstaller.quit());
$('finish').addEventListener('click', () => window.uninstaller.quit());
$('uninstall').addEventListener('click', async () => {
  $('actions').classList.add('hidden');
  $('progress').classList.remove('hidden');
  $('message').textContent = '正在移除 BLFP，请稍候…';
  const result = await window.uninstaller.uninstall();
  $('progress').classList.add('hidden');
  if (!result.ok) {
    $('message').textContent = '卸载失败：' + result.error;
    $('actions').classList.remove('hidden');
    return;
  }
  $('message').textContent = 'BLFP 已卸载，残留程序文件将在窗口关闭后自动删除。';
  $('done-actions').classList.remove('hidden');
});
