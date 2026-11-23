import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rw = require(path.join(root, 'remote-workspace.cjs'));

// Runs main.js against a stubbed worker and returns the PUT /harnesses bodies.
async function publishedHarnesses(detected, locale = 'zh-CN') {
  const puts = [];
  class Channel { constructor() { this.onmessage = null; } postMessage() {} }
  const context = vm.createContext({
    BroadcastChannel: Channel,
    setTimeout,
    clearTimeout,
    cindy: {
      request: async () => ({ ok: true, context: { locale, uiLocale: locale } }),
      node: {
        request: async (req) => (req.method === 'detect'
          ? { ok: true, result: detected }
          : { ok: true, result: { signedIn: true, family: 'bigmodel', plan: 'active' } }),
      },
      onHostMessage: () => () => {},
    },
    fetch: async (url, init) => {
      if (url === '/harnesses') puts.push(JSON.parse(init.body));
      return { ok: true, status: 204 };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });
  for (let i = 0; i < 50 && puts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  return puts;
}

// A stand-in ZCode install: its CLI only records how the bridge started it, so
// a real ZCode on this computer is never read or run. Network calls go to a
// closed local proxy, so no quota service is ever asked.
function standIn(tmp) {
  const home = path.join(tmp, 'home');
  const cliDir = path.join(tmp, 'zcode');
  const record = path.join(tmp, 'zcode-started.jsonl');
  fs.mkdirSync(path.join(home, '.zcode', 'v2'), { recursive: true });
  fs.writeFileSync(path.join(home, '.zcode', 'v2', 'provider_config.json'), '{"schemaVersion":1,"original":true}');
  fs.mkdirSync(path.join(cliDir, 'provider'), { recursive: true });
  fs.writeFileSync(path.join(cliDir, 'provider', 'zcode-builtin.json'), JSON.stringify({ schemaVersion: 1, revision: 1, config: { providerConfigRules: { providerRules: [] } } }));
  fs.writeFileSync(path.join(cliDir, 'zcode.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2), home: process.env.ZCODE_HOME, base: process.env.ZCODE_DATA_BASE_DIR,
  personal: process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, original: process.env.ZCODE_GUEST_ORIGINAL_CREDENTIALS_PATH,
}) + '\\n');
process.exit(1);
`);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: path.join(tmp, 'config'),
    ZCODE_BIN: path.join(cliDir, 'zcode.cjs'), ZCODE_NODE: process.execPath,
    NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', NO_PROXY: '',
  };
  for (const key of ['ZCODE_HOME', 'ZCODE_DATA_BASE_DIR', 'ZCODE_PROVIDER', 'ZCODE_BUILTIN_PROVIDER_CONFIG_FILE',
    'ZCODE_PERSONAL_PROVIDER_CONFIG_FILE', 'ZCODE_GUEST_ORIGINAL_CREDENTIALS_PATH']) delete env[key];
  const started = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { home, env, started };
}

// Windows may still hold a just-exited process's folder for a moment (or scan
// new files); a leftover temporary folder must not fail the test.
async function cleanup(dir) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
}

function tree(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).sort() : [];
}

// Starts the engine entry like Cindy does and drives it over ACP until ZCode's
// backend is started (or the entry exits).
async function driveEntry(env, cwd, args, { mcpServers = [] } = {}) {
  const child = spawn(process.execPath, [path.join(root, 'zcode-acp.cjs'), ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const replies = new Map();
  let buffered = '';
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split('\n');
    buffered = lines.pop();
    for (const line of lines.filter(Boolean)) {
      try { const message = JSON.parse(line); if (message.id !== undefined && !message.method) replies.set(message.id, message); } catch { /* not ACP */ }
    }
  });
  const closed = new Promise((resolve) => child.on('close', resolve));
  let exited = null;
  closed.then((code) => { exited = code; });
  const send = (message) => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); } catch { /* exited */ } };
  const reply = async (id) => {
    for (let i = 0; i < 1000 && !replies.has(id) && exited === null; i++) await new Promise((r) => setTimeout(r, 20));
    return replies.get(id);
  };
  send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
  if (await reply(1)) {
    send({ id: 2, method: 'session/new', params: { cwd, mcpServers } });
    const opened = await reply(2);
    if (opened?.result?.sessionId) {
      send({ id: 3, method: 'session/prompt', params: { sessionId: opened.result.sessionId, prompt: [{ type: 'text', text: 'hi' }] } });
      await reply(3);
    }
  }
  try { child.stdin.end(); } catch { /* exited */ }
  const timer = setTimeout(() => child.kill(), 8000);
  const code = await closed;
  clearTimeout(timer);
  return { code, stderr };
}

describe('ZCode accounts Cindy adds (--cindy-account-dir)', () => {
  test('main.js offers only the sign-in methods that work on this computer', async () => {
    const detected = { available: true, version: '0.17.1', models: [{ id: 'bigmodel\\GLM-5.3', name: 'GLM-5.3' }] };
    const desktop = await publishedHarnesses({ ...detected, signIn: 'desktop' });
    assert.deepEqual(desktop[0].harnesses[0].accounts, { methods: [] });
    const cli = await publishedHarnesses({ ...detected, signIn: 'cli', apiKeyFamilies: ['bigmodel', 'zai'] }, 'en');
    assert.deepEqual(cli[0].harnesses[0].accounts, { methods: [
      { id: 'bigmodel-browser', label: 'BigModel account (browser sign-in)', kind: 'browser' },
      { id: 'zai-browser', label: 'Z.ai account (browser sign-in)', kind: 'browser' },
      { id: 'bigmodel-key', label: 'BigModel Coding Plan API key', kind: 'secret', secretLabel: 'BigModel Coding Plan API key' },
      { id: 'zai-key', label: 'Z.ai Coding Plan API key', kind: 'secret', secretLabel: 'Z.ai Coding Plan API key' },
    ] });
    // Desktop CLI with a key template: keys only. Unavailable: no accounts at all.
    const keys = await publishedHarnesses({ ...detected, signIn: 'desktop', apiKeyFamilies: ['zai'] });
    assert.deepEqual(keys[0].harnesses[0].accounts.methods.map((method) => method.id), ['zai-key']);
    const unavailable = await publishedHarnesses({ available: false, reason: 'not-installed', signIn: 'cli' });
    assert.equal('accounts' in unavailable[0].harnesses[0], false);
  });

  test('main.js lists the added accounts\' models with the original login\'s and remembers them in /kv', async () => {
    const puts = [];
    const detects = [];
    let kv = { theme: 'kept', engineAccounts: [
      { dir: 'D:\\accounts\\a', models: [{ id: 'zai-api\\GLM-5.3', name: 'GLM-5.3' }] },
      { dir: 'D:\\accounts\\gone', models: [{ id: 'gone\\GLM-5', name: 'GLM-5' }] },
    ] };
    let onHost;
    class Channel { constructor() { this.onmessage = null; } postMessage() {} }
    const context = vm.createContext({
      BroadcastChannel: Channel, setTimeout, clearTimeout,
      cindy: {
        request: async () => ({ ok: true, context: { locale: 'en', uiLocale: 'en' } }),
        node: {
          request: async (req) => {
            if (req.method !== 'detect') return { ok: false };
            detects.push(req.params);
            // The original login has no model; the worker confirms which account folders still exist.
            return { ok: true, result: { available: true, version: '0.17.1', models: [], reason: 'sign-in-required',
              signIn: 'desktop', apiKeyFamilies: ['bigmodel'], accountDirs: ['D:\\accounts\\a'] } };
          },
        },
        onHostMessage: (handler) => { onHost = handler; return () => {}; },
      },
      fetch: async (url, init) => {
        if (url === '/kv') {
          if (init?.method === 'PUT') kv = JSON.parse(init.body);
          return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(kv)) };
        }
        if (url === '/harnesses') puts.push(JSON.parse(init.body).harnesses[0]);
        return { ok: true, status: 204 };
      },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });
    const settle = async (count) => {
      for (let i = 0; i < 100 && puts.length < count; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 50));
    };
    await settle(1);
    assert.deepEqual(JSON.parse(JSON.stringify(detects)), [{ accountDirs: ['D:\\accounts\\a', 'D:\\accounts\\gone'] }]);
    // Available although the original login has no model, so the first account can be added.
    assert.equal(puts[0].available, true);
    assert.equal('reason' in puts[0], false);
    assert.deepEqual(puts[0].accounts.methods.map((method) => method.id), ['bigmodel-key']);
    assert.deepEqual(puts[0].models, [{ id: 'zai-api\\GLM-5.3', name: 'GLM-5.3' }]);
    assert.deepEqual(kv, { theme: 'kept', engineAccounts: [{ dir: 'D:\\accounts\\a', models: [{ id: 'zai-api\\GLM-5.3', name: 'GLM-5.3' }] }] });

    const added = { id: 'account:bigmodel-individual-coding-plan\\GLM-5.3', name: 'GLM-5.3', efforts: ['low', 'high'], defaultEffort: 'high' };
    await onHost({ type: 'event', name: 'node-notification', method: 'account-models',
      params: { dir: 'D:\\accounts\\b', models: [added, { id: 'zai-api\\GLM-5.3', name: 'GLM-5.3' }] } });
    await settle(2);
    assert.deepEqual(puts[1].models, [{ id: 'zai-api\\GLM-5.3', name: 'GLM-5.3' }, added]);
    assert.deepEqual(kv.engineAccounts.map((entry) => entry.dir), ['D:\\accounts\\a', 'D:\\accounts\\b']);
    assert.equal(kv.theme, 'kept');

    await onHost({ type: 'event', name: 'node-notification', method: 'account-models', params: { dir: 'D:\\accounts\\a', removed: true } });
    await settle(3);
    assert.deepEqual(puts[2].models, [added, { id: 'zai-api\\GLM-5.3', name: 'GLM-5.3' }]);
    assert.deepEqual(kv.engineAccounts.map((entry) => entry.dir), ['D:\\accounts\\b']);
  });

  test('the entry refuses an unusable account directory and never falls back to the original login', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-account-entry-'));
    try {
      const { home, env, started } = standIn(tmp);
      const file = path.join(tmp, 'not-a-dir');
      fs.writeFileSync(file, '');
      // Links back to the original login: the folder itself, or a parent folder (junctions on Windows).
      fs.symlinkSync(home, path.join(tmp, 'linked-home'), 'junction');
      fs.symlinkSync(tmp, path.join(tmp, 'linked-parent'), 'junction');
      const before = tree(home);
      for (const args of [
        ['--cindy-account-dir'],
        ['--cindy-account-dir', 'relative/account'],
        ['--cindy-account-dir', path.join(tmp, 'missing')],
        ['--cindy-account-dir', file],
        // <home>/.zcode would be the original login itself.
        ['--cindy-account-dir', home],
        ['--cindy-account-dir', path.join(tmp, 'linked-home')],
        ['--cindy-account-dir', path.join(tmp, 'linked-parent', 'home')],
        ['--cindy-account-dir=' + path.join(tmp, 'missing')],
        ['--cindy-remote-workspace', '--cindy-guest-workspace', '--cindy-account-dir', path.join(tmp, 'missing')],
      ]) {
        const { code, stderr } = await driveEntry(env, tmp, args);
        assert.notEqual(code, 0, args.join(' '));
        assert.match(stderr, /ZCode was not started/, args.join(' '));
      }
      assert.deepEqual(started(), []);
      assert.deepEqual(tree(home), before);
    } finally {
      await cleanup(tmp);
    }
  });

  test('the entry runs ZCode with only the account directory as its home', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-account-entry-'));
    try {
      const { home, env, started } = standIn(tmp);
      const account = path.join(tmp, 'accounts', 'cindy-1');
      const work = path.join(tmp, 'work');
      fs.mkdirSync(account, { recursive: true });
      fs.mkdirSync(work);
      const before = tree(home);
      await driveEntry(env, work, ['--cindy-account-dir', account]);
      const [backend] = started();
      assert.ok(backend, 'ZCode backend was started');
      assert.equal(backend.home, path.join(account, '.zcode'));
      assert.equal(backend.base, account);
      assert.equal(backend.personal, path.join(account, '.zcode', 'v2', 'provider_config.json'));
      assert.equal(backend.original, undefined);
      // The bridge keeps its session records in the account's home; the original one is untouched.
      assert.ok(tree(account).includes(path.join('.zcode', 'v2', 'acp-lazy-sessions.json')), tree(account).join(', '));
      assert.deepEqual(tree(home), before);
    } finally {
      await cleanup(tmp);
    }
  });

  test('a shared session on an added account isolates from that account, not from the original login', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-account-guest-'));
    try {
      const { home, env, started } = standIn(tmp);
      const account = path.join(tmp, 'accounts', 'cindy-2');
      const accountV2 = path.join(account, '.zcode', 'v2');
      fs.mkdirSync(accountV2, { recursive: true });
      fs.writeFileSync(path.join(accountV2, 'provider_config.json'), '{"schemaVersion":1,"account":true}');
      fs.writeFileSync(path.join(accountV2, 'credentials.json'), '{}');
      const before = tree(home);
      await driveEntry(env, tmp, ['--cindy-remote-workspace', '--cindy-guest-workspace', '--cindy-account-dir', account], {
        mcpServers: [{ name: 'cindy_exec', type: 'http', url: 'http://127.0.0.1:9/mcp', headers: [] }],
      });
      const guestHome = path.join(account, '.zcode', 'cindy-guest-workspace', '.zcode');
      const [backend] = started();
      assert.ok(backend, 'ZCode backend was started');
      assert.equal(backend.home, guestHome);
      assert.equal(backend.base, path.dirname(guestHome));
      assert.equal(backend.original, path.join(accountV2, 'credentials.json'));
      assert.equal(fs.readFileSync(path.join(guestHome, 'v2', 'provider_config.json'), 'utf8'), '{"schemaVersion":1,"account":true}');
      assert.deepEqual(tree(home), before);
    } finally {
      await cleanup(tmp);
    }
  });
});

describe('ZCode remote & guest workspace', () => {
  test('main.js publishes both remoteWorkspace and guestWorkspace when available', async () => {
    const puts = [];
    class Channel { constructor() { this.onmessage = null; } postMessage() {} }
    const context = vm.createContext({
      BroadcastChannel: Channel,
      setTimeout,
      clearTimeout,
      cindy: {
        request: async () => ({ ok: true, context: { locale: 'zh-CN', uiLocale: 'zh-CN' } }),
        node: {
          request: async (req) => (req.method === 'detect'
            ? { ok: true, result: { available: true, version: '3.18.2', models: [{ id: 'bigmodel\\GLM-5.3', name: 'GLM-5.3' }], modes: ['default', 'plan'], defaultMode: 'default' } }
            : { ok: true, result: { signedIn: true, family: 'bigmodel', plan: 'active' } }),
        },
        onHostMessage: () => () => {},
      },
      fetch: async (url, init) => {
        if (url === '/harnesses') puts.push(JSON.parse(init.body));
        return { ok: true, status: 204 };
      },
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'main.js'), 'utf8'), context, { filename: 'main.js' });
    for (let i = 0; i < 50 && puts.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0], {
      harnesses: [{
        id: 'zcode',
        available: true,
        version: '3.18.2',
        reportsUsage: true,
        remoteWorkspace: true,
        guestWorkspace: true,
        accounts: { methods: [] },
        models: [{ id: 'bigmodel\\GLM-5.3', name: 'GLM-5.3' }],
        modes: ['default', 'plan'],
        defaultMode: 'default',
      }],
    });
  });

  test('prepareGuestZcodeHome isolates provider/credential files without copying skills, plugins, MCP or AGENTS.md', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-guest-home-test-'));
    try {
      const src = path.join(tmp, '.zcode');
      fs.mkdirSync(path.join(src, 'v2'), { recursive: true });
      fs.mkdirSync(path.join(src, 'cli', 'plugins', 'cache', 'm', 'p', '1.0.0'), { recursive: true });
      fs.mkdirSync(path.join(src, 'skills', 'secret-skill'), { recursive: true });
      fs.mkdirSync(path.join(src, 'agents'), { recursive: true });
      fs.writeFileSync(path.join(src, 'AGENTS.md'), 'private instructions');
      fs.writeFileSync(path.join(src, 'skills', 'secret-skill', 'SKILL.md'), '---\nname: secret\ndescription: private\n---\n');
      fs.writeFileSync(path.join(src, 'cli', 'config.json'), JSON.stringify({ mcp: { servers: { internal: { url: 'http://10.0.0.1' } } } }));
      fs.writeFileSync(path.join(src, 'v2', 'credentials.json'), JSON.stringify({ 'oauth:bigmodel:access_token': 'enc:v2:os:abc' }));
      fs.writeFileSync(path.join(src, 'v2', 'provider_config.json'), JSON.stringify({ schemaVersion: 1 }));
      fs.writeFileSync(path.join(src, 'v2', 'config.json'), JSON.stringify({ provider: { custom: { enabled: true } }, mcp: { leak: true } }));
      fs.writeFileSync(path.join(src, 'v2', 'setting.json'), JSON.stringify({ providerFamilyConnectionSelections: { bigmodel: { kind: 'coding-plan' } }, windowBounds: {} }));

      const isolated = rw.prepareGuestZcodeHome(src);
      assert.equal(isolated.originalCredentialsPath, path.resolve(src, 'v2', 'credentials.json'));
      assert.ok(!fs.existsSync(path.join(isolated.guestHome, 'AGENTS.md')));
      assert.ok(!fs.existsSync(path.join(isolated.guestHome, 'skills')));
      assert.ok(!fs.existsSync(path.join(isolated.guestHome, 'cli', 'plugins')));
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolated.guestHome, 'cli', 'config.json'), 'utf8')), {});
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolated.guestHome, 'v2', 'config.json'), 'utf8')), { provider: { custom: { enabled: true } } });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(isolated.guestHome, 'v2', 'setting.json'), 'utf8')), {
        providerFamilyConnectionSelections: { bigmodel: { kind: 'coding-plan' } },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('inspectToolCall rewrites cindy_exec MCP calls and flags local or unauthorized guest tools', () => {
    const seen = new Map();
    const servers = ['cindy_exec', 'cindy'];
    const bashStart = rw.inspectToolCall(
      { toolCallId: 'tc-1', title: 'mcp__cindy_exec__Bash: ls -la', kind: 'execute', rawInput: { command: 'ls -la', toolSummary: 'List files' } },
      seen,
      servers,
      { guest: true },
    );
    assert.deepEqual(bashStart, {
      type: 'mcp',
      toolCall: { toolCallId: 'tc-1', title: 'Bash', kind: 'execute', rawInput: { command: 'ls -la' } },
    });
    // Subsequent update without title retains the mapped Cindy tool name via seen map.
    const bashDone = rw.inspectToolCall({ toolCallId: 'tc-1', status: 'completed' }, seen, servers, { guest: true });
    assert.deepEqual(bashDone, { type: 'mcp', toolCall: { toolCallId: 'tc-1', title: 'Bash', status: 'completed' } });

    const otherMcp = rw.inspectToolCall(
      { toolCallId: 'tc-2', title: 'mcp__cindy__ghost_market_search: query', kind: 'execute', rawInput: { query: 'x' } },
      seen,
      servers,
      { guest: true },
    );
    assert.deepEqual(otherMcp, {
      type: 'mcp',
      toolCall: { toolCallId: 'tc-2', title: 'mcp__cindy__ghost_market_search', kind: 'other', rawInput: { query: 'x' } },
    });

    assert.deepEqual(rw.inspectToolCall({ toolCallId: 'tc-3', title: 'Bash: rm -rf /' }, seen, servers, { guest: false }), { type: 'local', tool: 'Bash' });
    assert.deepEqual(rw.inspectToolCall({ toolCallId: 'tc-4', title: 'mcp__node_repl__js: 1+1' }, seen, servers, { guest: false }), { type: 'local', tool: 'mcp__node_repl__js' });
    // WebFetch and Skill are allowed in same-account remote mode, but blocked in guest mode.
    assert.equal(rw.inspectToolCall({ toolCallId: 'tc-5', title: 'WebFetch: http://10.0.0.1' }, seen, servers, { guest: false }).type, 'other');
    assert.deepEqual(rw.inspectToolCall({ toolCallId: 'tc-5', title: 'WebFetch: http://10.0.0.1' }, seen, servers, { guest: true }), { type: 'local', tool: 'WebFetch' });
    assert.deepEqual(rw.inspectToolCall({ toolCallId: 'tc-6', title: 'mcp__foreign__secret: {}' }, seen, servers, { guest: true }), { type: 'local', tool: 'mcp__foreign__secret' });
  });

  test('guest-workspace relay enforces cindy_exec, blocks session/list, rewrites MCP tools, and exits 78 on local tools', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-relay-test-'));
    try {
      const fakeRunner = path.join(tmp, 'fake-runner.cjs');
      fs.writeFileSync(fakeRunner, `'use strict';
const readline = require('node:readline');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, envCheck: { remote: process.env.CINDY_REMOTE_WORKSPACE, guest: process.env.CINDY_GUEST_WORKSPACE, disallowed: process.env.ZCODE_DISALLOWED_TOOLS } } }) + '\\n');
  } else if (msg.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's-1', cwd: msg.params.cwd } }) + '\\n');
  } else if (msg.method === 'session/prompt') {
    if (msg.params.prompt[0].text === 'mcp') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'mcp__cindy_exec__Read: a.ts', kind: 'execute', rawInput: { file_path: 'a.ts', toolSummary: 'Read a.ts' } } } }) + '\\n');
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }) + '\\n');
    } else {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's-1', update: { sessionUpdate: 'tool_call', toolCallId: 'c2', title: 'Bash: whoami', kind: 'execute', rawInput: { command: 'whoami' } } } }) + '\\n');
    }
  }
});
`);
      const harnessScript = path.join(tmp, 'entry.cjs');
      fs.writeFileSync(harnessScript, `'use strict';
const rw = require(${JSON.stringify(path.join(root, 'remote-workspace.cjs'))});
rw.startRemoteWorkspace({ node: process.execPath, env: { ...process.env, ZCODE_HOME: ${JSON.stringify(path.join(tmp, '.zcode'))} } }, ${JSON.stringify(fakeRunner)}, { guest: true });
`);
      const child = spawn(process.execPath, [harnessScript, '--cindy-remote-workspace', '--cindy-guest-workspace'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const lines = [];
      child.stdout.on('data', (chunk) => {
        for (const l of chunk.toString('utf8').split('\n').filter(Boolean)) lines.push(JSON.parse(l));
      });
      const waitReply = async (id) => {
        for (let i = 0; i < 100; i++) {
          const hit = lines.find((m) => m.id === id && !m.method);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('timeout waiting for ' + id);
      };
      const send = (obj) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n');

      send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } });
      const init = await waitReply(1);
      assert.equal(init.result.envCheck.remote, '1');
      assert.equal(init.result.envCheck.guest, '1');
      assert.match(init.result.envCheck.disallowed, /\bBash\b/);
      assert.match(init.result.envCheck.disallowed, /\bWebFetch\b/);
      assert.match(init.result.envCheck.disallowed, /\bSkill\b/);

      // session/list is refused in guest mode.
      send({ id: 2, method: 'session/list', params: {} });
      assert.equal((await waitReply(2)).error.code, -32601);

      // session/new without cindy_exec is refused.
      send({ id: 3, method: 'session/new', params: { cwd: '/shadow/p', mcpServers: [] } });
      assert.equal((await waitReply(3)).error.code, -32602);

      // session/new with HTTP cindy_exec succeeds.
      send({ id: 4, method: 'session/new', params: { cwd: '/shadow/p', mcpServers: [{ name: 'cindy_exec', type: 'http', url: 'http://127.0.0.1:9/mcp' }] } });
      const opened = await waitReply(4);
      assert.equal(opened.result.sessionId, 's-1');

      // MCP tool call is rewritten to Read.
      send({ id: 5, method: 'session/prompt', params: { sessionId: 's-1', prompt: [{ type: 'text', text: 'mcp' }] } });
      await waitReply(5);
      const readUpdate = lines.find((m) => m.method === 'session/update' && m.params.update.toolCallId === 'c1').params.update;
      assert.equal(readUpdate.title, 'Read');
      assert.equal(readUpdate.kind, 'read');
      assert.deepEqual(readUpdate.rawInput, { file_path: 'a.ts' });

      // Local Bash tool call triggers fail-closed exit 78.
      const exitCode = new Promise((resolve) => child.on('close', resolve));
      send({ id: 6, method: 'session/prompt', params: { sessionId: 's-1', prompt: [{ type: 'text', text: 'local' }] } });
      assert.equal(await exitCode, 78);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
