import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { alive, runningBackends, sharedDir, stopShared } from '../src/shared.js';
import { saveConfig, type TwakeAiConfig } from '../src/config.js';
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
async function launch(root: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'run', 'chat', '--agent', 'claude-code'], {
    cwd: repoRoot,
    env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8' },
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
      ['--import', 'tsx', 'src/bin.ts', '__watch', '--shared', sharedDir(paths, 'chat', 'claude-code'), '--locks', paths.locksDir, '--idle', '300'],
      { cwd: repoRoot, env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8' }, stdio: 'ignore' },
    );
    running.push(watcher as ChildProcessWithoutNullStreams);
    await expect.poll(() => alive(pid), { timeout: 30_000 }).toBe(false);
    expect(await runningBackends(paths)).toEqual([]);
  });
});
