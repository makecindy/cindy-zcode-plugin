import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
