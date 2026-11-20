import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
  assert.deepEqual(result.usage.windows, [{ label: 'BigModel Coding Plan 3 · 5h', remainingPercent: 60, resetsAt: 1893456000000 }]);
});

test('a quota refusal leaves the plan unknown, not the key invalid', async t => {
  // BigModel's quota service refused a working Coding Plan API key with this
  // answer (2026-11-20); the same key ran GLM-5.3 turns through ZCode.
  const result = await probe(t, [provider('bigmodel-api', 'BigModel Coding Plan', 'key-a')], { 'key-a': rejected });
  assert.deepEqual(result.account, { signedIn: false, apiKeys: ['bigmodel'] });
  assert.deepEqual(result.plans, { bigmodel: 'unknown', zai: 'absent' });
  assert.equal(result.usage, null);
});
