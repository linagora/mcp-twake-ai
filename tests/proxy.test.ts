/**
 * The stdio ↔ Streamable HTTP relay of linagora/mcp-twake-ai#25 (guimard), driven on its own: a fake shared server
 * started directly (token file, known port), and a reconnection that reads where the next server is from a file.
 */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FAKE_HTTP_MCP } from './helpers/fake-http-mcp.js';
import { tempDir } from './helpers/tmp.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const driver = fileURLToPath(new URL('./helpers/proxy-driver.ts', import.meta.url));
const running: ChildProcess[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) server.close();
});

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

interface Fake {
  url: string;
  token: string;
  port: number;
  dir: string;
  child: ChildProcess;
  /** the end of a server: what a crash, `logout` or `login --chat` leave its clients with */
  stop(): Promise<void>;
}

/** A fake shared Chat server, on a port of its own, with a token in a file next to what its tools write. */
async function fake(): Promise<Fake> {
  const dir = await tempDir();
  const token = `token-${Math.random().toString(16).slice(2)}`;
  await writeFile(join(dir, 'token'), token, { mode: 0o600 });
  await writeFile(join(dir, 'fake.mjs'), FAKE_HTTP_MCP);
  const port = await freePort();
  const child = spawn(process.execPath, [join(dir, 'fake.mjs')], {
    env: { ...process.env, MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: String(port), MCP_HTTP_TOKEN_FILE: join(dir, 'token') },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  running.push(child);
  await new Promise<void>((resolve, reject) => {
    child.stderr!.on('data', (chunk: Buffer) => chunk.toString().includes('fake-chat ready') && resolve());
    child.once('exit', (code) => reject(new Error(`the fake server exited (${code})`)));
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    port,
    dir,
    child,
    stop: async () => {
      child.kill('SIGKILL');
      await exited;
    },
  };
}

/** The relay, as `run chat` starts it for an agent, with a JSON-RPC client on its stdio. */
async function relay(first: { url: string; token: string }, options: { initialize?: boolean; readyMs?: number } = {}) {
  const dir = await tempDir();
  const nextFile = join(dir, 'next.json');
  const reconnects = join(dir, 'reconnects.log');
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--import', 'tsx', driver], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PROXY_URL: first.url,
      PROXY_TOKEN: first.token,
      PROXY_NEXT: nextFile,
      PROXY_RECONNECTS: reconnects,
      ...(options.readyMs ? { PROXY_READY_MS: String(options.readyMs) } : {}),
    },
  });
  running.push(child);
  const lines: any[] = [];
  const waiting: ((message: any) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as unknown;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else lines.push(message);
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const next = () => new Promise<any>((resolve) => (lines.length ? resolve(lines.shift()) : waiting.push(resolve)));
  const initialize = () => send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'test', version: '1' } } });
  if (options.initialize !== false) {
    initialize();
    await next();
  }
  return {
    send,
    next,
    initialize,
    /** the next message within ms, or 'no answer' */
    within: (ms: number) => Promise.race([next(), new Promise((resolve) => setTimeout(() => resolve('no answer'), ms))]),
    /** where the next server is, once the relay looks for it */
    nextServer: (server: { url: string; token: string }) => writeFile(nextFile, JSON.stringify({ url: server.url, token: server.token })),
    reconnects: async () => (await readFile(reconnects, 'utf8').catch(() => '')).split('\n').filter(Boolean).length,
    close: () => child.stdin.end(),
    exited,
    stderr: () => stderr,
  };
}

type Relay = Awaited<ReturnType<typeof relay>>;

async function call(client: Relay, id: number, name: string): Promise<any> {
  client.send({ id, method: 'tools/call', params: { name, arguments: {} } });
  const answer = await client.next();
  if (!answer.result) throw new Error(`${name}: ${JSON.stringify(answer)} ${client.stderr()}`);
  return JSON.parse(answer.result.content[0].text);
}

describe('the relay to a shared server', () => {
  it('finds the next server when its own was stopped under it', { timeout: 60_000 }, async () => {
    const one = await fake();
    const two = await fake();
    const client = await relay(one);
    await client.nextServer(two);
    expect((await call(client, 2, 'whoami')).pid).toBe(one.child.pid);
    await one.stop();
    expect((await call(client, 3, 'whoami')).pid).toBe(two.child.pid);
    client.close();
    expect(await client.exited).toBe(0);
  });

  it('answers a call in flight when its server goes away', { timeout: 60_000 }, async () => {
    const one = await fake();
    const client = await relay(one);
    await call(client, 2, 'whoami');
    client.send({ id: 3, method: 'tools/call', params: { name: 'wait', arguments: {} } });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await one.stop();
    expect(await client.within(5_000)).toMatchObject({ id: 3, error: { code: -32603 } });
    client.close();
    await client.exited;
  });

  it('never sends a request again after the connection was reset while it ran', { timeout: 60_000 }, async () => {
    const one = await fake();
    const two = await fake();
    const client = await relay(one);
    await client.nextServer(two);
    await call(client, 2, 'whoami');
    await one.stop();
    // the request may have run before the reset: sent again, a message would be posted twice
    const resets = createTcpServer((socket) => socket.on('data', () => socket.resetAndDestroy()));
    await new Promise<void>((resolve) => resets.listen(one.port, '127.0.0.1', resolve));
    try {
      client.send({ id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
      expect(await client.next()).toMatchObject({ id: 3, error: { code: -32603 } });
      expect(await client.reconnects()).toBe(0);
    } finally {
      await new Promise((resolve) => resets.close(resolve));
    }
    // the port refuses now: the next request finds the next server
    expect((await call(client, 4, 'whoami')).pid).toBe(two.child.pid);
    client.close();
    await client.exited;
  });

  it('finds the next server when what answers on its port turns its token down', { timeout: 60_000 }, async () => {
    const one = await fake();
    const two = await fake();
    const client = await relay(one);
    await client.nextServer(two);
    await call(client, 2, 'whoami');
    await one.stop();
    // another start took that port, with a token of its own
    const other = createServer((_request, response) => void response.writeHead(401).end());
    servers.push(other);
    await new Promise<void>((resolve) => other.listen(one.port, '127.0.0.1', resolve));
    expect((await call(client, 3, 'whoami')).pid).toBe(two.child.pid);
    client.close();
    await client.exited;
  });

  it('closes the session it leaves behind when it finds its own server again', { timeout: 60_000 }, async () => {
    const one = await fake();
    const client = await relay(one);
    await call(client, 2, 'whoami');
    // the port refuses for a moment (1.5 s): the relay looks for the server of the moment, and finds the same one
    await call(client, 3, 'pause');
    setTimeout(() => void client.nextServer(one), 2_000);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect((await call(client, 4, 'sessions')).sessions).toBe(1);
    client.close();
    await client.exited;
  });

  it('opens a new session when the server closed ours', { timeout: 60_000 }, async () => {
    const one = await fake();
    const client = await relay(one);
    const before = await call(client, 2, 'whoami');
    expect(await call(client, 3, 'forget')).toEqual({ forgotten: true });
    const after = await call(client, 4, 'whoami');
    expect(after.pid).toBe(before.pid);
    expect(after.started).toBe(before.started);
    client.close();
    await client.exited;
  });

  it('tells the server the protocol version it agreed on, in a session opened again too', { timeout: 60_000 }, async () => {
    const one = await fake();
    const client = await relay(one);
    expect((await call(client, 2, 'headers')).protocol).toBe('2025-06-18');
    await call(client, 3, 'forget');
    expect((await call(client, 4, 'headers')).protocol).toBe('2025-06-18');
    client.close();
    await client.exited;
  });

  it('passes a cancellation on to the server', { timeout: 60_000 }, async () => {
    const one = await fake();
    const client = await relay(one);
    await call(client, 2, 'whoami');
    client.send({ id: 3, method: 'tools/call', params: { name: 'wait', arguments: {} } });
    client.send({ method: 'notifications/cancelled', params: { requestId: 3, reason: 'the user changed their mind' } });
    await expect.poll(() => readFile(join(one.dir, 'wait'), 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('cancelled');
    client.close();
    await client.exited;
  });

  it('forgets a cancelled request', { timeout: 60_000 }, async () => {
    const one = await fake();
    const two = await fake();
    const client = await relay(one);
    await client.nextServer(two);
    await call(client, 2, 'whoami');
    client.send({ id: 3, method: 'tools/call', params: { name: 'wait', arguments: {} } });
    client.send({ method: 'notifications/cancelled', params: { requestId: 3, reason: 'the user changed their mind' } });
    await expect.poll(() => readFile(join(one.dir, 'wait'), 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('cancelled');
    // the agent gave up on 3: the end of the server must not answer it
    await one.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    client.send({ id: 4, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
    const answer = await client.next();
    expect(answer.id).toBe(4);
    expect(JSON.parse(answer.result.content[0].text).pid).toBe(two.child.pid);
    client.close();
    await client.exited;
  });

  it('answers an initialize whose stream ended', { timeout: 60_000 }, async () => {
    // a server that opens a session, then ends the stream of the initialize without answering it
    const mute = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        if (request.method === 'POST') response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'mute' }).end();
        else response.writeHead(405).end();
      });
    });
    servers.push(mute);
    await new Promise<void>((resolve) => mute.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(mute.address() as AddressInfo).port}/mcp`;
    const client = await relay({ url, token: 't' }, { initialize: false, readyMs: 1_000 });
    client.initialize();
    expect(await client.within(8_000)).toMatchObject({ id: 1, error: { code: -32603 } });
    client.close();
    await client.exited;
  });
});
