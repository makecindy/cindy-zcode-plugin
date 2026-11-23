'use strict';

/**
 * Remote-workspace and guest-workspace modes for the ZCode ACP engine entry
 * (`--cindy-remote-workspace` and `--cindy-guest-workspace`).
 *
 * When a task's files and commands live on another computer (or belong to an invited friend via
 * provider sharing), ZCode's own local file, shell, workflow, plugin and cron tools would act on
 * this computer instead of the task's computer. This wrapper:
 *   1. Disables ZCode's local file/shell/workflow/cron/plugin tools via `ZCODE_DISALLOWED_TOOLS`
 *      (forwarded as per-session `toolDenylist` on `session/create` and `session/resume`, with
 *      `.build/build.mjs` failing closed if an older ZCode rejects `toolDenylist`) and forces
 *      `ZCODE_DYNAMIC_WORKFLOW_MODE=disabled`.
 *   2. In `--cindy-guest-workspace` mode, additionally disables `Skill` and `WebFetch`, blocks
 *      `session/list`, and isolates `ZCODE_HOME` / `ZCODE_DATA_BASE_DIR` under
 *      `<zcodeHome>/cindy-guest-workspace/.zcode` copying only provider & credential files from
 *      `v2/` (never the sharer's session history, user MCP servers, plugins, skills or AGENTS.md),
 *      while preserving `ZCODE_GUEST_ORIGINAL_CREDENTIALS_PATH` for OS keyring decryption. With
 *      `--cindy-account-dir`, `runtime.env.ZCODE_HOME` is that account's home (account-home.cjs),
 *      so the isolated tree is copied from the account, never from the original login.
 *   3. Watches the ACP JSON-RPC stream: requires HTTP `cindy_exec` on session open, rewrites
 *      `mcp__cindy_exec__<Tool>` titles/kinds back to Cindy's native tool names (`Bash`, `Read`,
 *      `Write`, `Edit`, …), and terminates the child fail-closed (exit code 78) if any local tool
 *      is ever attempted.
 */

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REMOTE_WORKSPACE_ARG = '--cindy-remote-workspace';
const GUEST_WORKSPACE_ARG = '--cindy-guest-workspace';
const REMOTE_WORKSPACE_EXIT_CODE = 78;
const EXEC_SERVER = 'cindy_exec';
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_SERVERS = 64;
const MAX_TRACKED_CALLS = 2_000;
const LAUNCH_DIR_PREFIX = 'cindy-zcode-remote-';
const STALE_LAUNCH_DIR_MS = 24 * 60 * 60 * 1000;
const NEWLINE = Buffer.from('\n');

const REMOTE_DISALLOWED_TOOLS = Object.freeze([
  'Bash', 'bash', 'js',
  'Read', 'read', 'Write', 'write', 'Edit', 'edit',
  'Glob', 'Grep', 'grep', 'NotebookEdit',
  'CreateWorkflow', 'AmendWorkflow', 'FillWorkflowHole', 'SaveWorkflow',
  'ListSavedWorkflows', 'EvalWorkflowSnippet', 'ListWorkflowRuns',
  'GetWorkflowRun', 'ResumeWorkflowRun', 'ResolveWorkflowQuestion',
  'OffPeakCreate', 'OffPeakList',
  'SearchPlugins', 'SuggestPluginInstall',
  'TaskOutput', 'TaskStop', 'ReadTopicResource',
  'CronCreate', 'CronList', 'CronUpdate', 'CronDelete', 'CronPauseSelf',
  'mcp__node_repl__js', 'mcp__node_repl__js_add_node_module_dir', 'mcp__node_repl__js_reset',
  ...['documents_documents', 'pdf_pdf', 'presentations_presentations', 'spreadsheets_spreadsheets'].flatMap((pkg) =>
    ['get_view', 'open_document', 'read_document', 'search_document', 'show_in_viewer'].map((op) => `mcp__plugin_${pkg}__${op}`)),
]);

const GUEST_EXTRA_DISALLOWED_TOOLS = Object.freeze([
  'Skill',
  'WebFetch',
]);

const LOCAL_TOOL_NAMES = new Set(REMOTE_DISALLOWED_TOOLS);
const GUEST_LOCAL_TOOL_NAMES = new Set(GUEST_EXTRA_DISALLOWED_TOOLS);
const FORBIDDEN_MCP_PREFIXES = Object.freeze([
  'mcp__node_repl__',
  'mcp__byob__',
  'mcp__computer-use__',
  'mcp__computer_use__',
  'mcp__plugin_',
]);

const EXEC_TOOL_KINDS = Object.freeze({
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  NotebookEdit: 'edit',
  WebFetch: 'fetch',
});

const STOPPED_MESSAGE =
  'ZCode 试图使用这台电脑上的工具，任务已停止。这个任务的文件在另一台电脑上，它只能使用那台电脑提供的工具。\n\n'
  + 'ZCode tried to use a tool on this computer, so the task was stopped. '
  + "This task's files are on another computer; it may only use the tools that computer provides.";

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isGuestWorkspaceLaunch(argv) {
  return Array.isArray(argv) && argv.slice(2).includes(GUEST_WORKSPACE_ARG);
}

function isRemoteWorkspaceLaunch(argv) {
  return Array.isArray(argv) && (argv.slice(2).includes(REMOTE_WORKSPACE_ARG) || argv.slice(2).includes(GUEST_WORKSPACE_ARG));
}

function disallowedToolsValue(existing, guest) {
  const prior = typeof existing === 'string' && existing.trim() ? existing.trim().split(/[,\s]+/).filter(Boolean) : [];
  const merged = new Set([
    ...prior,
    ...REMOTE_DISALLOWED_TOOLS,
    ...(guest ? GUEST_EXTRA_DISALLOWED_TOOLS : []),
  ]);
  return [...merged].join(' ');
}

function resolveSourceZcodeHome(env) {
  const explicit = env && typeof env.ZCODE_HOME === 'string' && env.ZCODE_HOME.trim();
  if (explicit) return path.resolve(explicit);
  const home = (env && (env.HOME || env.USERPROFILE)) || os.homedir();
  return path.join(home, '.zcode');
}

function writeRestrictedJson(destPath, data) {
  fs.writeFileSync(destPath, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Prepares an isolated ZCode data tree under `<sourceZcodeHome>/cindy-guest-workspace/.zcode`
 * containing only the provider/credential files from `v2/` needed to authenticate model calls.
 * User MCP servers, plugins, skills, custom agents, AGENTS.md and the owner's session history
 * remain outside this tree.
 */
function prepareGuestZcodeHome(sourceZcodeHome) {
  const baseDir = path.join(sourceZcodeHome, 'cindy-guest-workspace');
  const guestHome = path.join(baseDir, '.zcode');
  const sourceV2 = path.join(sourceZcodeHome, 'v2');
  const guestV2 = path.join(guestHome, 'v2');
  const guestCli = path.join(guestHome, 'cli');
  fs.mkdirSync(guestV2, { recursive: true, mode: 0o700 });
  fs.mkdirSync(guestCli, { recursive: true, mode: 0o700 });

  for (const name of ['skills', 'agents', 'AGENTS.md']) {
    try { fs.rmSync(path.join(guestHome, name), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(path.join(guestCli, 'plugins'), { recursive: true, force: true }); } catch { /* ignore */ }
  writeRestrictedJson(path.join(guestCli, 'config.json'), {});

  for (const rawCopy of ['credentials.json', 'provider_config.json']) {
    const src = path.join(sourceV2, rawCopy);
    const dst = path.join(guestV2, rawCopy);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      try { fs.chmodSync(dst, 0o600); } catch { /* Windows ignores POSIX mode */ }
    } else {
      try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
    }
  }

  // Copy only `provider` from legacy v2/config.json and `providerFamilyConnectionSelections` from v2/setting.json.
  const copyFiltered = (filename, pick) => {
    const src = path.join(sourceV2, filename);
    const dst = path.join(guestV2, filename);
    if (!fs.existsSync(src)) {
      try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(src, 'utf8'));
      if (isObject(parsed)) writeRestrictedJson(dst, pick(parsed));
    } catch {
      try { fs.rmSync(dst, { force: true }); } catch { /* ignore */ }
    }
  };
  copyFiltered('config.json', (obj) => (isObject(obj.provider) ? { provider: obj.provider } : {}));
  copyFiltered('setting.json', (obj) => (
    isObject(obj.providerFamilyConnectionSelections)
      ? { providerFamilyConnectionSelections: obj.providerFamilyConnectionSelections }
      : {}
  ));

  return {
    baseDir,
    guestHome,
    originalCredentialsPath: path.resolve(sourceV2, 'credentials.json'),
  };
}

function sweepStaleLaunchDirs(tmpRoot) {
  const cutoff = Date.now() - STALE_LAUNCH_DIR_MS;
  let entries;
  try { entries = fs.readdirSync(tmpRoot, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(LAUNCH_DIR_PREFIX)) continue;
    const target = path.join(tmpRoot, entry.name);
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isSymbolicLink() && stat.mtimeMs < cutoff) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } catch { /* in use or already gone */ }
  }
}

function prepareLaunchDir(tmpRoot) {
  const base = tmpRoot || os.tmpdir();
  sweepStaleLaunchDirs(base);
  const dir = fs.mkdtempSync(path.join(base, LAUNCH_DIR_PREFIX));
  fs.mkdirSync(path.join(dir, 'workspace'), { recursive: true, mode: 0o700 });
  return dir;
}

function removeLaunchDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function isSessionOpen(method) {
  return method === 'session/new' || method === 'session/load' || method === 'session/resume';
}

function usableServers(params) {
  const list = isObject(params) && Array.isArray(params.mcpServers) ? params.mcpServers : [];
  const servers = [];
  const dropped = [];
  for (const server of list) {
    const name = isObject(server) && typeof server.name === 'string' ? server.name : '';
    const usable = isObject(server) && server.type === 'http' && typeof server.url === 'string'
      && SERVER_NAME.test(name) && !servers.some((item) => item.name === name) && servers.length < MAX_SERVERS;
    if (usable) servers.push(server);
    else dropped.push(name || '(unnamed)');
  }
  return { servers, dropped };
}

function directMcpTool(head, serverNames) {
  if (typeof head !== 'string' || !head.startsWith('mcp_')) return null;
  let found = null;
  for (const server of serverNames) {
    const sanitized = server.replace(/[^A-Za-z0-9_]/g, '_');
    for (const candidate of new Set([server, sanitized])) {
      for (const prefix of [`mcp__${candidate}__`, `mcp_${candidate}_`]) {
        if (head.startsWith(prefix) && head.length > prefix.length && (!found || server.length > found.server.length)) {
          found = { server, tool: head.slice(prefix.length) };
        }
      }
    }
  }
  return found;
}

/**
 * Classifies and rewrites one ACP tool call (`session/request_permission` or `session/update`):
 *  - `mcp`: a call to one of the session's HTTP MCP servers (`cindy_exec` tools become native
 *    `Bash` / `Read` / `Write` / `Edit` titles & kinds; other servers become `mcp__<server>__<tool>`).
 *  - `local`: one of ZCode's local tools (or an unauthorized MCP server in guest mode) -> fail closed.
 *  - `other`: harmless metadata/todo/plan updates, passed through unchanged.
 */
function inspectToolCall(toolCall, seen, serverNames = [], options = {}) {
  if (!isObject(toolCall)) return { type: 'other' };
  const guest = Boolean(options && options.guest);
  const id = typeof toolCall.toolCallId === 'string' ? toolCall.toolCallId : null;
  const rawTitle = typeof toolCall.title === 'string'
    ? toolCall.title
    : (typeof toolCall.name === 'string' ? toolCall.name : '');
  const colon = rawTitle.indexOf(': ');
  const head = (colon === -1 ? rawTitle : rawTitle.slice(0, colon)).trim();

  const call = head ? directMcpTool(head, serverNames) : null;
  let known = id ? seen.get(id) : undefined;
  if (call) {
    const exec = call.server === EXEC_SERVER;
    known = {
      title: exec ? call.tool : `mcp__${call.server}__${call.tool}`,
      kind: exec ? (EXEC_TOOL_KINDS[call.tool] || 'other') : 'other',
      exec,
    };
    if (id) {
      if (seen.size >= MAX_TRACKED_CALLS && !seen.has(id)) seen.delete(seen.keys().next().value);
      seen.set(id, known);
    }
  }
  if (known) {
    const next = { ...toolCall, title: known.title };
    if ('name' in next) next.name = known.title;
    if ('kind' in next || call) next.kind = known.kind;
    if (known.exec && isObject(next.rawInput) && 'toolSummary' in next.rawInput) {
      const { toolSummary: _summary, ...rest } = next.rawInput;
      next.rawInput = rest;
    }
    return { type: 'mcp', toolCall: next };
  }
  if (head) {
    const forbiddenLocal = LOCAL_TOOL_NAMES.has(head)
      || (guest && GUEST_LOCAL_TOOL_NAMES.has(head))
      || FORBIDDEN_MCP_PREFIXES.some((prefix) => head.startsWith(prefix))
      || (guest && (head.startsWith('mcp__') || head.startsWith('mcp_')));
    if (forbiddenLocal) return { type: 'local', tool: head };
  }
  return { type: 'other' };
}

function lineSplitter(onLine) {
  let pending = [];
  return (chunk) => {
    let start = 0;
    let index;
    while ((index = chunk.indexOf(0x0a, start)) !== -1) {
      const piece = chunk.subarray(start, index);
      const line = pending.length ? Buffer.concat([...pending, piece]) : piece;
      pending = [];
      start = index + 1;
      if (line.length) onLine(line);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  };
}

function parseLine(line) {
  try {
    const message = JSON.parse(line.toString('utf8'));
    return isObject(message) ? message : null;
  } catch {
    return null;
  }
}

function killChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 2000 });
      return;
    } catch { /* fall through */ }
  }
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
}

function resolveSessionCwd(requestedCwd, workspaceDir, guest) {
  if (guest) return workspaceDir;
  if (typeof requestedCwd === 'string' && requestedCwd.trim() && requestedCwd !== '/') {
    try {
      if (fs.statSync(requestedCwd).isDirectory()) return requestedCwd;
    } catch { /* virtual path: use isolated launch workspace */ }
  }
  return workspaceDir;
}

function startRemoteWorkspace(runtime, runner, options = {}) {
  const guest = Boolean(options && options.guest);
  let launchDir;
  let env;
  try {
    launchDir = prepareLaunchDir();
    env = {
      ...runtime.env,
      CINDY_REMOTE_WORKSPACE: '1',
      ZCODE_DYNAMIC_WORKFLOW_MODE: 'disabled',
      ZCODE_DISALLOWED_TOOLS: disallowedToolsValue(runtime.env && runtime.env.ZCODE_DISALLOWED_TOOLS, guest),
    };
    if (guest) {
      const sourceHome = resolveSourceZcodeHome(runtime.env);
      const isolated = prepareGuestZcodeHome(sourceHome);
      env.CINDY_GUEST_WORKSPACE = '1';
      env.ZCODE_HOME = isolated.guestHome;
      env.ZCODE_DATA_BASE_DIR = isolated.baseDir;
      env.ZCODE_GUEST_ORIGINAL_CREDENTIALS_PATH = isolated.originalCredentialsPath;
    }
  } catch (error) {
    if (launchDir) removeLaunchDir(launchDir);
    process.stderr.write(`[zcode-acp] Could not prepare the remote-workspace launch (${error && error.message ? error.message : error}). ZCode was not started.\n`);
    process.exit(REMOTE_WORKSPACE_EXIT_CODE);
    return;
  }

  const workspaceDir = path.join(launchDir, 'workspace');
  const child = spawn(runtime.node, [runner], {
    env,
    cwd: workspaceDir,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });

  let finished = false;
  let stopCode = null;
  let serverNames = [];
  const seenCalls = new Map();

  const pipeWrite = (destination, data, source) => {
    let accepted = true;
    try { accepted = destination.write(data); } catch { return; }
    if (!accepted && source && !source.isPaused()) {
      source.pause();
      destination.once('drain', () => source.resume());
    }
  };
  const toClientLine = (line, source) => pipeWrite(process.stdout, Buffer.concat([line, NEWLINE]), source);
  const toClient = (message, source) => pipeWrite(process.stdout, JSON.stringify(message) + '\n', source);
  const toAgentLine = (line) => pipeWrite(child.stdin, Buffer.concat([line, NEWLINE]), process.stdin);
  const toAgent = (message) => pipeWrite(child.stdin, JSON.stringify(message) + '\n', process.stdin);
  const refuse = (id, code, message) => toClient({ jsonrpc: '2.0', id, error: { code, message } });

  const finish = (code) => {
    if (finished) return;
    finished = true;
    removeLaunchDir(launchDir);
    const done = () => process.exit(code);
    if (process.stdout.writableLength > 0) {
      process.stdout.once('drain', done);
      setTimeout(done, 1500).unref();
    } else {
      done();
    }
  };

  const abandon = (line, sessionId) => {
    if (stopCode !== null) return;
    stopCode = REMOTE_WORKSPACE_EXIT_CODE;
    if (sessionId) {
      toClient({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: STOPPED_MESSAGE } } },
      });
    }
    try { process.stderr.write(line + '\n'); } catch { /* ignore */ }
    try { child.stdin.end(); } catch { /* ignore */ }
    killChildTree(child);
    setTimeout(() => finish(stopCode), 1500).unref();
  };

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    try { child.stdin.end(); } catch { /* ignore */ }
    setTimeout(() => killChildTree(child), 1200).unref();
  };

  child.on('error', () => {
    process.stderr.write('Could not launch the ZCode ACP adapter.\n');
    finish(1);
  });
  child.stdin.on('error', stop);
  child.on('close', (code) => {
    process.stdin.pause();
    finish(stopCode !== null ? stopCode : (code ?? 1));
  });

  child.stdout.on('data', lineSplitter((line) => {
    if (finished || stopCode !== null) return;
    const message = parseLine(line);
    if (!message) {
      toClientLine(line, child.stdout);
      return;
    }
    const params = isObject(message.params) ? message.params : null;
    const isPermission = message.method === 'session/request_permission' && message.id !== undefined;
    const update = message.method === 'session/update' && params && isObject(params.update) ? params.update : null;
    const isToolUpdate = Boolean(update) && (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update');
    if (!params || (!isPermission && !isToolUpdate)) {
      toClientLine(line, child.stdout);
      return;
    }
    const verdict = inspectToolCall(isPermission ? params.toolCall : update, seenCalls, serverNames, { guest });
    if (verdict.type === 'local') {
      if (isPermission) {
        const opts = Array.isArray(params.options) ? params.options : [];
        const reject = opts.find((opt) => isObject(opt) && opt.kind === 'reject_once');
        toAgent({ jsonrpc: '2.0', id: message.id, result: { outcome: reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' } } });
      }
      abandon(
        `[zcode-acp] ZCode used its own tool "${verdict.tool}" in a task whose files are on another computer. The task was stopped.`,
        typeof params.sessionId === 'string' ? params.sessionId : null,
      );
      return;
    }
    if (verdict.type === 'mcp') {
      toClient({
        ...message,
        params: isPermission ? { ...params, toolCall: verdict.toolCall } : { ...params, update: verdict.toolCall },
      }, child.stdout);
      return;
    }
    toClientLine(line, child.stdout);
  }));

  process.stdin.on('data', lineSplitter((line) => {
    if (finished || stopCode !== null) return;
    const message = parseLine(line);
    if (!message || typeof message.method !== 'string') {
      toAgentLine(line);
      return;
    }
    if (guest && message.method === 'session/list') {
      if (message.id !== undefined) refuse(message.id, -32601, 'session/list is not available for shared sessions');
      return;
    }
    if (isSessionOpen(message.method) && message.id !== undefined) {
      const { servers, dropped } = usableServers(message.params);
      if (!servers.some((server) => server.name === EXEC_SERVER)) {
        refuse(message.id, -32602, `ZCode can only run this task with Cindy's file and command tools (${EXEC_SERVER}), and they were not provided.`);
        return;
      }
      if (dropped.length) {
        process.stderr.write(`[zcode-acp] These MCP servers cannot be given to ZCode and were left out: ${dropped.join(', ')}\n`);
      }
      serverNames = servers.map((server) => server.name);
      const nextParams = {
        ...(isObject(message.params) ? message.params : {}),
        cwd: resolveSessionCwd(isObject(message.params) ? message.params.cwd : undefined, workspaceDir, guest),
        mcpServers: servers,
      };
      toAgent({ ...message, params: nextParams });
      return;
    }
    toAgentLine(line);
  }));

  process.stdin.once('end', stop);
  process.stdin.once('error', stop);
  process.stdout.on('error', stop);
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  if (process.platform === 'win32') signals.push('SIGBREAK');
  for (const signal of signals) process.once(signal, stop);
  process.once('disconnect', stop);
  process.on('exit', () => {
    killChildTree(child);
    removeLaunchDir(launchDir);
  });
}

module.exports = {
  EXEC_SERVER,
  GUEST_EXTRA_DISALLOWED_TOOLS,
  GUEST_WORKSPACE_ARG,
  REMOTE_DISALLOWED_TOOLS,
  REMOTE_WORKSPACE_ARG,
  REMOTE_WORKSPACE_EXIT_CODE,
  disallowedToolsValue,
  inspectToolCall,
  isGuestWorkspaceLaunch,
  isRemoteWorkspaceLaunch,
  prepareGuestZcodeHome,
  startRemoteWorkspace,
  usableServers,
};
