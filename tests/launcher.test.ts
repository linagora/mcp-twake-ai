import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { saveConfig, type TwakeAiConfig } from '../src/config.js';
import type { AppPaths } from '../src/paths.js';
import { sharedChatFiles, stopSharedChat } from '../src/shared-chat.js';
import { FAKE_HTTP_MCP } from './helpers/fake-http-mcp.js';
import { FAKE_MCP, installFakeMcp } from './helpers/fake-mcp.js';
import { tempPaths } from './helpers/tmp.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const running: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
});

const config: TwakeAiConfig = {
  version: 1,
  email: 'jdoe@linagora.com',
  vault: 'file',
  oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
  environment: {
    domain: 'linagora.com',
    oidc: { issuer: 'https://sso.linagora.com', authorization_endpoint: 'https://sso.linagora.com/a', token_endpoint: 'https://sso.linagora.com/t', userinfo_endpoint: 'https://sso.linagora.com/u' },
    matrix: { homeserver: 'https://matrix.linagora.com/' },
    services: { mail: { url: 'https://jmap.linagora.com/jmap/session', source: 'discovered' } },
    cozy: {},
  },
};

/** `mcp-twake-ai run …` as an agent starts it, with a JSON-RPC client on its stdio. */
async function launch(args: string[], env: Record<string, string> = {}) {
  const { root, paths } = await tempPaths();
  await saveConfig(paths, config);
  await installFakeMcp(paths, 'mail');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'run', ...args], {
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
  return {
    send: (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
    next: () => new Promise<any>((resolve) => (lines.length ? resolve(lines.shift()) : waiting.push(resolve))),
    close: () => child.stdin.end(),
    exited,
    stderr: () => stderr,
  };
}

describe('mcp-twake-ai run', () => {
  it('starts the server with its environment and lets the approval request go both ways', { timeout: 30_000 }, async () => {
    const mcp = await launch(['mail', '--agent', 'claude-code']);
    mcp.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'test', version: '1' } } });
    expect((await mcp.next()).result.serverInfo.name).toBe('fake');
    mcp.send({ id: 2, method: 'tools/call', params: { name: 'send_email', arguments: {} } });
    const approval = await mcp.next();
    expect(approval).toMatchObject({ id: 'approval-1', method: 'elicitation/create' });
    mcp.send({ id: 'approval-1', result: { action: 'accept', content: {} } });
    const result = JSON.parse((await mcp.next()).result.content[0].text) as { action: string; env: Record<string, string> };
    expect(result.action).toBe('accept');
    expect(result.env).toMatchObject({
      JMAP_SESSION_URL: 'https://jmap.linagora.com/jmap/session',
      JMAP_AUTH_METHOD: 'command',
      // quoted for the shell the server runs it through: cmd.exe on Windows, /bin/sh elsewhere
      JMAP_TOKEN_COMMAND: expect.stringContaining(process.platform === 'win32' ? '"token" "mail"' : "'token' 'mail'"),
      USER_LANGUAGE: 'en',
    });
    mcp.close();
    expect(await mcp.exited).toBe(0);
    expect(mcp.stderr()).toBe('');
  });

  it("keeps what the agent's environment already sets", { timeout: 30_000 }, async () => {
    const mcp = await launch(['mail', '--agent', 'claude-code'], { USER_LANGUAGE: 'fr', JMAP_SESSION_URL: 'https://jmap.example.org/session' });
    mcp.send({ id: 1, method: 'tools/call', params: { name: 'x', arguments: {} } });
    await mcp.next();
    mcp.send({ id: 'approval-1', result: { action: 'decline' } });
    const { env } = JSON.parse((await mcp.next()).result.content[0].text) as { env: Record<string, string> };
    expect(env.USER_LANGUAGE).toBe('fr');
    expect(env.JMAP_SESSION_URL).toBe('https://jmap.example.org/session');
    mcp.close();
    await mcp.exited;
  });

  it('exits with the code of the server', { timeout: 30_000 }, async () => {
    const mcp = await launch(['mail', '--agent', 'claude-code']);
    mcp.send({ method: 'quit', params: { code: 3 } });
    expect(await mcp.exited).toBe(3);
  });

  it('says on stderr, never on stdout, what is missing', { timeout: 30_000 }, async () => {
    const mcp = await launch(['space', '--agent', 'claude-code']);
    expect(await mcp.exited).toBe(1);
    expect(mcp.stderr()).toMatch(/^mcp-twake-ai: No Twake Space server was found/);
  });
});

describe('mcp-twake-ai run chat, with a mcp-twake-chat that has the shared mode', () => {
  const used: AppPaths[] = [];
  afterEach(async () => {
    for (const paths of used.splice(0)) await stopSharedChat('claude-code', { paths }).catch(() => 'none');
  });

  const chatConfig: TwakeAiConfig = { ...config, chat: { 'claude-code': { userId: '@jdoe:linagora.com', deviceId: 'DEVICEONE' } } };

  async function setupChat(script = FAKE_HTTP_MCP, extra: Record<string, unknown> = { twake: { commandLine: 1, sharedHttp: 1 } }) {
    const { root, paths } = await tempPaths();
    used.push(paths);
    await saveConfig(paths, chatConfig);
    await installFakeMcp(paths, 'chat', script, undefined, extra);
    return { root, paths };
  }

  /** `run chat --agent claude-code` in that folder, initialized */
  async function client(root: string, env: Record<string, string> = {}) {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'run', 'chat', '--agent', 'claude-code'], {
      cwd: repoRoot,
      env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8', ...env },
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
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'test', version: '1' } } });
    const initialized = await next();
    let id = 10;
    return {
      initialized,
      send,
      next,
      whoami: async () => {
        send({ id: ++id, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
        return JSON.parse((await next()).result.content[0].text) as { pid: number; env: Record<string, string> };
      },
      close: () => child.stdin.end(),
      exited,
      stderr: () => stderr,
    };
  }

  it('two clients of one agent share one Chat server', { timeout: 60_000 }, async () => {
    const { root, paths } = await setupChat();
    const [one, two] = await Promise.all([client(root), client(root)]);
    const [a, b] = await Promise.all([one.whoami(), two.whoami()]);
    expect(a.pid).toBe(b.pid);
    expect(a.env).toMatchObject({ MCP_TRANSPORT: 'http', MCP_HTTP_HOST: '127.0.0.1', MCP_HTTP_PORT: '0', MCP_HTTP_EXIT_WHEN_IDLE_MS: '600000' });
    expect(a.env.MCP_HTTP_STATE_FILE).toBe(sharedChatFiles(paths, 'claude-code').state);
    expect(a.env.MATRIX_STORE_DIR).toMatch(/DEVICEONE$/);
    // the token is drawn by the server: no variable carries it
    const { token } = JSON.parse(await readFile(sharedChatFiles(paths, 'claude-code').state, 'utf8')) as { token: string };
    expect(Object.values(a.env).some((value) => value.includes(token))).toBe(false);
    one.close();
    two.close();
    expect(await one.exited).toBe(0);
    expect(await two.exited).toBe(0);
  });

  it('a client exits when the agent closes stdin, the server stays for the other', { timeout: 60_000 }, async () => {
    const { root } = await setupChat();
    const one = await client(root);
    const two = await client(root);
    const before = await two.whoami();
    one.close();
    expect(await one.exited).toBe(0);
    expect((await two.whoami()).pid).toBe(before.pid);
    two.close();
    await two.exited;
  });

  it('gives the server only the configuration mcp-twake-ai builds, whichever client starts it', { timeout: 60_000 }, async () => {
    const { root } = await setupChat();
    const one = await client(root, { MATRIX_STORE_DIR: '/elsewhere', USER_LANGUAGE: 'fr', MCP_HTTP_PORT: '4000' });
    const { env } = await one.whoami();
    expect(env.MATRIX_STORE_DIR).toMatch(/DEVICEONE$/);
    expect(env.USER_LANGUAGE).toBe('en');
    expect(env.MCP_HTTP_PORT).toBe('0');
    expect(one.stderr()).toMatch(/ignores .*MATRIX_STORE_DIR/);
    one.close();
    await one.exited;
  });

  it('moves a connected client to the new device', { timeout: 60_000 }, async () => {
    const { root, paths } = await setupChat();
    const one = await client(root);
    const before = await one.whoami();
    expect(before.env.MATRIX_STORE_DIR).toMatch(/DEVICEONE$/);
    // what login --chat does: the new device written first, then the server of the old one stopped by its route
    await saveConfig(paths, { ...chatConfig, chat: { 'claude-code': { userId: '@jdoe:linagora.com', deviceId: 'DEVICETWO' } } });
    expect(await stopSharedChat('claude-code', { paths })).toBe('stopped');
    const after = await one.whoami();
    expect(after.env.MATRIX_STORE_DIR).toMatch(/DEVICETWO$/);
    expect(after.pid).not.toBe(before.pid);
    one.close();
    expect(await one.exited).toBe(0);
  });

  it('keeps the stdio child for a Chat without the shared mode', { timeout: 30_000 }, async () => {
    const { root, paths } = await setupChat(FAKE_MCP, {});
    const one = await client(root);
    expect(one.initialized.result.serverInfo.name).toBe('fake');
    one.close();
    expect(await one.exited).toBe(0);
    expect(await readFile(sharedChatFiles(paths, 'claude-code').state, 'utf8').catch(() => 'none')).toBe('none');
  });
});
