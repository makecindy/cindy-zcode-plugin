'use strict';

const { spawn } = require('node:child_process');
const { resolveRuntime, runner } = require('./local-runtime.cjs');
const remoteWorkspace = require('./remote-workspace.cjs');
const accountHome = require('./account-home.cjs');

// A task on an account Cindy added (`--cindy-account-dir <path>`) runs ZCode
// only in that account's directory and never falls back to the original
// login. Without the argument nothing changes.
let account = accountHome.accountFromArgv(process.argv);
if (account && !account.error) {
  try {
    accountHome.prepareAccountHome(account);
  } catch (error) {
    account = { error: `The account directory cannot be used (${error && error.message ? error.message : error}).` };
  }
}

const runtime = account && account.error ? null : resolveRuntime();
if (account && account.error) {
  console.error(`[zcode-acp] ${account.error} ZCode was not started.`);
  process.exitCode = accountHome.ACCOUNT_EXIT_CODE;
} else if (runtime.reason) {
  console.error(runtime.reason === 'not-installed' ? 'Install ZCode on this computer to run this task.' : 'ZCode requires Node.js 22.13+ with node:sqlite.');
  process.exitCode = 1;
} else if (remoteWorkspace.isRemoteWorkspaceLaunch(process.argv)) {
  // Shared sessions isolate from the account's tree when one is given.
  remoteWorkspace.startRemoteWorkspace(account ? { ...runtime, env: accountHome.accountEnv(runtime.env, account) } : runtime, runner, {
    guest: remoteWorkspace.isGuestWorkspaceLaunch(process.argv),
  });
} else {
  // Cindy supplies a virtual stdin. Stdout goes straight to the host so a
  // final response cannot be lost between child exit and the wrapper exit.
  const env = account ? accountHome.accountEnv(runtime.env, account) : runtime.env;
  const child = spawn(runtime.node, [runner], { env, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
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
