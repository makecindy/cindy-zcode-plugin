import { readFileSync } from 'node:fs';
import { readBuiltinTable } from 'zcode-acp-server/dist/config/account-provider.js';
import { zcodePersonalProviderPath } from 'zcode-acp-server/dist/utils.js';

// ZCode 3.18 stores a provider added from a built-in template (for example a
// "BigModel Coding Plan" API key) as { providerId, templateId, providerName,
// config: { access: { apiKey } } }. The address and the default models stay in
// the template of zcode-builtin.json, which upstream 0.89.0 does not read.
export function withProviderTemplate(rule, table = readBuiltinTable()?.table) {
  const id = rule?.templateId;
  const template = id ? table?.config?.providerConfigRules?.templateRules?.find(item => item.templateId === id) : undefined;
  if (!template?.config) return rule;
  const off = new Set((table.config.modelConfigRules?.templateModelRules ?? [])
    .filter(item => item.templateId === id && item.config?.enabled === false).map(item => item.modelId));
  const own = rule.config ?? {};
  return {
    ...rule,
    config: {
      ...template.config, ...own,
      access: { ...template.config.access, ...own.access },
      api: { ...template.config.api, ...own.api },
      personalModelIds: [...(template.config.builtinModelIds ?? []).filter(model => !off.has(model)),
        ...(Array.isArray(own.personalModelIds) ? own.personalModelIds : [])],
    },
  };
}

const origins = { 'https://open.bigmodel.cn': 'bigmodel', 'https://api.z.ai': 'zai' };

// Coding Plan API keys the user added in ZCode's model settings, by platform.
// Only the quota service of the key's own platform ever receives a key.
export function codingPlanApiKeys() {
  let rules = [];
  try {
    rules = JSON.parse(readFileSync(zcodePersonalProviderPath(), 'utf8')).config?.providerConfigRules?.providerRules ?? [];
  } catch { /* No personal providers. */ }
  const table = readBuiltinTable()?.table;
  const out = { bigmodel: [], zai: [] };
  for (const raw of rules) {
    if (!raw || raw.enabled === false) continue;
    const rule = withProviderTemplate(raw, table);
    if (rule.config?.access?.type !== 'zhipu-coding-plan-api-key') continue;
    const key = typeof rule.config.access.apiKey === 'string' ? rule.config.access.apiKey.trim() : '';
    let family;
    try { family = origins[new URL(rule.config.api?.baseUrl).origin]; } catch { /* Not a Coding Plan address. */ }
    if (!key || !family || out[family].some(entry => entry.key === key)) continue;
    out[family].push({ key, name: typeof rule.providerName === 'string' ? rule.providerName : '' });
  }
  return out;
}
