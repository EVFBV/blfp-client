/* 安装程序：打开即自动安装，只显示加载进度，完成后自动启动客户端 */
const $ = (id) => document.getElementById(id);
const show = (which) => {
  ['state-loading', 'state-done', 'state-error'].forEach((id) => {
    $(id).classList.toggle('hidden', id !== which);
  });
};

function setProgress(percent, text) {
  const p = Math.max(0, Math.min(100, Math.round(percent || 0)));
  $('bar-fill').style.width = p + '%';
  $('percent-text').textContent = p + '%';
  if (text) $('status-text').textContent = text;
}

async function runInstall() {
  show('state-loading');
  setProgress(0, '正在准备安装…');
  try {
    const dir = await window.installer.getDefaultDir();
    $('dir-text').textContent = dir;
    const result = await window.installer.install({ dir, desktopShortcut: true });
    if (!result || !result.ok) throw new Error((result && result.error) || '未知错误');
    setProgress(100, '安装完成');
    show('state-done');
    setTimeout(() => { window.installer.launch(result.exePath); }, 800);
  } catch (e) {
    $('error-text').textContent = e && e.message ? e.message : String(e);
    show('state-error');
  }
}

window.installer.onProgress((data) => {
  if (data) setProgress(data.percent, data.text);
});

document.addEventListener('DOMContentLoaded', () => {
  $('btn-retry').addEventListener('click', runInstall);
  $('btn-quit').addEventListener('click', () => window.installer.quit());
  runInstall();
});
