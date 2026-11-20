'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const maintain = require('./cli-installer.cjs');
const { promisify } = require('node:util');
const { resolveRuntime, runner } = require('./local-runtime.cjs');

// `zcode login` stops polling after 5 minutes. Allow it to report that itself.
const LOGIN_LIMIT_MS = 330000;
const ACCOUNT_FRESH_MS = 20000;
const families = new Set(['bigmodel', 'zai']);

// The CLI inside the desktop app has no OS keyring module of its own (ZCode
// 3.18.2 / CLI 0.17.1: `zcode login` fails with
// CREDENTIAL_SECURE_STORAGE_UNAVAILABLE). That app signs in and switches
// accounts itself, so the settings page opens it. A standalone CLI signs in here.
function desktopApp(entry) {
  if (process.platform === 'darwin') {
    const bundle = /^(.+\.app)\/Contents\/Resources\/glm\/zcode\.cjs$/.exec(entry || '')?.[1];
    return bundle ? { command: '/usr/bin/open', args: [bundle] } : null;
  }
  const root = /^(.+)[\\/]resources[\\/]glm[\\/]zcode\.cjs$/i.exec(entry || '')?.[1];
  const app = root && path.join(root, process.platform === 'win32' ? 'ZCode.exe' : 'zcode');
  try { return app && fs.statSync(app).isFile() ? { command: app, args: [] } : null; } catch { return null; }
}
function openDesktop() {
  const app = desktopApp(resolveRuntime().entry);
  if (!app) return { ok: false, error: 'unsupported' };
  // Start the app as itself, not as the Node runtime the plugin uses.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:ELECTRON_|NODE_OPTIONS$|NODE_PATH$|ZCODE_BIN$|ZCODE_NODE$)/i.test(key)));
  try {
    const child = spawn(app.command, app.args, { env, detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
    return { ok: true };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

function send(packet) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
}
function reply(id, body) {
  send({ id, ...body });
}

async function probe(mode) {
  const runtime = resolveRuntime();
  if (runtime.reason) return mode === 'detect' ? { available: false, ...runtime } : null;
  try {
    const { stdout } = await promisify(execFile)(runtime.node, [runner, '--' + mode], {
      env: runtime.env, timeout: 22000, maxBuffer: 512 * 1024, windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch {
    return mode === 'detect' ? { available: false, reason: 'check-failed', path: runtime.entry } : null;
  }
}

// The settings page asks for the account and the usage at the same time. Both
// come from one read, so each family's quota service sees one request.
let accountRead;
let accountCache;
function readAccountState(fresh) {
  if (!fresh && !accountRead && accountCache && Date.now() - accountCache.at < ACCOUNT_FRESH_MS) {
    return Promise.resolve(accountCache.value);
  }
  accountRead ??= probe('account').then(value => {
    accountCache = value ? { at: Date.now(), value } : undefined;
    return value;
  }).finally(() => { accountRead = undefined; });
  return accountRead;
}

// The official CLI keeps the sign-in in ZCode's shared credential store, so the
// ZCode desktop app switches to the same account. Cindy never reads the tokens.
// run.mjs supplies the provider environment; ending its stdin stops the CLI.
function runCli(args, onStderr) {
  const runtime = resolveRuntime();
  if (runtime.reason) return null;
  const child = spawn(runtime.node, [runner, '--cli', ...args], {
    env: runtime.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  child.stdin.on('error', () => {});
  child.stop = () => {
    child.stdin.end();
    setTimeout(() => child.kill(), 3000).unref();
  };
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout += chunk; });
  child.stderr.on('data', chunk => {
    if (stderr.length < 16384) stderr += chunk;
    onStderr?.(stderr);
  });
  const done = new Promise(resolve => {
    child.on('error', () => resolve({ code: -1, stdout, stderr }));
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}
function lastJson(stdout) {
  try { return JSON.parse(stdout.trim().split(/\r?\n/).pop()); } catch { return null; }
}
// The CLI's own message, without the authorization address or any path.
function cliDetail(stderr) {
  const line = stderr.split(/\r?\n/).map(text => text.trim()).filter(text => text.startsWith('Error:')).pop();
  return line ? line.slice(6).replace(/https?:\/\/\S+|[A-Za-z]:\\\S+|\/\S+/g, '').trim().slice(0, 200) || undefined : undefined;
}

let login = null;
async function signIn(params) {
  const family = params?.family;
  if (!families.has(family) || desktopApp(resolveRuntime().entry)) return { ok: false, error: 'unsupported' };
  if (login) return { ok: false, error: 'busy' };
  const state = { cancelled: false, timedOut: false, url: undefined };
  login = state;
  const ticker = setInterval(() => send({ method: 'progress' }), 10000);
  try {
    const run = runCli(['login', family, '--json'], stderr => {
      // `--json` prints "Fallback URL:" and the address to stderr.
      const url = !state.url && /https:\/\/[^\s"'<>]+/.exec(stderr)?.[0];
      if (url) {
        state.url = url;
        send({ method: 'login-url', params: { url } });
      }
    });
    if (!run) return { ok: false, error: 'not-installed' };
    state.child = run.child;
    const timer = setTimeout(() => { state.timedOut = true; run.child.stop(); }, LOGIN_LIMIT_MS);
    const { code, stdout, stderr } = await run.done;
    clearTimeout(timer);
    if (state.cancelled) return { ok: false, error: 'cancelled' };
    if (state.timedOut || /timed out/i.test(stderr)) return { ok: false, error: 'timeout' };
    if (code === 0 && lastJson(stdout)?.status === 'ready') return { ok: true };
    const detail = cliDetail(stderr);
    return { ok: false, error: 'failed', ...(detail ? { detail } : {}) };
  } finally {
    clearInterval(ticker);
    accountCache = undefined;
    if (login === state) login = null;
  }
}
function cancelSignIn() {
  if (!login) return { ok: true, cancelled: false };
  login.cancelled = true;
  login.child?.stop();
  return { ok: true, cancelled: true };
}
async function signOut() {
  if (desktopApp(resolveRuntime().entry)) return { ok: false, error: 'unsupported' };
  if (login) return { ok: false, error: 'busy' };
  const run = runCli(['logout', '--json']);
  if (!run) return { ok: false, error: 'not-installed' };
  const timer = setTimeout(() => run.child.stop(), 30000);
  try {
    const { code, stdout, stderr } = await run.done;
    if (code === 0 && lastJson(stdout)?.status === 'logged_out') return { ok: true };
    const detail = cliDetail(stderr);
    return { ok: false, error: 'failed', ...(detail ? { detail } : {}) };
  } finally {
    clearTimeout(timer);
    accountCache = undefined;
  }
}

let checking;
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let request;
  try { request = JSON.parse(line.trim()); } catch { return reply(null, { error: { code: -32700, message: 'Parse error' } }); }
  if (request?.id == null) return;
  switch (request.method) {
    case 'cliMaintenance': {
      // 'progress' keeps the request alive; 'cli-progress' carries install steps for the settings page.
      const result = await maintain(request.params, (method, params) => send({ method, ...(params ? { params } : {}) }));
      return reply(request.id, { result });
    }
    case 'usage': {
      const state = await readAccountState(false).catch(() => null);
      return reply(request.id, { result: state?.usage ?? null });
    }
    case 'account': {
      const state = await readAccountState(request.params?.fresh === true).catch(() => null);
      const signIn = desktopApp(resolveRuntime().entry) ? 'desktop' : 'cli';
      return reply(request.id, { result: state?.account ? { ...state.account, signIn } : null });
    }
    case 'open-app':
      return reply(request.id, { result: openDesktop() });
    case 'login':
      return reply(request.id, { result: await signIn(request.params).catch(() => ({ ok: false, error: 'failed' })) });
    case 'cancel-login':
      return reply(request.id, { result: cancelSignIn() });
    case 'logout':
      return reply(request.id, { result: await signOut().catch(() => ({ ok: false, error: 'failed' })) });
    case 'detect':
      checking ??= probe('detect').finally(() => { checking = undefined; });
      try { return reply(request.id, { result: await checking }); }
      catch { return reply(request.id, { error: { code: -32603, message: 'Could not check ZCode' } }); }
    default:
      return reply(request.id, { error: { code: -32601, message: 'Method not found' } });
  }
});
