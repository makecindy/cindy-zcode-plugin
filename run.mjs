// This file runs with real Node. Both the task and the short settings probe
// use the same executable, bundled bridge and provider environment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { builtinProviderEnv, buildInitialConfigOptions, describeEfforts, serve } from './vendor/dist/adapter.mjs';

const entry = process.env.ZCODE_BIN;
Object.assign(process.env, builtinProviderEnv(entry));

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
  if (!models.length) return { available: false, reason: 'no-models', version, path: entry };
  const mode = options.find(item => item.category === 'mode');
  const modes = (mode?.options ?? []).map(o => o.value).filter(id => ['default', 'acceptEdits', 'plan'].includes(id));
  return { available: true, version, path: entry, models, modes, defaultMode: mode?.currentValue };
}

try {
  if (process.argv[2] === '--detect') {
    process.stdout.write(JSON.stringify(await detect()) + '\n');
  } else {
    await serve();
  }
} catch {
  process.stderr.write('ZCode could not start. Check ZCode and its model configuration on this computer.\n');
  process.exitCode = 1;
}
