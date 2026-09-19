const $ = (id) => document.getElementById(id);

let installedExe = null;

function showStep(id) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

// 初始化默认安装目录
(async () => {
  $('install-dir').value = await window.installer.getDefaultDir();
})();

// 浏览目录
$('btn-browse').addEventListener('click', async () => {
  const dir = await window.installer.chooseDir();
  if (dir) $('install-dir').value = dir;
});

// 取消
$('btn-cancel').addEventListener('click', () => window.installer.quit());

// 开始安装
$('btn-install').addEventListener('click', async () => {
  const dir = $('install-dir').value.trim();
  if (!dir) return;
  showStep('step-progress');

  const res = await window.installer.install({
    dir,
    desktopShortcut: $('opt-desktop').checked,
  });

  if (res.ok) {
    installedExe = res.exePath;
    $('done-text').textContent = 'BLFP 已成功安装到：' + dir;
    showStep('step-done');
  } else {
    $('error-text').textContent = '安装失败：' + (res.error || '未知错误');
    showStep('step-error');
  }
});

// 进度更新
window.installer.onProgress(({ percent, text }) => {
  $('progress-fill').style.width = percent + '%';
  $('progress-pct').textContent = percent + '%';
  if (text) $('progress-text').textContent = text;
});

// 完成
$('btn-finish').addEventListener('click', async () => {
  if ($('opt-launch').checked && installedExe) {
    await window.installer.launch(installedExe);
  } else {
    window.installer.quit();
  }
});

// 错误：返回 / 关闭
$('btn-retry').addEventListener('click', () => showStep('step-setup'));
$('btn-close-err').addEventListener('click', () => window.installer.quit());
