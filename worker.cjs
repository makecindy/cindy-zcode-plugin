'use strict';

const { execFile } = require('node:child_process');
const readline = require('node:readline');
const { promisify } = require('node:util');
const { resolveRuntime, runner } = require('./local-runtime.cjs');

async function probe(usage = false) {
  const runtime = resolveRuntime();
  if (runtime.reason) return usage ? null : { available: false, ...runtime };
  try {
    const { stdout } = await promisify(execFile)(runtime.node, [runner, usage ? '--usage' : '--detect'], {
      env: runtime.env, timeout: 22000, maxBuffer: 512 * 1024, windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch {
    return usage ? null : { available: false, reason: 'check-failed', path: runtime.entry };
  }
}

let checking;
let usageRead;
function reply(id, body) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n');
}
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async line => {
  let request;
  try { request = JSON.parse(line.trim()); } catch { return reply(null, { error: { code: -32700, message: 'Parse error' } }); }
  if (request?.id == null) return;
  if (request.method === 'usage') {
    usageRead ??= probe(true).catch(() => null).finally(() => { usageRead = undefined; });
    return reply(request.id, { result: await usageRead });
  }
  if (request.method !== 'detect') return reply(request.id, { error: { code: -32601, message: 'Method not found' } });
  checking ??= probe().finally(() => { checking = undefined; });
  try { reply(request.id, { result: await checking }); }
  catch { reply(request.id, { error: { code: -32603, message: 'Could not check ZCode' } }); }
});
