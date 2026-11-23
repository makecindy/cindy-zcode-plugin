import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// The packaged bridge reads an isolated ZCode home in a child process, as the
// worker does. The credential store layout is what `zcode login bigmodel`
// (ZCode CLI 0.17.1) writes; plain values stand in for OS-encrypted ones.
const plan = 'account:bigmodel-individual-coding-plan';
const startPlan = 'account:bigmodel-start-plan';
const rule = (providerId, mode) => ({ providerId, providerName: mode, config: {
  access: { type: 'zhipu-account', accountType: 'bigmodel', mode }, builtinModelIds: ['GLM-5.3'],
} });

async function probe(t, credentials) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-account-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cfg = path.join(home, '.zcode', 'v2');
  await fs.mkdir(cfg, { recursive: true });
  // A stand-in ZCode install. The bridge would otherwise find a real one
  // through the registry or the Applications folder and read its table.
  const cli = path.join(home, 'zcode', 'zcode.cjs');
  await fs.mkdir(path.join(home, 'zcode', 'provider'), { recursive: true });
  await fs.writeFile(cli, '');
  await fs.writeFile(path.join(home, 'zcode', 'provider', 'zcode-builtin.json'), JSON.stringify({ schemaVersion: 1, revision: 1, config: {
    providerConfigRules: { providerRules: [rule(plan, 'individual-coding-plan'), rule(startPlan, 'start-plan')] },
  } }));
  await fs.writeFile(path.join(cfg, 'credentials.json'), JSON.stringify(credentials));
  // The desktop marks the family's Start Plan connection here.
  await fs.writeFile(path.join(cfg, 'setting.json'), JSON.stringify({
    providerFamilyConnectionSelections: { bigmodel: { kind: 'start-plan' } },
  }));
  const script = path.join(home, 'probe.mjs');
  const adapter = new URL('../vendor/dist/adapter.mjs', import.meta.url).href;
  await fs.writeFile(script, `import { buildInitialConfigOptions, readAccount } from ${JSON.stringify(adapter)};
    const options = await buildInitialConfigOptions({ backendKind: 'zcode' });
    const models = options.find(item => item.category === 'model')?.options.map(item => item.value) ?? [];
    console.log(JSON.stringify({ account: readAccount(), models }));
  `);
  const env = { ...process.env, ZCODE_HOME: path.join(home, '.zcode'), HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, ZCODE_BIN: cli };
  delete env.ZCODE_PROVIDER;
  delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const { stdout } = await promisify(execFile)(process.execPath, [script], { env, cwd: home, windowsHide: true });
  return JSON.parse(stdout);
}

test('a CLI BigModel sign-in lists the Coding Plan and never the desktop-only Start Plan', async t => {
  const result = await probe(t, {
    'oauth:active_provider': 'bigmodel',
    'oauth:bigmodel:access_token': 'fixture',
    'oauth:bigmodel:user_info': JSON.stringify({ id: 'key-1', username: 'Test User', displayName: 'Test User' }),
    zcodejwttoken: 'fixture',
    [`account-provider:${plan}:identity`]: 'key-1',
    [`account-provider:${plan}:auth-source`]: 'oauth',
  });
  assert.deepEqual(result.account, { signedIn: true, family: 'bigmodel', name: 'Test User' });
  assert.ok(result.models.some(value => value.startsWith(plan)), JSON.stringify(result.models));
  assert.ok(!result.models.some(value => value.includes('start-plan')), JSON.stringify(result.models));
});

test('without a sign-in there is no account and Start Plan stays hidden', async t => {
  const result = await probe(t, { zcodejwttoken: 'fixture' });
  assert.deepEqual(result.account, { signedIn: false });
  assert.ok(!result.models.some(value => value.includes('start-plan')), JSON.stringify(result.models));
});

// Cindy engine accounts, through the plugin worker's JSON-RPC as Cindy calls it.
// A stand-in ZCode install, temporary homes, and a closed local proxy: no real
// ZCode, ZCode home or quota service is touched.
async function workerFixture(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-engine-account-'));
  const home = path.join(tmp, 'home');
  const cli = path.join(tmp, 'zcode', 'zcode.cjs');
  await fs.mkdir(path.join(tmp, 'zcode', 'provider'), { recursive: true });
  await fs.writeFile(cli, '');
  await fs.writeFile(path.join(tmp, 'zcode', 'provider', 'zcode-builtin.json'), JSON.stringify({ schemaVersion: 1, revision: 1,
    config: { providerConfigRules: { providerRules: [] } } }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: path.join(tmp, 'config'), ZCODE_BIN: cli, ZCODE_NODE: process.execPath,
    NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };
  for (const key of ['ZCODE_HOME', 'ZCODE_DATA_BASE_DIR', 'ZCODE_PROVIDER', 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
    'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_GUEST_ORIGINAL_CREDENTIALS_PATH']) delete env[key];
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../worker.cjs', import.meta.url))], {
    env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const exited = new Promise(resolve => worker.on('close', resolve));
  t.after(async () => {
    worker.kill();
    await exited;
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
  });
  const replies = new Map();
  const notifications = [];
  readline.createInterface({ input: worker.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id != null) replies.get(message.id)?.(message);
    else if (message.method !== 'progress') notifications.push(message);
  });
  let next = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = ++next;
    const timer = setTimeout(() => reject(new Error(method + ' timed out')), 30000);
    replies.set(id, message => { clearTimeout(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
    worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const credentials = async (dir, store) => {
    await fs.mkdir(path.join(dir, '.zcode', 'v2'), { recursive: true });
    await fs.writeFile(path.join(dir, '.zcode', 'v2', 'credentials.json'), JSON.stringify(store));
  };
  return { tmp, home, cli, call, credentials, notifications };
}

test('accountStatus reports the name and email of the account in its own directory', async t => {
  const { tmp, home, call, credentials, notifications } = await workerFixture(t);
  // The original login (the user's ZCode home) and an account Cindy added.
  await credentials(home, {
    'oauth:active_provider': 'bigmodel',
    'oauth:bigmodel:access_token': 'fixture',
    'oauth:bigmodel:user_info': JSON.stringify({ id: 'b-1', username: 'Original User', displayName: 'Original User' }),
  });
  const account = path.join(tmp, 'accounts', 'cindy-a');
  await credentials(account, {
    'oauth:active_provider': 'zai',
    'oauth:zai:access_token': 'fixture',
    'oauth:zai:user_info': JSON.stringify({ id: 'z-42', name: 'Zed User', email: 'zed@example.com' }),
  });
  const added = await call('accountStatus', { harnessId: 'zcode', accountDir: account });
  assert.equal(added.state, 'signed-in');
  assert.deepEqual(added.identity, { email: 'zed@example.com', name: 'Zed User' });
  assert.match(added.fingerprint, /^[0-9a-f]{32}$/);
  assert.deepEqual(added.models, []);

  // main.js learns the account's models (to list them for the engine) from this.
  assert.deepEqual(notifications.filter(message => message.method === 'account-models'),
    [{ jsonrpc: '2.0', method: 'account-models', params: { dir: account, models: [] } }]);

  const original = await call('accountStatus', { harnessId: 'zcode' });
  assert.equal(original.state, 'signed-in');
  assert.deepEqual(original.identity, { name: 'Original User' });
  assert.notEqual(original.fingerprint, added.fingerprint);
  // The engine lists the added accounts' models too, so the original login names its own.
  assert.deepEqual(original.models, []);
  // The settings page keeps its own view of the original login, still without the email.
  assert.deepEqual(await call('account', {}), { signedIn: true, family: 'bigmodel', name: 'Original User', plan: 'absent', signIn: 'cli' });

  // An added account with nothing in it is signed out; anything else is no data.
  const empty = path.join(tmp, 'accounts', 'cindy-b');
  await fs.mkdir(empty, { recursive: true });
  assert.deepEqual(await call('accountStatus', { harnessId: 'zcode', accountDir: empty }), { state: 'signed-out' });
  const missing = path.join(tmp, 'accounts', 'missing');
  assert.equal(await call('accountStatus', { harnessId: 'zcode', accountDir: missing }), null);
  // A removed account folder is forgotten.
  assert.ok(notifications.some(message => message.method === 'account-models'
    && message.params.dir === missing && message.params.removed === true));
  assert.equal(await call('accountStatus', { harnessId: 'zcode', accountDir: home }), null);
  assert.equal(await call('accountStatus', { harnessId: 'other', accountDir: account }), null);
  assert.equal(await call('usage', { harnessId: 'zcode', accountDir: empty }), null);
  assert.deepEqual(await call('accountLoginCancel', { harnessId: 'zcode', accountDir: account }), { ok: true });
  // Browser sign-in of a stand-in CLI that is not a desktop app runs `zcode login`;
  // an unknown method is refused before anything starts.
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', accountDir: account, methodId: 'github' }),
    { ok: false, error: 'unsupported' });
});

test('a browser sign-in runs `zcode login` in the account directory and can be cancelled', async t => {
  const { tmp, home, cli, call, credentials } = await workerFixture(t);
  await credentials(home, { 'oauth:active_provider': 'bigmodel', 'oauth:bigmodel:access_token': 'fixture' });
  const original = await fs.readFile(path.join(home, '.zcode', 'v2', 'credentials.json'), 'utf8');
  // A standalone CLI stand-in: `login bigmodel` saves a sign-in where ZCode's data
  // root points; `login zai` keeps waiting for the browser.
  await fs.writeFile(cli, `const fs = require('node:fs'), path = require('node:path');
const [command, family] = process.argv.slice(2);
if (command !== 'login') process.exit(2);
process.stderr.write('Fallback URL: https://example.invalid/authorize\\n');
if (family === 'zai') setInterval(() => {}, 1000);
else {
  const v2 = path.join(process.env.ZCODE_DATA_BASE_DIR, '.zcode', 'v2');
  fs.mkdirSync(v2, { recursive: true });
  fs.writeFileSync(path.join(v2, 'credentials.json'), JSON.stringify({
    'oauth:active_provider': 'bigmodel', 'oauth:bigmodel:access_token': 'fixture',
    'oauth:bigmodel:user_info': JSON.stringify({ id: 'b-7', username: 'second@example.com', displayName: 'Second User' }),
  }));
  console.log(JSON.stringify({ status: 'ready' }));
}
`);
  // The account used a Coding Plan API key before; signing in replaces it.
  const keyRule = (providerId, apiKey) => ({ providerId, templateId: providerId, providerName: 'BigModel Coding Plan', config: {
    access: { type: 'zhipu-coding-plan-api-key', apiKey }, api: { baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
  } });
  const providers = (dir, rules) => fs.mkdir(path.join(dir, '.zcode', 'v2'), { recursive: true }).then(() =>
    fs.writeFile(path.join(dir, '.zcode', 'v2', 'provider_config.json'), JSON.stringify({ schemaVersion: 1, config: {
      providerConfigRules: { providerRules: rules } } })));
  const account = path.join(tmp, 'accounts', 'cindy-browser');
  await providers(account, [keyRule('bigmodel-api', 'old-key-1234'), { providerId: 'custom', config: { access: { type: 'api-key' } } }]);
  assert.deepEqual((await call('accountStatus', { harnessId: 'zcode', accountDir: account })).identity,
    { detail: 'BigModel API Key ····1234' });
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', accountDir: account, methodId: 'bigmodel-browser' }), { ok: true });
  const status = await call('accountStatus', { harnessId: 'zcode', accountDir: account });
  assert.equal(status.state, 'signed-in');
  assert.deepEqual(status.identity, { email: 'second@example.com', name: 'Second User' });
  assert.match(status.fingerprint, /^[0-9a-f]{32}$/);
  const kept = JSON.parse(await fs.readFile(path.join(account, '.zcode', 'v2', 'provider_config.json'), 'utf8'));
  assert.deepEqual(kept.config.providerConfigRules.providerRules.map(rule => rule.providerId), ['custom']);

  const waiting = path.join(tmp, 'accounts', 'cindy-waiting');
  await fs.mkdir(waiting, { recursive: true });
  const pending = call('accountLogin', { harnessId: 'zcode', accountDir: waiting, methodId: 'zai-browser' });
  await new Promise(resolve => setTimeout(resolve, 1500));
  // One sign-in at a time; cancelling another account's leaves this one running.
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', accountDir: account, methodId: 'bigmodel-browser' }),
    { ok: false, error: 'busy' });
  assert.deepEqual(await call('accountLoginCancel', { harnessId: 'zcode', accountDir: account }), { ok: true });
  assert.equal(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('running'), 500))]), 'running');
  assert.deepEqual(await call('accountLoginCancel', { harnessId: 'zcode', accountDir: waiting }), { ok: true });
  assert.deepEqual(await pending, { ok: false, error: 'cancelled' });
  assert.equal(await fs.readFile(path.join(home, '.zcode', 'v2', 'credentials.json'), 'utf8'), original);

  // The original login (shared with ZCode desktop) is never switched between a
  // key and a sign-in here, and its credentials are never removed.
  await providers(home, [keyRule('bigmodel-api', 'desktop-key-5678')]);
  const desktopProviders = await fs.readFile(path.join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8');
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', methodId: 'bigmodel-browser' }),
    { ok: false, error: 'unsupported', message: 'ZCode uses a Coding Plan API key here. Change it in ZCode.' });
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', methodId: 'bigmodel-key', secret: 'new-key-0000' }),
    { ok: false, error: 'unsupported', message: 'Add API keys of the original ZCode login in ZCode.' });
  assert.equal(await fs.readFile(path.join(home, '.zcode', 'v2', 'provider_config.json'), 'utf8'), desktopProviders);
  assert.equal(await fs.readFile(path.join(home, '.zcode', 'v2', 'credentials.json'), 'utf8'), original);
});

test('ZCode stays available without a usable original login, so accounts can be added', async t => {
  const { tmp, cli, call } = await workerFixture(t);
  await fs.writeFile(cli, `if (process.argv.includes('--version')) console.log('0.17.1');\n`);
  const kept = path.join(tmp, 'accounts', 'cindy-kept');
  await fs.mkdir(kept, { recursive: true });
  const detected = await call('detect', { accountDirs: [kept, path.join(tmp, 'accounts', 'removed'), path.join(tmp, 'home')] });
  assert.equal(detected.available, true);
  assert.equal(detected.reason, 'sign-in-required');
  assert.deepEqual(detected.models, []);
  assert.equal(detected.signIn, 'cli');
  // Only folders that are still added accounts of their own come back.
  assert.deepEqual(detected.accountDirs, [kept]);
  // With nothing to run, the original login is signed out (not merely unknown).
  assert.deepEqual(await call('accountStatus', { harnessId: 'zcode' }), { state: 'signed-out' });
});

test('turn failures say whether the account is used up, signed out or busy', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-errors-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'probe.mjs');
  const adapter = new URL('../vendor/dist/adapter.mjs', import.meta.url).href;
  // Payloads in the shape of the bridge's acpTurnFailureData.
  await fs.writeFile(script, `import { withCindyErrorMeta } from ${JSON.stringify(adapter)};
    const now = Date.now();
    const cases = {
      quota: [{ type: 'zcode_turn_failed', code: 'model_rate_limited', reason: 'rate_limited', statusCode: 429, providerCode: '1308', retryable: false, retryAfterMs: 3600000 }],
      expired: [{ type: 'zcode_turn_failed', providerCode: '1309', statusCode: 400 }],
      quotaRaw: [{ type: 'zcode_turn_failed', code: 'model_rate_limited' }, { cause: { code: 'model_rate_limited', context: { providerCode: '1310', reason: 'rate_limited', retryable: false } } }],
      key: [{ type: 'zcode_turn_failed', code: 'model_request_failed', statusCode: 401 }],
      token: [{ type: 'zcode_turn_failed', providerCode: '1002', statusCode: 400 }],
      busy: [{ type: 'zcode_turn_failed', providerCode: '1302', statusCode: 429, retryable: false }],
      down: [{ type: 'zcode_turn_failed', code: 'model_request_failed', statusCode: 503 }],
      other: [{ type: 'zcode_turn_failed', code: 'model_request_failed', statusCode: 400 }],
    };
    const out = {};
    for (const [name, [data, turnError]] of Object.entries(cases)) out[name] = withCindyErrorMeta(data, turnError ?? {});
    console.log(JSON.stringify({ now, out }));
  `);
  const { stdout } = await promisify(execFile)(process.execPath, [script], { cwd: dir, windowsHide: true });
  const { now, out } = JSON.parse(stdout);
  const kind = name => out[name]._meta?.cindy;
  assert.equal(kind('quota').kind, 'usage-limit');
  assert.ok(kind('quota').resetsAt >= now + 3600000 - 1000 && kind('quota').resetsAt <= now + 3600000 + 60000);
  assert.equal(out.quota.providerCode, '1308');
  assert.deepEqual(kind('expired'), { kind: 'usage-limit' });
  assert.deepEqual(kind('quotaRaw'), { kind: 'usage-limit' });
  assert.deepEqual(kind('key'), { kind: 'auth-required' });
  assert.deepEqual(kind('token'), { kind: 'auth-required' });
  assert.deepEqual(kind('busy'), { kind: 'overloaded' });
  assert.deepEqual(kind('down'), { kind: 'overloaded' });
  assert.deepEqual(out.other, { type: 'zcode_turn_failed', code: 'model_request_failed', statusCode: 400 });
});
