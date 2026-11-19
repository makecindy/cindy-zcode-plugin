(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const strings = {
    zh: { check: '重新检测', checking: '正在检测…', ready: '可以在模型选择器中使用 ZCode。', setup: 'ZCode 尚未就绪',
      stopped: '未收到插件的检测结果，请重新检测。', version: '命令行版本', path: '位置', count: '可用模型',
      unsupported: '当前 Cindy 版本还不支持插件执行引擎。', error: '检测结果未能同步到模型选择器，请重新检测。',
      site: '官方下载页' },
    en: { check: 'Check again', checking: 'Checking…', ready: 'ZCode is ready in the model picker.', setup: 'ZCode needs setup',
      stopped: 'The plugin did not return a result. Check again.', version: 'CLI version', path: 'Location', count: 'Available models',
      unsupported: 'This version of Cindy does not support plugin engines yet.', error: 'Cindy could not update the model picker. Check again.',
      site: 'Official downloads' },
  };
  let language = /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
  const channel = new BroadcastChannel('cindy-zcode-status');
  const renderMaintenance = window.createCliMaintenance(channel, check);
  let current, retry, timeout;
  let view = { checking: true };

  function render() {
    const t = strings[language];
    renderMaintenance(view.checking || view.failed ? null : view, language);
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    $('check').textContent = t.check;
    $('check').disabled = !!current;
    $('state').textContent = view.checking ? t.checking : view.failed ? t.stopped :
      view.published !== 'ok' ? (t[view.published] || t.error) : (view.available ? t.ready : t.setup);
    const message = $('message');
    message.textContent = view.message || '';
    message.hidden = !message.textContent;
    for (const key of ['version', 'path', 'count']) {
      const absent = view[key] == null;
      $(key + '-label').textContent = t[key];
      $(key).textContent = absent ? '' : String(view[key]);
      $(key + '-label').hidden = $(key).hidden = absent;
    }
    $('details').hidden = !view.path && !view.version && view.count == null;
  }
  function finish(data) {
    clearInterval(retry);
    clearTimeout(timeout);
    current = undefined;
    view = data;
    render();
  }
  function check() {
    if (current) return;
    current = crypto.randomUUID();
    view = { checking: true };
    render();
    const send = () => channel.postMessage({ type: 'check', id: current });
    fetch('/wake').catch(() => {});
    send();
    retry = setInterval(send, 600);
    timeout = setTimeout(() => finish({ failed: true }), 52000);
  }
  channel.onmessage = ({ data }) => {
    if (data?.type === 'locale-changed') { check(); return; }
    if (!current || data?.id !== current) return;
    if (data.type === 'ack') clearInterval(retry);
    if (data.type === 'status') {
      language = data.locale === 'zh' ? 'zh' : 'en';
      finish(data);
    }
  };
  $('check').onclick = check;
  fetch('/app-context').then(r => r.json()).then(r => {
    const locale = r.context?.uiLocale || r.context?.locale;
    if (locale) language = /^zh\b/i.test(locale) ? 'zh' : 'en';
    render();
  }).catch(() => {});
  check();
})();
