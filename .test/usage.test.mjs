import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('packaged ZCode reader checks only its billing origin and preserves exhausted windows', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-usage-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const zcode = path.join(home, '.zcode');
  const cfg = path.join(zcode, 'v2');
  await fs.mkdir(cfg, { recursive: true });
  const probe = path.join(home, 'probe.mjs');
  const adapter = new URL('../vendor/dist/adapter.mjs', import.meta.url).href;
  await fs.writeFile(probe, `import { readPlanUsage } from ${JSON.stringify(adapter)};
    const calls = [];
    const usage = await readPlanUsage(async (url, options) => {
      calls.push([url, options.redirect, options.headers.Authorization === 'Bearer fixture']);
      if (url.startsWith('https://zcode.z.ai/')) return Response.json({ code: 0, data: {
        plans: [{ status: 'active', plan_id: 'zcode-test', name: 'ZCode Test' }],
        balances: [{ plan_id: 'zcode-test', total_units: 10, remaining_units: 0,
          show_name: 'Grant', expires_at: 1893456000 }],
      } });
      return Response.json({ success: true, data: { limits: [
        { type: 'TOKENS_LIMIT', number: 5, percentage: 100, nextResetTime: 1893456000000 }
      ] } });
    });
    console.log(JSON.stringify({ calls, usage }));
  `);
  const env = { ...process.env, ZCODE_HOME: zcode, HOME: home, USERPROFILE: home,
    APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, ZCODE_PROVIDER: 'local' };
  const run = async baseURL => {
    await fs.writeFile(path.join(cfg, 'config.json'), JSON.stringify({ provider: {
      local: { enabled: true, models: { example: {} }, options: { apiKey: 'fixture', baseURL } },
    } }));
    const { stdout } = await promisify(execFile)(process.execPath, [probe], { env, cwd: home, windowsHide: true });
    return JSON.parse(stdout);
  };
  assert.deepEqual(await run('https://custom.invalid'), { calls: [], usage: null });
  const plan = await run('https://api.z.ai/api/anthropic');
  assert.deepEqual(plan.calls, [['https://api.z.ai/api/monitor/usage/quota/limit', 'error', true]]);
  assert.deepEqual(plan.usage.windows, [{ label: 'Z.ai · 5h', remainingPercent: 0, resetsAt: 1893456000000 }]);
  assert.ok(plan.usage.updatedAt > 0);
  await fs.writeFile(path.join(cfg, 'credentials.json'), JSON.stringify({ zcodejwttoken: 'fixture' }));
  await fs.writeFile(path.join(cfg, 'telemetry-state.json'), JSON.stringify({ deviceMid: 'test-device' }));
  const grant = await run('https://custom.invalid');
  assert.deepEqual(grant.calls, [['https://zcode.z.ai/api/v1/zcode-plan/billing/balance', 'error', true]]);
  assert.deepEqual(grant.usage.windows, [{ label: 'ZCode Test · Grant', remainingPercent: 0 }]);
});
