import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { ServiceId } from './broker.js';
import { CATALOG, serviceEnv } from './catalog.js';
import { loadConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { checkAgentId } from './grants.js';
import { entryPoint } from './installer.js';
import type { AppPaths } from './paths.js';
import { proxyShared } from './proxy.js';
import { backendUrl, endSharedSession, enterSharedBackend, isSharedService, keepSharedClient, leaveSharedClient, setSharedSession, stopSharedIfUnused, type SharedSession } from './shared.js';

export interface LaunchDeps {
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  platform: NodeJS.Platform;
  language: 'en' | 'fr';
  timezone: string;
}

/**
 * Starts one MCP server for one agent. Its stdio is the agent's (inherited, so approval requests go both ways untouched);
 * signals are passed on, and its exit code becomes ours. Nothing is ever written to stdout here: that is the MCP channel.
 *
 * A service that cannot run twice for one account (Twake Chat and its Matrix device) is not started here: its single
 * backend is shared, and this process is one more client of it.
 */
export async function runService(service: ServiceId, agent: string, deps: LaunchDeps): Promise<number> {
  checkAgentId(agent);
  const config = await loadConfig(deps.paths);
  if (!config) throw new TwakeAiError('login_required', 'mcp-twake-ai is not set up on this computer: run `mcp-twake-ai login --email <address>`.');
  const built = serviceEnv(service, agent, { config, paths: deps.paths, nodePath: deps.nodePath, cliPath: deps.cliPath, platform: deps.platform, language: deps.language, timezone: deps.timezone });
  if (isSharedService(service)) return runShared(service, agent, deps, built);
  // what the agent's environment already sets wins (spec §9)
  const env = { ...built, ...deps.env };
  const entry = await entryPoint(deps.paths, service);
  return new Promise((resolve, reject) => {
    const child = spawn(deps.nodePath, [entry], { stdio: 'inherit', env, windowsHide: true });
    const forwarded = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => [signal, () => child.kill(signal)] as const);
    for (const [signal, handler] of forwarded) process.on(signal, handler);
    const cleanup = () => {
      for (const [signal, handler] of forwarded) process.off(signal, handler);
    };
    child.once('error', (error) => {
      cleanup();
      reject(new TwakeAiError('unavailable', `Cannot start ${CATALOG[service].name}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
  });
}

/**
 * `run` for a shared service: one backend per agent, started by the first client and stopped by the last one, and every
 * client bridged to a session of its own. The environment the agent sets for the service is not passed on: it belongs to
 * the process that starts the server, which here is shared with other clients. The process environment is inherited, so
 * that the backend finds the same home folder, keychain and network as its first client.
 */
async function runShared(service: ServiceId, agent: string, deps: LaunchDeps, env: Record<string, string>): Promise<number> {
  const backendEnv = { ...stringEnv(deps.env), ...env };
  // a signal during the start stops the server this client was starting: see the handlers below
  const starting = new AbortController();
  let entering: Promise<unknown> = Promise.resolve();
  let shared: SharedSession | undefined;
  let session: string | undefined;
  let stopBeat = () => {};
  let left = false;
  const leave = async () => {
    // a client that never got in has nothing to leave: the start it aborted has cleaned up after itself
    if (left || !shared) return;
    left = true;
    stopBeat();
    await leaveSharedClient(deps.paths, service, agent);
    await stopSharedIfUnused(deps.paths, service, agent).catch(() => false);
  };
  // set before the start: a client stopped during the Matrix sign-in must not leave a server nobody knows of. A client
  // killed by its agent still stops the backend when it was the last one, and closes its session first: the other
  // clients keep the server running, which would hold that session for 6 hours
  const signals = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
    const handler = () => {
      starting.abort();
      // the start notices within a ping, then stops its server; a client still waiting for the lock started nothing
      void Promise.race([entering.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 10_000))])
        .then(() => (shared && session ? endSharedSession(shared.backend, shared.token, session) : undefined))
        .then(leave)
        .finally(() => process.exit(128 + (constants.signals[signal] ?? 0)));
    };
    process.once(signal, handler);
    return [signal, handler] as const;
  });
  const entry = await entryPoint(deps.paths, service);
  // this process registers as a client before the start returns, under the same lock the last client leaving takes
  const enter = async () => {
    const entered = enterSharedBackend({ paths: deps.paths, service, agent, env: backendEnv, nodePath: deps.nodePath, cliPath: deps.cliPath, entry, signal: starting.signal });
    entering = entered;
    shared = await entered;
    return shared;
  };
  try {
    shared = await enter();
    // the watchdog believes a client's pid only while its entry is touched: a pid is soon someone else's on some systems
    stopBeat = keepSharedClient(deps.paths, service, agent);
    return await proxyShared({
      url: backendUrl(shared.backend),
      token: shared.token,
      name: CATALOG[service].name,
      version: CATALOG[service].version,
      onSession: (id) => {
        session = id;
        void setSharedSession(deps.paths, service, agent, id);
      },
      // the server went under a connected client: the one running now, or a new one, as at the start
      reconnect: async () => {
        const next = await enter();
        return { url: backendUrl(next.backend), token: next.token };
      },
    });
  } finally {
    for (const [signal, handler] of signals) process.off(signal, handler);
    await leave();
  }
}

/** The process environment as plain strings; `spawn` takes no undefined value. */
function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}
