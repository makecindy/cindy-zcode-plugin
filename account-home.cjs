'use strict';

/**
 * Accounts Cindy adds to the ZCode engine (Cindy plugin harnesses, "engine accounts").
 *
 * Cindy creates one directory per added account and passes it to the engine entry as
 * `--cindy-account-dir <absolute path>` and to the worker's account methods as `accountDir`.
 * ZCode keeps that account's data in `<accountDir>/.zcode`: the bridge reads `ZCODE_HOME` and
 * the ZCode CLI reads `ZCODE_DATA_BASE_DIR` (the parent of `.zcode`; the bridge only translates
 * a home whose basename is `.zcode`). Credentials, provider config, settings and session history
 * all live under that tree. The encrypted credential store is keyed in the OS keyring by the
 * resolved path of `<home>/v2/credentials.json`, so each account directory has its own keyring
 * entry and never replaces the original login's.
 *
 * The original login (ZCode's normal `~/.zcode`, shared with the desktop app) has no directory
 * and no argument; its behaviour is unchanged.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ACCOUNT_DIR_ARG = '--cindy-account-dir';
const ACCOUNT_EXIT_CODE = 1;
const HOME_NAME = '.zcode';
const PATH_MAX = 4096;

/** ZCode's own data root for an environment: `ZCODE_HOME`, else `~/.zcode`. */
function defaultZcodeHome(env) {
  const explicit = env && typeof env.ZCODE_HOME === 'string' && env.ZCODE_HOME.trim();
  if (explicit) return path.resolve(explicit);
  const home = (env && (env.HOME || env.USERPROFILE)) || os.homedir();
  return path.resolve(home, HOME_NAME);
}

function samePath(a, b) {
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function inside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Checks an account directory Cindy passed. Returns `{ dir, home }` or `{ error }` (plain text,
 * no secrets). The directory must already exist (Cindy creates it) and must not lead back to the
 * original login.
 */
function checkAccountDir(raw, env = process.env) {
  if (typeof raw !== 'string' || !raw || raw.length > PATH_MAX || raw.includes('\0')) {
    return { error: 'The account directory is missing.' };
  }
  if (!path.isAbsolute(raw)) return { error: 'The account directory must be an absolute path.' };
  const dir = path.resolve(raw);
  let stat;
  try { stat = fs.statSync(dir); } catch { return { error: 'The account directory does not exist.' }; }
  if (!stat.isDirectory()) return { error: 'The account directory is not a directory.' };
  const home = path.join(dir, HOME_NAME);
  const original = defaultZcodeHome(env);
  // `<dir>/.zcode` must be a home of its own: never the original login's tree, nor inside it.
  if (samePath(home, original) || inside(home, original) || inside(original, home)) {
    return { error: 'The account directory would use the original ZCode login.' };
  }
  return { dir, home };
}

/**
 * Reads `--cindy-account-dir <path>` from an entry's argv (after the script). Returns null when
 * absent, `{ error }` when malformed, else the checked `{ dir, home }`.
 */
function accountFromArgv(argv, env = process.env) {
  const args = Array.isArray(argv) ? argv.slice(2) : [];
  const at = args.indexOf(ACCOUNT_DIR_ARG);
  if (at === -1) {
    return args.some((arg) => typeof arg === 'string' && arg.startsWith(ACCOUNT_DIR_ARG + '='))
      ? { error: `Use "${ACCOUNT_DIR_ARG} <path>" as two arguments.` }
      : null;
  }
  if (args.indexOf(ACCOUNT_DIR_ARG, at + 1) !== -1) return { error: `${ACCOUNT_DIR_ARG} was given more than once.` };
  return checkAccountDir(args[at + 1], env);
}

/**
 * Creates the account's ZCode tree (`<dir>/.zcode/v2`) with owner-only permissions. Throws when
 * the tree cannot be created or is not a plain directory.
 */
function prepareAccountHome(account) {
  const v2 = path.join(account.home, 'v2');
  fs.mkdirSync(v2, { recursive: true, mode: 0o700 });
  for (const dir of [account.home, v2]) {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('The account ZCode folder is not a plain directory.');
  }
  return account;
}

/**
 * The environment for ZCode processes of this account: only this account's tree, never the
 * original login's. Variables that would point a reader back at the original tree are removed;
 * run.mjs derives the personal provider file again from `ZCODE_HOME`.
 */
function accountEnv(baseEnv, account) {
  const env = {
    ...baseEnv,
    ZCODE_HOME: account.home,
    ZCODE_DATA_BASE_DIR: account.dir,
    // Marks the home as one Cindy added; run.mjs writes an API key only there.
    CINDY_ZCODE_ACCOUNT_HOME: account.home,
  };
  delete env.ZCODE_GUEST_ORIGINAL_CREDENTIALS_PATH;
  delete env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  delete env.CINDY_GUEST_WORKSPACE;
  return env;
}

module.exports = {
  ACCOUNT_DIR_ARG,
  ACCOUNT_EXIT_CODE,
  accountEnv,
  accountFromArgv,
  checkAccountDir,
  defaultZcodeHome,
  prepareAccountHome,
};
