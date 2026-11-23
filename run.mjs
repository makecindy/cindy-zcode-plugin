// This file runs with real Node. Both the task and the short settings probe
// use the same executable, bundled bridge and provider environment.
import { execFile, spawn } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
  builtinProviderEnv, buildInitialConfigOptions, clearCodingPlanKeys, codingPlanKeyTemplates, describeEfforts, readAccount,
  readAccountIdentity, readCodingPlans, saveCodingPlanKey, serve,
} from './vendor/dist/adapter.mjs';

const entry = process.env.ZCODE_BIN;
Object.assign(process.env, builtinProviderEnv(entry));

// The initial menu of session/new, and its models as Cindy lists them.
async function modelMenu() {
  const options = await buildInitialConfigOptions({ backendKind: 'zcode' });
  const model = options.find(item => item.category === 'model');
  const models = [];
  const seen = new Set();
  for (const { value: id, name } of model?.options ?? []) {
    if (typeof id !== 'string' || !id.trim() || id.length > 256 || seen.has(id) || typeof name !== 'string' || !name.trim()) continue;
    seen.add(id);
    models.push({ id, name: name.slice(0, 200), ...describeEfforts(id) });
    if (models.length === 200) break;
  }
  return { options, models };
}

async function detect() {
  const isScript = /\.(?:mjs|cjs|js)$/i.test(entry);
  let version;
  try {
    const { stdout } = await promisify(execFile)(isScript ? process.execPath : entry, isScript ? [entry, '--version'] : ['--version'], {
      timeout: 8000, maxBuffer: 65536, windowsHide: true,
    });
    version = stdout.trim().match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0];
    if (!version) throw new Error('Unrecognised version');
  } catch {
    return { available: false, reason: 'not-runnable', path: entry };
  }
  // The same initial menu as session/new, without creating a user-visible
  // conversation, opening a workspace, sending a prompt or charging a turn.
  const { options, models } = await modelMenu();
  const mode = options.find(item => item.category === 'mode');
  const modes = (mode?.options ?? []).map(o => o.value).filter(id => ['default', 'acceptEdits', 'plan'].includes(id));
  // Platforms whose Coding Plan API key template this ZCode has: Cindy can add
  // such keys as accounts of their own.
  const apiKeyFamilies = Object.keys(codingPlanKeyTemplates()).sort();
  // ZCode runs even when its own login has no model yet: Cindy can still add
  // accounts, whose models main.js lists too. Only local files are read here;
  // whether the account has a plan is checked with the account status.
  const reason = models.length ? undefined : readAccount().signedIn ? 'no-models' : 'sign-in-required';
  return {
    available: true, version, path: entry, models, modes, apiKeyFamilies,
    ...(mode?.currentValue ? { defaultMode: mode.currentValue } : {}), ...(reason ? { reason } : {}),
  };
}

// `zcode login` and `zcode logout` read the same provider table as the bridge,
// so they run with this environment (and an added account's ZCODE_HOME and
// ZCODE_DATA_BASE_DIR). The worker ends stdin to cancel; stdin also ends when
// the worker exits, which stops a sign-in still waiting.
async function cli(args) {
  if (!['login', 'logout'].includes(args[0])) return 2;
  const isScript = /\.(?:mjs|cjs|js)$/i.test(entry);
  const child = spawn(isScript ? process.execPath : entry, isScript ? [entry, ...args] : args, {
    stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  });
  const stop = () => child.kill();
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
  process.stdin.resume();
  return new Promise(resolve => {
    child.once('error', () => resolve(1));
    child.once('close', code => resolve(code ?? 1));
  });
}

// Only an account Cindy added is ever changed here; the original ZCode home
// (shared with the desktop app) never is.
function addedAccountHome() {
  const home = process.env.ZCODE_HOME;
  return home && home === process.env.CINDY_ZCODE_ACCOUNT_HOME ? home : null;
}

function readOptional(file) {
  try { return readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function restore(file, text) {
  if (text === null) rmSync(file, { force: true });
  else writeFileSync(file, text, { mode: 0o600 });
}

// Saves a Coding Plan API key as this account's only credential. The key comes
// on stdin, never on the command line: first line the key, then the worker
// answers `commit` once it has not been cancelled. Ending stdin before that
// leaves the account untouched. A browser sign-in kept in the account is
// removed with it, so the identity Cindy shows is the one that is billed.
async function saveKey(family) {
  const home = addedAccountHome();
  if (!home) return { ok: false, error: 'unsupported' };
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })[Symbol.asyncIterator]();
  let key = (await lines.next()).value;
  try {
    if (typeof key !== 'string' || key.length > 8192) return { ok: false, error: key === undefined ? 'cancelled' : 'invalid-secret' };
    key = key.trim();
    if (!/^[!-~]{1,4096}$/.test(key)) return { ok: false, error: 'invalid-secret' };
    if (!codingPlanKeyTemplates()[family]) return { ok: false, error: 'unsupported' };
    process.stdout.write(JSON.stringify({ ready: true }) + '\n');
    if ((await lines.next()).value !== 'commit') return { ok: false, error: 'cancelled' };
    const providers = path.join(home, 'v2', 'provider_config.json');
    const signIn = path.join(home, 'v2', 'credentials.json');
    const before = readOptional(providers);
    saveCodingPlanKey(family, key, providers);
    try {
      rmSync(signIn, { force: true });
    } catch {
      restore(providers, before);
      return { ok: false, error: 'failed', message: 'Could not remove the previous sign-in of this account.' };
    }
    return { ok: true };
  } catch (error) {
    const code = error?.message;
    return { ok: false, error: code === 'unsupported' || code === 'invalid-secret' ? code : 'failed' };
  } finally {
    key = '';
  }
}

// After a browser sign-in: the account's previous API key goes, for the same reason.
function clearKeys() {
  const home = addedAccountHome();
  if (!home) return { ok: false, error: 'unsupported' };
  try {
    clearCodingPlanKeys(path.join(home, 'v2', 'provider_config.json'));
    return { ok: true };
  } catch {
    return { ok: false, error: 'failed' };
  }
}

try {
  if (process.argv[2] === '--cli') {
    process.exit(await cli(process.argv.slice(3)));
  } else if (process.argv[2] === '--detect') {
    process.stdout.write(JSON.stringify(await detect()) + '\n');
  } else if (process.argv[2] === '--save-key') {
    // stdin may still be open; leave once the result is written.
    process.stdout.write(JSON.stringify(await saveKey(process.argv[3])) + '\n', () => process.exit(0));
  } else if (process.argv[2] === '--clear-keys') {
    process.stdout.write(JSON.stringify(clearKeys()) + '\n');
  } else if (process.argv[2] === '--account') {
    // Account status and usage share one quota read per credential. Without a
    // sign-in, the plan is the one behind the Coding Plan API key in ZCode.
    const account = readAccount();
    const { plans, levels, usage } = await readCodingPlans();
    const platform = account.signedIn ? account.family : account.apiKeys?.[0];
    const plan = platform ? plans[platform] : undefined;
    const level = plan === 'active' ? levels?.[platform] : undefined;
    // For Cindy's engine accounts: who is signed in, and the models this ZCode home offers.
    const extra = { identity: readAccountIdentity(), ...(level ? { planLevel: level } : {}) };
    if (process.argv.includes('--models')) extra.models = (await modelMenu()).models;
    process.stdout.write(JSON.stringify({ account: { ...account, ...(plan ? { plan } : {}) }, usage, ...extra }) + '\n');
  } else {
    await serve();
  }
} catch {
  process.stderr.write('ZCode could not start. Check ZCode and its model configuration on this computer.\n');
  process.exitCode = 1;
}
