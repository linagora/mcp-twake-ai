import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { saveConfig, type TwakeAiConfig } from '../src/config.js';
import { installFakeMcp } from './helpers/fake-mcp.js';
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

/** `twake-ai run …` as an agent starts it, with a JSON-RPC client on its stdio. */
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

describe('twake-ai run', () => {
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
      JMAP_TOKEN_COMMAND: expect.stringContaining("'token' 'mail'"),
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
    expect(mcp.stderr()).toMatch(/^twake-ai: No Twake Space server was found/);
  });
});
