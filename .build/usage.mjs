import { loadZcodeCredentials } from 'zcode-acp-server/dist/backend/credentials.js';
import { accountProviderIdFor, codingPlanRequestAuthFor, oauthProjectTokenFamilyFor } from 'zcode-acp-server/dist/config/account-provider.js';
import { resolveOAuthProjectToken } from 'zcode-acp-server/dist/config/project-token.js';
import { parseQuotaEnvelope } from 'zcode-acp-server/dist/quota/parse.js';
import { codingPlanApiKeys } from './templates.mjs';

const regions = { bigmodel: 'https://open.bigmodel.cn', zai: 'https://api.z.ai' };
// Both quota services answer an account without the subscription with
// { success: false, msg: "当前用户不存在coding plan" }.
const noPlan = /不存在\s*coding\s*plan|no\s+coding\s+plan/i;

// A user may add the same platform's key several times in ZCode. Read at most
// this many distinct keys per platform.
const KEYS_PER_PLATFORM = 3;

async function quota(origin, key, request) {
  const response = await request(origin + '/api/monitor/usage/quota/limit', {
    headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return { state: 'unknown', items: [] };
  const json = await response.json();
  if (json?.success === false && noPlan.test(String(json.msg ?? ''))) return { state: 'none', items: [] };
  const result = parseQuotaEnvelope({ status: response.status, json, text: '' });
  // A refusal here says nothing about the key: on 2026-11-20 BigModel answered
  // a working Coding Plan API key with { code: 401, msg: "令牌已过期或验证不正确" }
  // while the same key ran GLM-5.3 turns.
  return result.kind === 'success' ? { state: 'active', items: result.items } : { state: 'unknown', items: [] };
}

// state: 'active' (quota returned), 'none' (the service says there is no plan),
// 'absent' (no Coding Plan credential for this family), 'unknown' (unreadable).
async function codingPlan(family, origin, legacy, request, apiKeys) {
  const id = accountProviderIdFor('builtin:' + family + '-coding-plan');
  let key = codingPlanRequestAuthFor(id)?.apiKey;
  if (!key && oauthProjectTokenFamilyFor(id) === family) key = (await resolveOAuthProjectToken(family)).token;
  // Older ZCode stores the active provider URL and key together. A personal or
  // proxy provider's credential must never be sent to either billing service.
  if (!key && legacy.providerBaseURL && new URL(legacy.providerBaseURL).origin === origin) key = legacy.ANTHROPIC_API_KEY;
  const keys = [...(key ? [{ key, name: '' }] : []), ...apiKeys.filter(entry => entry.key !== key)].slice(0, KEYS_PER_PLATFORM);
  if (!keys.length) return { state: 'absent', windows: [] };
  const platform = family === 'zai' ? 'Z.ai' : 'BigModel';
  const results = await Promise.all(keys.map(entry => quota(origin, entry.key, request).catch(() => ({ state: 'unknown', items: [] }))));
  const state = ['active', 'none', 'unknown'].find(value => results.some(result => result.state === value));
  return {
    state,
    windows: results.flatMap((result, index) => result.items.map(item => ({
      // Several keys of one platform are told apart by their ZCode names.
      label: (keys.length > 1 && keys[index].name ? keys[index].name : platform) + ' · ' + item.label,
      remainingPercent: item.leftPercent,
      ...(item.nextResetTime > 0 ? { resetsAt: item.nextResetTime } : {}),
    }))),
  };
}

function shown(row) {
  return typeof row.label === 'string' && row.label.trim() && row.label.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(row.label) && Number.isFinite(row.remainingPercent) &&
    row.remainingPercent >= 0 && row.remainingPercent <= 100;
}

// One quota request per Coding Plan credential. Start Plan is not read: Cindy
// cannot run it (see the model list adaptation in build.mjs).
export async function readCodingPlans(request = fetch) {
  const legacy = loadZcodeCredentials();
  const apiKeys = codingPlanApiKeys();
  const entries = await Promise.all(Object.entries(regions).map(async ([family, origin]) => {
    const plan = await codingPlan(family, origin, legacy, request, apiKeys[family])
      .catch(() => ({ state: 'unknown', windows: [] }));
    return [family, plan];
  }));
  const plans = Object.fromEntries(entries.map(([family, plan]) => [family, plan.state]));
  const windows = entries.flatMap(([, plan]) => plan.windows).filter(shown).slice(0, 24);
  return { plans, usage: windows.length ? { updatedAt: Date.now(), windows } : null };
}

export async function readPlanUsage(request = fetch) {
  return (await readCodingPlans(request)).usage;
}
