import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import type { ServiceId } from './broker.js';
import { CATALOG } from './catalog.js';
import { TwakeAiError } from './errors.js';
import { writePrivateFile } from './files.js';
import { withLock } from './lock.js';
import type { AppPaths } from './paths.js';

/**
 * The services that cannot run twice for one account: Twake Chat keeps one Matrix device, whose end-to-end encryption
 * store tolerates a single process. Two clients (two agents, two windows of the same IDE, a reload) would otherwise fight
 * over it — the second one dies. Such a service gets one backend per agent, and every client talks to it over loopback
 * HTTP, which the server already speaks (MCP_TRANSPORT=http), each with its own MCP session.
 */
export const SHARED_SERVICES: readonly ServiceId[] = ['chat'];

export function isSharedService(service: ServiceId): boolean {
  return SHARED_SERVICES.includes(service);
}

/** The backend listens on loopback only: nothing but this computer can reach it, and its token never leaves a 0600 file. */
export const SHARED_HOST = '127.0.0.1';

/** One backend per (service, agent): each agent has its own Matrix device, hence its own store. */
export function sharedDir(paths: AppPaths, service: ServiceId, agent: string): string {
  return join(paths.dataDir, 'shared', `${service}-${agent}`);
}

export interface SharedBackend {
  /** the backend process, killed when the last client leaves */
  pid: number;
  port: number;
}

/** What a client of a backend needs: where it answers, and the token that proves it is allowed to talk to it. */
export interface SharedSession {
  backend: SharedBackend;
  token: string;
}

const backendFile = (dir: string) => join(dir, 'backend.json');
const tokenFile = (dir: string) => join(dir, 'token');
const logFile = (dir: string) => join(dir, 'backend.log');
const clientsDir = (dir: string) => join(dir, 'clients');

/** The lock every process of this (service, agent) takes: the folder of the pair is `<service>-<agent>`. */
function sharedLock(dir: string): string {
  return `shared-${dir.split(/[\\/]/).at(-1)}`;
}

export function backendUrl(backend: SharedBackend): string {
  return `http://${SHARED_HOST}:${backend.port}/mcp`;
}

/** Reads what the backend of that agent wrote when it started; undefined when nothing runs. */
export async function readBackend(dir: string): Promise<SharedBackend | undefined> {
  try {
    const state = JSON.parse(await readFile(backendFile(dir), 'utf8')) as Partial<SharedBackend>;
    if (typeof state.pid !== 'number' || typeof state.port !== 'number') return undefined;
    return { pid: state.pid, port: state.port };
  } catch {
    return undefined;
  }
}

export async function readToken(dir: string): Promise<string | undefined> {
  try {
    const token = (await readFile(tokenFile(dir), 'utf8')).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

/** True while the process of that pid exists (a zombie counts as gone only once reaped: the backend is detached). */
export function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True when something accepts connections on the port: a backend that is still starting answers nothing yet. */
export function listening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: SHARED_HOST, port });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * True when the process of `backend.json` is really our server, and not an unrelated process that inherited its pid after
 * a reboot: the port answers, and `/mcp` takes our token, which was generated for this start and lived in a 0600 file.
 * Anything else answers 401 (the token is wrong) or nothing at all (the port is closed, or something else holds it).
 */
export async function isBackend(dir: string, backend: SharedBackend): Promise<boolean> {
  const token = await readToken(dir);
  if (!token || !alive(backend.pid) || !(await listening(backend.port))) return false;
  const answer = await fetch(backendUrl(backend), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'mcp-twake-ai', method: 'ping' }),
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
  if (!answer) return false;
  await answer.body?.cancel().catch(() => {});
  return answer.status !== 401;
}

/** A port nobody holds right now: the backend is asked to listen on it (MCP_HTTP_PORT takes no 0). */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, SHARED_HOST, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new TwakeAiError('unavailable', 'No loopback port is free to share the Twake.ai MCP server.'))));
    });
  });
}

export interface SharedBackendOptions {
  paths: AppPaths;
  service: ServiceId;
  agent: string;
  /** the environment `run` would give the server, which the backend owns for every client */
  env: Record<string, string>;
  nodePath: string;
  /** the server's entry point (its package's bin) */
  entry: string;
  /** mcp-twake-ai's own command, which watches the backend once its last client is gone */
  cliPath: string;
  /** how long a starting backend may take to accept connections: Matrix signs in and syncs its rooms first */
  readyMs?: number;
}

async function startBackend(options: SharedBackendOptions, dir: string): Promise<SharedBackend> {
  const port = await freePort();
  const token = randomBytes(32).toString('hex');
  // the clients of a backend that is gone listed themselves for nothing: a pid reused by another process must not make
  // the new server look busy, which would leave it running for ever
  await rm(clientsDir(dir), { recursive: true, force: true });
  await writePrivateFile(tokenFile(dir), `${token}\n`);
  // the backend runs on its own, with no terminal: its stderr goes to a file, so that a failure can be explained
  const log = await open(logFile(dir), 'w', 0o600);
  const child = spawn(options.nodePath, [options.entry], {
    // detached: the backend outlives the client that started it; every client, then the last one leaving, stops it
    detached: true,
    stdio: ['ignore', 'ignore', log.fd],
    windowsHide: true,
    env: {
      ...options.env,
      MCP_TRANSPORT: 'http',
      MCP_HTTP_HOST: SHARED_HOST,
      MCP_HTTP_PORT: String(port),
      MCP_HTTP_TOKEN_FILE: tokenFile(dir),
    },
  });
  await log.close();
  child.unref();
  const backend: SharedBackend = { pid: child.pid ?? 0, port };
  await writePrivateFile(backendFile(dir), `${JSON.stringify(backend)}\n`);
  const deadline = Date.now() + (options.readyMs ?? 60_000);
  while (Date.now() < deadline) {
    if (await listening(port)) {
      await watchBackend(options, dir);
      return backend;
    }
    if (!alive(backend.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const reason = await lastLogLine(dir);
  await stopBackend(dir, { trusted: true }).catch(() => {});
  throw new TwakeAiError(
    'unavailable',
    `${options.service} could not start its shared server${reason ? `: ${reason}` : ''}. Run \`mcp-twake-ai run ${options.service} --agent ${options.agent}\` in a terminal to see more, or read ${logFile(dir)}.`,
  );
}

/**
 * A client killed by its agent never says it leaves (SIGKILL on every platform, any crash): the backend would then sync
 * on, holding the Matrix device, until a reboot or a `logout`. This watchdog stops it once no client is left, which is
 * the one thing the server cannot do itself.
 */
async function watchBackend(options: SharedBackendOptions, dir: string): Promise<void> {
  try {
    const child = spawn(options.nodePath, [options.cliPath, '__watch', '--shared', dir, '--locks', options.paths.locksDir], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch {
    /* the watchdog is a safety net: a client that leaves normally still stops the backend */
  }
}

export interface WatchOptions {
  /** how long a backend may have no client before it is stopped: a client that is still starting has not registered yet */
  idleMs?: number;
  /** how often the clients are looked at */
  intervalMs?: number;
}

/**
 * Stops a backend nobody uses any more. Under the lock of the pair, and looking at the clients again: a client that
 * started meanwhile has registered before this could see none.
 */
export async function watchShared(shared: string, locksDir: string, options: WatchOptions = {}): Promise<void> {
  const idleMs = options.idleMs ?? 5 * 60_000;
  const intervalMs = options.intervalMs ?? Math.max(100, Math.min(30_000, Math.floor(idleMs / 4)));
  let idleSince = Date.now();
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const backend = await readBackend(shared);
    if (!backend || !alive(backend.pid)) return;
    if ((await livingClients(clientsDir(shared))) > 0) {
      idleSince = Date.now();
      continue;
    }
    if (Date.now() - idleSince < idleMs) continue;
    if (await stopIfUnused(shared, locksDir)) return;
    idleSince = Date.now();
  }
}

/** The last line the backend wrote before it died, for the error the user reads. */
async function lastLogLine(dir: string): Promise<string | undefined> {
  const text = await readFile(logFile(dir), 'utf8').catch(() => '');
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

/** The MCP sessions the clients of that backend recorded: `stop` closes them before stopping the server. */
async function recordedSessions(dir: string): Promise<string[]> {
  const sessions: string[] = [];
  for (const entry of await readdir(clientsDir(dir)).catch(() => [] as string[])) {
    const text = await readFile(join(clientsDir(dir), entry), 'utf8').catch(() => '');
    try {
      const { session } = JSON.parse(text) as { session?: unknown };
      if (typeof session === 'string' && session) sessions.push(session);
    } catch {
      /* a client that has not opened its session yet, or a file half written when it was killed */
    }
  }
  return sessions;
}

/** Asks the server to close one session (HTTP DELETE): the transport it kept for that client ends with it. */
async function endSession(backend: SharedBackend, token: string, session: string): Promise<void> {
  const answer = await fetch(backendUrl(backend), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'mcp-session-id': session },
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
  await answer?.body?.cancel().catch(() => {});
}

async function stopBackend(dir: string, options: { trusted?: boolean } = {}): Promise<void> {
  const backend = await readBackend(dir);
  if (backend && alive(backend.pid) && (options.trusted || (await isBackend(dir, backend)))) {
    // close the sessions first: every client's stream ends, and the Matrix client sees its clients go before it closes
    const token = await readToken(dir);
    if (token) for (const session of await recordedSessions(dir)) await endSession(backend, token, session);
    // Windows has no signal that asks a process to close: it is terminated, unless it leaves once its sessions are gone
    if (process.platform === 'win32') await waitForExit(backend.pid, 2_000);
    try {
      process.kill(backend.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    // it closes its Matrix session and its store on SIGTERM: give it a moment, without waiting for a hung one
    if (!(await waitForExit(backend.pid, 5_000))) {
      try {
        process.kill(backend.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  await rm(backendFile(dir), { force: true });
  await rm(clientsDir(dir), { recursive: true, force: true });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !alive(pid);
}

/**
 * The backend of that (service, agent), started if nothing answers, and this process registered as one of its clients.
 * Under the lock of that pair: two clients starting at the same moment must not start two backends, which would be back
 * to one store and two processes — and a client that registers here, before the lock is released, cannot lose its server
 * to the last one leaving.
 */
export async function enterSharedBackend(options: SharedBackendOptions): Promise<SharedSession> {
  const dir = sharedDir(options.paths, options.service, options.agent);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // the lock covers the whole start: a Matrix sign-in and its first sync take as long as they take
  const wait = (options.readyMs ?? 60_000) + 10_000;
  return withLock(options.paths.locksDir, sharedLock(dir), async () => {
    const state = await readBackend(dir);
    let backend = state && (await isBackend(dir, state)) ? state : undefined;
    if (!backend) {
      // a backend that was killed, or whose port was taken meanwhile: its state is worthless
      await rm(backendFile(dir), { force: true });
      backend = await startBackend(options, dir);
    }
    const token = await readToken(dir);
    if (!token) throw new TwakeAiError('damaged_file', `The shared ${CATALOG[options.service].name} server of ${options.agent} lost its token: run mcp-twake-ai uninstall, then setup again.`);
    await registerClient(dir);
    return { backend, token };
  }, { timeoutMs: wait });
}

/** Marks this process as a client of the backend, before it connects. */
async function registerClient(dir: string): Promise<void> {
  const clients = clientsDir(dir);
  await mkdir(clients, { recursive: true, mode: 0o700 });
  await writeFile(join(clients, String(process.pid)), '{}\n', { mode: 0o600, flag: 'w' });
}

/** Records the upstream session of this client, so that `stop` can close it before stopping the server. */
export async function setSharedSession(paths: AppPaths, service: ServiceId, agent: string, sessionId: string | undefined): Promise<void> {
  const dir = clientsDir(sharedDir(paths, service, agent));
  await writeFile(join(dir, String(process.pid)), `${JSON.stringify(sessionId ? { session: sessionId } : {})}\n`, { mode: 0o600, flag: 'w' }).catch(() => {});
}

/** The clients still around: a client killed without a chance to leave is not a client any more. */
async function livingClients(dir: string): Promise<number> {
  let others = 0;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid !== process.pid && alive(pid)) others++;
    else await rm(join(dir, entry), { force: true });
  }
  return others;
}

/** Forgets this client of the backend. */
export async function leaveSharedClient(paths: AppPaths, service: ServiceId, agent: string): Promise<void> {
  await rm(join(clientsDir(sharedDir(paths, service, agent)), String(process.pid)), { force: true });
}

async function stopIfUnused(dir: string, locksDir: string): Promise<boolean> {
  if (!(await readBackend(dir))) return false;
  return withLock(locksDir, sharedLock(dir), async () => {
    if ((await livingClients(clientsDir(dir))) > 0) return false;
    await stopBackend(dir);
    await rm(dir, { recursive: true, force: true });
    return true;
  }, { timeoutMs: 30_000 });
}

/**
 * Stops the backend of that agent once no client is left. Under the lock of the pair, and after looking at the clients
 * again: a client that started while this one was leaving must keep its server.
 */
export async function stopSharedIfUnused(paths: AppPaths, service: ServiceId, agent: string): Promise<boolean> {
  return stopIfUnused(sharedDir(paths, service, agent), paths.locksDir);
}

/** Stops the backend of that agent, whoever still lists itself as a client: what `logout` and `uninstall` use. */
export async function stopShared(paths: AppPaths, service: ServiceId, agent: string): Promise<boolean> {
  const dir = sharedDir(paths, service, agent);
  if (!(await readBackend(dir))) return false;
  await withLock(paths.locksDir, sharedLock(dir), async () => {
    await stopBackend(dir);
    await rm(dir, { recursive: true, force: true });
  });
  return true;
}

/** Every backend running for this account, as `(service, agent)`, for `logout`, `uninstall` and `status`. */
export async function runningBackends(paths: AppPaths): Promise<{ service: ServiceId; agent: string; backend: SharedBackend }[]> {
  const root = join(paths.dataDir, 'shared');
  const found: { service: ServiceId; agent: string; backend: SharedBackend }[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const [service, ...rest] = name.split('-');
    const agent = rest.join('-');
    if (!isSharedService(service as ServiceId) || !agent) continue;
    // a backend.json survives a reboot, and its pid may now belong to another process: only our server is reported
    const backend = await readBackend(join(root, name));
    if (backend && (await isBackend(join(root, name), backend))) found.push({ service: service as ServiceId, agent, backend });
  }
  return found;
}
