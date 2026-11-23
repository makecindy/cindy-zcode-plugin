import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
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

// The installed ZCode's own templates for Coding Plan API keys, by platform:
// the same templates its model settings use when the user adds such a key.
export function codingPlanKeyTemplates(table = readBuiltinTable()?.table) {
  const out = {};
  for (const template of table?.config?.providerConfigRules?.templateRules ?? []) {
    if (!template?.templateId || typeof template.templateId !== 'string') continue;
    if (template.config?.access?.type !== 'zhipu-coding-plan-api-key') continue;
    let family;
    try { family = origins[new URL(template.config.api?.baseUrl).origin]; } catch { /* Not a Coding Plan address. */ }
    if (family && !out[family]) out[family] = template;
  }
  return out;
}

const keyShape = /^[!-~]{1,4096}$/;

/**
 * Saves a Coding Plan API key into this ZCode home's personal provider file the
 * way ZCode's model settings do: a provider made from the platform's template
 * that holds the key. The template's address is repeated so the bridge also
 * entitles the platform's Coding Plan models (upstream manualCodingPlanKeys reads
 * the family from that address), the model ids a sign-in lists. Other Coding
 * Plan key providers of this home are replaced: one home is one account.
 * Throws 'unsupported' without a template, 'invalid-secret' for a malformed key.
 */
export function saveCodingPlanKey(family, apiKey, file = zcodePersonalProviderPath()) {
  if (!Object.values(origins).includes(family)) throw new Error('unsupported');
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!keyShape.test(key)) throw new Error('invalid-secret');
  const table = readBuiltinTable()?.table;
  const template = codingPlanKeyTemplates(table)[family];
  if (!template) throw new Error('unsupported');
  const { current, config, rulesHolder, rules } = providerFileWithoutKeys(file, table);
  rules.push({
    providerId: template.templateId,
    templateId: template.templateId,
    providerName: printableName(template.providerName) ?? (family === 'zai' ? 'Z.ai Coding Plan' : 'BigModel Coding Plan'),
    config: {
      group: 'standard-personal',
      access: { type: 'zhipu-coding-plan-api-key', apiKey: key },
      api: { baseUrl: template.config.api.baseUrl },
      personalModelIds: [],
      modelOrder: [],
    },
  });
  writeJson(file, { ...current, config: { ...config, providerConfigRules: { ...rulesHolder, providerRules: rules } } });
}

/**
 * Removes this ZCode home's Coding Plan API keys (after the account signed in
 * with the browser instead). Returns whether the file changed.
 */
export function clearCodingPlanKeys(file = zcodePersonalProviderPath()) {
  const { exists, current, config, rulesHolder, rules, removed } = providerFileWithoutKeys(file, readBuiltinTable()?.table);
  if (!exists || !removed) return false;
  writeJson(file, { ...current, config: { ...config, providerConfigRules: { ...rulesHolder, providerRules: rules } } });
  return true;
}

// The personal provider file with its Coding Plan key providers taken out. An
// unreadable file throws rather than being replaced.
function providerFileWithoutKeys(file, table) {
  let current = { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] } } };
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (text !== undefined) {
    current = JSON.parse(text);
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error('Unreadable provider file');
  }
  const config = current.config && typeof current.config === 'object' ? current.config : {};
  const rulesHolder = config.providerConfigRules && typeof config.providerConfigRules === 'object' ? config.providerConfigRules : {};
  const all = Array.isArray(rulesHolder.providerRules) ? rulesHolder.providerRules : [];
  const rules = all.filter(rule => withProviderTemplate(rule, table)?.config?.access?.type !== 'zhipu-coding-plan-api-key');
  return { exists: text !== undefined, current, config, rulesHolder, rules, removed: rules.length !== all.length };
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    try { unlinkSync(temporary); } catch { /* Renamed. */ }
  }
}

function printableName(value) {
  return typeof value === 'string' && value.trim() && value.length <= 80 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim() : undefined;
}
