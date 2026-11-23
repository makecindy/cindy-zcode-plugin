'use strict';

const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const maintain = require('./cli-installer.cjs');
const { promisify } = require('node:util');
const { resolveRuntime, runner } = require('./local-runtime.cjs');
const accountHome = require('./account-home.cjs');

// `zcode login` stops polling after 5 minutes. Allow it to report that itself.
const LOGIN_LIMIT_MS = 330000;
const ACCOUNT_FRESH_MS = 20000;
const ACCOUNT_CACHE_MAX = 32;
const families = new Set(['bigmodel', 'zai']);
const HARNESS_ID = 'zcode';
const platformName = family => (family === 'zai' ? 'Z.ai' : 'BigModel');

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

// `account` is an added account's checked directory ({ dir, home }); null is the
// original ZCode login.
function runtimeFor(account) {
  const runtime = resolveRuntime();
  if (runtime.reason || !account) return runtime;
  return { ...runtime, env: accountHome.accountEnv(runtime.env, account) };
}

async function probe(mode, account = null, args = []) {
  const runtime = runtimeFor(account);
  if (runtime.reason) return mode === 'detect' ? { available: false, ...runtime } : null;
  try {
    const { stdout } = await promisify(execFile)(runtime.node, [runner, '--' + mode, ...args], {
      env: runtime.env, timeout: 22000, maxBuffer: 512 * 1024, windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch {
    return mode === 'detect' ? { available: false, reason: 'check-failed', path: runtime.entry } : null;
  }
}

// The settings page asks for the account and the usage at the same time. Both
// come from one read, so each family's quota service sees one request. Cindy's
// engine accounts read the same way, one entry per account directory.
const accountReads = new Map();
const accountCache = new Map();
function readAccountState(fresh, account = null) {
  const key = account ? account.dir : '';
  const cached = accountCache.get(key);
  if (!fresh && !accountReads.has(key) && cached && Date.now() - cached.at < ACCOUNT_FRESH_MS) {
    return Promise.resolve(cached.value);
  }
  if (!accountReads.has(key)) {
    const read = probe('account', account, account ? ['--models'] : []).then(value => {
      accountCache.delete(key);
      if (value) accountCache.set(key, { at: Date.now(), value });
      while (accountCache.size > ACCOUNT_CACHE_MAX) accountCache.delete(accountCache.keys().next().value);
      return value;
    }).finally(() => { accountReads.delete(key); });
    accountReads.set(key, read);
  }
  return accountReads.get(key);
}

// The official CLI keeps the sign-in in ZCode's shared credential store, so the
// ZCode desktop app switches to the same account. Cindy never reads the tokens.
// run.mjs supplies the provider environment; ending its stdin stops the CLI.
// An added account's sign-in goes to that account's own ZCode home.
function runCli(args, onStderr, account = null) {
  const runtime = runtimeFor(account);
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
async function browserSignIn(family, account = null) {
  if (!families.has(family) || desktopApp(resolveRuntime().entry)) return { ok: false, error: 'unsupported' };
  if (login) return { ok: false, error: 'busy' };
  const state = { cancelled: false, timedOut: false, url: undefined, dir: account ? account.dir : '' };
  login = state;
  // Keeps the request alive in Cindy while the browser authorization waits.
  const ticker = setInterval(() => send({ method: 'progress' }), 10000);
  try {
    if (account) accountHome.prepareAccountHome(account);
    const run = runCli(['login', family, '--json'], stderr => {
      // `--json` prints "Fallback URL:" and the address to stderr.
      const url = !state.url && /https:\/\/[^\s"'<>]+/.exec(stderr)?.[0];
      if (url) {
        state.url = url;
        send({ method: 'login-url', params: { url } });
      }
    }, account);
    if (!run) return { ok: false, error: 'not-installed' };
    state.child = run.child;
    const timer = setTimeout(() => { state.timedOut = true; run.child.stop(); }, LOGIN_LIMIT_MS);
    const { code, stdout, stderr } = await run.done;
    clearTimeout(timer);
    if (state.cancelled) return { ok: false, error: 'cancelled' };
    if (state.timedOut || /timed out/i.test(stderr)) return { ok: false, error: 'timeout' };
    if (code === 0 && lastJson(stdout)?.status === 'ready') {
      // An added account's sign-in must have landed in its own folder.
      if (account && !fs.existsSync(path.join(account.home, 'v2', 'credentials.json'))) {
        return { ok: false, error: 'failed', detail: 'ZCode did not save this sign-in in the account folder.' };
      }
      return { ok: true };
    }
    const detail = cliDetail(stderr);
    return { ok: false, error: 'failed', ...(detail ? { detail } : {}) };
  } finally {
    clearInterval(ticker);
    accountCache.delete(state.dir);
    if (login === state) login = null;
  }
}
function signIn(params) {
  return browserSignIn(params?.family);
}
function cancelSignIn(account) {
  if (!login || (account !== undefined && login.dir !== (account ? account.dir : ''))) return { ok: true, cancelled: false };
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
    accountCache.delete('');
  }
}

/* ── Cindy engine accounts (accountStatus / accountLogin / accountLoginCancel, usage with accountDir) ── */

// Method ids Cindy hands back in accountLogin; main.js publishes those this computer supports.
const METHODS = {
  'bigmodel-browser': { kind: 'browser', family: 'bigmodel' },
  'zai-browser': { kind: 'browser', family: 'zai' },
  'bigmodel-key': { kind: 'secret', family: 'bigmodel' },
  'zai-key': { kind: 'secret', family: 'zai' },
};
const keyShape = /^[!-~]{1,4096}$/;

// undefined: the original login; null: unusable; else the checked { dir, home }.
function accountParam(params) {
  if (params?.accountDir === undefined) return undefined;
  const account = accountHome.checkAccountDir(params.accountDir, process.env);
  return account.error ? null : account;
}

function plainText(value, max) {
  return typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : undefined;
}

function planName(state) {
  if (state.account?.plan !== 'active') return undefined;
  const level = plainText(state.planLevel, 24);
  return level ? `GLM Coding Plan ${level.charAt(0).toUpperCase()}${level.slice(1)}` : 'GLM Coding Plan';
}

// The probe's view of one ZCode home, as Cindy's account status. Display data only.
// `added`: an account Cindy added (its home holds only that sign-in or key).
function accountStatusFrom(state, added) {
  const account = state?.account;
  if (!account || typeof account.signedIn !== 'boolean') return null;
  const oauth = state.identity?.oauth;
  const key = state.identity?.apiKey;
  const plan = planName(state);
  const extra = {
    ...(plan ? { plan } : {}),
    // Model values are per ZCode home (provider id + model id); an added home can offer fewer.
    ...(added && Array.isArray(state.models) ? { models: state.models.filter(id => plainText(id, 256)).slice(0, 200) } : {}),
  };
  if (account.signedIn && families.has(account.family)) {
    const own = oauth?.family === account.family ? oauth : {};
    const email = plainText(own.email, 254);
    const name = plainText(own.name, 80);
    const identity = { ...(email ? { email } : {}), ...(name ? { name } : {}) };
    if (!email && !name) identity.detail = `${platformName(account.family)} account`;
    return {
      state: 'signed-in', identity,
      ...(plainText(own.fingerprint, 128) ? { fingerprint: own.fingerprint } : {}), ...extra,
    };
  }
  if (key && families.has(key.family) && typeof key.last4 === 'string' && /^[!-~]{1,4}$/.test(key.last4)) {
    return {
      state: 'signed-in', identity: { detail: `${platformName(key.family)} API Key ····${key.last4}` },
      ...(plainText(key.fingerprint, 128) ? { fingerprint: key.fingerprint } : {}), ...extra,
    };
  }
  // The original home may run on other providers configured in ZCode: unknown,
  // not signed out (ZCode reports itself unavailable when it has no model).
  return added ? { state: 'signed-out' } : null;
}

async function accountStatus(params) {
  if (params?.harnessId !== HARNESS_ID) return null;
  const account = accountParam(params);
  if (account === null) return null;
  const state = await readAccountState(false, account ?? null).catch(() => null);
  return accountStatusFrom(state, !!account);
}

async function saveKey(family, secret, account) {
  const runtime = runtimeFor(account);
  if (runtime.reason) return { ok: false, error: 'unsupported' };
  accountHome.prepareAccountHome(account);
  const child = spawn(runtime.node, [runner, '--save-key', family], {
    env: runtime.env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
  });
  let stdout = '';
  child.stdout.on('data', chunk => { if (stdout.length < 4096) stdout += chunk; });
  child.stdin.on('error', () => {});
  child.stdin.end(secret);
  const timer = setTimeout(() => child.kill(), 20000);
  const code = await new Promise(resolve => {
    child.on('error', () => resolve(-1));
    child.on('close', resolve);
  });
  clearTimeout(timer);
  const result = code === 0 ? lastJson(stdout) : null;
  if (result?.ok === true) return { ok: true };
  return { ok: false, error: ['unsupported', 'invalid-secret'].includes(result?.error) ? result.error : 'failed' };
}

async function accountLogin(params) {
  const method = params?.harnessId === HARNESS_ID && typeof params.methodId === 'string' ? METHODS[params.methodId] : undefined;
  if (!method) return { ok: false, error: 'unsupported' };
  const account = accountParam(params);
  if (account === null) return { ok: false, error: 'failed', message: 'The account folder cannot be used.' };
  let result;
  if (method.kind === 'browser') {
    result = await browserSignIn(method.family, account ?? null);
  } else {
    // A key is only ever written into an account Cindy added, never into the
    // original ZCode home that the desktop app shares.
    if (!account) return { ok: false, error: 'unsupported' };
    const secret = typeof params.secret === 'string' ? params.secret.trim() : '';
    if (!keyShape.test(secret)) return { ok: false, error: 'invalid-secret' };
    if (login) return { ok: false, error: 'busy' };
    const state = { cancelled: false, dir: account.dir };
    login = state;
    try {
      result = await saveKey(method.family, secret, account);
    } finally {
      accountCache.delete(account.dir);
      if (login === state) login = null;
    }
  }
  if (result.ok) return { ok: true };
  const error = ['cancelled', 'timeout', 'busy', 'unsupported', 'invalid-secret'].includes(result.error) ? result.error
    : result.error === 'not-installed' ? 'unsupported' : 'failed';
  const message = plainText(result.detail, 200);
  return { ok: false, error, ...(message ? { message } : {}) };
}

function accountLoginCancel(params) {
  const account = accountParam(params);
  if (account !== null) cancelSignIn(account ?? null);
  return { ok: true };
}

async function usage(params) {
  // Without accountDir: the original login, as older Cindy asks.
  if (params?.accountDir === undefined) {
    const state = await readAccountState(false).catch(() => null);
    return state?.usage ?? null;
  }
  const account = params?.harnessId === HARNESS_ID ? accountParam(params) : null;
  if (!account) return null;
  const state = await readAccountState(false, account).catch(() => null);
  return state?.usage ?? null;
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
    case 'usage':
      return reply(request.id, { result: await usage(request.params).catch(() => null) });
    case 'accountStatus':
      return reply(request.id, { result: await accountStatus(request.params).catch(() => null) });
    case 'accountLogin':
      return reply(request.id, { result: await accountLogin(request.params).catch(() => ({ ok: false, error: 'failed' })) });
    case 'accountLoginCancel':
      return reply(request.id, { result: accountLoginCancel(request.params) });
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
      checking ??= probe('detect').then(status => (status?.available
        // Whether `zcode login` can sign in here (a standalone CLI) or the desktop app must.
        ? { ...status, signIn: desktopApp(status.path) ? 'desktop' : 'cli' } : status))
        .finally(() => { checking = undefined; });
      try { return reply(request.id, { result: await checking }); }
      catch { return reply(request.id, { error: { code: -32603, message: 'Could not check ZCode' } }); }
    default:
      return reply(request.id, { error: { code: -32601, message: 'Method not found' } });
  }
});
