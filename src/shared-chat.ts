import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, open, readFile } from 'node:fs/promises';
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
}

export function sharedChatFiles(paths: AppPaths, agent: string): { dir: string; state: string; log: string } {
  const dir = join(paths.dataDir, 'chat', agent);
  return { dir, state: join(dir, 'server.json'), log: join(dir, 'server.log') };
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

/** A loopback http URL: the only kind the shared mode listens on, and the only kind the token goes to. */
function loopback(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export async function readSharedState(file: string): Promise<SharedServer | undefined> {
  try {
    const s = JSON.parse(await readFile(file, 'utf8')) as Partial<SharedServer> & { version?: number };
    if (s.version !== 1 || typeof s.url !== 'string' || typeof s.token !== 'string' || typeof s.pid !== 'number' || typeof s.deviceId !== 'string') return undefined;
    if (!loopback(s.url)) return undefined;
    return { url: s.url, token: s.token, pid: s.pid, deviceId: s.deviceId };
  } catch {
    return undefined;
  }
}

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
    const s = await readSharedState(file);
    if (!s || s.pid !== pid) return true;
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
  const current = await readSharedState(files.state);
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
    const state = await readSharedState(files.state);
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
export async function stopSharedChat(agent: string, d: Pick<SharedChatDeps, 'paths'>): Promise<'stopped' | 'none'> {
  const files = sharedChatFiles(d.paths, agent);
  const state = await readSharedState(files.state);
  if (!state) return 'none';
  if (!(await answers(state))) {
    throw new TwakeAiError('unavailable', `The shared Twake Chat server for ${agent} (pid ${state.pid}) does not answer: stop it, then run this command again.`);
  }
  if (!(await stopServer(state)) || !(await waitGone(files.state, state.pid))) {
    throw new TwakeAiError('unavailable', `The shared Twake Chat server for ${agent} (pid ${state.pid}) did not stop: stop it, then run this command again.`);
  }
  return 'stopped';
}
