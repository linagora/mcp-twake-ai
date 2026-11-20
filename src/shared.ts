import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { uptime } from 'node:os';
import { join } from 'node:path';
import type { ServiceId } from './broker.js';
import { CATALOG } from './catalog.js';
import { TwakeAiError } from './errors.js';
import { writePrivateFile } from './files.js';
import { withLock } from './lock.js';
import type { AppPaths } from './paths.js';
import { processIdentity } from './process-identity.js';

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
  /**
   * when it was spawned, and how long it was given to answer: until then, a port that refuses is a server still in its
   * Matrix sign-in and first sync, not a stranger — even when the client that started it is gone
   */
  startedAt?: number;
  readyMs?: number;
  /** the fingerprint of the token that start wrote next to it: what ties this record to that token file */
  tokenHash?: string;
  /** the start time of the process, read from the system as it was spawned: what ties this pid to that process */
  identity?: string;
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
    const start =
      typeof state.startedAt === 'number' && typeof state.readyMs === 'number' && typeof state.tokenHash === 'string'
        ? { startedAt: state.startedAt, readyMs: state.readyMs, tokenHash: state.tokenHash }
        : {};
    const identity = typeof state.identity === 'string' ? { identity: state.identity } : {};
    return { pid: state.pid, port: state.port, ...start, ...identity };
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

/** When this computer booted: a start recorded before it is a pid of another life of the system. */
function bootedAt(): number {
  // a little slack: the clock and the uptime are not read at the same instant
  return Date.now() - uptime() * 1000 - 5_000;
}

/** True while a backend may still be in its sign-in and first sync: the time its start was given has not run out. */
function starting(backend: SharedBackend): boolean {
  return backend.startedAt !== undefined && backend.readyMs !== undefined && backend.startedAt >= bootedAt() && Date.now() < backend.startedAt + backend.readyMs;
}

const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * True when the process that has the recorded pid now is the one that was spawned with it: same start time, read from
 * the system. Nothing else binds a pid to a process — the pid is reused, and the files only say what they were told.
 */
async function sameProcess(backend: SharedBackend): Promise<boolean> {
  return backend.identity !== undefined && (await processIdentity(backend.pid)) === backend.identity;
}

/**
 * The proof that a process that does not answer is the one a start of ours spawned: the process with that pid is the
 * one spawned with it (`sameProcess`), its start was recorded in this boot of the computer, and the token file next to
 * the record is the one that start wrote. A bare pid from a file is never enough.
 */
async function provenStart(dir: string, backend: SharedBackend): Promise<boolean> {
  if (backend.startedAt === undefined || backend.tokenHash === undefined || backend.startedAt < bootedAt() || !(await sameProcess(backend))) return false;
  const token = await readToken(dir);
  return token !== undefined && fingerprint(token) === backend.tokenHash;
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

/**
 * Whether something accepts connections on the port: `refused` when nothing does (a backend that is still starting
 * answers nothing yet), `silent` when the connection neither opens nor fails in time — the kernel accepts for a process
 * whatever its load, so that one is not taken for a no.
 */
function connects(port: number, timeoutMs = 500): Promise<'open' | 'refused' | 'silent'> {
  return new Promise((resolve) => {
    const socket = connect({ host: SHARED_HOST, port });
    const done = (state: 'open' | 'refused' | 'silent') => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => done('silent'));
    socket.once('connect', () => done('open'));
    socket.once('error', () => done('refused'));
  });
}

/**
 * What the process of `backend.json` is: `ours`, `foreign`, or `unknown` when it does not say in time.
 *
 * - ours: the port answers our ping with JSON-RPC, and `/mcp` took our token, which was generated for this start and
 *   lived in a 0600 file.
 * - foreign: the process is gone, or the port is closed, or it turns our token down (401), or something answers that
 *   speaks no JSON-RPC, or no HTTP at all — an unrelated process that inherited the pid after a reboot, or that holds
 *   the port.
 * - unknown: the process lives and the port is open, but no answer came in time (a Matrix sync keeping the server
 *   busy, a laptop waking up); or the port still refuses within the time its start was given (`startedAt`, `readyMs`),
 *   whoever started it — a client killed during the start leaves a server that will answer soon. Its state must not be forgotten then: the next client would start a second server on the same
 *   store, and nothing could stop the first one any more.
 */
export type BackendState = 'ours' | 'foreign' | 'unknown';

export async function probeBackend(dir: string, backend: SharedBackend): Promise<BackendState> {
  const token = await readToken(dir);
  if (!token || !alive(backend.pid)) return 'foreign';
  const port = await connects(backend.port);
  if (port !== 'open') return port === 'refused' && !starting(backend) ? 'foreign' : 'unknown';
  try {
    const answer = await fetch(backendUrl(backend), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'mcp-twake-ai', method: 'ping' }),
      signal: AbortSignal.timeout(2_000),
    });
    if (answer.status === 401) {
      await answer.body?.cancel().catch(() => {});
      return 'foreign';
    }
    return isJsonRpc(await answer.text()) ? 'ours' : 'foreign';
  } catch (error) {
    // no answer in time says nothing; an answer that is not HTTP (a banner, a reset) comes from something else
    const name = (error as Error).name;
    return name === 'TimeoutError' || name === 'AbortError' ? 'unknown' : 'foreign';
  }
}

/**
 * True when the body is a JSON-RPC answer, plain or as a server-sent event: a result, or an error the MCP transport
 * gives (a server that wants a session first) — either way, an MCP server that took our token.
 */
function isJsonRpc(body: string): boolean {
  const candidates = body.trimStart().startsWith('{') ? [body] : body.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5));
  return candidates.some((text) => {
    try {
      const message = JSON.parse(text) as { jsonrpc?: unknown; result?: unknown; error?: unknown };
      return message.jsonrpc === '2.0' && ('result' in message || 'error' in message);
    } catch {
      return false;
    }
  });
}

/**
 * The state of a backend that may be busy: asked again until it says, for `busyMs` at most, or until the time its start
 * was given runs out. Still unknown then, it is reported as such, and the caller fails rather than guess.
 *
 * `stalled`: a start seen running, that ran out of time without answering while its process lives — what its client
 * would have stopped had it not been killed meanwhile. It is ours: left alone, it would hold the store while the next
 * start fails on it, with no `backend.json` to find it by.
 */
async function settleBackend(dir: string, backend: SharedBackend, busyMs: number): Promise<BackendState | 'stalled'> {
  const wasStarting = starting(backend);
  const deadline = Math.max(Date.now() + busyMs, wasStarting ? backend.startedAt! + backend.readyMs! : 0);
  for (;;) {
    const state = await probeBackend(dir, backend);
    if (state === 'foreign' && wasStarting && (await connects(backend.port)) === 'refused' && (await provenStart(dir, backend))) return 'stalled';
    if (state !== 'unknown' || Date.now() >= deadline) return state;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** The error of a backend that lives and does not answer: nothing is started over it, nothing is stopped blindly. */
function busyError(dir: string, backend: SharedBackend): TwakeAiError {
  const [service, ...agent] = (dir.split(/[\\/]/).at(-1) ?? '').split('-');
  const name = CATALOG[service as ServiceId]?.name ?? service;
  return new TwakeAiError(
    'unavailable',
    `The shared ${name} server of ${agent.join('-')} (pid ${backend.pid}) runs but does not answer: try again in a moment. If it stays so, stop that process, then try again; its log is ${logFile(dir)}.`,
  );
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
  /** how long a starting backend may take to answer: Matrix signs in and syncs its rooms first */
  readyMs?: number;
  /** how long a running backend that does not answer is asked again before the client gives up */
  busyMs?: number;
  /** how long the watchdog lets the backend run with no client */
  idleMs?: number;
  /** aborted when the client is stopped during the start: the server it was starting goes with it */
  signal?: AbortSignal;
  /** called as the client is about to list itself: where a test puts the last client leaving at the worst moment */
  beforeRegister?: () => Promise<void>;
}

/** How long a backend that lives and does not answer is asked again: a sync that keeps it busy for longer is a hung one. */
const BUSY_MS = 10_000;

/** How long a starting backend may take to answer: a Matrix sign-in and its first sync take as long as they take. */
const READY_MS = 60_000;

/**
 * How long anyone waits for the lock of a pair, hence how long anyone may hold it: a start that first waited for a
 * server left starting by a killed client, or asked a busy one again (READY_MS at most, BUSY_MS being shorter), then
 * waited for its own (READY_MS), and stopped it when it failed. The start keeps the lock all that time — a client let
 * in meanwhile would see a port that refuses, and could not tell a start from a stranger without `startedAt` — so
 * `logout`, `login --chat`, a client leaving and the watchdog wait it out instead of giving up after the 10 s other
 * locks are waited for.
 */
const LOCK_MS = 2 * READY_MS + 20_000;

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
  const readyMs = options.readyMs ?? READY_MS;
  // when it started, so that another client tells this start from a stranger even if this one is killed meanwhile
  const backend: SharedBackend = { pid: child.pid ?? 0, port, startedAt: Date.now(), readyMs, tokenHash: fingerprint(token) };
  // read from the system now, while this process holds the child: later, only it tells this process from the next one
  // with the same pid
  const identity = await processIdentity(backend.pid);
  if (identity) backend.identity = identity;
  await writePrivateFile(backendFile(dir), `${JSON.stringify(backend)}\n`);
  // the watchdog from the start: a client killed during the sign-in must not leave a server nobody ever stops
  await watchBackend(options, dir, backend);
  const deadline = backend.startedAt! + readyMs;
  while (Date.now() < deadline && !options.signal?.aborted) {
    // the server it started, and not whatever took the port it was given meanwhile (a sign-in and a first sync are long):
    // that process lives, and the port takes the token of this start
    if ((await probeBackend(dir, backend)) === 'ours') return backend;
    if (!alive(backend.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const reason = await lastLogLine(dir);
  // the process this one spawned, through its own handle: no pid read back from a file
  await terminate(dir, backend, child).catch(() => {});
  await forget(dir);
  throw new TwakeAiError(
    'unavailable',
    // the server's stderr is all there is to read: `run` in a terminal is a proxy, and would show nothing more
    `The shared ${CATALOG[options.service].name} server of ${options.agent} could not start${reason ? `: ${reason}` : ''}. Its whole log is in ${logFile(dir)}.`,
  );
}

/**
 * A client killed by its agent never says it leaves (SIGKILL on every platform, any crash): the backend would then sync
 * on, holding the Matrix device, until a reboot or a `logout`. This watchdog stops it once no client is left, which is
 * the one thing the server cannot do itself.
 */
async function watchBackend(options: SharedBackendOptions, dir: string, backend: SharedBackend): Promise<void> {
  try {
    const idle = options.idleMs === undefined ? [] : ['--idle', String(options.idleMs)];
    const given = ['--pid', String(backend.pid), '--started', String(backend.startedAt)];
    const child = spawn(options.nodePath, [options.cliPath, '__watch', '--shared', dir, '--locks', options.paths.locksDir, ...given, ...idle], {
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
  /** the backend this watchdog was started with: the one after it, started by another client, has a watchdog of its own */
  pid: number;
  /** when that backend was started, as the start recorded it: with `pid`, what proves a hung server is that one */
  startedAt?: number;
  /** how long a backend may have no client before it is stopped: a client that is still starting has not registered yet */
  idleMs?: number;
  /** how often the clients are looked at */
  intervalMs?: number;
  /** how long the server may take connections and answer none before it is taken for hung, and stopped */
  frozenMs?: number;
}

/**
 * How long a server may go on not answering before its watchdog stops it, clients or not: every client waits on it, and
 * a Matrix sync never keeps the event loop busy for minutes. The clients then find the port refused, and start the next.
 */
const FROZEN_MS = 5 * 60_000;

/**
 * Stops a backend nobody uses any more. Under the lock of the pair, and looking at the clients again: a client that
 * started meanwhile has registered before this could see none.
 */
export async function watchShared(shared: string, locksDir: string, options: WatchOptions): Promise<void> {
  const idleMs = options.idleMs ?? 5 * 60_000;
  const intervalMs = options.intervalMs ?? Math.max(100, Math.min(30_000, Math.floor(idleMs / 4)));
  // idle since the first look that found no client, not since the last one that found some: after a laptop's sleep,
  // every client's entry is old until its next heartbeat, and that is no reason to stop a server in use
  let idleSince: number | undefined = Date.now();
  let frozenSince: number | undefined;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    const backend = await readBackend(shared);
    if (!backend || backend.pid !== options.pid || !alive(backend.pid)) return;
    // its own server — the pid and start time the start handed it, still recorded with that start's token — that takes
    // connections and answers none
    const own = options.startedAt !== undefined && backend.startedAt === options.startedAt && !starting(backend);
    if (own && (await probeBackend(shared, backend)) === 'unknown') {
      frozenSince ??= Date.now();
      if (Date.now() - frozenSince >= (options.frozenMs ?? FROZEN_MS) && (await stopFrozen(shared, locksDir, options).catch(() => false))) return;
    } else {
      frozenSince = undefined;
    }
    if ((await livingClients(clientsDir(shared), CLIENT_STALE_MS)) > 0) {
      idleSince = undefined;
      continue;
    }
    idleSince ??= Date.now();
    if (Date.now() - idleSince < idleMs) continue;
    // a backend that does not answer is neither stopped nor forgotten: the next look tries again
    if (await stopIfUnused(shared, locksDir, CLIENT_STALE_MS).catch(() => false)) return;
    idleSince = undefined;
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

/**
 * Asks the server to close one session (HTTP DELETE): the transport it kept for that client ends with it. Best effort,
 * and 2 s at most: what `stop` does for every client, and a client stopped by a signal for its own.
 */
export async function endSharedSession(backend: SharedBackend, token: string, session: string): Promise<void> {
  const answer = await fetch(backendUrl(backend), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}`, 'mcp-session-id': session },
    signal: AbortSignal.timeout(2_000),
  }).catch(() => undefined);
  await answer?.body?.cancel().catch(() => {});
}

/**
 * Stops the backend of that folder if it is proven ours — it answers our ping with the token of its start, or it is a
 * start that ran out of time and `provenStart` vouches for it — then forgets its state. A stranger is only forgotten.
 */
async function stopBackend(dir: string, options: { busyMs?: number } = {}): Promise<void> {
  const backend = await readBackend(dir);
  const state = !backend || !alive(backend.pid) ? 'foreign' : await settleBackend(dir, backend, options.busyMs ?? BUSY_MS);
  // a server that may be ours keeps its state: forgotten, it would run on with the Matrix device and nothing to stop it
  if (state === 'unknown') throw busyError(dir, backend!);
  if (backend && (state === 'ours' || state === 'stalled')) await terminate(dir, backend);
  await forget(dir);
}

/** Forgets the state of a backend that is gone, or was never ours. */
async function forget(dir: string): Promise<void> {
  await rm(backendFile(dir), { force: true });
  await rm(clientsDir(dir), { recursive: true, force: true });
}

/**
 * Stops a backend whose ownership the caller has proven: the process it spawned (`child`, its own handle), or a pid it
 * has just confirmed — and then only if the process with that pid is still the one spawned with it, checked again
 * before each signal. Never called with a bare pid read from a file; when the process cannot be told apart, nothing is
 * signalled and the caller is told.
 */
async function terminate(dir: string, backend: SharedBackend, child?: ChildProcess): Promise<void> {
  const notProven = () =>
    new TwakeAiError(
      'unavailable',
      `The process ${backend.pid} recorded for the shared server in ${dir} cannot be told from another process that got its pid (its start time ${backend.identity ? 'does not match' : 'was not recorded'}): it was left running. Stop it yourself if it is the server.`,
    );
  if (!child && !(await sameProcess(backend))) throw notProven();
  const signal = async (name: NodeJS.Signals) => {
    if (!child && !(await sameProcess(backend))) return;
    try {
      if (child) child.kill(name);
      else process.kill(backend.pid, name);
    } catch {
      /* already gone */
    }
  };
  // close the sessions first: every client's stream ends, and the Matrix client sees its clients go before it closes
  const token = await readToken(dir);
  if (token) for (const session of await recordedSessions(dir)) await endSharedSession(backend, token, session);
  // Windows has no signal that asks a process to close: it is terminated, unless it leaves once its sessions are gone
  if (process.platform === 'win32') await waitForExit(backend.pid, 2_000);
  await signal('SIGTERM');
  // it closes its Matrix session and its store on SIGTERM: give it a moment, without waiting for a hung one
  if (!(await waitForExit(backend.pid, 5_000))) await signal('SIGKILL');
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
  // the lock covers the whole start: see LOCK_MS
  return withLock(options.paths.locksDir, sharedLock(dir), async () => {
    const state = await readBackend(dir);
    const known = state ? await settleBackend(dir, state, options.busyMs ?? BUSY_MS) : 'foreign';
    // a second server on the same store is what this whole folder prevents: better no Chat for now than two
    if (state && known === 'unknown') throw busyError(dir, state);
    // proven by settleBackend: its start was recorded in this boot, with the token file next to it
    if (state && known === 'stalled') {
      await terminate(dir, state);
      await forget(dir);
    }
    let backend = known === 'ours' ? state : undefined;
    if (!backend) {
      // a backend that was killed, or whose port was taken meanwhile: its state is worthless
      await rm(backendFile(dir), { force: true });
      backend = await startBackend(options, dir);
    }
    const token = await readToken(dir);
    if (!token) throw new TwakeAiError('damaged_file', `The shared ${CATALOG[options.service].name} server of ${options.agent} lost its token: run mcp-twake-ai uninstall, then setup again.`);
    await registerClient(dir, options);
    return { backend, token };
  }, { timeoutMs: LOCK_MS });
}

/** Marks this process as a client of the backend, before it connects. */
async function registerClient(dir: string, options: SharedBackendOptions): Promise<void> {
  await options.beforeRegister?.();
  const clients = clientsDir(dir);
  await mkdir(clients, { recursive: true, mode: 0o700 });
  await writeFile(join(clients, String(process.pid)), '{}\n', { mode: 0o600, flag: 'w' });
}

/** Records the upstream session of this client, so that `stop` can close it before stopping the server. */
export async function setSharedSession(paths: AppPaths, service: ServiceId, agent: string, sessionId: string | undefined): Promise<void> {
  const dir = clientsDir(sharedDir(paths, service, agent));
  await writeFile(join(dir, String(process.pid)), `${JSON.stringify(sessionId ? { session: sessionId } : {})}\n`, { mode: 0o600, flag: 'w' }).catch(() => {});
}

/**
 * How often a client touches its entry, and how long an entry may go untouched before the watchdog stops believing its
 * pid: Windows and macOS give a pid out again soon, and a process that inherited the pid of a killed client would keep
 * the server running for ever. A heartbeat is the one sign of life that works the same on every platform.
 */
export const CLIENT_BEAT_MS = 30_000;
const CLIENT_STALE_MS = 4 * CLIENT_BEAT_MS;

/**
 * Touches this client's entry until the returned function is called: what tells the watchdog the pid is still ours.
 * Never recreated: an entry that is gone belongs to a server that is gone.
 */
export function keepSharedClient(paths: AppPaths, service: ServiceId, agent: string, intervalMs = CLIENT_BEAT_MS): () => void {
  const entry = join(clientsDir(sharedDir(paths, service, agent)), String(process.pid));
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(entry, now, now).catch(() => {});
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * The clients still around: a client killed without a chance to leave is not a client any more. With `staleMs` (the
 * watchdog), neither is one whose entry went untouched for that long — its pid is someone else's, or it is hung — but
 * that entry stays: a client that wakes up from a sleep touches it again. A client leaving trusts the pid alone, and
 * leaves a doubtful server to the watchdog.
 */
async function livingClients(dir: string, staleMs?: number): Promise<number> {
  let others = 0;
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (pid === process.pid || !alive(pid)) {
      await rm(join(dir, entry), { force: true });
      continue;
    }
    if (staleMs !== undefined) {
      const touched = await stat(join(dir, entry)).then((info) => info.mtimeMs, () => 0);
      if (Date.now() - touched > staleMs) continue;
    }
    others++;
  }
  return others;
}

/** Forgets this client of the backend. */
export async function leaveSharedClient(paths: AppPaths, service: ServiceId, agent: string): Promise<void> {
  await rm(join(clientsDir(sharedDir(paths, service, agent)), String(process.pid)), { force: true });
}

/**
 * Stops a hung server under the lock of its pair, once proven to be the one the watchdog was given: same pid, same start
 * time, the token file of that start next to it, recorded in this boot — and still answering nothing.
 */
async function stopFrozen(dir: string, locksDir: string, given: WatchOptions): Promise<boolean> {
  return withLock(locksDir, sharedLock(dir), async () => {
    const backend = await readBackend(dir);
    if (!backend || backend.pid !== given.pid || backend.startedAt !== given.startedAt || !(await provenStart(dir, backend))) return false;
    if ((await probeBackend(dir, backend)) === 'foreign') return false;
    await terminate(dir, backend);
    await rm(dir, { recursive: true, force: true });
    return true;
  }, { timeoutMs: LOCK_MS });
}

async function stopIfUnused(dir: string, locksDir: string, staleMs?: number): Promise<boolean> {
  if (!(await readBackend(dir))) return false;
  return withLock(locksDir, sharedLock(dir), async () => {
    if ((await livingClients(clientsDir(dir), staleMs)) > 0) return false;
    await stopBackend(dir);
    await rm(dir, { recursive: true, force: true });
    return true;
  }, { timeoutMs: LOCK_MS });
}

/**
 * Stops the backend of that agent once no client is left. Under the lock of the pair, and after looking at the clients
 * again: a client that started while this one was leaving must keep its server.
 */
export async function stopSharedIfUnused(paths: AppPaths, service: ServiceId, agent: string): Promise<boolean> {
  return stopIfUnused(sharedDir(paths, service, agent), paths.locksDir);
}

/**
 * Stops the backend of that agent, whoever still lists itself as a client: what `logout` and `uninstall` use. `busyMs`:
 * how long one that does not answer is asked again before this gives up (BUSY_MS).
 */
export async function stopShared(paths: AppPaths, service: ServiceId, agent: string, options: { busyMs?: number } = {}): Promise<boolean> {
  const dir = sharedDir(paths, service, agent);
  if (!(await readBackend(dir))) return false;
  await withLock(paths.locksDir, sharedLock(dir), async () => {
    await stopBackend(dir, options);
    await rm(dir, { recursive: true, force: true });
  }, { timeoutMs: LOCK_MS });
  return true;
}

/**
 * Runs `fn` with the backend of that agent stopped, and none able to start until it returns: under the lock of the pair.
 * What `login --chat` does around the device swap: the backend keeps the store of the device it was started with, and
 * must not get the token of the next one; the next client starts a server on the new device.
 */
export async function withSharedStopped<T>(paths: AppPaths, service: ServiceId, agent: string, fn: () => Promise<T>, options: { busyMs?: number } = {}): Promise<T> {
  const dir = sharedDir(paths, service, agent);
  return withLock(paths.locksDir, sharedLock(dir), async () => {
    if (await readBackend(dir)) {
      await stopBackend(dir, options);
      await rm(dir, { recursive: true, force: true });
    }
    return fn();
  }, { timeoutMs: LOCK_MS });
}

/** A backend that runs for this account: `answers` is false while it is still starting, or too busy to say. */
export interface RunningBackend {
  service: ServiceId;
  agent: string;
  backend: SharedBackend;
  answers: boolean;
}

/** Every backend running for this account, as `(service, agent)`, for `logout`, `uninstall` and `status`. */
export async function runningBackends(paths: AppPaths): Promise<RunningBackend[]> {
  const root = join(paths.dataDir, 'shared');
  const found: RunningBackend[] = [];
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const [service, ...rest] = name.split('-');
    const agent = rest.join('-');
    if (!isSharedService(service as ServiceId) || !agent) continue;
    // a backend.json survives a reboot, and its pid may now belong to another process: only our server is reported, or
    // one still starting or too busy to say, which `logout` must still try to stop
    const backend = await readBackend(join(root, name));
    const state = backend ? await probeBackend(join(root, name), backend) : 'foreign';
    if (backend && state !== 'foreign') found.push({ service: service as ServiceId, agent, backend, answers: state === 'ours' });
  }
  return found;
}
