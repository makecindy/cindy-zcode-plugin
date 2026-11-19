'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const win = process.platform === 'win32';
const runner = path.join(__dirname, 'run.mjs');

function isFile(file, executable = false) {
  if (!file || !path.isAbsolute(file)) return false;
  try {
    if (executable && !win) fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

function searchPath(names) {
  return (process.env.PATH || '').split(path.delimiter)
    .map(dir => dir.replace(/^"(.*)"$/, '$1'))
    .filter(dir => path.isAbsolute(dir))
    .flatMap(dir => names.map(name => path.join(dir, name)));
}

function windowsInstallDirs() {
  // Get both standard uninstall hives and the per-user registration. Reading the
  // registered install path also handles a user picking a drive other than C:.
  const root = process.env.SystemRoot || 'C:\\Windows';
  const ps = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    "$roots = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
    '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
    "Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'ZCode' } | ForEach-Object { if ($_.InstallLocation) { $_.InstallLocation } elseif ($_.DisplayIcon) { Split-Path (($_.DisplayIcon -replace ',[0-9]+$','').Trim('\"')) } }",
  ].join('\n');
  try {
    return execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'],
    }).split(/\r?\n/).filter(dir => path.isAbsolute(dir.trim())).map(dir => dir.trim());
  } catch { return []; }
}

function findZcode() {
  if (process.env.ZCODE_BIN && isFile(process.env.ZCODE_BIN)) return process.env.ZCODE_BIN;
  const home = os.homedir();
  const entries = win ? [
    path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
  ] : [
    '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs',
    path.join(home, 'Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
    '/opt/ZCode/resources/glm/zcode.cjs', '/usr/share/zcode/resources/glm/zcode.cjs',
  ];
  const desktop = entries.find(file => isFile(file));
  if (desktop) return desktop;
  if (win) {
    const registered = windowsInstallDirs().map(dir => path.join(dir, 'resources', 'glm', 'zcode.cjs')).find(file => isFile(file));
    if (registered) return registered;
  }
  const commands = win ? searchPath(['zcode.exe', 'zcode.cjs', 'zcode.mjs', 'zcode.cmd']) :
    [...searchPath(['zcode']), path.join(home, '.local/bin/zcode'), '/opt/homebrew/bin/zcode', '/usr/local/bin/zcode'];
  for (const file of commands) {
    if (!isFile(file, true)) continue;
    // A desktop GUI or an official standalone .cmd may also be on PATH.
    const parent = path.dirname(file);
    const inner = [path.join(parent, 'resources/glm/zcode.cjs'), path.join(parent, 'zcode.mjs'), path.join(parent, 'bin/zcode.mjs')].find(entry => isFile(entry));
    if (inner) return inner;
    if (!file.toLowerCase().endsWith('.cmd')) return file;
  }
  return null;
}

function findNode(entry) {
  const name = win ? 'node.exe' : 'node';
  const dir = path.dirname(entry);
  // Recent desktop distributions explicitly identify their own Electron Node
  // runtime in this metadata. Use it only with the matching bundled CLI.
  let appNode;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '.node-bundle-meta.json'), 'utf8'));
    if (meta.runtime === 'electron-node' && meta.entry === path.basename(entry)) {
      appNode = process.platform === 'darwin' ? path.resolve(dir, '../../MacOS/ZCode') :
        path.resolve(dir, '../..', win ? 'ZCode.exe' : 'zcode');
    }
  } catch { /* Standalone distributions can use their own Node or the system Node. */ }
  const candidates = [
    process.env.ZCODE_NODE,
    path.join(dir, 'node-runtime', name), path.join(dir, 'node-runtime', 'bin', name),
    appNode,
    ...(process.versions.electron ? [] : [process.execPath]),
    ...searchPath([name]),
    ...(win ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', name)] :
      ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']),
  ];
  for (const file of new Set(candidates)) {
    if (!isFile(file, true)) continue;
    const env = { ...process.env, ZCODE_BIN: entry, ZCODE_NODE: file };
    if (file === appNode) env.ELECTRON_RUN_AS_NODE = '1';
    const probe = spawnSync(file, ['-e', 'require("node:sqlite"); if (+process.versions.node.split(".")[0] >= 22) process.stdout.write("ready")'], {
      env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 3000,
    });
    if (probe.status === 0 && probe.stdout === 'ready') return { entry, node: file, env };
  }
  return null;
}

function resolveRuntime() {
  const entry = findZcode();
  if (!entry) return { reason: 'not-installed' };
  return findNode(entry) || { reason: 'node-missing', path: entry };
}

module.exports = { findZcode, resolveRuntime, runner };
