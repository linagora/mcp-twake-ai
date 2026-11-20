import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { CATALOG } from './catalog.js';
import { TwakeAiError } from './errors.js';
import { entryPoint, serverDir } from './installer.js';
import type { AppPaths } from './paths.js';
import { proves } from './proof.js';

/**
 * One mcp-twake-chat per agent, shared by the agent's clients (spec shared-chat §3). mcp-twake-chat holds the store lock
 * (one process per device), publishes server.json once it listens, and stops on POST /mcp/shutdown or once idle: this
 * module only finds it, starts it, and asks it to stop. It never signals a process it did not start in this command,
 * and never sends the token to what listens on the server's port before it proved it holds that token (proof.ts).
 */
const READY_MS = 5 * 60_000;
const PING_MS = 2000;
const GONE_MS = 15_000;
const PROGRESS_MS = 3000;
const STORE_IN_USE = 75;
/** after a start that found the store held, the next try comes this late, then twice as late, up to RETRY_MAX_MS */
const RETRY_MS = 1000;
const RETRY_MAX_MS = 15_000;

export interface SharedServer {
  url: string;
  token: string;
  pid: number;
  deviceId: string;
}

export interface SharedChatDeps {
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  /** serviceEnv('chat', agent) as the config is now, plus the shared-mode variables: read again at every entry */
  buildEnv(): Promise<Record<string, string>>;
  /** the device the config gives the agent now */
  deviceId(): Promise<string>;
  stderr(text: string): void;
  readyMs?: number;
  /** the account whose files these must be (POSIX; default: this process's) */
  uid?: number;
}

export function sharedChatFiles(paths: AppPaths, agent: string): { dir: string; state: string; log: string } {
  const dir = join(paths.dataDir, 'chat', agent);
  return { dir, state: join(dir, 'server.json'), log: join(dir, 'server.log') };
}

/** What turns mcp-twake-chat into the agent's shared server (spec §3.1), on top of serviceEnv('chat', agent). */
export function sharedChatEnv(paths: AppPaths, agent: string): Record<string, string> {
  return {
    MCP_TRANSPORT: 'http',
    MCP_HTTP_HOST: '127.0.0.1',
    MCP_HTTP_PORT: '0',
    MCP_HTTP_STATE_FILE: sharedChatFiles(paths, agent).state,
    MCP_HTTP_EXIT_WHEN_IDLE_MS: '600000',
  };
}

/** mcp-twake-chat 0.7.0 and later declare `"twake": { "sharedHttp": 1 }`: older ones keep running over stdio. */
export async function supportsSharedHttp(paths: AppPaths): Promise<boolean> {
  const pkg = CATALOG.chat;
  try {
    const json = JSON.parse(await readFile(join(serverDir(paths, pkg.name), 'node_modules', pkg.name, 'package.json'), 'utf8')) as { twake?: { sharedHttp?: unknown } };
    const level = json.twake?.sharedHttp;
    return typeof level === 'number' && level >= 1;
  } catch {
    return false;
  }
}

/** http://127.0.0.1:<port>/mcp or http://localhost:<port>/mcp: what the shared mode publishes, and where the token may go. */
function loopbackEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'http:' &&
      (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
      u.port !== '' &&
      u.pathname === '/mcp' &&
      u.search === '' &&
      u.hash === '' &&
      u.username === '' &&
      u.password === '' &&
      url === `http://${u.hostname}:${u.port}/mcp`
    );
  } catch {
    return false;
  }
}

function parseState(text: string): (SharedServer & { url: string }) | undefined {
  try {
    const s = JSON.parse(text) as Partial<SharedServer> & { version?: number };
    if (s.version !== 1 || typeof s.url !== 'string' || typeof s.token !== 'string' || typeof s.pid !== 'number' || typeof s.deviceId !== 'string') return undefined;
    return { url: s.url, token: s.token, pid: s.pid, deviceId: s.deviceId };
  } catch {
    return undefined;
  }
}

/** The pid server.json names now, whoever wrote it: only to see a server go, never to use its token. */
async function statePid(file: string): Promise<number | undefined> {
  return parseState(await readFile(file, 'utf8').catch(() => ''))?.pid;
}

const notFound = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * server.json, when mcp-twake-ai can trust it with a token: a regular file (not a link), and on POSIX, it and its folder
 * this account's and closed to others (0600, 0700), with a loopback address. A folder of another account makes it fail;
 * a file that is not to be trusted is `refused`, with the reason, and its token never used.
 */
async function trustedState(files: ReturnType<typeof sharedChatFiles>, uid: number | undefined): Promise<{ state?: SharedServer; refused?: string }> {
  const posix = process.platform !== 'win32';
  const folder = await lstat(files.dir).catch((error: unknown) => {
    if (notFound(error)) return undefined;
    throw error;
  });
  if (!folder) return {};
  if (!folder.isDirectory() || (posix && uid !== undefined && folder.uid !== uid)) {
    throw new TwakeAiError('insecure_file', `${files.dir} is not a folder of this account: mcp-twake-ai does not use it. Remove it, then run this command again.`);
  }
  const file = await lstat(files.state).catch((error: unknown) => {
    if (notFound(error)) return undefined;
    throw error;
  });
  if (!file) return {};
  if (file.isSymbolicLink()) return { refused: 'it is a symbolic link' };
  if (!file.isFile()) return { refused: 'it is not a file' };
  if (posix) {
    if (uid !== undefined && file.uid !== uid) return { refused: 'it belongs to another account' };
    if (file.mode & 0o077) return { refused: 'other accounts can read or change it' };
    if (folder.mode & 0o077) return { refused: `other accounts can enter ${files.dir}` };
  }
  const state = parseState(await readFile(files.state, 'utf8').catch(() => ''));
  if (!state) return {};
  if (!loopbackEndpoint(state.url)) return { refused: 'its address is not a loopback address of this computer' };
  return { state };
}

const accountOf = (d: Pick<SharedChatDeps, 'uid'>) => d.uid ?? process.getuid?.();

/**
 * The server of this state file, and nothing else, answers: it proves it holds the token (without the token going
 * anywhere), then answers a JSON-RPC ping sent with the token.
 */
export async function answers(server: SharedServer): Promise<boolean> {
  if (!(await proves(server.url, server.token, { pid: server.pid }))) return false;
  try {
    const r = await fetch(server.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'twake-ai-ping', method: 'ping' }),
      signal: AbortSignal.timeout(PING_MS),
      redirect: 'error',
    });
    if (r.status !== 200) return false;
    return (await r.text()).includes('"jsonrpc"');
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitGone(file: string, pid: number): Promise<boolean> {
  const deadline = Date.now() + GONE_MS;
  while (Date.now() < deadline) {
    if ((await statePid(file)) !== pid) return true;
    await sleep(200);
  }
  return false;
}

async function lastLine(file: string): Promise<string> {
  const text = await readFile(file, 'utf8').catch(() => '');
  return text.trim().split('\n').pop()?.trim() ?? '';
}

/**
 * The agent's shared server (spec §3.1): the one server.json describes when it proves itself and runs on the agent's
 * device now, or a new one. The config is read again at every call: a client that reconnects after `login --chat`
 * lands on the new device.
 */
export async function enterSharedChat(agent: string, d: SharedChatDeps): Promise<SharedServer> {
  const files = sharedChatFiles(d.paths, agent);
  const device = await d.deviceId();
  const { state: current, refused } = await trustedState(files, accountOf(d));
  if (refused) {
    // its token is never used; the folder is ours (trustedState checked it): the file goes, and our server writes its own
    d.stderr(`mcp-twake-ai: ${files.state} is not to be trusted (${refused}): ignored, a shared Chat server of our own starts.\n`);
    await unlink(files.state).catch(() => {});
  }
  if (current && (await answers(current))) {
    if (current.deviceId === device) return current;
    // the agent has another device now: the server of the old one goes, by its route
    await stopServer(current);
    await waitGone(files.state, current.pid);
  }
  return start(agent, files, device, d);
}

async function spawnServer(files: ReturnType<typeof sharedChatFiles>, d: SharedChatDeps): Promise<ChildProcess> {
  await mkdir(files.dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(files.dir, 0o700);
  const log = await open(files.log, 'a', 0o600);
  try {
    if (process.platform !== 'win32') await log.chmod(0o600);
    const entry = await entryPoint(d.paths, 'chat');
    const env = await d.buildEnv();
    // detached, with no stdio of ours: the server outlives this client, and serves the next ones
    const child = spawn(d.nodePath, [entry], { env, stdio: ['ignore', 'ignore', log.fd], detached: true, windowsHide: true });
    child.unref();
    return child;
  } finally {
    await log.close();
  }
}

async function start(agent: string, files: ReturnType<typeof sharedChatFiles>, device: string, d: SharedChatDeps): Promise<SharedServer> {
  const readyMs = d.readyMs ?? READY_MS;
  const started = Date.now();
  let child = await spawnServer(files, d);
  let exited: number | null | undefined;
  const watch = (c: ChildProcess) => {
    exited = undefined;
    c.once('exit', (code) => {
      if (c === child) exited = code;
    });
    c.once('error', () => {
      if (c === child) exited = 1;
    });
  };
  watch(child);
  let told = false;
  let retries = 0;
  let retryAt = 0;
  for (;;) {
    const { state } = await trustedState(files, accountOf(d));
    if (state && state.deviceId === device && (state.pid === child.pid || exited === STORE_IN_USE) && (await answers(state))) {
      // ours, or the one that won the store lock against ours
      return state;
    }
    if (exited !== undefined && exited !== STORE_IN_USE) {
      throw new TwakeAiError('unavailable', `The shared Twake Chat server for ${agent} stopped (${await lastLine(files.log)}). Its log: ${files.log}`);
    }
    if (exited === STORE_IN_USE) {
      // another process holds the store: a start that won (it publishes once it listens), or a server that is stopping
      // (its state file already gone). Try again now and then: the store is free once that server has stopped.
      if (retryAt === 0) retryAt = Date.now() + Math.min(RETRY_MS * 2 ** retries, RETRY_MAX_MS);
      else if (Date.now() >= retryAt) {
        retries++;
        retryAt = 0;
        child = await spawnServer(files, d);
        watch(child);
      }
    }
    if (!told && Date.now() - started > PROGRESS_MS) {
      told = true;
      d.stderr(`Starting the shared Twake Chat server for ${agent} (pid ${child.pid ?? '?'}, log ${files.log})…\n`);
    }
    if (Date.now() - started > readyMs) {
      // our child, in this command: the only process we ever signal
      if (exited === undefined) child.kill();
      throw new TwakeAiError('unavailable', `The shared Twake Chat server for ${agent} did not start within ${Math.round(readyMs / 1000)} s. Its log: ${files.log}`);
    }
    await sleep(250);
  }
}

/** POST /mcp/shutdown, only to a server that proved it holds the token. */
async function stopServer(server: SharedServer): Promise<boolean> {
  if (!(await proves(server.url, server.token, { pid: server.pid }))) return false;
  try {
    const r = await fetch(`${server.url}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(PING_MS), redirect: 'error' });
    return r.status === 202;
  } catch {
    return false;
  }
}

/** Stops the agent's shared server by its route (spec §3.3): logout, uninstall and login --chat. */
export async function stopSharedChat(agent: string, d: Pick<SharedChatDeps, 'paths' | 'uid'>): Promise<'stopped' | 'none'> {
  const files = sharedChatFiles(d.paths, agent);
  const { state, refused } = await trustedState(files, accountOf(d));
  if (refused) throw new TwakeAiError('insecure_file', `${files.state} is not to be trusted (${refused}): nothing was stopped. Remove it, then run this command again.`);
  if (!state) return 'none';
  if (!(await answers(state))) {
    throw new TwakeAiError('unavailable', `The shared Twake Chat server for ${agent} (pid ${state.pid}) does not answer: stop it, then run this command again.`);
  }
  if (!(await stopServer(state)) || !(await waitGone(files.state, state.pid))) {
    throw new TwakeAiError('unavailable', `The shared Twake Chat server for ${agent} (pid ${state.pid}) did not stop: stop it, then run this command again.`);
  }
  return 'stopped';
}
