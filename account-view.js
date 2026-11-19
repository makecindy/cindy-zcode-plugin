(() => {
  'use strict';
  // Account card. main.js runs the official `zcode login` / `zcode logout`;
  // this page only sends the user's choice and shows the result.
  const $ = id => document.getElementById(id);
  const channel = new BroadcastChannel('cindy-zcode-status');
  const families = ['bigmodel', 'zai'];
  const planPages = {
    bigmodel: 'https://bigmodel.cn/coding-plan/personal/overview',
    zai: 'https://z.ai/manage-apikey/subscription',
  };
  const deadlines = { status: 40000, login: 380000, cancel: 20000, logout: 60000, open: 20000 };
  const strings = {
    zh: {
      title: '账号', checking: '检查中…', signedOut: '未登录', signingIn: '等待浏览器授权…', signingOut: '正在退出…',
      family: { bigmodel: '智谱 BigModel', zai: 'Z.ai' },
      login: family => family === 'zai' ? '用 Z.ai 登录' : '用智谱 BigModel 登录',
      switchTo: family => family === 'zai' ? '改用 Z.ai 登录' : '改用智谱 BigModel 登录',
      cancel: '取消登录', logout: '退出登录',
      planActive: 'GLM Coding Plan 已开通。',
      planNone: '这个账号还没有开通 GLM Coding Plan，开通后才能在 Cindy 里使用 ZCode。',
      planUnknown: '暂时没能确认这个账号的 GLM Coding Plan，可以稍后点刷新图标重查。',
      planLink: '去开通 GLM Coding Plan ↗',
      helpSignedIn: '登录信息由 ZCode 自己保存，Cindy 不保存。ZCode 桌面版用的也是这个账号。',
      helpSignedOut: '选择开通了 GLM Coding Plan 的平台登录，会在浏览器里完成授权。登录信息由 ZCode 自己保存，Cindy 不保存；ZCode 桌面版也会换成这个账号。',
      helpSigningIn: '请在打开的浏览器窗口里完成授权，最多等 5 分钟。',
      openSignIn: '打开 ZCode 登录', openSwitch: '打开 ZCode 切换账号', openApp: '打开 ZCode',
      desktopSignedOut: '请在 ZCode 桌面版里登录开通了 GLM Coding Plan 的智谱 BigModel 或 Z.ai 账号，回到 Cindy 后这里会自动刷新。登录信息由 ZCode 保存，Cindy 不保存。',
      desktopSignedIn: '账号由 ZCode 桌面版管理，Cindy 不保存登录信息。切换或退出账号请在 ZCode 桌面版里操作。',
      opened: '在 ZCode 里完成登录后回到这里，状态会自动刷新。',
      openFailed: '没能打开 ZCode，请手动打开 ZCode 桌面版。',
      openLink: '浏览器没有打开？点这里打开授权页 ↗',
      confirm: '退出后，Cindy 里的 ZCode 和 ZCode 桌面版都要重新登录才能使用。确定退出吗？',
      confirmYes: '退出登录', confirmNo: '取消',
      cancelled: '已取消登录。', timeout: '5 分钟内没有完成授权，请重试。', signedOutNote: '已退出登录。',
      busy: '上一个登录操作还没有结束，请稍候。', worker: '插件后台没有响应，请稍后重试。',
      statusFailed: '没能读取登录状态，请点刷新图标重查。',
      loginFailed: detail => '没能完成登录' + (detail ? '：' + detail : '，请重试。'),
      logoutFailed: detail => '没能退出登录' + (detail ? '：' + detail : '，请重试。'),
    },
    en: {
      title: 'Account', checking: 'Checking…', signedOut: 'Not signed in', signingIn: 'Waiting for browser authorization…', signingOut: 'Signing out…',
      family: { bigmodel: 'BigModel', zai: 'Z.ai' },
      login: family => 'Sign in with ' + strings.en.family[family],
      switchTo: family => 'Use ' + strings.en.family[family] + ' instead',
      cancel: 'Cancel sign-in', logout: 'Sign out',
      planActive: 'GLM Coding Plan is active.',
      planNone: 'This account has no GLM Coding Plan yet. Subscribe to use ZCode in Cindy.',
      planUnknown: 'Couldn’t confirm this account’s GLM Coding Plan. Use the refresh icon to check again later.',
      planLink: 'Get a GLM Coding Plan ↗',
      helpSignedIn: 'ZCode keeps your sign-in; Cindy doesn’t store it. The ZCode desktop app uses the same account.',
      helpSignedOut: 'Sign in with the platform where you subscribed to the GLM Coding Plan; authorization finishes in your browser. ZCode keeps your sign-in and Cindy doesn’t store it. The ZCode desktop app switches to this account too.',
      helpSigningIn: 'Finish authorizing in the browser window that opened (up to 5 minutes).',
      openSignIn: 'Open ZCode to sign in', openSwitch: 'Open ZCode to switch accounts', openApp: 'Open ZCode',
      desktopSignedOut: 'In the ZCode desktop app, sign in with a BigModel or Z.ai account that has a GLM Coding Plan. This card refreshes when you return to Cindy. ZCode keeps the sign-in; Cindy doesn’t store it.',
      desktopSignedIn: 'The ZCode desktop app manages this account; Cindy doesn’t store the sign-in. Switch or sign out in the ZCode desktop app.',
      opened: 'After signing in to ZCode, come back here and the status refreshes.',
      openFailed: 'Couldn’t open ZCode. Open the ZCode desktop app yourself.',
      openLink: 'No browser opened? Open the authorization page ↗',
      confirm: 'After signing out, ZCode in Cindy and the ZCode desktop app both need a new sign-in. Sign out?',
      confirmYes: 'Sign out', confirmNo: 'Cancel',
      cancelled: 'Sign-in cancelled.', timeout: 'Authorization didn’t finish within 5 minutes. Try again.', signedOutNote: 'Signed out.',
      busy: 'The previous sign-in action hasn’t finished yet. Please wait.', worker: 'The plugin’s background process didn’t respond. Try again later.',
      statusFailed: 'Couldn’t read the sign-in. Use the refresh icon to check again.',
      loginFailed: detail => 'Couldn’t sign in' + (detail ? ': ' + detail : '. Try again.'),
      logoutFailed: detail => 'Couldn’t sign out' + (detail ? ': ' + detail : '. Try again.'),
    },
  };
  let account = null;
  let installed = false;
  let confirming = false;
  let note = null;
  // The refresh icon asks ZCode again instead of reusing the last read.
  let wantFresh = false;
  let awaitingReturn = false;
  const pending = new Map();

  const language = () => /^zh/i.test(document.documentElement.lang || navigator.language || '') ? 'zh' : 'en';
  function button(label, onClick, danger) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (danger) element.className = 'danger';
    element.addEventListener('click', onClick);
    return element;
  }
  function link(label, href) {
    const element = document.createElement('a');
    element.href = href;
    element.textContent = label;
    return element;
  }
  function inFlight(op) {
    for (const request of pending.values()) if (request.op === op) return true;
    return false;
  }

  function render() {
    const t = strings[language()];
    const section = $('account');
    section.hidden = !installed && !account?.signedIn;
    if (section.hidden) return;
    const state = account || {};
    const busy = state.busy || (inFlight('login') ? 'login' : inFlight('logout') ? 'logout' : null);
    $('account-title').textContent = t.title;
    let status = t.checking;
    let tone = '';
    if (busy === 'login') status = t.signingIn;
    else if (busy === 'logout') status = t.signingOut;
    else if (state.signedIn === true) {
      status = [t.family[state.family], state.name].filter(Boolean).join(' · ');
      tone = state.plan === 'active' ? 'success' : state.plan === 'none' ? 'warning' : '';
    } else if (state.signedIn === false) {
      status = t.signedOut;
      tone = 'warning';
    }
    $('account-status').textContent = status;
    $('account-status').dataset.tone = tone;

    const plan = $('account-plan');
    plan.replaceChildren();
    if (!busy && state.signedIn === true && state.family) {
      if (state.plan === 'active') plan.append(t.planActive);
      else if (state.plan === 'none') plan.append(t.planNone, ' ', link(t.planLink, planPages[state.family]));
      else if (state.plan === 'unknown') plan.append(t.planUnknown);
    }
    plan.hidden = !plan.childNodes.length;

    const desktop = state.signIn === 'desktop';
    const help = $('account-help');
    help.replaceChildren();
    const helpText = busy === 'login' ? t.helpSigningIn : busy ? '' :
      state.signedIn === true ? (desktop ? t.desktopSignedIn : t.helpSignedIn) :
      state.signedIn === false ? (desktop ? t.desktopSignedOut : t.helpSignedOut) : '';
    if (helpText) help.append(helpText);
    if (busy === 'login' && state.url) help.append(' ', link(t.openLink, state.url));
    help.hidden = !help.childNodes.length;

    const actions = $('account-actions');
    actions.replaceChildren();
    if (desktop && !busy && typeof state.signedIn === 'boolean') {
      const label = !state.signedIn ? t.openSignIn : state.plan !== 'active' ? t.openSwitch : t.openApp;
      actions.append(button(label, () => request('open')));
    } else if (busy === 'login') actions.append(button(t.cancel, () => request('cancel')));
    else if (!busy && state.signedIn === false) {
      for (const family of families) actions.append(button(t.login(family), () => request('login', family)));
    } else if (!busy && state.signedIn === true && !confirming) {
      if (state.plan !== 'active') {
        for (const family of families) if (family !== state.family) actions.append(button(t.switchTo(family), () => request('login', family)));
      }
      actions.append(button(t.logout, () => { confirming = true; note = null; render(); }));
    }
    actions.hidden = !actions.childElementCount;

    $('account-confirm').hidden = !confirming || !!busy || state.signedIn !== true;
    $('account-confirm-text').textContent = t.confirm;
    $('account-confirm-yes').textContent = t.confirmYes;
    $('account-confirm-no').textContent = t.confirmNo;

    const message = $('account-note');
    const failed = state.failed && !busy && !note ? { tone: 'error', text: t.statusFailed } : null;
    const shown = note ? { tone: note.tone, text: typeof note.text === 'function' ? note.text(t) : note.text } : failed;
    message.textContent = shown?.text || '';
    message.dataset.tone = shown?.tone || '';
    message.hidden = !message.textContent;
  }

  function finishRequest(reqId) {
    const entry = pending.get(reqId);
    if (!entry) return;
    clearInterval(entry.resend);
    clearTimeout(entry.deadline);
    pending.delete(reqId);
  }
  function request(op, family) {
    if (op !== 'status' && op !== 'cancel' && (inFlight('login') || inFlight('logout'))) return;
    const reqId = crypto.randomUUID();
    const message = { type: 'account-request', reqId, op, ...(family ? { family } : {}), ...(op === 'status' ? { fresh: wantFresh } : {}) };
    if (op === 'status') wantFresh = false;
    const entry = { op, acked: false };
    entry.resend = setInterval(() => { if (!entry.acked) channel.postMessage(message); }, 600);
    entry.deadline = setTimeout(() => {
      finishRequest(reqId);
      if (op !== 'status') note = { tone: 'error', text: t => t.worker };
      render();
    }, deadlines[op]);
    pending.set(reqId, entry);
    if (op === 'login' || op === 'logout') { note = null; confirming = false; }
    fetch('/wake').catch(() => {});
    channel.postMessage(message);
    render();
  }

  channel.addEventListener('message', ({ data }) => {
    if (data?.type === 'account-ack') {
      const entry = pending.get(data.reqId);
      if (!entry) return;
      entry.acked = true;
      clearInterval(entry.resend);
      if (entry.op === 'status') finishRequest(data.reqId);
    } else if (data?.type === 'account-changed' && data.account) {
      account = data.account;
      render();
    } else if (data?.type === 'account-result') {
      if (!pending.has(data.reqId)) return;
      finishRequest(data.reqId);
      if (data.op === 'login') {
        note = data.ok ? null : data.error === 'cancelled' ? { tone: '', text: t => t.cancelled } :
          data.error === 'timeout' ? { tone: 'error', text: t => t.timeout } :
          data.error === 'busy' ? { tone: 'error', text: t => t.busy } :
          data.error === 'worker' ? { tone: 'error', text: t => t.worker } :
          { tone: 'error', text: t => t.loginFailed(data.detail) };
      } else if (data.op === 'logout') {
        note = data.ok ? { tone: '', text: t => t.signedOutNote } :
          data.error === 'busy' ? { tone: 'error', text: t => t.busy } : { tone: 'error', text: t => t.logoutFailed(data.detail) };
      } else if (data.op === 'open') {
        awaitingReturn = data.ok;
        note = data.ok ? { tone: '', text: t => t.opened } : { tone: 'error', text: t => t.openFailed };
      }
      render();
    } else if (data?.type === 'status') {
      // Show the card once ZCode itself runs; installation problems come first.
      installed = !['not-installed', 'node-missing', 'not-runnable'].includes(data.reason);
      if (installed && !inFlight('status')) request('status');
      render();
    }
  });
  $('check').addEventListener('click', () => { wantFresh = true; note = null; awaitingReturn = false; });
  // After the user signs in to the desktop app, coming back re-runs the same
  // check as the refresh icon: models, account and usage together.
  const returned = () => {
    if (!awaitingReturn || document.hidden) return;
    awaitingReturn = false;
    if (!$('check').disabled) $('check').click();
  };
  window.addEventListener('focus', returned);
  document.addEventListener('visibilitychange', returned);
  $('account-confirm-yes').addEventListener('click', () => request('logout'));
  $('account-confirm-no').addEventListener('click', () => { confirming = false; render(); });
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
  render();
})();
