import { classifyQuotaExhaustion } from "zcode-acp-server/dist/quota/resume.js";

// Cindy engine accounts: a failed turn may carry error.data._meta.cindy =
// { kind: 'usage-limit' | 'auth-required' | 'overloaded', resetsAt? } so Cindy
// can cool the account and move the task to another one. Older Cindy ignores
// `data`; the message and the other fields stay as upstream builds them.
//
// GLM business codes (BigModel / Z.ai API error code table):
// - usage limits: upstream QUOTA_PROVIDER_CODES (1308 5-hour window, 1310
//   weekly/monthly window, …) plus 1113 (no balance or resource package), 1304
//   (daily call limit) and 1309 (the GLM Coding Plan has expired);
// - sign-in: 1000-1004 (authentication failed, missing, invalid or expired token);
// - busy: 1302 (too many concurrent requests), 1303 (too frequent), 1305
//   (the model is overloaded).
const USAGE_CODES = new Set(["1113", "1304", "1309"]);
const AUTH_CODES = new Set(["1000", "1001", "1002", "1003", "1004"]);
const BUSY_CODES = new Set(["1302", "1303", "1305"]);
const AUTH_WORDS = /^(?:model_)?(?:auth(?:entication)?(?:_error|_failed|_required)?|unauthori[sz]ed|invalid_api_key|api_key_invalid)$/;
const BUSY_WORDS = /^(?:model_)?(?:overloaded(?:_error)?|server_overloaded|service_unavailable)$/;

function text(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : typeof value === "number" ? String(value) : "";
}

/**
 * Classify one backend turn failure. `data` is the bridge's ACP error payload
 * (acpTurnFailureData), `turnError` the raw turn.failed object it came from.
 * Returns the `{ kind, resetsAt? }` record, or null when the failure is not
 * about the account.
 */
export function classifyAccountError(data, turnError) {
  const record = data && typeof data === "object" ? data : {};
  const provider = text(record.providerCode);
  const code = text(record.code);
  const reason = text(record.reason);
  const status = typeof record.statusCode === "number" ? record.statusCode : undefined;
  const quota = (turnError && typeof turnError === "object" ? classifyQuotaExhaustion(turnError) : undefined) ??
    classifyQuotaExhaustion(record);
  if (quota || USAGE_CODES.has(provider)) {
    const reset = quota?.resetAt;
    return {
      kind: "usage-limit",
      ...(typeof reset === "number" && Number.isFinite(reset) && reset > Date.now() ? { resetsAt: Math.round(reset) } : {}),
    };
  }
  if (status === 401 || AUTH_CODES.has(provider) || AUTH_WORDS.test(code) || AUTH_WORDS.test(reason)) {
    return { kind: "auth-required" };
  }
  if (status === 429 || status === 503 || status === 529 || BUSY_CODES.has(provider) || BUSY_WORDS.test(code) ||
      BUSY_WORDS.test(reason) || reason === "rate_limited") {
    return { kind: "overloaded" };
  }
  return null;
}

/** The bridge's error payload with Cindy's classification added when there is one. */
export function withCindyErrorMeta(data, turnError) {
  const cindy = classifyAccountError(data, turnError);
  if (!cindy) return data;
  const meta = data && typeof data._meta === "object" && data._meta !== null ? data._meta : {};
  return { ...data, _meta: { ...meta, cindy } };
}
