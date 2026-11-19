(() => {
  'use strict';
  const channel = new BroadcastChannel('cindy-zcode-status');
  const hints = {
    'not-installed': ['请在这台电脑上安装 ZCode。', 'Install ZCode on this computer.'],
    'node-missing': ['请安装支持 SQLite 的 Node.js 22.13 或更高版本，再重新检测。', 'Install Node.js 22.13 or later with SQLite support, then check again.'],
    'not-runnable': ['找到了 ZCode，但启动失败。请确认本机的 ZCode 可以正常打开。', 'ZCode was found but could not start. Check that it opens on this computer.'],
    'no-models': ['请打开 ZCode，登录账号或配置模型，确认可以对话后重新检测。', 'Open ZCode, sign in or configure a model, then check again.'],
    'check-failed': ['本次检测失败，请重新检测。', 'The check failed. Please check again.'],
  };
  let locale = 'en';
  let latest;
  let inflight;

  function useLocale(context) {
    locale = /^zh\b/i.test(context?.uiLocale || context?.locale || '') ? 'zh' : 'en';
  }
  function hint(status) {
    const pair = hints[status.reason] || hints['check-failed'];
    return pair[locale === 'zh' ? 0 : 1];
  }
  async function publish(status) {
    const record = { id: 'zcode', available: status.available };
    if (status.version) record.version = status.version;
    if (status.available) {
      record.models = status.models;
      if (status.modes?.length) {
        record.modes = status.modes;
        if (record.modes.includes(status.defaultMode)) record.defaultMode = status.defaultMode;
      }
    } else {
      record.reason = status.reason;
      record.message = hint(status);
    }
    const response = await fetch('/harnesses', { method: 'PUT', body: JSON.stringify({ harnesses: [record] }) });
    return response.ok ? 'ok' : response.status === 404 ? 'unsupported' : 'error';
  }

  async function refresh() {
    if (!inflight) {
      inflight = (async () => {
        let status;
        try {
          const response = await cindy.node.request({ method: 'detect', params: {}, timeoutMs: 45000 });
          if (response?.ok && typeof response.result?.available === 'boolean') status = response.result;
        } catch {}
        status ??= { available: false, reason: 'check-failed' };
        const published = await publish(status).catch(() => 'error');
        latest = { status, published };
      })().finally(() => { inflight = undefined; });
    }
    await inflight;
  }
  const context = Promise.resolve().then(() => cindy.request({ kind: 'app-context' }))
    .then(response => useLocale(response?.context)).catch(() => {});
  channel.onmessage = async ({ data }) => {
    if (data?.type !== 'check' || typeof data.id !== 'string' || data.id.length > 64) return;
    channel.postMessage({ type: 'ack', id: data.id });
    await context;
    await refresh();
    const { status, published } = latest;
    channel.postMessage({
      type: 'status', id: data.id, locale, published,
      available: status.available, reason: status.reason, message: status.available ? '' : hint(status),
      version: status.version, path: status.path, count: status.models?.length,
    });
  };
  cindy.onHostMessage(async message => {
    if (message?.type === 'harnesses-refresh-requested') {
      await context;
      await refresh();
    } else if (message?.type === 'host-context-changed' && message.context) {
      const previous = locale;
      useLocale(message.context);
      if (locale !== previous) {
        if (latest && !latest.status.available) latest.published = await publish(latest.status).catch(() => 'error');
        channel.postMessage({ type: 'locale-changed' });
      }
    }
  });
  context.then(refresh);
})();
