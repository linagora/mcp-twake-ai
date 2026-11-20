import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { access, mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { alive, enterSharedBackend, keepSharedClient, runningBackends, sharedDir, stopShared, watchShared, type SharedBackendOptions } from '../src/shared.js';
import { saveConfig, type TwakeAiConfig } from '../src/config.js';
import { entryPoint } from '../src/installer.js';
import type { AppPaths } from '../src/paths.js';
import { fakeBackend } from './helpers/fake-backend.js';
import { FAKE_HTTP_MCP } from './helpers/fake-http-mcp.js';
import { installFakeMcp } from './helpers/fake-mcp.js';
import { tempPaths } from './helpers/tmp.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const running: ChildProcessWithoutNullStreams[] = [];
/** a process that is alive and has nothing to do with mcp-twake-ai: a pid reused after a reboot looks like one */
const bystanders: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
  for (const child of bystanders.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
  if (lastPaths) {
    const { paths } = await lastPaths;
    for (const { service, agent } of await runningBackends(paths)) await stopShared(paths, service, agent).catch(() => false);
  }
});

/** A process that stays alive until the test kills it. */
function bystander(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  bystanders.push(child);
  return child;
}

/** the folder of the test that runs: its backends outlive the clients, so they are stopped here when a test fails */
let lastPaths: Promise<Awaited<ReturnType<typeof tempPaths>>>;

const config: TwakeAiConfig = {
  version: 1,
  email: 'jdoe@linagora.com',
  vault: 'file',
  oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
  environment: {
    domain: 'linagora.com',
    oidc: { issuer: 'https://sso.linagora.com', authorization_endpoint: 'https://sso.linagora.com/a', token_endpoint: 'https://sso.linagora.com/t', userinfo_endpoint: 'https://sso.linagora.com/u' },
    matrix: { homeserver: 'https://matrix.linagora.com/' },
    services: {},
    cozy: {},
  },
  chat: { 'claude-code': { userId: '@jdoe:linagora.com', deviceId: 'DEVICEONE' } },
};

async function setup() {
  const paths = await tempPaths();
  lastPaths = Promise.resolve(paths);
  await saveConfig(paths.paths, config);
  await installFakeMcp(paths.paths, 'chat', FAKE_HTTP_MCP);
  return paths;
}

/** `mcp-twake-ai run chat --agent claude-code`, as an agent starts it, with a JSON-RPC client on its stdio. */
async function launch(root: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'run', 'chat', '--agent', 'claude-code'], {
    cwd: repoRoot,
    env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8', ...env },
  });
  running.push(child);
  const lines: unknown[] = [];
  const waiting: ((message: unknown) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as unknown;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else lines.push(message);
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const next = () => new Promise<any>((resolve) => (lines.length ? resolve(lines.shift()) : waiting.push(resolve)));
  await (async () => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'test', version: '1' } } })}\n`);
    await next();
  })();
  return {
    send: (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
    next,
    close: () => child.stdin.end(),
    /** SIGKILL: the agent that crashes, with no chance to say it leaves */
    kill: () => child.kill('SIGKILL'),
    /** a signal the client can catch: the agent that stops it, or Ctrl-C in a terminal */
    signal: (signal: NodeJS.Signals) => child.kill(signal),
    exited,
    stderr: () => stderr,
  };
}

async function whoami(client: Awaited<ReturnType<typeof launch>>) {
  client.send({ id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  const answer = await client.next();
  return JSON.parse(answer.result.content[0].text) as { pid: number; started: number; env: Record<string, string> };
}

describe('a shared service', () => {
  it('serves two clients at once from one backend, and gives each its own approval', { timeout: 90_000 }, async () => {
    const { root, paths } = await setup();
    const first = await launch(root);
    const second = await launch(root);

    // both see the tools of the same process, started once
    const one = await whoami(first);
    const two = await whoami(second);
    expect(two.pid).toBe(one.pid);
    expect(two.started).toBe(one.started);
    // the environment `run` builds reaches the shared backend, once
    expect(one.env.MATRIX_USER_ID).toBe('@jdoe:linagora.com');
    expect(one.env.MATRIX_STORE_DIR).toMatch(/chat[\\/]claude-code[\\/]DEVICEONE$/);

    // an approval request raised by one client goes to that client, not to the other
    first.send({ id: 3, method: 'tools/call', params: { name: 'ask', arguments: {} } });
    const approval = await first.next();
    expect(approval).toMatchObject({ method: 'elicitation/create' });
    first.send({ id: approval.id, result: { action: 'accept', content: {} } });
    const answered = await first.next();
    expect(JSON.parse(answered.result.content[0].text)).toMatchObject({ action: 'accept', pid: one.pid });

    // the first client leaves: the backend stays for the second one
    first.close();
    expect(await first.exited).toBe(0);
    const stillThere = await whoami(second);
    expect(stillThere.pid).toBe(one.pid);

    // the last client leaves: the backend goes with it
    second.close();
    expect(await second.exited).toBe(0);
    await expect.poll(() => alive(one.pid), { timeout: 15_000 }).toBe(false);
    expect(await runningBackends(paths)).toEqual([]);
  });

  it('stops a running backend, clients or not: what logout and uninstall use', { timeout: 90_000 }, async () => {
    const { root, paths } = await setup();
    const client = await launch(root);
    const { pid } = await whoami(client);
    expect((await runningBackends(paths)).map((running) => running.backend.pid)).toEqual([pid]);

    expect(await stopShared(paths, 'chat', 'claude-code')).toBe(true);
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
    expect(await runningBackends(paths)).toEqual([]);
    client.close();
  });

  it('gives the server only the configuration mcp-twake-ai builds, whichever client starts it', { timeout: 90_000 }, async () => {
    const { root } = await setup();
    // what an agent's entry may set for twake-chat: it would reach every other client's server, as the first one wants
    const client = await launch(root, { MATRIX_SEARCH_BACKFILL_DAYS: '7', MATRIX_USER_ID: '@someone-else:linagora.com' });
    const { env } = await whoami(client);
    expect(env.MATRIX_SEARCH_BACKFILL_DAYS).toBeUndefined();
    expect(env.MATRIX_USER_ID).toBe('@jdoe:linagora.com');
    client.close();
    await client.exited;
  });

  it('leaves the other services to their own process', { timeout: 30_000 }, async () => {
    const { root } = await setup();
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'run', 'space', '--agent', 'claude-code'], {
      cwd: repoRoot,
      env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8' },
    });
    running.push(child);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    // Space has no server in this account: it fails as before, without any shared backend
    expect(code).toBe(1);
    expect(await runningBackends((await lastPaths).paths)).toEqual([]);
  });
});

describe('a shared service, when the server or a client goes away', () => {
  it('keeps its server for a client that starts while the last one leaves', { timeout: 90_000 }, async () => {
    const { root, paths } = await setup();
    const first = await launch(root);
    const { pid } = await whoami(first);

    // the second client starts as the first one leaves: whichever wins the lock, the second one gets a server
    const second = launch(root);
    first.close();
    expect(await first.exited).toBe(0);
    const client = await second;
    const served = await whoami(client);
    expect(served.pid).toBeTruthy();
    expect((await runningBackends(paths)).map((running) => running.agent)).toEqual(['claude-code']);

    client.close();
    expect(await client.exited).toBe(0);
    await expect.poll(() => runningBackends(paths), { timeout: 15_000 }).toEqual([]);
    // whichever backend served it, none of them is left
    expect(alive(pid) && served.pid === pid).toBe(false);
    await expect.poll(() => alive(served.pid), { timeout: 15_000 }).toBe(false);
  });

  it('lists a joining client before the last one leaving can look for clients', { timeout: 60_000 }, async () => {
    const { paths } = await setup();
    let leaving: ReturnType<typeof sharedCli> | undefined;
    const { backend } = await enterSharedBackend({
      ...(await backendOptions(paths)),
      beforeRegister: async () => {
        // the last client leaves at the worst moment: the server answers, and this client is not listed yet
        leaving = sharedCli('leave', { paths, service: 'chat', agent: 'claude-code' });
        expect(await leaving.next()).toBe('ready');
        await new Promise((resolve) => setTimeout(resolve, 500));
      },
    });
    expect(await leaving!.next()).toBe('false');
    expect(alive(backend.pid)).toBe(true);
  });

  it('ignores the clients a server that is gone left behind', { timeout: 90_000 }, async () => {
    const { root, paths } = await setup();
    // what a crash or a reboot leaves: a client that never said it left, whose pid now belongs to someone else
    const clients = join(sharedDir(paths, 'chat', 'claude-code'), 'clients');
    await mkdir(clients, { recursive: true, mode: 0o700 });
    await writeFile(join(clients, String(bystander().pid)), '{}\n');

    const client = await launch(root);
    const { pid } = await whoami(client);
    client.close();
    expect(await client.exited).toBe(0);
    // the new server starts over: that stale entry must not keep it running for ever
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
    expect(alive(bystanders[0].pid!)).toBe(true);
  });

  it('never stops a process that is not its server', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const dir = sharedDir(paths, 'chat', 'claude-code');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // a backend.json survives a reboot: its pid may be some other process, and something else may hold its port
    const stranger = bystander();
    const http = createServer((_request, response) => void response.writeHead(401).end());
    servers.push(http);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    await writeFile(join(dir, 'backend.json'), JSON.stringify({ pid: stranger.pid, port }));
    await writeFile(join(dir, 'token'), 'a token that server never took\n');

    expect(await runningBackends(paths)).toEqual([]);
    expect(await stopShared(paths, 'chat', 'claude-code')).toBe(true);
    expect(alive(stranger.pid!)).toBe(true);
  });

  // Windows has no signal a process can catch: kill() terminates it there
  it.skipIf(process.platform === 'win32')('closes the session of a client stopped by a signal', { timeout: 90_000 }, async () => {
    const { root } = await setup();
    const first = await launch(root);
    const second = await launch(root);
    const open = async (id: number) => {
      second.send({ id, method: 'tools/call', params: { name: 'sessions', arguments: {} } });
      return JSON.parse((await second.next()).result.content[0].text).sessions;
    };
    expect(await open(2)).toBe(2);

    first.signal('SIGTERM');
    await first.exited;
    // the server would keep it open for 6 hours otherwise, since the other client keeps the server running
    expect(await open(3)).toBe(1);
    second.close();
    await second.exited;
  });

  it('finds the next server when its own was stopped under it', { timeout: 90_000 }, async () => {
    const { root, paths } = await setup();
    const client = await launch(root);
    const before = await whoami(client);
    // what `login --chat`, a crash or the watchdog leave a connected client with: no server on that port any more
    expect(await stopShared(paths, 'chat', 'claude-code')).toBe(true);

    client.send({ id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const answer = await client.next();
    expect(answer.error).toBeUndefined();
    const after = JSON.parse(answer.result.content[0].text) as { pid: number };
    expect(after.pid).not.toBe(before.pid);
    expect(alive(after.pid)).toBe(true);
    client.close();
    expect(await client.exited).toBe(0);
  });

  it('exits, so that the agent starts it again, when no server can be found any more', { timeout: 90_000 }, async () => {
    const { root, paths } = await setup();
    const client = await launch(root);
    await whoami(client);
    expect(await stopShared(paths, 'chat', 'claude-code')).toBe(true);
    // the next start fails at once
    await installFakeMcp(paths, 'chat', `process.stderr.write('no Matrix today\\n');\nprocess.exit(1);\n`);

    client.send({ id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    expect(await client.next()).toMatchObject({ id: 3, error: { code: -32603 } });
    expect(await client.exited).not.toBe(0);
  });

  it('opens a new session when the server closed ours', { timeout: 90_000 }, async () => {
    const { root } = await setup();
    const client = await launch(root);
    const one = await whoami(client);

    // what the server's 6-hour idle sweep does: our session stops existing, and the next request gets a 404
    client.send({ id: 3, method: 'tools/call', params: { name: 'forget', arguments: {} } });
    expect((await client.next()).result.content[0].text).toBe(JSON.stringify({ forgotten: true }));

    const again = await whoami(client);
    expect(again.pid).toBe(one.pid);
    expect(again.started).toBe(one.started);
    client.close();
    await client.exited;
  });

  it('tells the server the protocol version it agreed on, in a session opened again too', { timeout: 90_000 }, async () => {
    const { root } = await setup();
    const client = await launch(root);
    const protocol = async (id: number) => {
      client.send({ id, method: 'tools/call', params: { name: 'headers', arguments: {} } });
      return JSON.parse((await client.next()).result.content[0].text).protocol;
    };
    expect(await protocol(2)).toBe('2025-06-18');

    client.send({ id: 3, method: 'tools/call', params: { name: 'forget', arguments: {} } });
    await client.next();
    expect(await protocol(4)).toBe('2025-06-18');
    client.close();
    await client.exited;
  });

  it('passes a cancellation on to the server', { timeout: 90_000 }, async () => {
    const { root, paths } = await setup();
    const client = await launch(root);
    await whoami(client);

    client.send({ id: 3, method: 'tools/call', params: { name: 'wait', arguments: {} } });
    client.send({ method: 'notifications/cancelled', params: { requestId: 3, reason: 'the user changed their mind' } });
    // the tool writes what became of it next to the server's token, in the shared folder of the agent
    await expect.poll(() => readFile(join(sharedDir(paths, 'chat', 'claude-code'), 'wait'), 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('cancelled');
    client.close();
    await client.exited;
  });

  it('stops a server whose last client was killed, once nobody uses it', { timeout: 90_000 }, async () => {
    const { root, paths } = await setup();
    const client = await launch(root);
    const { pid } = await whoami(client);
    // SIGKILL: the client never says it leaves, and the server would sync on until a reboot
    client.kill();
    await client.exited;
    expect(await runningBackends(paths)).toHaveLength(1);

    // the watchdog the server is started with, as `run` starts it
    const watcher = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/bin.ts', '__watch', '--shared', sharedDir(paths, 'chat', 'claude-code'), '--locks', paths.locksDir, '--pid', String(pid), '--idle', '300'],
      { cwd: repoRoot, env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8' }, stdio: 'ignore' },
    );
    running.push(watcher as ChildProcessWithoutNullStreams);
    await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
    expect(await runningBackends(paths)).toEqual([]);
  });
});

/** What `run` gives `enterSharedBackend`, with the fake server as the backend, and this checkout's CLI for its watchdog. */
async function backendOptions(paths: AppPaths): Promise<SharedBackendOptions> {
  // the watchdog is started as `node <cli> __watch …`: the CLI of this checkout is TypeScript, loaded through tsx
  const cli = join(paths.dataDir, 'cli.mjs');
  const url = (path: string) => JSON.stringify(pathToFileURL(join(repoRoot, path)).href);
  await mkdir(paths.dataDir, { recursive: true });
  await writeFile(cli, `import { register } from ${url('node_modules/tsx/dist/esm/api/index.mjs')};\nregister();\nawait import(${url('src/bin.ts')});\n`);
  return {
    paths,
    service: 'chat',
    agent: 'claude-code',
    env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    nodePath: process.execPath,
    entry: await entryPoint(paths, 'chat'),
    cliPath: cli,
  };
}

describe('a shared service, when what answers on its port is not plainly its server', () => {
  it('takes a server that answers its ping with the token of that start for its own', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const server = await fakeBackend(sharedDir(paths, 'chat', 'claude-code'), 'mcp');
    bystanders.push(server.child);
    expect((await runningBackends(paths)).map((running) => running.backend)).toMatchObject([{ pid: server.pid, port: server.port }]);
  });

  it('never takes a port that answers anything but JSON-RPC for its server', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const stranger = await fakeBackend(sharedDir(paths, 'chat', 'claude-code'), 'html');
    bystanders.push(stranger.child);
    expect(await runningBackends(paths)).toEqual([]);
    expect(await stopShared(paths, 'chat', 'claude-code')).toBe(true);
    expect(alive(stranger.pid)).toBe(true);
  });

  it('takes what speaks no HTTP on its port for a stranger, not for a busy server', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    // after a reboot: the pid is some service's, and so is the port, which answers with a banner
    const stranger = await fakeBackend(sharedDir(paths, 'chat', 'claude-code'), 'garbage');
    bystanders.push(stranger.child);
    expect(await runningBackends(paths)).toEqual([]);
    const { backend } = await enterSharedBackend({ ...(await backendOptions(paths)), busyMs: 1_000 });
    expect(backend.pid).not.toBe(stranger.pid);
    expect(alive(stranger.pid)).toBe(true);
  });

  it('keeps a server too busy to answer, and starts no second one on its store', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const dir = sharedDir(paths, 'chat', 'claude-code');
    const busy = await fakeBackend(dir, 'busy');
    bystanders.push(busy.child);
    await expect(enterSharedBackend({ ...(await backendOptions(paths)), busyMs: 1_000 })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining(String(busy.pid)) });
    expect(JSON.parse(await readFile(join(dir, 'backend.json'), 'utf8'))).toMatchObject({ pid: busy.pid, port: busy.port });
    expect(alive(busy.pid)).toBe(true);
  });

  it('does not take whatever listens on its port for the server it started', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    // what answers on the port turns the token of this start down: another process took it, or the server is not ours
    await installFakeMcp(
      paths,
      'chat',
      `import { createServer } from 'node:http';\ncreateServer((_req, res) => void res.writeHead(401).end()).listen(Number(process.env.MCP_HTTP_PORT), process.env.MCP_HTTP_HOST);\n`,
    );
    await expect(enterSharedBackend({ ...(await backendOptions(paths)), readyMs: 2_000 })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('could not start') });
    expect(await runningBackends(paths)).toEqual([]);
  });

  it('tells where the server said why it could not start', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    await installFakeMcp(paths, 'chat', `process.stderr.write('M_UNKNOWN_TOKEN: the device is gone\\n');\nprocess.exit(1);\n`);
    const failed = await enterSharedBackend(await backendOptions(paths)).catch((error: Error) => error);
    expect(failed).toMatchObject({ code: 'unavailable', message: expect.stringContaining('M_UNKNOWN_TOKEN: the device is gone') });
    // `run` in a terminal is now a proxy: it would show nothing more; the server's own log does
    expect((failed as Error).message).toContain(join(sharedDir(paths, 'chat', 'claude-code'), 'backend.log'));
    expect((failed as Error).message).not.toContain('in a terminal');
  });

  it('lets logout wait for a server that is starting, then stops it', { timeout: 60_000 }, async () => {
    const { paths } = await setup();
    const options = await backendOptions(paths);
    // a first sync longer than the 10 s a lock is waited for by default
    const starting = enterSharedBackend({ ...options, env: { ...options.env, FAKE_SYNC_MS: '11000' } });
    const dir = sharedDir(paths, 'chat', 'claude-code');
    await expect.poll(() => access(join(dir, 'backend.json')).then(() => true, () => false), { timeout: 10_000 }).toBe(true);

    const stopped = stopShared(paths, 'chat', 'claude-code');
    const { backend } = await starting;
    expect(await stopped).toBe(true);
    await expect.poll(() => alive(backend.pid), { timeout: 15_000 }).toBe(false);
  });

  it('never stops a process that answers for a server whose pid it does not have', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    // the port answers with our token, but the process of that pid is not the one the start recorded
    const server = await fakeBackend(sharedDir(paths, 'chat', 'claude-code'), 'mcp', { identity: 'the start time of another process' });
    bystanders.push(server.child);
    await expect(stopShared(paths, 'chat', 'claude-code', { busyMs: 500 })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining(String(server.pid)) });
    expect(alive(server.pid)).toBe(true);
  });

  it('neither stops nor forgets a server too busy to answer, and says so', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const dir = sharedDir(paths, 'chat', 'claude-code');
    const busy = await fakeBackend(dir, 'busy');
    bystanders.push(busy.child);
    // logout tries it: a server it cannot reach is still a server that runs
    expect((await runningBackends(paths)).map((running) => running.backend.pid)).toEqual([busy.pid]);
    const asked = Date.now();
    await expect(stopShared(paths, 'chat', 'claude-code', { busyMs: 500 })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining(String(busy.pid)) });
    // asked again for as long as it was told, not the 10 s logout gives
    expect(Date.now() - asked).toBeLessThan(5_000);
    expect(alive(busy.pid)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'backend.json'), 'utf8'))).toMatchObject({ pid: busy.pid, port: busy.port });
  });
});

describe('the watchdog of a shared server', () => {
  it('stops a server whose last client left a pid another process now has', { timeout: 90_000 }, async () => {
    const { root, paths } = await setup();
    const client = await launch(root);
    const { pid } = await whoami(client);
    // a client killed long ago, whose pid the system gave to a process that has nothing to do with us (Windows and macOS
    // hand pids out again soon): its entry has not been touched since
    const recycled = join(sharedDir(paths, 'chat', 'claude-code'), 'clients', String(bystander().pid));
    await writeFile(recycled, '{}\n');
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(recycled, longAgo, longAgo);
    client.kill();
    await client.exited;

    const watcher = spawn(
      process.execPath,
      ['--import', 'tsx', 'src/bin.ts', '__watch', '--shared', sharedDir(paths, 'chat', 'claude-code'), '--locks', paths.locksDir, '--pid', String(pid), '--idle', '300'],
      { cwd: repoRoot, env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8' }, stdio: 'ignore' },
    );
    running.push(watcher as ChildProcessWithoutNullStreams);
    await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
    expect(alive(bystanders[0].pid!)).toBe(true);
  });

  it('is told by a living client that it is still there', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const clients = join(sharedDir(paths, 'chat', 'claude-code'), 'clients');
    await mkdir(clients, { recursive: true });
    const mine = join(clients, String(process.pid));
    await writeFile(mine, '{}\n');
    const longAgo = new Date(Date.now() - 60 * 60_000);
    await utimes(mine, longAgo, longAgo);

    const stop = keepSharedClient(paths, 'chat', 'claude-code', 50);
    try {
      await expect.poll(async () => Date.now() - (await stat(mine)).mtimeMs < 10_000, { timeout: 5_000 }).toBe(true);
    } finally {
      stop();
    }
  });

  it('stops its server once it has stopped answering for good', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    // the port takes connections, and nothing ever answers: a hung event loop, which every client waits on
    const startedAt = Date.now() - 1_000;
    const frozen = await fakeBackend(sharedDir(paths, 'chat', 'claude-code'), 'busy', { startedAt, readyMs: 500 });
    bystanders.push(frozen.child);
    const watching = watchShared(sharedDir(paths, 'chat', 'claude-code'), paths.locksDir, { pid: frozen.pid, startedAt, idleMs: 60_000, intervalMs: 100, frozenMs: 1_000 });
    await Promise.race([watching, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    expect(alive(frozen.pid)).toBe(false);
  });

  it('never takes a hung process for its server without the start it was given', { timeout: 60_000 }, async () => {
    const { paths } = await setup();
    const dir = sharedDir(paths, 'chat', 'claude-code');
    // its pid, and a port that takes connections and answers none: but no start of its own, or another one
    for (const start of [{}, { startedAt: Date.now() - 1_000, readyMs: 500 }]) {
      const stranger = await fakeBackend(dir, 'busy', start);
      bystanders.push(stranger.child);
      const watching = watchShared(dir, paths.locksDir, { pid: stranger.pid, startedAt: Date.now() - 60_000, idleMs: 60_000, intervalMs: 100, frozenMs: 500 });
      await Promise.race([watching, new Promise((resolve) => setTimeout(resolve, 7_000))]);
      expect(alive(stranger.pid), JSON.stringify(start)).toBe(true);
      stranger.child.kill('SIGKILL');
      await watching;
    }
  });

  it('leaves alone a server started after its own one', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const dir = sharedDir(paths, 'chat', 'claude-code');
    const watched = await fakeBackend(dir, 'mcp');
    bystanders.push(watched.child);
    // its server went, another client started the next one: that one has a watchdog of its own, and clients soon
    watched.child.kill('SIGKILL');
    const next = await fakeBackend(dir, 'mcp');
    bystanders.push(next.child);

    await watchShared(dir, paths.locksDir, { pid: watched.pid, idleMs: 200, intervalMs: 50 });
    expect(alive(next.pid)).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'backend.json'), 'utf8'))).toMatchObject({ pid: next.pid, port: next.port });
  });
});

/** `enter` or `leave` from another process: a client of its own, with a pid of its own. */
function sharedCli(command: 'enter' | 'leave', options: object) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/helpers/shared-cli.ts', command, JSON.stringify(options)], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'] });
  running.push(child as unknown as ChildProcessWithoutNullStreams);
  const lines: string[] = [];
  const waiting: ((line: string) => void)[] = [];
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const resolve = waiting.shift();
    if (resolve) resolve(line);
    else lines.push(line);
  });
  return { child, next: () => new Promise<string>((resolve) => (lines.length ? resolve(lines.shift()!) : waiting.push(resolve))) };
}

describe('a shared service, while its server starts', () => {
  it('lists a server that is still starting, so that logout sees it', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const starting = await fakeBackend(sharedDir(paths, 'chat', 'claude-code'), 'mcp', { listenAfterMs: null, startedAt: Date.now(), readyMs: 60_000 });
    bystanders.push(starting.child);
    expect((await runningBackends(paths)).map((running) => running.backend.pid)).toEqual([starting.pid]);
  });

  it('joins a server another client started and left before it answered, instead of starting a second one', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const orphan = await fakeBackend(sharedDir(paths, 'chat', 'claude-code'), 'mcp', { listenAfterMs: 1_500, startedAt: Date.now(), readyMs: 10_000 });
    bystanders.push(orphan.child);
    const { backend } = await enterSharedBackend({ ...(await backendOptions(paths)), busyMs: 500 });
    expect(backend.pid).toBe(orphan.pid);
  });

  it('lets logout stop a server that is still starting', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const starting = await fakeBackend(sharedDir(paths, 'chat', 'claude-code'), 'mcp', { listenAfterMs: 1_500, startedAt: Date.now(), readyMs: 10_000 });
    bystanders.push(starting.child);
    expect(await stopShared(paths, 'chat', 'claude-code')).toBe(true);
    await expect.poll(() => alive(starting.pid), { timeout: 10_000 }).toBe(false);
  });

  it('never stops a process whose start is not proven ours, wherever its backend.json comes from', { timeout: 60_000 }, async () => {
    const { paths } = await setup();
    const dir = sharedDir(paths, 'chat', 'claude-code');
    // built as each case comes: a start recorded "now" must still be in its window then
    const cases = [
      // a bare pid: no start recorded, nothing listens
      () => ({}),
      // a start recorded, but with another token than the one next to it
      () => ({ startedAt: Date.now(), readyMs: 1_000, tokenHash: 'not the hash of that token' }),
      // a start recorded before this computer booted: whatever the file says, that pid is someone else's now
      () => ({ startedAt: Date.now() - uptime() * 1000 - 60 * 60_000, readyMs: (uptime() + 2 * 60 * 60) * 1000 }),
      // everything right about the files, but the pid is now another process's (same boot: Windows reuses them soon)
      () => ({ startedAt: Date.now(), readyMs: 1_000, identity: 'the start time of the process that had that pid' }),
    ];
    for (const make of cases) {
      const start = make();
      const stranger = await fakeBackend(dir, 'mcp', { listenAfterMs: null, ...start });
      bystanders.push(stranger.child);
      // a client starting, logout and uninstall: each looks at it, none stops it
      await enterSharedBackend({ ...(await backendOptions(paths)), busyMs: 500 }).catch(() => undefined);
      await stopShared(paths, 'chat', 'claude-code', { busyMs: 500 }).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(alive(stranger.pid), JSON.stringify(start)).toBe(true);
      for (const { service, agent } of await runningBackends(paths)) await stopShared(paths, service, agent).catch(() => false);
    }
  });

  it('takes a start that ran out of time long ago for a stranger', { timeout: 30_000 }, async () => {
    const { paths } = await setup();
    const stale = await fakeBackend(sharedDir(paths, 'chat', 'claude-code'), 'mcp', { listenAfterMs: null, startedAt: Date.now() - 60 * 60_000, readyMs: 60_000 });
    bystanders.push(stale.child);
    expect(await runningBackends(paths)).toEqual([]);
  });

  // Windows has no signal a process can catch: kill() terminates it there
  it.skipIf(process.platform === 'win32')('stops the server it was starting when a signal stops the client', { timeout: 60_000 }, async () => {
    const { root, paths } = await setup();
    const client = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'run', 'chat', '--agent', 'claude-code'], {
      cwd: repoRoot,
      env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8', FAKE_SYNC_MS: '20000' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    running.push(client as ChildProcessWithoutNullStreams);
    const dir = sharedDir(paths, 'chat', 'claude-code');
    await expect.poll(() => readFile(join(dir, 'backend.json'), 'utf8').then(() => true, () => false), { timeout: 15_000 }).toBe(true);
    const { pid } = JSON.parse(await readFile(join(dir, 'backend.json'), 'utf8')) as { pid: number };

    client.kill('SIGTERM');
    await new Promise((resolve) => client.once('exit', resolve));
    // nothing is left for the next client to take for a stranger, and start a second server next to
    await expect.poll(() => alive(pid), { timeout: 15_000 }).toBe(false);
    expect(await access(join(dir, 'backend.json')).then(() => true, () => false)).toBe(false);
  });

  it('gives a server its watchdog as it spawns: a client killed while starting it leaves nothing running', { timeout: 90_000 }, async () => {
    const { paths } = await setup();
    const options = await backendOptions(paths);
    const starter = sharedCli('enter', { ...options, env: { ...options.env, FAKE_SYNC_MS: '1500' }, idleMs: 300 });
    const dir = sharedDir(paths, 'chat', 'claude-code');
    await expect.poll(() => readFile(join(dir, 'backend.json'), 'utf8').then(() => true, () => false), { timeout: 15_000 }).toBe(true);
    const { pid } = JSON.parse(await readFile(join(dir, 'backend.json'), 'utf8')) as { pid: number };
    // SIGKILL, or TerminateProcess: the client says nothing, and its lock is left to go stale
    starter.child.kill('SIGKILL');
    await expect.poll(() => alive(pid), { timeout: 75_000, interval: 500 }).toBe(false);
  });
});
