export { main as serve } from "zcode-acp-server/dist/index.js";
export { builtinProviderEnv } from "zcode-acp-server/dist/backend/resolve.js";
export { buildInitialConfigOptions } from "zcode-acp-server/dist/config/options.js";
import { parseModelValue, personalModelSpec, findProviderConfig } from "zcode-acp-server/dist/config/options.js";

const levels = ["minimal", "low", "medium", "high", "xhigh", "max"];
export function describeEfforts(value) {
  const { providerId, modelId } = parseModelValue(value);
  const personal = personalModelSpec(providerId, modelId)?.reasoningValues;
  const legacy = findProviderConfig(providerId)?.models?.[modelId]?.reasoning;
  const declared = personal?.length ? personal : legacy?.enabled === false ? [] : legacy?.variants;
  if (!Array.isArray(declared)) return {};
  const efforts = levels.filter(level => declared.includes(level));
  if (!efforts.length) return {};
  const preferred = personal?.length ? personal.at(-1) : legacy?.defaultVariant;
  return { efforts, ...(efforts.includes(preferred) ? { defaultEffort: preferred } : {}) };
}
