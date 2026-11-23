import { createHash } from 'node:crypto';
import { readCredentialStoreSync } from 'zcode-acp-server/dist/backend/credential-store.js';
import { codingPlanApiKeys } from './templates.mjs';

// ZCode keeps one OAuth sign-in at a time in its credential store: the desktop
// app and `zcode login <family>` both replace the previous account of that
// ZCode home. Accounts Cindy adds each have a home of their own.
const families = ['bigmodel', 'zai'];

function printable(value, max = 80) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

const emailShape = /^[^\s@]{1,64}@[^\s@]{1,253}$/;
function email(value) {
  const text = printable(value, 254);
  return text && emailShape.test(text) ? text : undefined;
}

function userInfo(raw) {
  try {
    const info = JSON.parse(raw);
    return info && typeof info === 'object' && !Array.isArray(info) ? info : undefined;
  } catch {
    return undefined;
  }
}

// BigModel stores { displayName, username }, Z.ai the profile { name, email }.
// readAccount() (the settings page) lets only a display name leave.
function displayName(raw) {
  const info = userInfo(raw);
  return printable(info?.displayName) ?? printable(info?.username) ?? printable(info?.name) ??
    printable(info?.rawProfile?.name);
}

// Platforms with a Coding Plan API key in ZCode's model settings. Such a key
// works without a sign-in; only the platform names leave this function.
function apiKeyPlatforms() {
  const keys = codingPlanApiKeys();
  return families.filter(family => keys[family].length);
}

function signedInFamily(store) {
  const signedIn = family => !!store[`oauth:${family}:access_token`]?.trim();
  const active = store['oauth:active_provider']?.trim();
  return families.includes(active) && signedIn(active) ? active : families.find(signedIn);
}

export function readAccount() {
  const store = readCredentialStoreSync();
  const family = signedInFamily(store);
  const apiKeys = apiKeyPlatforms();
  const keys = apiKeys.length ? { apiKeys } : {};
  if (!family) return { signedIn: false, ...keys };
  const name = displayName(store[`oauth:${family}:user_info`]);
  return { signedIn: true, family, ...(name ? { name } : {}), ...keys };
}

// Opaque and stable per account, so Cindy recognises the same account added
// twice. Never shown; a hash, so neither the user id nor a key can be read back.
function fingerprint(kind, family, id) {
  return createHash('sha256').update(`cindy-zcode:${kind}:${family}:${id}`).digest('hex').slice(0, 32);
}

/**
 * Who this ZCode home is signed in as, for Cindy's engine accounts: the OAuth
 * user's name and email, and the platform and last four characters of a Coding
 * Plan API key. Tokens and keys never leave this function.
 */
export function readAccountIdentity() {
  const store = readCredentialStoreSync();
  const family = signedInFamily(store);
  const out = {};
  if (family) {
    const info = userInfo(store[`oauth:${family}:user_info`]) ?? {};
    const address = email(info.email) ?? email(info.rawProfile?.email) ?? email(info.username);
    const name = printable(info.displayName) ?? (email(info.username) ? undefined : printable(info.username)) ??
      printable(info.name) ?? printable(info.rawProfile?.name);
    const plan = `account:${family}-individual-coding-plan`;
    const id = [info.id, info.userId, info.uid, info.rawProfile?.id, store[`account-provider:${plan}:identity`]]
      .map(value => (typeof value === 'number' && Number.isFinite(value) ? String(value) : printable(value, 256)))
      .find(Boolean) ?? address?.toLowerCase() ?? name;
    out.oauth = {
      family, ...(name ? { name } : {}), ...(address ? { email: address } : {}),
      ...(id ? { fingerprint: fingerprint('oauth', family, id) } : {}),
    };
  }
  const keys = codingPlanApiKeys();
  const keyFamily = families.find(item => keys[item].length);
  if (keyFamily) {
    const { key } = keys[keyFamily][0];
    out.apiKey = { family: keyFamily, last4: key.slice(-4), fingerprint: fingerprint('key', keyFamily, key) };
  }
  return out;
}
