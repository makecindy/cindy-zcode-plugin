'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createMaintenance, download, fail, json, run, versionPattern } = require('./cli-maintenance.cjs');
const { findZcode, resolveRuntime } = require('./local-runtime.cjs');

const repo = 'https://github.com/zai-org/ZCode/releases/download/';
const win = process.platform === 'win32';

async function latest() {
  if ((!win && process.platform !== 'darwin') || !['arm64', 'x64'].includes(process.arch)) fail('unsupported');
  const release = await json('https://api.github.com/repos/zai-org/ZCode/releases/latest', {
    Accept: 'application/vnd.github+json',
  });
  const version = typeof release.tag_name === 'string' ? release.tag_name.slice(1) : '';
  if (!versionPattern.test(version) || release.tag_name !== 'v' + version || release.draft || release.prerelease) fail('source');
  const name = 'ZCode-' + version + (win ? '-win-' + process.arch + '.exe' : '-mac-' + process.arch + '.zip');
  const url = repo + release.tag_name + '/' + name;
  const asset = release.assets?.find(item => item.name === name && item.browser_download_url === url && item.state === 'uploaded');
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0) fail('source');
  return { version, name, url, digest: asset.digest.slice(7), size: asset.size };
}

async function installedPackageVersion(entry) {
  const dir = path.dirname(entry);
  if (path.basename(entry).toLowerCase() !== 'zcode.cjs' || path.basename(dir).toLowerCase() !== 'glm' ||
      path.basename(path.dirname(dir)).toLowerCase() !== 'resources') return undefined;
  try {
    let result;
    if (win) {
      const system = process.env.SystemRoot || 'C:\\Windows';
      const shell = path.join(system, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      result = await run(shell, ['-NoProfile', '-NonInteractive', '-Command',
        '[Diagnostics.FileVersionInfo]::GetVersionInfo($env:CINDY_ZCODE_EXE).ProductVersion'],
      { timeout: 4000, env: { ...process.env, CINDY_ZCODE_EXE: path.resolve(dir, '../..', 'ZCode.exe') } });
    } else if (process.platform === 'darwin') {
      result = await run('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-',
        path.resolve(dir, '../..', 'Info.plist')], { timeout: 4000 });
    }
    const productVersion = result?.stdout.trim() || '';
    // Windows product versions carry a fourth build number, e.g. 3.18.2.1490 for release v3.18.2.
    const version = win ? productVersion.replace(/^(\d+\.\d+\.\d+)\.\d+$/, '$1') : productVersion;
    return versionPattern.test(version) ? version : undefined;
  } catch { return undefined; }
}

async function installed() {
  const runtime = resolveRuntime();
  const entry = runtime.entry || runtime.path;
  if (!entry) return { present: false };
  const version = await installedPackageVersion(entry);
  if (runtime.reason) return { present: true, path: entry, version };
  const isScript = /\.(?:mjs|cjs|js)$/i.test(entry);
  try {
    const { stdout } = await run(isScript ? runtime.node : entry, isScript ? [entry, '--version'] : ['--version'], {
      env: runtime.env, timeout: 15000,
    });
    const runnable = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.test(stdout);
    return { present: true, runnable, version, path: entry };
  } catch {
    return { present: true, path: entry, version };
  }
}

async function ensureZCodeClosed() {
  // Match the ZCode process name and preserve the app if its status can't be determined.
  try {
    await run('/usr/bin/pgrep', ['-x', 'ZCode'], { timeout: 3000 });
  } catch (error) {
    if (error.code === 1) return;
    throw error;
  }
  fail('close-zcode');
}

/** Settings-page steps between "get the official version" and "confirm". */
function plan() {
  return win ? ['download', 'wizard'] : ['download', 'extract', 'signature', 'activate'];
}

/** Downloads the official package with byte progress for the settings page. */
async function fetchPackage(release, file, report) {
  report.step('download');
  const size = await download(release.url, ['https://github.com', 'https://release-assets.githubusercontent.com'],
    file, 'sha256', release.digest, 512 * 1024 * 1024, release.size, (loaded, total) => report.bytes(loaded, total));
  report.note('downloaded', { size });
}

async function installMac(release, current, report) {
  const bundledEntry = '/Contents/Resources/glm/zcode.cjs';
  const target = current.path?.endsWith('/ZCode.app' + bundledEntry) ?
    current.path.slice(0, -bundledEntry.length) : path.join(os.homedir(), 'Applications', 'ZCode.app');
  await ensureZCodeClosed();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const stage = await fs.mkdtemp(path.join(path.dirname(target), '.zcode-install-'));
  const backup = path.join(stage, 'backup.app');
  let backedUp = false;
  try {
    const file = path.join(stage, release.name);
    await fetchPackage(release, file, report);
    report.step('extract');
    await run('/usr/bin/ditto', ['-x', '-k', file, stage], { timeout: 60000 });
    const app = path.join(stage, 'ZCode.app');
    if (!(await fs.lstat(app)).isDirectory()) fail('integrity');
    report.step('signature');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { timeout: 60000 });
    if (!(await fs.stat(path.join(app, bundledEntry))).isFile()) fail('verify');
    report.step('activate');
    await ensureZCodeClosed();
    try {
      if (!(await fs.lstat(target)).isDirectory()) fail('operation');
      await fs.rename(target, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    try {
      await fs.rename(app, target);
      const check = await installed();
      if (!check.runnable || check.version !== release.version || findZcode() !== path.join(target, bundledEntry)) fail('verify');
    } catch (error) {
      // Move only the bundle from this operation out of the way before restoring the old one.
      if (await fs.lstat(app).then(() => false, err => err.code === 'ENOENT')) await fs.rename(target, app);
      if (backedUp) await fs.rename(backup, target);
      backedUp = false;
      throw error;
    }
    backedUp = false;
  } finally {
    // If filesystem errors prevent rollback, retain the backup for manual recovery.
    if (!backedUp) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

async function install(release, current, report) {
  if (!win) return installMac(release, current, report);
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'zcode-install-'));
  try {
    const file = path.join(stage, release.name);
    await fetchPackage(release, file, report);
    // The official wizard opens its own window; the settings page asks the user to finish it there.
    report.step('wizard');
    await run(file, [], { timeout: 240000, windowsHide: false });
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = createMaintenance({ latest, installed, install, plan });
