import { loadZcodeCredentials } from 'zcode-acp-server/dist/backend/credentials.js';
import { accountProviderIdFor, codingPlanRequestAuthFor, oauthProjectTokenFamilyFor } from 'zcode-acp-server/dist/config/account-provider.js';
import { resolveOAuthProjectToken } from 'zcode-acp-server/dist/config/project-token.js';
import { parseQuotaEnvelope } from 'zcode-acp-server/dist/quota/parse.js';

const regions = { bigmodel: 'https://open.bigmodel.cn', zai: 'https://api.z.ai' };
// Both quota services answer an account without the subscription with
// { success: false, msg: "当前用户不存在coding plan" }.
const noPlan = /不存在\s*coding\s*plan|no\s+coding\s+plan/i;

// state: 'active' (quota returned), 'none' (the service says there is no plan),
// 'absent' (no Coding Plan credential for this family), 'unknown' (unreadable).
async function codingPlan(family, origin, legacy, request) {
  const id = accountProviderIdFor('builtin:' + family + '-coding-plan');
  let key = codingPlanRequestAuthFor(id)?.apiKey;
  if (!key && oauthProjectTokenFamilyFor(id) === family) key = (await resolveOAuthProjectToken(family)).token;
  // Older ZCode stores the active provider URL and key together. A personal or
  // proxy provider's credential must never be sent to either billing service.
  if (!key && legacy.providerBaseURL && new URL(legacy.providerBaseURL).origin === origin) key = legacy.ANTHROPIC_API_KEY;
  if (!key) return { state: 'absent', windows: [] };
  const response = await request(origin + '/api/monitor/usage/quota/limit', {
    headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return { state: 'unknown', windows: [] };
  const json = await response.json();
  if (json?.success === false && noPlan.test(String(json.msg ?? ''))) return { state: 'none', windows: [] };
  const result = parseQuotaEnvelope({ status: response.status, json, text: '' });
  if (result.kind !== 'success') return { state: 'unknown', windows: [] };
  return {
    state: 'active',
    windows: result.items.map(item => ({
      label: (family === 'zai' ? 'Z.ai' : 'BigModel') + ' · ' + item.label, remainingPercent: item.leftPercent,
      ...(item.nextResetTime > 0 ? { resetsAt: item.nextResetTime } : {}),
    })),
  };
}

function shown(row) {
  return typeof row.label === 'string' && row.label.trim() && row.label.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(row.label) && Number.isFinite(row.remainingPercent) &&
    row.remainingPercent >= 0 && row.remainingPercent <= 100;
}

// One quota request per family with a Coding Plan credential. Start Plan is
// not read: Cindy cannot run it (see the model list adaptation in build.mjs).
export async function readCodingPlans(request = fetch) {
  const legacy = loadZcodeCredentials();
  const entries = await Promise.all(Object.entries(regions).map(async ([family, origin]) => {
    const plan = await codingPlan(family, origin, legacy, request).catch(() => ({ state: 'unknown', windows: [] }));
    return [family, plan];
  }));
  const plans = Object.fromEntries(entries.map(([family, plan]) => [family, plan.state]));
  const windows = entries.flatMap(([, plan]) => plan.windows).filter(shown).slice(0, 24);
  return { plans, usage: windows.length ? { updatedAt: Date.now(), windows } : null };
}

export async function readPlanUsage(request = fetch) {
  return (await readCodingPlans(request)).usage;
}
