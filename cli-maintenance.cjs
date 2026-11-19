'use strict';

const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;

function compareVersions(a, b) {
  if (!a || !b || !versionPattern.test(a) || !versionPattern.test(b)) return null;
  const split = value => value.split('+')[0].match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  const left = split(a), right = split(b);
  for (let i = 1; i <= 3; i++) {
    if (left[i] !== right[i]) return Number(left[i]) > Number(right[i]) ? 1 : -1;
  }
  if (!left[4] || !right[4]) return Number(!left[4]) - Number(!right[4]);
  const x = left[4].split('.'), y = right[4].split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined || y[i] === undefined) return x[i] === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i]);
    if (xn && yn) return Number(x[i]) > Number(y[i]) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

function fail(code) {
  throw Object.assign(new Error(code), { maintenanceCode: code });
}

async function fetchOfficial(url, origins, timeout, headers) {
  const signal = AbortSignal.timeout(timeout);
  for (let redirects = 0; redirects < 4; redirects++) {
    const target = new URL(url);
    if (!origins.includes(target.origin) || target.username || target.password) fail('source');
    const response = await fetch(target, { redirect: 'manual', signal, headers }).catch(() => fail('source'));
    if (response.ok && response.body) return response;
    await response.body?.cancel();
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.get('location')) fail('source');
    url = new URL(response.headers.get('location'), target).href;
  }
  fail('source');
}

async function json(url, headers) {
  const response = await fetchOfficial(url, [new URL(url).origin], 15000, headers);
  try {
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 256 * 1024) fail('source');
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { fail('source'); }
}

async function download(url, origins, file, algorithm, digest, maxBytes, size) {
  const response = await fetchOfficial(url, origins, 420000);
  const hash = createHash(algorithm);
  let received = 0;
  await pipeline(response.body, async function* (chunks) {
    for await (const chunk of chunks) {
      received += chunk.byteLength;
      if (received > maxBytes || (size && received > size)) fail('integrity');
      hash.update(chunk);
      yield chunk;
    }
    if (!received || (size && received !== size) || hash.digest('hex') !== digest) fail('integrity');
  }, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
}

function run(file, args, options = {}) {
  return promisify(execFile)(file, args, {
    encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true, timeout: 30000, ...options,
  });
}

// One operation at a time per worker. The browser never supplies a command, URL or path.
function createMaintenance({ latest, installed, install }) {
  let pending;
  return function maintain(params, progress) {
    const action = params?.action;
    if (!['check', 'install', 'update'].includes(action)) return { error: 'unsupported' };
    if (pending) return { error: 'busy' };
    const timer = action === 'check' ? null : setInterval(progress, 10000);
    pending = (async () => {
      const current = await installed();
      const release = await latest();
      if (!versionPattern.test(release.version)) fail('source');
      const comparison = compareVersions(release.version, current.version);
      if (action === 'check') {
        return { version: comparison < 0 ? current.version : release.version, state: !current.present ? 'missing' :
          comparison === null ? 'unknown' : comparison > 0 ? 'newer' : 'current' };
      }
      if (comparison !== null && comparison < 0) return { version: current.version, state: 'current' };
      if (comparison === 0 && current.runnable) return { version: current.version, state: 'current' };
      if (action === 'update' && params.version !== release.version) {
        return { version: release.version, state: comparison === null ? 'unknown' : 'newer' };
      }
      await install(release, current);
      const after = await installed();
      if (!after.runnable || compareVersions(after.version, release.version) !== 0) fail('verify');
      return { version: after.version, state: 'installed' };
    })().catch(error => ({ error: error.maintenanceCode || 'operation' }))
      .finally(() => { clearInterval(timer); pending = undefined; });
    return pending;
  };
}

module.exports = { compareVersions, createMaintenance, download, fail, json, run, versionPattern };
