// Integration tier. Exercise the two manifest entries with an actual local ZCode
// and a loopback model. A stdio echo test cannot catch a broken app-server,
// unusable model id, or an approval that never reaches Cindy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'ghost.json'), 'utf8'));

function client(env, directory, entry) {
  const child = spawn(process.execPath, [path.join(root, entry)], { env, cwd: directory, windowsHide: true });
  const pending = new Map();
  const updates = [];
  const permissions = [];
  let nextId = 0;
  let errors = '';
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-2600); });
  const closed = once(child, 'close');
  const send = packet => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...packet }) + '\n');
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    const msg = JSON.parse(line);
    if (msg.method === 'session/request_permission') {
      permissions.push(msg.params);
      const reject = msg.params.options.find(option => option.kind === 'reject_once');
      send({ id: msg.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } });
    } else if (msg.method === 'session/update') {
      updates.push(msg.params.update);
    } else if (pending.has(msg.id)) {
      const { method, resolve, reject } = pending.get(msg.id);
      msg.error ? reject(new Error(method + ': ' + JSON.stringify(msg.error) + '\n' + errors)) : resolve(msg.result);
    }
  });
  child.on('close', code => {
    for (const { reject } of pending.values()) reject(new Error('Process exited ' + code + ': ' + errors));
  });
  return {
    updates, permissions,
    notify(method, params) { send({ method, params }); },
    async call(method, params) {
      const id = ++nextId;
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error(method + ' timed out. ' + errors)), 35000);
          pending.set(id, { method, resolve, reject });
          send({ id, method, params });
        });
      } finally { clearTimeout(timer); pending.delete(id); }
    },
    async close() {
      child.stdin.end();
      const killer = setTimeout(() => child.kill(), 5000);
      try { await closed; } finally { clearTimeout(killer); }
    },
  };
}

test('ZCode desktop, Cindy plugin stdio and an isolated model', { skip: !process.env.ZCODE_TEST_BIN, timeout: 140000 }, async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-zcode-acp-'));
  const settings = path.join(tmp, '.zcode/v2');
  const workspace = path.join(tmp, 'project');
  await Promise.all([settings, workspace].map(dir => fs.mkdir(dir, { recursive: true })));
  const env = {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH,
    HOME: tmp, USERPROFILE: tmp, APPDATA: path.join(tmp, 'roaming'), LOCALAPPDATA: path.join(tmp, 'local'),
    XDG_CONFIG_HOME: path.join(tmp, 'config'), TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    ZCODE_HOME: path.join(tmp, '.zcode'), ZCODE_DATA_BASE_DIR: tmp, ZCODE_BIN: process.env.ZCODE_TEST_BIN,
    ZCODE_ACP_DEBUG: '1',
  };
  const worker = client(env, tmp, manifest.node.entry);
  let agent;
  let model;
  t.after(async () => {
    if (agent) await agent.close();
    await worker.close();
    if (model) { model.closeAllConnections(); model.close(); }
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
  });
  const fresh = await worker.call('detect', {});
  // A fresh install has neither a sign-in nor a model; the settings page offers sign-in.
  assert.equal(fresh.reason, 'sign-in-required', JSON.stringify(fresh));

  let requests = 0;
  let lastTools = [];
  const mcpMethods = [];
  let script = 'reply';
  let toolFile;
  let onHeld;
  model = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/mcp') {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      const rpc = JSON.parse(body);
      mcpMethods.push(rpc.method);
      if (rpc.id == null) { res.writeHead(202); res.end(); return; }
      const result = rpc.method === 'initialize'
        ? { protocolVersion: rpc.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
        : rpc.method === 'tools/list'
          ? { tools: [{ name: 'fixture_echo', description: 'Echo a test response', inputSchema: { type: 'object', properties: {} } }] }
          : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      return;
    }
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
    const request = JSON.parse(body);
    requests++;
    lastTools = (request.tools || []).map(tool => tool.function?.name);
    const reply = 'Reply from the local test model.';
    if (script === 'hold') { onHeld(); return; }
    const writeTool = lastTools.find(name => /^write$/i.test(name));
    const doWrite = script === 'write' && writeTool;
    if (doWrite) script = 'reply';
    const toolCall = { id: 'call_write', type: 'function', function: { name: writeTool,
      arguments: JSON.stringify({ file_path: toolFile, content: 'should be refused' }) } };
    const message = doWrite ? { role: 'assistant', tool_calls: [toolCall] } : { role: 'assistant', content: reply };
    const finish_reason = doWrite ? 'tool_calls' : 'stop';
    const head = { id: 'chatcmpl-test', model: request.model, created: 1730000000 };
    if (request.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const frame = (delta, finish_reason) => 'data: ' + JSON.stringify({ ...head, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
      res.write(frame({ role: 'assistant' }, null));
      res.write(frame(doWrite ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: reply }, null));
      res.end(frame({}, finish_reason) + 'data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...head, object: 'chat.completion', choices: [{ index: 0, message, finish_reason }],
        usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } }));
    }
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const url = 'http://127.0.0.1:' + model.address().port + '/v1';
  const pid = 'test-local';
  const ids = ['fixture-a', 'fixture-b'];
  const config = { provider: { [pid]: { kind: 'openai-compatible', name: 'Test local', enabled: true,
    options: { baseURL: url, apiKeyRequired: false }, models: Object.fromEntries(ids.map(id => [id, { name: id }])) } } };
  await fs.writeFile(path.join(settings, 'config.json'), JSON.stringify(config));
  const personal = { schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [{ providerId: pid, providerName: 'Test local', config: {
      group: 'standard-personal', access: { type: 'api-key', apiKey: 'local-fixture' },
      api: { type: 'openai-chat-completions', baseUrl: url }, personalModelIds: ids,
    } }] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: pid, modelId: ids[0] },
  } };
  await fs.writeFile(path.join(settings, 'provider_config.json'), JSON.stringify(personal));
  const detected = await worker.call('detect', {});
  assert.equal(detected.available, true, JSON.stringify(detected));
  const modelId = detected.models.find(item => item.id.endsWith('\\fixture-b'))?.id;
  assert.ok(modelId);
  assert.equal(requests, 0, 'Opening the picker must not spend a turn');
  t.diagnostic('Detected ZCode ' + detected.version + ' and both configured models');

  const entry = manifest.harnesses[0].entry;
  agent = client(env, tmp, entry);
  const init = { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'cindy', version: '0.0.0' } };
  assert.equal((await agent.call('initialize', init)).protocolVersion, 1);
  const mcpServers = [{ name: 'cindy-test', type: 'http', url: new URL('/mcp', url).href, headers: [] }];
  const session = await agent.call('session/new', { cwd: workspace, mcpServers });
  const { sessionId } = session;
  const option = (result, id) => result.configOptions.find(o => o.id === id);
  assert.equal(option(session, 'mode').currentValue, 'default');
  const set = (id, value) => agent.call('session/set_config_option', { sessionId, configId: id, value });
  assert.equal(option(await set('model', modelId), 'model').currentValue, modelId);
  assert.equal(option(await set('mode', 'plan'), 'mode').currentValue, 'plan');
  assert.equal(option(await set('mode', 'default'), 'mode').currentValue, 'default');
  const prompt = text => agent.call('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
  assert.equal((await prompt('Reply briefly.')).stopReason, 'end_turn');
  assert.ok(agent.updates.some(u => u.sessionUpdate === 'agent_message_chunk' && u.content?.text?.includes('local test model')),
    'Expected real streamed text from app-server. Last events: ' + JSON.stringify(agent.updates.slice(-3)).slice(-1300));
  assert.ok(mcpMethods.includes('tools/list'), 'ZCode must discover the MCP server supplied with the session: ' + mcpMethods);
  t.diagnostic('ACP model and mode switching and streamed prompt passed');

  toolFile = path.join(workspace, 'denied.txt');
  script = 'write';
  await prompt('Write the test file.');
  assert.ok(agent.permissions.length > 0, 'Write should request approval. Tools: ' + lastTools.join(', '));
  await assert.rejects(fs.access(toolFile), { code: 'ENOENT' });
  t.diagnostic('The client rejected a real tool request and the file was not created');

  await agent.close();
  agent = client(env, tmp, entry);
  await agent.call('initialize', init);
  const resumed = await agent.call('session/resume', { sessionId, cwd: workspace, mcpServers });
  assert.ok(Array.isArray(resumed.configOptions));
  script = 'hold';
  const held = new Promise(resolve => { onHeld = resolve; });
  const pending = prompt('Wait for a response.');
  await Promise.race([held, pending.then(() => { throw new Error('Expected an in-flight model request'); })]);
  agent.notify('session/cancel', { sessionId });
  assert.equal((await pending).stopReason, 'cancelled');
  t.diagnostic('A fresh adapter resumed the same session and cancelled an in-flight turn');
});
