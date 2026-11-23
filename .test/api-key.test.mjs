import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// ZCode 3.18.2 saves a "BigModel Coding Plan" API key added in its model
// settings as a provider that names a template and holds only the key. The
// address and models stay in zcode-builtin.json. Unit tier: the packaged bridge
// reads an isolated ZCode home in a child process, as the plugin worker does.
const template = {
  templateId: 'bigmodel-api',
  config: {
    access: { type: 'zhipu-coding-plan-api-key' },
    api: { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' },
    builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash', 'GLM-5-Turbo'],
  },
};
const provider = (providerId, providerName, apiKey) => ({ providerId, templateId: 'bigmodel-api', providerName, config: {
  group: 'standard-personal', access: { type: 'zhipu-coding-plan-api-key', apiKey }, personalModelIds: [], modelOrder: [],
} });

async function probe(t, providers, answers) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-api-key-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cfg = path.join(home, '.zcode', 'v2');
  await fs.mkdir(cfg, { recursive: true });
  // A stand-in ZCode install, so a real one on this computer is never read.
  const cli = path.join(home, 'zcode', 'zcode.cjs');
  await fs.mkdir(path.join(home, 'zcode', 'provider'), { recursive: true });
  await fs.writeFile(cli, '');
  await fs.writeFile(path.join(home, 'zcode', 'provider', 'zcode-builtin.json'), JSON.stringify({ schemaVersion: 1, revision: 1, config: {
    providerConfigRules: { templateRules: [template], providerRules: [] },
    modelConfigRules: { templateModelRules: [{ modelId: 'GLM-5-Turbo', templateId: 'bigmodel-api', config: { enabled: false } }] },
  } }));
  await fs.writeFile(path.join(cfg, 'provider_config.json'), JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: providers },
  } }));
  const script = path.join(home, 'probe.mjs');
  const adapter = new URL('../vendor/dist/adapter.mjs', import.meta.url).href;
  await fs.writeFile(script, `import { buildInitialConfigOptions, readAccount, readCodingPlans } from ${JSON.stringify(adapter)};
    const answers = JSON.parse(process.env.FIXTURE_ANSWERS);
    const options = await buildInitialConfigOptions({ backendKind: 'zcode' });
    const models = options.find(item => item.category === 'model')?.options.map(item => item.value) ?? [];
    const calls = [];
    const plans = await readCodingPlans(async (url, request) => {
      const key = request.headers.Authorization.replace(/^Bearer /, '');
      calls.push([url, key]);
      return Response.json(answers[key]);
    });
    console.log(JSON.stringify({ models, account: readAccount(), calls, ...plans }));
  `);
  const env = { ...process.env, ZCODE_HOME: path.join(home, '.zcode'), HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, ZCODE_BIN: cli, FIXTURE_ANSWERS: JSON.stringify(answers) };
  delete env.ZCODE_PROVIDER;
  delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  const { stdout } = await promisify(execFile)(process.execPath, [script], { env, cwd: home, windowsHide: true });
  return JSON.parse(stdout);
}

const rejected = { code: 401, msg: '令牌已过期或验证不正确', success: false };
const quota = { success: true, data: { limits: [{ type: 'TOKENS_LIMIT', number: 5, percentage: 40, nextResetTime: 1893456000000 }] } };

test('a template API key provider lists the template models and is read once per distinct key', async t => {
  const result = await probe(t, [
    provider('bigmodel-api', 'BigModel Coding Plan', 'key-a'),
    provider('bigmodel-api-2', 'BigModel Coding Plan 2', 'key-a'),
    provider('bigmodel-api-3', 'BigModel Coding Plan 3', 'key-b'),
  ], { 'key-a': rejected, 'key-b': quota });
  assert.deepEqual(result.models, [
    'bigmodel-api\\GLM-5.3', 'bigmodel-api\\GLM-5.3-Flash',
    'bigmodel-api-2\\GLM-5.3', 'bigmodel-api-2\\GLM-5.3-Flash',
    'bigmodel-api-3\\GLM-5.3', 'bigmodel-api-3\\GLM-5.3-Flash',
  ]);
  assert.deepEqual(result.account, { signedIn: false, apiKeys: ['bigmodel'] });
  const quotaUrl = 'https://open.bigmodel.cn/api/monitor/usage/quota/limit';
  assert.deepEqual(result.calls.sort(), [[quotaUrl, 'key-a'], [quotaUrl, 'key-b']]);
  assert.deepEqual(result.plans, { bigmodel: 'active', zai: 'absent' });
  assert.deepEqual(result.usage.windows, [{ label: 'BigModel Coding Plan 3 · 5h', remainingPercent: 60, resetsAt: 1893456000000, windowMinutes: 300 }]);
});

test('a quota refusal leaves the plan unknown, not the key invalid', async t => {
  // BigModel's quota service refused a working Coding Plan API key with this
  // answer (2026-11-20); the same key ran GLM-5.3 turns through ZCode.
  const result = await probe(t, [provider('bigmodel-api', 'BigModel Coding Plan', 'key-a')], { 'key-a': rejected });
  assert.deepEqual(result.account, { signedIn: false, apiKeys: ['bigmodel'] });
  assert.deepEqual(result.plans, { bigmodel: 'unknown', zai: 'absent' });
  assert.equal(result.usage, null);
});

// Cindy engine accounts: a Coding Plan API key typed into Cindy becomes an
// account of its own. Through the worker's JSON-RPC, with a stand-in ZCode
// install, temporary homes and a closed local proxy (no quota service is asked).
test('an API key login writes the key only into the account directory', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-api-key-account-'));
  const home = path.join(tmp, 'home');
  const cli = path.join(tmp, 'zcode', 'zcode.cjs');
  await fs.mkdir(path.join(tmp, 'zcode', 'provider'), { recursive: true });
  await fs.writeFile(cli, '');
  const zaiTemplate = { templateId: 'zai-api', providerName: 'Z.ai Coding Plan', config: {
    access: { type: 'zhipu-coding-plan-api-key' },
    api: { type: 'anthropic-messages', baseUrl: 'https://api.z.ai/api/anthropic' },
    builtinModelIds: ['GLM-5.3'],
  } };
  // The platform's Coding Plan as the installed table names it: a key saved
  // with its address also entitles these models, the ids a sign-in lists.
  const plan = { providerId: 'account:bigmodel-individual-coding-plan', providerName: 'BigModel Coding Plan', config: {
    access: { type: 'zhipu-account', accountType: 'bigmodel', mode: 'individual-coding-plan' },
    api: { type: 'anthropic-messages', baseUrl: 'https://open.bigmodel.cn/api/anthropic' }, builtinModelIds: ['GLM-5.3'],
  } };
  await fs.writeFile(path.join(tmp, 'zcode', 'provider', 'zcode-builtin.json'), JSON.stringify({ schemaVersion: 1, revision: 1, config: {
    providerConfigRules: { templateRules: [template, zaiTemplate], providerRules: [plan] },
    modelConfigRules: { templateModelRules: [{ modelId: 'GLM-5-Turbo', templateId: 'bigmodel-api', config: { enabled: false } }] },
  } }));
  // The original login keeps its own key; it must stay byte for byte.
  await fs.mkdir(path.join(home, '.zcode', 'v2'), { recursive: true });
  await fs.writeFile(path.join(home, '.zcode', 'v2', 'provider_config.json'), JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [provider('bigmodel-api', 'BigModel Coding Plan', 'original-key')] },
  } }));
  const accounts = path.join(tmp, 'accounts');
  const account = path.join(accounts, 'cindy-key');
  // The account was signed in with the browser before; the key replaces that sign-in.
  await fs.mkdir(path.join(account, '.zcode', 'v2'), { recursive: true });
  const signIn = path.join(account, '.zcode', 'v2', 'credentials.json');
  await fs.writeFile(signIn, JSON.stringify({ 'oauth:active_provider': 'bigmodel', 'oauth:bigmodel:access_token': 'fixture',
    'oauth:bigmodel:user_info': JSON.stringify({ id: 'b-9', displayName: 'Browser User' }) }));
  const snapshot = async () => {
    const files = {};
    for (const entry of await fs.readdir(tmp, { recursive: true, withFileTypes: true })) {
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      if (entry.isFile() && !file.startsWith(accounts + path.sep)) files[path.relative(tmp, file)] = await fs.readFile(file, 'utf8');
    }
    return files;
  };
  const before = await snapshot();

  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: path.join(tmp, 'config'), ZCODE_BIN: cli, ZCODE_NODE: process.execPath,
    NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '' };
  for (const key of ['ZCODE_HOME', 'ZCODE_DATA_BASE_DIR', 'ZCODE_PROVIDER', 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
    'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_GUEST_ORIGINAL_CREDENTIALS_PATH']) delete env[key];
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../worker.cjs', import.meta.url))], {
    env, cwd: tmp, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '';
  worker.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => worker.on('close', resolve));
  t.after(async () => {
    worker.kill();
    await exited;
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => {});
  });
  const replies = new Map();
  readline.createInterface({ input: worker.stdout }).on('line', line => {
    output += line + '\n';
    const message = JSON.parse(line);
    if (message.id != null) replies.get(message.id)?.(message.result);
  });
  let next = 0;
  const call = (method, params) => new Promise(resolve => {
    const id = ++next;
    replies.set(id, resolve);
    worker.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const saved = () => fs.readFile(path.join(account, '.zcode', 'v2', 'provider_config.json'), 'utf8').then(JSON.parse);

  // Format checks and the original login come first: nothing is written.
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', accountDir: account, methodId: 'bigmodel-key', secret: 'two words' }),
    { ok: false, error: 'invalid-secret' });
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', methodId: 'bigmodel-key', secret: 'fixture-key-abcd' }),
    { ok: false, error: 'unsupported', message: 'Add API keys of the original ZCode login in ZCode.' });
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', accountDir: home, methodId: 'bigmodel-key', secret: 'fixture-key-abcd' }),
    { ok: false, error: 'failed', message: 'The account folder cannot be used.' });
  // Links do not lead back to the original login either: a linked account
  // folder, or one under a linked parent folder (junctions on Windows).
  const linkedHome = path.join(tmp, 'linked-home');
  const linkedParent = path.join(tmp, 'linked-parent');
  await fs.symlink(home, linkedHome, 'junction');
  await fs.symlink(tmp, linkedParent, 'junction');
  for (const dir of [linkedHome, path.join(linkedParent, 'home')]) {
    assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', accountDir: dir, methodId: 'bigmodel-key', secret: 'fixture-key-abcd' }),
      { ok: false, error: 'failed', message: 'The account folder cannot be used.' }, dir);
    assert.equal(await call('accountStatus', { harnessId: 'zcode', accountDir: dir }), null, dir);
  }

  // Cancelled before the key is written: nothing is saved.
  const cancelled = path.join(accounts, 'cindy-cancelled');
  await fs.mkdir(cancelled, { recursive: true });
  const loginId = ++next;
  const loginResult = new Promise(resolve => replies.set(loginId, resolve));
  worker.stdin.write([
    { jsonrpc: '2.0', id: loginId, method: 'accountLogin', params: { harnessId: 'zcode', accountDir: cancelled, methodId: 'bigmodel-key', secret: 'fixture-key-abcd' } },
    { jsonrpc: '2.0', id: ++next, method: 'accountLoginCancel', params: { harnessId: 'zcode', accountDir: cancelled } },
  ].map(message => JSON.stringify(message)).join('\n') + '\n');
  assert.deepEqual(await loginResult, { ok: false, error: 'cancelled' });
  await assert.rejects(fs.stat(path.join(cancelled, '.zcode', 'v2', 'provider_config.json')), { code: 'ENOENT' });

  assert.equal((await call('accountStatus', { harnessId: 'zcode', accountDir: account })).identity.name, 'Browser User');
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', accountDir: account, methodId: 'bigmodel-key', secret: ' fixture-key-abcd\n' }),
    { ok: true });
  await assert.rejects(fs.stat(signIn), { code: 'ENOENT' }, 'the previous browser sign-in of the account is removed');
  assert.deepEqual((await saved()).config.providerConfigRules.providerRules, [{
    providerId: 'bigmodel-api', templateId: 'bigmodel-api', providerName: 'BigModel Coding Plan',
    config: { group: 'standard-personal', access: { type: 'zhipu-coding-plan-api-key', apiKey: 'fixture-key-abcd' },
      api: { baseUrl: 'https://open.bigmodel.cn/api/anthropic' }, personalModelIds: [], modelOrder: [] },
  }]);
  const status = await call('accountStatus', { harnessId: 'zcode', accountDir: account });
  assert.equal(status.state, 'signed-in');
  assert.deepEqual(status.identity, { detail: 'BigModel API Key ····abcd' });
  // Nothing is derived from the key but its last four characters.
  assert.equal('fingerprint' in status, false);
  assert.deepEqual([...status.models].sort(), [
    'account:bigmodel-individual-coding-plan\\GLM-5.3', 'bigmodel-api\\GLM-5.3', 'bigmodel-api\\GLM-5.3-Flash',
  ]);

  // One account is one key: a new key replaces the previous one.
  assert.deepEqual(await call('accountLogin', { harnessId: 'zcode', accountDir: account, methodId: 'zai-key', secret: 'fixture-key-wxyz' }),
    { ok: true });
  const rules = (await saved()).config.providerConfigRules.providerRules;
  assert.deepEqual(rules.map(rule => [rule.providerId, rule.config.access.apiKey]), [['zai-api', 'fixture-key-wxyz']]);
  const replaced = await call('accountStatus', { harnessId: 'zcode', accountDir: account });
  assert.deepEqual(replaced.identity, { detail: 'Z.ai API Key ····wxyz' });

  assert.deepEqual(await snapshot(), before);
  assert.ok(!output.includes('fixture-key-abcd') && !output.includes('fixture-key-wxyz'), 'the key never appears in worker output');
});
