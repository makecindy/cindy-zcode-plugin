/* CLI maintenance controls shared by the plugin's local settings pages. */
window.createCliMaintenance = function (channel, refresh) {
  const root = document.getElementById('cli-maintenance');
  const action = document.getElementById('cli-action');
  const status = document.getElementById('cli-status');
  const strings = {
    'zh-CN': {
      install: '从官方安装', check: '检查 CLI 更新', update: '更新到 {version}', installing: '正在安装…',
      updating: '正在更新…', checking: '正在检查更新…', installed: '已安装官方安装包 {version}',
      current: '官方安装包已是最新版（{version}）', newer: '官方安装包 {version} 可用', unknown: '官方安装包 {version} 可用，无法比较现有安装版本。',
      missing: '本机尚未安装。', source: '无法连接官方发布源，请稍后重试。',
      integrity: '下载文件校验失败，请重试。', unsupported: '官方源不提供适用于这台电脑的安装包。',
      busy: '操作正在另一处进行，请稍后重试。', verify: '安装后仍未检测到目标版本，请重新检测。',
      operation: '安装或更新未完成，请重试。',
      'close-zcode': '请先退出 ZCode，再重试。', timeout: '未收到操作结果，请先重新检测。',
      'zcode-source': '官方安装包装有 Cindy 使用的 ZCode 命令行。Windows 上请在安装向导中完成安装。',
    },
    en: {
      install: 'Install from official source', check: 'Check for CLI updates', update: 'Update to {version}', installing: 'Installing…',
      updating: 'Updating…', checking: 'Checking for updates…', installed: 'Installed official package {version}',
      current: 'Official package is up to date ({version})', newer: 'Official package {version} is available', unknown: 'Official package {version} is available. Could not compare the installed package version.',
      missing: 'Not installed on this computer.', source: 'Could not reach the official release source. Try again.',
      integrity: 'The download failed verification. Try again.', unsupported: 'The official source has no installer for this computer.',
      busy: 'An operation is already running. Try again later.', verify: 'The expected version was not detected after installation. Check again.',
      operation: 'Installation or update did not finish. Try again.',
      'close-zcode': 'Quit ZCode before trying again.', timeout: 'No result was received. Check the local CLI again.',
      'zcode-source': 'The official installer includes the ZCode command line used by Cindy. On Windows, complete the installation wizard.',
    },
  };
  let local = null;
  let locale = 'en';
  let result;
  let pending;
  let retry;
  let timer;

  function render() {
    const text = strings[locale];
    const missing = !['installed', 'current'].includes(result?.state) && (local?.reason === 'not-installed' || result?.state === 'missing');
    const next = missing ? 'install' : ['newer', 'unknown'].includes(result?.state) ? 'update' : 'check';
    const key = pending ? { install: 'installing', check: 'checking', update: 'updating' }[pending.action] :
      result?.error || result?.state;
    root.hidden = !local && !pending;
    action.dataset.action = next;
    action.textContent = text[next].replace('{version}', result?.version || '');
    action.disabled = !!pending || !channel;
    status.textContent = (text[key] || '').replace('{version}', result?.version || '');
    const source = document.getElementById('cli-source');
    if (source) source.textContent = text['zcode-source'];
  }

  function finish(value) {
    const shouldRefresh = value.state === 'installed' || (pending?.action !== 'check' && value.state === 'current');
    clearInterval(retry);
    clearTimeout(timer);
    pending = undefined;
    result = value;
    render();
    if (shouldRefresh) refresh();
  }

  channel?.addEventListener('message', ({ data }) => {
    if (!pending || data?.reqId !== pending.reqId) return;
    if (data.type === 'cli-ack') clearInterval(retry);
    if (data.type === 'cli-result') finish(data.result || { error: 'operation' });
  });
  action.addEventListener('click', () => {
    if (pending || !channel) return;
    const operation = action.dataset.action;
    pending = { type: 'cli-maintenance', reqId: crypto.randomUUID(), action: operation, version: result?.version };
    const send = () => channel.postMessage(pending);
    void fetch('/wake').catch(() => {});
    render();
    send();
    retry = setInterval(send, 650);
    timer = setTimeout(() => finish({ error: 'timeout' }), operation === 'check' ? 55000 : 855000);
  });

  return function renderMaintenance(status, language) {
    if (status && local && (status.version !== local.version || status.reason !== local.reason) && result?.state !== 'installed') {
      result = undefined;
    }
    if (status) local = status;
    locale = /^zh\b/i.test(language) ? 'zh-CN' : 'en';
    render();
  };
};
