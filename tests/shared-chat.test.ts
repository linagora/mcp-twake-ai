/**
 * One mcp-twake-chat per agent, found, started, joined and stopped by mcp-twake-ai (spec shared-chat §3.1, §3.3), on the
 * fake shared server, which locks its store as mcp-twake-chat does (exit 75), publishes its state, stops on its route,
 * and writes the signals it gets into signals.log.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { chmod, readdir, readFile, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { journalFile } from '../src/journal.js';
import type { AppPaths } from '../src/paths.js';
import { enterSharedChat, sharedChatFiles, stopSharedChat, supportsSharedHttp } from '../src/shared-chat.js';
import { FAKE_HTTP_MCP } from './helpers/fake-http-mcp.js';
import { installFakeMcp } from './helpers/fake-mcp.js';
import { AGENT, sharedDeps } from './helpers/shared-chat-deps.js';
import { tempPaths } from './helpers/tmp.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const SHARED = { twake: { commandLine: 1, sharedHttp: 1 } };
const used: AppPaths[] = [];
const bystanders: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const paths of used.splice(0)) await stopSharedChat(AGENT, { paths }).catch(() => 'none');
  for (const child of bystanders.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
});

async function setup(script = FAKE_HTTP_MCP) {
  const { root, paths } = await tempPaths();
  used.push(paths);
  await installFakeMcp(paths, 'chat', script, undefined, SHARED);
  return { root, paths, files: sharedChatFiles(paths, AGENT) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A process that stays alive until the test kills it: a pid reused by another program looks like one. */
function bystander(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  bystanders.push(child);
  return child;
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true });
  await new Promise((resolve) => child.once('exit', resolve));
  return child.pid!;
}

async function closedPort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A program of another account on the port a state file names: it answers 200 to everything, and notes what it got. */
async function squatter() {
  const seen: { method?: string; url?: string; headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":"twake-ai-ping","result":{}}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

/** A port that takes connections and never answers: a server too busy to, or hung */
async function silentPort(): Promise<number> {
  const server = createTcpServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server as unknown as Server);
  return (server.address() as AddressInfo).port;
}

const stateOf = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { pid: number; url: string; token: string; deviceId: string };
const lockPid = async (paths: AppPaths, device = 'DEVICEONE') => Number(await readFile(join(paths.dataDir, 'chat', AGENT, device, '.lock'), 'utf8').catch(() => '0'));
const until = async (check: () => boolean | Promise<boolean>, ms = 15_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
const fakeState = (pid: number, port: number, token = 'f'.repeat(64)) => ({
  version: 1,
  pid,
  url: `http://127.0.0.1:${port}/mcp`,
  token,
  userId: '@jdoe:linagora.com',
  deviceId: 'DEVICEONE',
  serverVersion: '0.7.0',
  startedAt: new Date().toISOString(),
});

describe('the shared Chat server of an agent', () => {
  it('is used only with a mcp-twake-chat that declares the shared mode', async () => {
    const { paths } = await setup();
    expect(await supportsSharedHttp(paths)).toBe(true);
    await installFakeMcp(paths, 'chat', FAKE_HTTP_MCP);
    expect(await supportsSharedHttp(paths)).toBe(false);
  });

  it('starts one server and writes nothing but its log and its state', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const server = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(alive(server.pid)).toBe(true);
    expect(server.deviceId).toBe('DEVICEONE');
    expect(await stateOf(files.state)).toMatchObject({ pid: server.pid, url: server.url, token: server.token });
    // the store is the server's own; mcp-twake-ai writes the log, the server its state
    expect((await readdir(files.dir)).sort()).toEqual(['DEVICEONE', 'server.json', 'server.log']);
    if (process.platform !== 'win32') {
      expect((await stat(files.dir)).mode & 0o777).toBe(0o700);
      expect((await stat(files.log)).mode & 0o777).toBe(0o600);
    }
  });

  it('starts one server for three clients that start together', { timeout: 60_000 }, async () => {
    const { paths, files } = await setup();
    const three = await Promise.all([1, 2, 3].map(() => enterSharedChat(AGENT, sharedDeps(paths))));
    expect(new Set(three.map((s) => s.pid)).size).toBe(1);
    // the store's lock is the one server's, the others went with 75
    expect(await lockPid(paths)).toBe(three[0].pid);
    // the losing starts go with 75 on their own, maybe after their client has joined the winner
    const losers = async () => (await readFile(files.log, 'utf8')).match(/already used by process/g)?.length ?? 0;
    for (let i = 0; i < 50 && (await losers()) < 2; i++) await new Promise((resolve) => setTimeout(resolve, 200));
    expect(await losers()).toBeGreaterThanOrEqual(2);
  });

  it('joins the winner as soon as it proves itself, while its own losing start is still going', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const winner = enterSharedChat(AGENT, sharedDeps(paths, { extra: { FAKE_SYNC_MS: '1500' } }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    const started = Date.now();
    const loser = await enterSharedChat(AGENT, sharedDeps(paths, { extra: { FAKE_LOCK_EXIT_DELAY_MS: '8000' } }));
    expect(Date.now() - started).toBeLessThan(5000);
    expect(loser.pid).toBe((await winner).pid);
  });

  it('joins the server another client started', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const first = await enterSharedChat(AGENT, sharedDeps(paths));
    const log = await readFile(files.log, 'utf8');
    const second = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(second).toEqual(first);
    // nothing was started for the second one
    expect(await readFile(files.log, 'utf8')).toBe(log);
  });

  it('replaces a state file left by a dead server', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const dead = await deadPid();
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    await writeFile(files.state, JSON.stringify(fakeState(dead, await closedPort())), { mode: 0o600 });
    const server = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(server.pid).not.toBe(dead);
    expect((await stateOf(files.state)).pid).toBe(server.pid);
  });

  it('never joins nor stops what answers without the token', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const stranger = bystander();
    const squat = await squatter();
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    const left = fakeState(stranger.pid!, squat.port);
    await writeFile(files.state, JSON.stringify(left), { mode: 0o600 });
    const server = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(server.pid).not.toBe(stranger.pid);
    expect(server.url).not.toBe(left.url);
    expect(alive(stranger.pid!)).toBe(true);
    // what listens there got the proof requests, never the token, a ping nor a shutdown
    expect(squat.seen.length).toBeGreaterThan(0);
    for (const request of squat.seen) {
      expect(request.method).toBe('GET');
      expect(request.url).toMatch(/^\/mcp\/proof\?nonce=[0-9a-f]+$/);
      expect(JSON.stringify(request.headers)).not.toContain(left.token);
      expect(request.headers.authorization).toBeUndefined();
    }
  });

  it("stops the server of another device by its route, then starts one on the agent's device", { timeout: 60_000 }, async () => {
    const { paths, files } = await setup();
    let device = 'DEVICEONE';
    const deps = sharedDeps(paths, { device: () => device });
    const old = await enterSharedChat(AGENT, deps);
    // what login --chat leaves: the config gives the agent another device
    device = 'DEVICETWO';
    const now = await enterSharedChat(AGENT, deps);
    expect(now.deviceId).toBe('DEVICETWO');
    expect(now.pid).not.toBe(old.pid);
    await until(() => !alive(old.pid));
    expect(await readFile(join(files.dir, 'signals.log'), 'utf8').catch(() => 'none')).toBe('none');
  });

  it.skipIf(process.platform === 'win32')('joins a server whose starter died while it started', { timeout: 60_000 }, async () => {
    const { root, paths } = await setup();
    const starter = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/shared-chat-driver.ts'], {
      cwd: repoRoot,
      env: { ...process.env, TWAKE_AI_HOME: root, SHARED_EXTRA: JSON.stringify({ FAKE_SYNC_MS: '3000' }) },
      stdio: 'ignore',
    });
    bystanders.push(starter);
    // the server has its store: its starter goes, with no chance to say so
    await until(async () => (await lockPid(paths)) > 0);
    const server = await lockPid(paths);
    starter.kill('SIGKILL');
    const joined = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(joined.pid).toBe(server);
    expect(await lockPid(paths)).toBe(server);
  });

  it('starts again when the process that held the store goes without publishing', { timeout: 60_000 }, async () => {
    // a server that was stopping (its state file gone, its store still held) when this client started
    const { paths } = await setup();
    const holder = bystander();
    await mkdir(join(paths.dataDir, 'chat', AGENT, 'DEVICEONE'), { recursive: true });
    await writeFile(join(paths.dataDir, 'chat', AGENT, 'DEVICEONE', '.lock'), String(holder.pid));
    setTimeout(() => holder.kill('SIGKILL'), 1_500);
    const started = Date.now();
    const server = await enterSharedChat(AGENT, sharedDeps(paths, { readyMs: 30_000 }));
    expect(server.pid).not.toBe(holder.pid);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('stops a start that ran out of time by its handle, and tells where the log is', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const deps = sharedDeps(paths, { readyMs: 1_000, extra: { FAKE_SYNC_MS: '8000' } });
    let server = 0;
    const entering = enterSharedChat(AGENT, deps);
    void until(async () => (server = await lockPid(paths)) > 0).catch(() => {});
    await expect(entering).rejects.toThrow(/did not start within 1 s.*server\.log/s);
    expect(server).toBeGreaterThan(0);
    await until(() => !alive(server));
    // the child of this very command, by its handle: SIGTERM, which mcp-twake-chat handles (Windows: TerminateProcess)
    if (process.platform !== 'win32') expect(await readFile(join(files.dir, 'signals.log'), 'utf8')).toBe('SIGTERM\n');
  });

  it('says where the log is when the server fails at once', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup(`process.stderr.write('M_UNKNOWN_TOKEN: the device is gone\\n');\nprocess.exit(1);\n`);
    await expect(enterSharedChat(AGENT, sharedDeps(paths))).rejects.toThrow(/M_UNKNOWN_TOKEN: the device is gone/);
    await expect(enterSharedChat(AGENT, sharedDeps(paths))).rejects.toThrow(files.log);
  });

  it('says it is starting after 3 s', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const stderr: string[] = [];
    const server = await enterSharedChat(AGENT, sharedDeps(paths, { stderr, extra: { FAKE_SYNC_MS: '3500' } }));
    expect(stderr.join('')).toMatch(new RegExp(`Starting the shared Twake Chat server for ${AGENT} \\(pid ${server.pid}, log .*server\\.log\\)`));
  });

  it('never writes the token anywhere but the state file', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const stderr: string[] = [];
    const server = await enterSharedChat(AGENT, sharedDeps(paths, { stderr, extra: { FAKE_SYNC_MS: '3500' } }));
    expect(stderr.join('')).not.toContain(server.token);
    expect(await readFile(files.log, 'utf8')).not.toContain(server.token);
    expect(await readFile(journalFile(paths), 'utf8').catch(() => '')).not.toContain(server.token);
    await stopSharedChat(AGENT, { paths });
    expect(await readFile(files.log, 'utf8')).not.toContain(server.token);
  });
});

describe('stopSharedChat', () => {
  it('has nothing to stop without a state file', async () => {
    const { paths } = await setup();
    expect(await stopSharedChat(AGENT, { paths })).toBe('none');
  });

  it('stops it by its route, and sends no signal', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const server = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(await stopSharedChat(AGENT, { paths })).toBe('stopped');
    expect(await readFile(files.state, 'utf8').catch(() => 'gone')).toBe('gone');
    await until(() => !alive(server.pid));
    expect(await readFile(join(files.dir, 'signals.log'), 'utf8').catch(() => 'none')).toBe('none');
  });

  it('has nothing to stop when the port of a state file refuses: its server is gone (it leaves its port last)', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const stranger = bystander();
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    await writeFile(files.state, JSON.stringify(fakeState(stranger.pid!, await closedPort())), { mode: 0o600 });
    expect(await stopSharedChat(AGENT, { paths })).toBe('none');
    expect(await readFile(files.state, 'utf8').catch(() => 'gone')).toBe('gone');
    expect(alive(stranger.pid!)).toBe(true);
  });

  it('names the pid of a server that does not answer in time, never asks to kill it, and kills nothing', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const stranger = bystander();
    const silent = await silentPort();
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    await writeFile(files.state, JSON.stringify(fakeState(stranger.pid!, silent)), { mode: 0o600 });
    const error = await stopSharedChat(AGENT, { paths }).then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(new RegExp(`pid ${stranger.pid}\\b`));
    expect(error?.message).toContain(files.state);
    expect(error?.message).not.toMatch(/stop it|kill/i);
    expect(await readFile(files.state, 'utf8')).toContain(String(stranger.pid));
    expect(alive(stranger.pid!)).toBe(true);
  });

  it('never sends the token to what listens on the port without the proof, and takes the file for a stale one', { timeout: 30_000 }, async () => {
    const { paths, files } = await setup();
    const stranger = bystander();
    const squat = await squatter();
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    const left = fakeState(stranger.pid!, squat.port);
    await writeFile(files.state, JSON.stringify(left), { mode: 0o600 });
    expect(await stopSharedChat(AGENT, { paths })).toBe('none');
    for (const request of squat.seen) {
      expect(request.url).toMatch(/^\/mcp\/proof\?/);
      expect(JSON.stringify(request.headers)).not.toContain(left.token);
    }
    expect(alive(stranger.pid!)).toBe(true);
  });
});

/** A server that proves the token it was given, as ours would, and notes every request: only the trust checks keep it out. */
async function lookalike(token: string) {
  const seen: { url?: string; authorization?: string }[] = [];
  let port = 0;
  const server = createServer((request, response) => {
    request.resume();
    seen.push({ url: request.url, authorization: request.headers.authorization });
    const nonce = new URL(request.url ?? '/', 'http://x').searchParams.get('nonce');
    if (request.url?.startsWith('/mcp/proof?') && nonce) {
      const proof = createHmac('sha256', token).update(`twake-chat-proof:${nonce}:${port}`).digest('hex');
      return void response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof, pid: process.pid }));
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":"twake-ai-ping","result":{}}');
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return { port, seen };
}

describe('a state file mcp-twake-ai does not trust', () => {
  const token = 'e'.repeat(64);

  async function planted(mutate: (files: ReturnType<typeof sharedChatFiles>, state: object, port: number) => Promise<void>) {
    const { paths, files } = await setup();
    const like = await lookalike(token);
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(files.dir, 0o700);
    const state = { ...fakeState(process.pid, like.port, token) };
    await mutate(files, state, like.port);
    return { paths, files, like };
  }

  const write = (file: string, state: object, mode = 0o600) => writeFile(file, JSON.stringify(state), { mode });

  it('is a good one: the lookalike proves itself and is joined (the checks below are what keep it out)', { timeout: 30_000 }, async () => {
    const { paths, like } = await planted((files, state) => write(files.state, state));
    const joined = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(joined.token).toBe(token);
    expect(like.seen.some((request) => request.authorization === `Bearer ${token}`)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('is ignored when others can read or write it, said once, and a server of our own starts', { timeout: 30_000 }, async () => {
    const { paths, files, like } = await planted(async (f, state) => {
      await write(f.state, state, 0o644);
      await chmod(f.state, 0o644);
    });
    const stderr: string[] = [];
    const server = await enterSharedChat(AGENT, sharedDeps(paths, { stderr }));
    expect(server.token).not.toBe(token);
    expect(like.seen).toEqual([]);
    expect(stderr.join('').split(files.state).length - 1).toBe(1);
    expect(stderr.join('')).toMatch(/not mcp-twake-ai's|ignored/);
  });

  it.skipIf(process.platform === 'win32')('is ignored in a folder others can enter, and the folder is closed again', { timeout: 30_000 }, async () => {
    const { paths, files, like } = await planted(async (f, state) => {
      await write(f.state, state);
      await chmod(f.dir, 0o755);
    });
    const server = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(server.token).not.toBe(token);
    expect(like.seen).toEqual([]);
    expect((await stat(files.dir)).mode & 0o777).toBe(0o700);
  });

  it('is ignored when it is a symbolic link', { timeout: 30_000 }, async () => {
    let linked = true;
    const { paths, like } = await planted(async (f, state) => {
      const elsewhere = join(f.dir, '..', 'elsewhere.json');
      await write(elsewhere, state);
      await symlink(elsewhere, f.state).catch(() => (linked = false));
    });
    // Windows without the right to create links: nothing to check
    if (!linked) return;
    const server = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(server.token).not.toBe(token);
    expect(like.seen).toEqual([]);
  });

  it.each([
    ['another host', (port: number) => `http://192.0.2.1:${port}/mcp`],
    ['https', (port: number) => `https://127.0.0.1:${port}/mcp`],
    ['another path', (port: number) => `http://127.0.0.1:${port}/other`],
    ['a user name', (port: number) => `http://someone@127.0.0.1:${port}/mcp`],
    ['a query', (port: number) => `http://127.0.0.1:${port}/mcp?x=1`],
    ['no port', () => `http://127.0.0.1/mcp`],
  ])('is ignored when its URL has %s', { timeout: 30_000 }, async (_what, url) => {
    const { paths, like } = await planted((f, state, port) => write(f.state, { ...state, url: url(port) }));
    const server = await enterSharedChat(AGENT, sharedDeps(paths));
    expect(server.token).not.toBe(token);
    expect(like.seen).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('makes everything fail clearly in a folder of another account', { timeout: 30_000 }, async () => {
    const { paths, files, like } = await planted((f, state) => write(f.state, state));
    const deps = { ...sharedDeps(paths), uid: process.getuid!() + 1 };
    await expect(enterSharedChat(AGENT, deps)).rejects.toThrow(files.dir);
    await expect(stopSharedChat(AGENT, deps)).rejects.toThrow(files.dir);
    expect(like.seen).toEqual([]);
    expect(await readFile(files.log, 'utf8').catch(() => 'none')).toBe('none');
  });

  it.skipIf(process.platform === 'win32')('is not used to stop anything', { timeout: 30_000 }, async () => {
    const { paths, files, like } = await planted(async (f, state) => {
      await write(f.state, state, 0o644);
      await chmod(f.state, 0o644);
    });
    await expect(stopSharedChat(AGENT, { paths })).rejects.toThrow(files.state);
    expect(like.seen).toEqual([]);
  });
});
