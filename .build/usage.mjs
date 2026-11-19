import { loadZcodeCredentials } from 'zcode-acp-server/dist/backend/credentials.js';
import { accountProviderIdFor, codingPlanRequestAuthFor, oauthProjectTokenFamilyFor } from 'zcode-acp-server/dist/config/account-provider.js';
import { resolveOAuthProjectToken } from 'zcode-acp-server/dist/config/project-token.js';
import { parseQuotaEnvelope } from 'zcode-acp-server/dist/quota/parse.js';
import { queryStartPlan } from 'zcode-acp-server/dist/quota/startplan.js';

const regions = { bigmodel: 'https://open.bigmodel.cn', zai: 'https://api.z.ai' };
async function codingPlan(family, origin, legacy, request) {
  const id = accountProviderIdFor('builtin:' + family + '-coding-plan');
  let key = codingPlanRequestAuthFor(id)?.apiKey;
  if (!key && oauthProjectTokenFamilyFor(id) === family) key = (await resolveOAuthProjectToken(family)).token;
  // Older ZCode stores the active provider URL and key together. A personal or
  // proxy provider's credential must never be sent to either billing service.
  if (!key && legacy.providerBaseURL && new URL(legacy.providerBaseURL).origin === origin) key = legacy.ANTHROPIC_API_KEY;
  if (!key) return [];
  const response = await request(origin + '/api/monitor/usage/quota/limit', {
    headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return [];
  const result = parseQuotaEnvelope({ status: response.status, json: await response.json(), text: '' });
  return result.kind === 'success' ? result.items.map(item => ({
    label: (family === 'zai' ? 'Z.ai' : 'BigModel') + ' · ' + item.label, remainingPercent: item.leftPercent,
    ...(item.nextResetTime > 0 ? { resetsAt: item.nextResetTime } : {}),
  })) : [];
}

export async function readPlanUsage(request = fetch) {
  const legacy = loadZcodeCredentials();
  const startPlan = queryStartPlan((url, options) => {
    if (new URL(url).origin !== 'https://zcode.z.ai') throw new Error('Unknown billing origin');
    return request(url, { ...options, redirect: 'error' });
  }).then(plan => plan.kind === 'success' ? plan.windows.map(row => ({
    label: row.label, remainingPercent: Math.min(100, 100 * row.remainingUnits / row.totalUnits),
    ...(!row.oneTime && row.resetsAt > 0 ? { resetsAt: row.resetsAt } : {}),
  })) : []);
  const queries = Object.entries(regions).map(([family, origin]) => codingPlan(family, origin, legacy, request));
  const rows = await Promise.all([...queries, startPlan].map(query => query.catch(() => [])));
  const windows = rows.flat().filter(row => typeof row.label === 'string' && row.label.trim() && row.label.length <= 120
    && !/[\u0000-\u001f\u007f]/.test(row.label) && Number.isFinite(row.remainingPercent)
    && row.remainingPercent >= 0 && row.remainingPercent <= 100).slice(0, 24);
  return windows.length ? { updatedAt: Date.now(), windows } : null;
}
