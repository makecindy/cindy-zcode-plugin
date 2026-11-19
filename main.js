(() => {
  'use strict';
  const channel = new BroadcastChannel('cindy-zcode-status');
  const hints = {
    'not-installed': ['请在这台电脑上安装 ZCode。', 'Install ZCode on this computer.'],
    'node-missing': ['请安装支持 SQLite 的 Node.js 22.13 或更高版本，再重新检测。', 'Install Node.js 22.13 or later with SQLite support, then check again.'],
    'not-runnable': ['找到了 ZCode，但启动失败。请确认本机的 ZCode 可以正常打开。', 'ZCode was found but could not start. Check that it opens on this computer.'],
    'sign-in-required': ['请在 ZCode 插件设置里登录开通了 GLM Coding Plan 的智谱 BigModel 或 Z.ai 账号。', 'In the ZCode plugin settings, sign in with a BigModel or Z.ai account that has a GLM Coding Plan.'],
    'no-models': ['这个账号没有能在 Cindy 里用的模型。请开通 GLM Coding Plan，或在 ZCode 里配置 API Key 后重新检测。ZCode 的 Start Plan 只能在 ZCode 桌面版里用。',
      'This account has no model Cindy can use. Subscribe to a GLM Coding Plan or add an API key in ZCode, then check again. ZCode Start Plan works only in the ZCode desktop app.'],
    'check-failed': ['本次检测失败，请重新检测。', 'The check failed. Please check again.'],
  };
  let locale = 'en';
  let latest;
  let inflight;
  // Coalesce settings checks. Drop a read
  // from the previous account if sign-in or credentials change mid-request.
  let usage = null;
  let usageWanted = false;
  let usageCheck = 0;
  let usageGeneration = 0;
  let usagePending = null;
  function announceUsage(checking = false) {
    if (channel) channel.postMessage({ type: 'harness-usage', usage, checking });
  }
  function clearUsage() {
    usageGeneration++;
    usageCheck = 0;
    usagePending = null;
    usage = null;
    announceUsage();
  }
  function refreshUsage() {
    if (!usageAvailable()) {
      usageWanted = true;
      return Promise.resolve();
    }
    usageWanted = false;
    if (usagePending) return usagePending;
    if (Date.now() - usageCheck < 60000) return Promise.resolve();
    usageCheck = Date.now();
    const generation = usageGeneration;
    usagePending = (async () => {
      let next = null;
      try {
        const response = await cindy.node.request({ method: 'usage', params: {}, timeoutMs: 26000 });
        if (response?.ok && (response.result?.windows?.length || response.result?.balances?.length)) next = response.result;
      } catch { /* Absence of billing data does not affect the engine. */ }
      if (generation !== usageGeneration || !usageAvailable()) return;
      usage = next;
      announceUsage();

    })().finally(() => { if (generation === usageGeneration) usagePending = null; });
    return usagePending;
  }
  function usageAvailable() { return latest?.status.available === true; }

  // Account card. The ZCode desktop app (or a standalone official CLI) signs in
  // and keeps the credentials in ZCode's own store; this view holds only the
  // platform, display name, plan state and how to sign in.
  let account = { signedIn: null };
  let accountOp = null;
  let loginUrl;
  let accountStatus = null;
  const accountReplies = new Set();
  function accountView() {
    return { ...account, busy: accountOp, ...(accountOp === 'login' && loginUrl ? { url: loginUrl } : {}) };
  }
  function announceAccount() {
    channel.postMessage({ type: 'account-changed', account: accountView() });
  }
  function readAccount(fresh = false) {
    if (accountOp) return Promise.resolve();
    if (accountStatus) return accountStatus;
    accountStatus = (async () => {
      try {
        const response = await cindy.node.request({ method: 'account', params: { fresh }, timeoutMs: 30000 });
        const next = response?.ok ? response.result : null;
        if (!accountOp && next && typeof next.signedIn === 'boolean') {
          account = {
            signedIn: next.signedIn,
            signIn: next.signIn === 'cli' ? 'cli' : 'desktop',
            ...(next.signedIn && ['bigmodel', 'zai'].includes(next.family) ? { family: next.family } : {}),
            ...(next.signedIn && typeof next.name === 'string' ? { name: next.name.slice(0, 80) } : {}),
            ...(next.signedIn && ['active', 'none', 'absent', 'unknown'].includes(next.plan) ? { plan: next.plan } : {}),
          };
        } else if (!accountOp) {
          account = { signedIn: account.signedIn, signIn: account.signIn, failed: true };
        }
      } catch {
        if (!accountOp) account = { signedIn: account.signedIn, signIn: account.signIn, failed: true };
      }
      announceAccount();
    })().finally(() => { accountStatus = null; });
    return accountStatus;
  }
  async function afterAccountChange() {
    clearUsage();
    await Promise.all([refresh(), readAccount(true)]);
    usageWanted = true;
    void refreshUsage();
  }
  async function runAccountOp(op, family) {
    if (op === 'cancel') {
      await cindy.node.request({ method: 'cancel-login', params: {}, timeoutMs: 15000 }).catch(() => {});
      return { ok: true };
    }
    if (op === 'open') {
      // The desktop app signs in; the page reads the account again on return.
      const response = await cindy.node.request({ method: 'open-app', params: {}, timeoutMs: 15000 }).catch(() => null);
      return response?.ok && typeof response.result?.ok === 'boolean' ? response.result : { ok: false, error: 'worker' };
    }
    if (accountOp) return { ok: false, error: 'busy' };
    accountOp = op;
    loginUrl = undefined;
    announceAccount();
    let result;
    try {
      const response = await cindy.node.request(op === 'login' ?
        { method: 'login', params: { family }, timeoutMs: 45000, maxTotalMs: 360000 } :
        { method: 'logout', params: {}, timeoutMs: 40000 });
      result = response?.ok ? response.result : null;
    } catch { /* Reported below as a failed operation. */ }
    result = result && typeof result.ok === 'boolean' ? result : { ok: false, error: 'worker' };
    accountOp = null;
    loginUrl = undefined;
    if (result.ok || op === 'login') await afterAccountChange();
    else announceAccount();
    return result;
  }
  function handleAccount(data) {
    if (data?.type !== 'account-request') return false;
    const { reqId, op } = data;
    if (typeof reqId !== 'string' || reqId.length > 64 || !['status', 'login', 'cancel', 'logout', 'open'].includes(op)) return true;
    channel.postMessage({ type: 'account-ack', reqId });
    if (accountReplies.has(reqId)) return true;
    accountReplies.add(reqId);
    if (accountReplies.size > 64) accountReplies.delete(accountReplies.values().next().value);
    if (op === 'status') {
      announceAccount();
      void readAccount(data.fresh === true);
      return true;
    }
    const family = op === 'login' && ['bigmodel', 'zai'].includes(data.family) ? data.family : undefined;
    if (op === 'login' && !family) return true;
    void runAccountOp(op, family).then(result => {
      channel.postMessage({
        type: 'account-result', reqId, op, ok: result.ok,
        ...(result.error ? { error: String(result.error).slice(0, 32) } : {}),
        ...(typeof result.detail === 'string' ? { detail: result.detail.slice(0, 200) } : {}),
      });
    });
    return true;
  }

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
      record.reportsUsage = true;

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
        if (!status.available) clearUsage();
        const published = await publish(status).catch(() => 'error');
        latest = { status, published };
        if (usageWanted) void refreshUsage();
      })().finally(() => { inflight = undefined; });
    }
    await inflight;
  }
  const context = Promise.resolve().then(() => cindy.request({ kind: 'app-context' }))
    .then(response => useLocale(response?.context)).catch(() => {});
  const cliRequests = new Set();
  let cliState = {};
  function announceCliState() {
    channel.postMessage({ type: 'cli-state', ...cliState });
  }
  function handleCliMaintenance(data) {
    if (data?.type === 'cli-state-request') {
      announceCliState();
      return true;
    }
    if (data?.type !== 'cli-maintenance') return false;
    if (typeof data.reqId !== 'string' || data.reqId.length > 64 ||
        !['check', 'install', 'update'].includes(data.action)) return true;
    const { reqId, action } = data;
    if (cliState.active || cliRequests.has(reqId)) {
      announceCliState();
      return true;
    }
    cliRequests.add(reqId);
    if (cliRequests.size > 64) cliRequests.delete(cliRequests.values().next().value);
    const version = typeof data.version === 'string' ? data.version.slice(0, 64) : undefined;
    cliState = { active: true, reqId, action };
    announceCliState();
    void (async () => {
      let result;
      try {
        const response = await cindy.node.request({
          method: 'cliMaintenance', params: { action, version },
          timeoutMs: action === 'check' ? 50000 : 60000,
          ...(action === 'check' ? {} : { maxTotalMs: 840000 }),
        });
        if (response?.ok) result = response.result;
        if (result?.state === 'installed') void refresh();
      } catch { /* Report a failed operation without exposing installer output. */ }
      cliState = { reqId, action, result: result || { error: 'operation' } };
      announceCliState();
    })();
    return true;
  }
  channel.onmessage = async ({ data }) => {
    if (handleCliMaintenance(data)) return;
    if (handleAccount(data)) return;
    if (data?.type === 'harness-usage-request') {
      usageWanted = true;
      announceUsage(usageAvailable() && !usage && (!usageCheck || !!usagePending));
      void refreshUsage();
      return;
    }
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
    if (message?.type === 'event' && message.name === 'node-notification' && message.method === 'login-url') {
      // The CLI opens the browser itself; this address is the fallback link.
      const url = message.params?.url;
      if (accountOp === 'login' && typeof url === 'string' && url.length <= 2048 && /^https:\/\//.test(url)) {
        loginUrl = url;
        announceAccount();
      }
      return;
    }
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
