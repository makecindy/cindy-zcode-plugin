import { readCredentialStoreSync } from 'zcode-acp-server/dist/backend/credential-store.js';
import { codingPlanApiKeys } from './templates.mjs';

// ZCode keeps one OAuth sign-in at a time in its shared credential store: the
// desktop app and `zcode login <family>` both replace the previous account.
const families = ['bigmodel', 'zai'];

function printable(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text && text.length <= 80 && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

// BigModel stores { displayName, username }, Z.ai the profile { name, email }.
// Only a display name leaves this function; tokens and email stay in the store.
function displayName(raw) {
  try {
    const info = JSON.parse(raw);
    return printable(info?.displayName) ?? printable(info?.username) ?? printable(info?.name) ??
      printable(info?.rawProfile?.name);
  } catch {
    return undefined;
  }
}

// Platforms with a Coding Plan API key in ZCode's model settings. Such a key
// works without a sign-in; only the platform names leave this function.
function apiKeyPlatforms() {
  const keys = codingPlanApiKeys();
  return families.filter(family => keys[family].length);
}

export function readAccount() {
  const store = readCredentialStoreSync();
  const signedIn = family => !!store[`oauth:${family}:access_token`]?.trim();
  const active = store['oauth:active_provider']?.trim();
  const family = families.includes(active) && signedIn(active) ? active : families.find(signedIn);
  const apiKeys = apiKeyPlatforms();
  const keys = apiKeys.length ? { apiKeys } : {};
  if (!family) return { signedIn: false, ...keys };
  const name = displayName(store[`oauth:${family}:user_info`]);
  return { signedIn: true, family, ...(name ? { name } : {}), ...keys };
}
