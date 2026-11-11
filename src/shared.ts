import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import type { ServiceId } from './broker.js';
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

const backendFile = (dir: string) => join(dir, 'backend.json');
const tokenFile = (dir: string) => join(dir, 'token');
const logFile = (dir: string) => join(dir, 'backend.log');
const clientsDir = (dir: string) => join(dir, 'clients');

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
  /** how long a starting backend may take to accept connections: Matrix signs in and syncs its rooms first */
  readyMs?: number;
}

async function startBackend(options: SharedBackendOptions, dir: string): Promise<SharedBackend> {
  const port = await freePort();
  const token = randomBytes(32).toString('hex');
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
    if (await listening(port)) return backend;
    if (!alive(backend.pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const reason = await lastLogLine(dir);
  await stopBackend(dir).catch(() => {});
  throw new TwakeAiError(
    'unavailable',
    `${options.service} could not start its shared server${reason ? `: ${reason}` : ''}. Run \`mcp-twake-ai run ${options.service} --agent ${options.agent}\` in a terminal to see more, or read ${logFile(dir)}.`,
  );
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

async function stopBackend(dir: string): Promise<void> {
  const backend = await readBackend(dir);
  if (backend && alive(backend.pid)) {
    try {
      process.kill(backend.pid);
    } catch {
      /* already gone */
    }
    // it closes its Matrix session and its store on SIGTERM: give it a moment, without waiting for a hung one
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && alive(backend.pid)) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await rm(backendFile(dir), { force: true });
}

/**
 * The backend of that (service, agent), started if nothing answers. Under the lock of that pair: two clients starting
 * at the same moment must not start two backends, which would be back to one store and two processes.
 */
export async function ensureSharedBackend(options: SharedBackendOptions): Promise<SharedBackend> {
  const dir = sharedDir(options.paths, options.service, options.agent);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // the lock covers the whole start: a Matrix sign-in and its first sync take as long as they take
  const wait = (options.readyMs ?? 60_000) + 10_000;
  return withLock(options.paths.locksDir, `shared-${options.service}-${options.agent}`, async () => {
    const backend = await readBackend(dir);
    if (backend && alive(backend.pid) && (await listening(backend.port))) return backend;
    // a backend that was killed, or whose port was taken meanwhile: its state is worthless
    await rm(backendFile(dir), { force: true });
    return startBackend(options, dir);
  }, { timeoutMs: wait });
}

/** Marks this process as a client of the backend, before it connects. */
export async function enterSharedClient(paths: AppPaths, service: ServiceId, agent: string): Promise<void> {
  const dir = clientsDir(sharedDir(paths, service, agent));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, String(process.pid)), '', { mode: 0o600, flag: 'w' });
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

/**
 * Stops the backend of that agent once no client is left. Under the lock of the pair, and after looking at the clients
 * again: a client that started while this one was leaving must keep its server.
 */
export async function stopSharedIfUnused(paths: AppPaths, service: ServiceId, agent: string): Promise<boolean> {
  const dir = sharedDir(paths, service, agent);
  if (!(await readBackend(dir))) return false;
  return withLock(paths.locksDir, `shared-${service}-${agent}`, async () => {
    if ((await livingClients(clientsDir(dir))) > 0) return false;
    await stopBackend(dir);
    await rm(dir, { recursive: true, force: true });
    return true;
  }, { timeoutMs: 30_000 });
}

/** Stops the backend of that agent, whoever still lists itself as a client: what `logout` and `uninstall` use. */
export async function stopShared(paths: AppPaths, service: ServiceId, agent: string): Promise<boolean> {
  const dir = sharedDir(paths, service, agent);
  if (!(await readBackend(dir))) return false;
  await withLock(paths.locksDir, `shared-${service}-${agent}`, async () => {
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
    const backend = await readBackend(join(root, name));
    if (backend && alive(backend.pid)) found.push({ service: service as ServiceId, agent, backend });
  }
  return found;
}
