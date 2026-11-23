import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Run the packaged reader in a child with an isolated ZCode home, as the
// plugin worker does. Each fixture answer is chosen by the request URL.
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-usage-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const cfg = path.join(home, '.zcode', 'v2');
  await fs.mkdir(cfg, { recursive: true });
  const probe = path.join(home, 'probe.mjs');
  const adapter = new URL('../vendor/dist/adapter.mjs', import.meta.url).href;
  await fs.writeFile(probe, `import { readCodingPlans } from ${JSON.stringify(adapter)};
    const answer = JSON.parse(process.env.FIXTURE_ANSWER);
    const calls = [];
    const result = await readCodingPlans(async (url, options) => {
      calls.push([url, options.redirect, options.headers.Authorization === 'Bearer fixture']);
      return Response.json(answer);
    });
    console.log(JSON.stringify({ calls, ...result }));
  `);
  const env = { ...process.env, ZCODE_HOME: path.join(home, '.zcode'), HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, ZCODE_PROVIDER: 'local',
    // A missing install keeps the bridge from reading a real ZCode's table.
    ZCODE_BIN: path.join(home, 'missing', 'zcode.cjs') };
  delete env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
  return async (baseURL, answer) => {
    await fs.writeFile(path.join(cfg, 'config.json'), JSON.stringify({ provider: {
      local: { enabled: true, models: { example: {} }, options: { apiKey: 'fixture', baseURL } },
    } }));
    // A Start Plan sign-in must not be queried: Cindy cannot run that plan.
    await fs.writeFile(path.join(cfg, 'credentials.json'), JSON.stringify({ zcodejwttoken: 'fixture' }));
    const { stdout } = await promisify(execFile)(process.execPath, [probe], {
      env: { ...env, FIXTURE_ANSWER: JSON.stringify(answer) }, cwd: home, windowsHide: true,
    });
    return JSON.parse(stdout);
  };
}

test('Coding Plan quota is read only from its own billing origin; Start Plan is not queried', async t => {
  const run = await fixture(t);
  const quota = { success: true, data: { limits: [
    { type: 'TOKENS_LIMIT', number: 5, percentage: 100, nextResetTime: 1893456000000 },
  ] } };
  const custom = await run('https://custom.invalid', quota);
  assert.deepEqual(custom.calls, []);
  assert.deepEqual(custom.plans, { bigmodel: 'absent', zai: 'absent' });
  assert.equal(custom.usage, null);

  const active = await run('https://api.z.ai/api/anthropic', quota);
  assert.deepEqual(active.calls, [['https://api.z.ai/api/monitor/usage/quota/limit', 'error', true]]);
  assert.deepEqual(active.plans, { bigmodel: 'absent', zai: 'active' });
  assert.deepEqual(active.usage.windows, [{ label: 'Z.ai · 5h', remainingPercent: 0, resetsAt: 1893456000000, windowMinutes: 300 }]);
  assert.ok(active.usage.updatedAt > 0);
});

test('windows carry their length, the tool quota limits no model, and the plan tier is kept', async t => {
  const run = await fixture(t);
  const result = await run('https://api.z.ai/api/anthropic', { success: true, data: { level: 'pro', limits: [
    { type: 'TIME_LIMIT', usage: 1000, currentValue: 1000, remaining: 0, nextResetTime: 1895000000000 },
    { type: 'TOKENS_LIMIT', number: 7, percentage: 30, nextResetTime: 1894000000000 },
    { type: 'TOKENS_LIMIT', number: 5, percentage: 10, nextResetTime: 1893456000000 },
  ] } });
  assert.deepEqual(result.usage.windows, [
    { label: 'Z.ai · 5h', remainingPercent: 90, resetsAt: 1893456000000, windowMinutes: 300 },
    { label: 'Z.ai · Week', remainingPercent: 70, resetsAt: 1894000000000, windowMinutes: 10080 },
    // Used-up web search / reader calls must not stop Cindy from using the account's models.
    { label: 'Z.ai · MCP', remainingPercent: 0, resetsAt: 1895000000000, models: [] },
  ]);
  assert.deepEqual(result.levels, { zai: 'pro' });
});

test('an account without a Coding Plan is reported as having none', async t => {
  const run = await fixture(t);
  // The quota service's answer for an account without the plan (api.z.ai, 2026-11-20).
  const none = await run('https://open.bigmodel.cn/api/anthropic', { code: 500, msg: '当前用户不存在coding plan', success: false });
  assert.deepEqual(none.calls, [['https://open.bigmodel.cn/api/monitor/usage/quota/limit', 'error', true]]);
  assert.deepEqual(none.plans, { bigmodel: 'none', zai: 'absent' });
  assert.equal(none.usage, null);
  const unknown = await run('https://open.bigmodel.cn/api/anthropic', { code: 500, msg: 'busy', success: false });
  assert.deepEqual(unknown.plans, { bigmodel: 'unknown', zai: 'absent' });
});
