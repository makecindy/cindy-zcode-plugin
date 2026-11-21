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
