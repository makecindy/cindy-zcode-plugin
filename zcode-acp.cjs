'use strict';

const { spawn } = require('node:child_process');
const { resolveRuntime, runner } = require('./local-runtime.cjs');
const remoteWorkspace = require('./remote-workspace.cjs');

const runtime = resolveRuntime();
if (runtime.reason) {
  console.error(runtime.reason === 'not-installed' ? 'Install ZCode on this computer to run this task.' : 'ZCode requires Node.js 22.13+ with node:sqlite.');
  process.exitCode = 1;
} else if (remoteWorkspace.isRemoteWorkspaceLaunch(process.argv)) {
  remoteWorkspace.startRemoteWorkspace(runtime, runner, {
    guest: remoteWorkspace.isGuestWorkspaceLaunch(process.argv),
  });
} else {
  // Cindy supplies a virtual stdin. Stdout goes straight to the host so a
  // final response cannot be lost between child exit and the wrapper exit.
  const child = spawn(runtime.node, [runner], { env: runtime.env, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  let stopping = false;
  function stop() {
    if (stopping) return;
    stopping = true;
    process.stdin.unpipe(child.stdin);
    child.stdin.end();
    // The upstream bridge releases its backend group on EOF and also has an
    // orphan watchdog if Cindy terminates the wrapper before the grace period.
    setTimeout(() => child.kill('SIGKILL'), 1200).unref();
  }
  child.on('error', () => { console.error('Could not launch the ZCode ACP adapter.'); process.exitCode = 1; });
  child.stdin.on('error', stop);
  child.on('close', code => {
    process.stdin.unpipe(child.stdin);
    process.stdin.pause();
    process.exit(code ?? 1);
  });
  process.stdin.pipe(child.stdin);
  process.stdin.once('end', stop);
  process.stdin.once('error', stop);
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(signal, stop);
  process.once('disconnect', stop);
}
