import { spawn } from 'node:child_process';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig, loadConfig, type TwakeAiConfig } from '../src/config.js';
import { COZY_KEYS, matrixGrant, matrixKey, OIDC_GRANT, OIDC_REFRESH_KEY } from '../src/grants.js';
import { withLock } from '../src/lock.js';
import { refreshMatrix } from '../src/matrix.js';
import { logout } from '../src/logout.js';
import { fetchOidcMetadata } from '../src/oidc.js';
import { writeCachedToken } from '../src/token-cache.js';
import { MemoryVault } from '../src/vault.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';
import { tempPaths } from './helpers/tmp.js';
import type { AppPaths } from '../src/paths.js';
import { enterSharedChat, sharedChatFiles, stopSharedChat } from '../src/shared-chat.js';
import { FAKE_HTTP_MCP } from './helpers/fake-http-mcp.js';
import { installFakeMcp } from './helpers/fake-mcp.js';
import { sharedDeps } from './helpers/shared-chat-deps.js';

let idp: FakeIdp;
let cozy: FakeCozy;
let synapse: FakeSynapse;
beforeEach(async () => {
  [idp, cozy, synapse] = await Promise.all([startFakeIdp(), startFakeCozy(), startFakeSynapse()]);
});
afterEach(async () => {
  idp.close();
  await cozy.close();
  await synapse.close();
});

/** Signed in, with Drive and a Chat device for hermes, as the fakes issued them. */
async function signedIn() {
  const { paths } = await tempPaths();
  const vault = new MemoryVault();
  const refresh = idp.issueRefreshToken();
  await vault.set(OIDC_REFRESH_KEY, refresh);
  const client = await cozy.registerClient();
  await vault.set(COZY_KEYS.clientSecret, client.clientSecret);
  await vault.set(COZY_KEYS.registrationToken, client.registrationToken);
  const device = await synapse.issueDevice('Twake AI · hermes');
  await vault.set(matrixKey('hermes', 'access_token'), device.accessToken);
  await vault.set(matrixKey('hermes', 'refresh_token'), device.refreshToken);
  const config: TwakeAiConfig = {
    version: 1,
    email: 'alice@example.com',
    vault: 'file',
    oidc: { clientId: 'twake-ai-agents', scope: 'openid offline_access' },
    environment: { domain: 'example.com', oidc: await fetchOidcMetadata(idp.url), matrix: { homeserver: synapse.url }, services: {}, cozy: { instance: cozy.url } },
    drive: { clientId: client.clientId, apps: [] },
    chat: { hermes: { userId: '@alice:example.com', deviceId: device.deviceId } },
    agents: { cursor: { entries: { 'twake-mail': '0123456789abcdef' } } },
  };
  await saveConfig(paths, config);
  await writeCachedToken(paths, 'oidc', { accessToken: 'a', expiresAt: Number.MAX_SAFE_INTEGER });
  return { paths, vault, config, refresh, device };
}

describe('logout', () => {
  it('revokes the session, removes the Drive client, signs the devices out, then forgets every secret', async () => {
    const { paths, vault, config, refresh, device } = await signedIn();
    const result = await logout({ paths, config, vault, http: {} });
    expect(result.failed).toEqual([]);
    expect(result.done).toEqual(['Twake session revoked', 'Twake Drive access removed', 'Twake Chat device of hermes signed out']);
    expect(idp.revoked).toEqual([refresh]);
    expect(cozy.deleted).toEqual([config.drive!.clientId]);
    expect(synapse.loggedOut).toEqual([device.deviceId]);
    expect(await vault.get(OIDC_REFRESH_KEY)).toBeUndefined();
    expect(await vault.get(matrixKey('hermes', 'refresh_token'))).toBeUndefined();
    expect(await readdir(paths.tokensDir).catch(() => [])).toEqual([]);
    const after = await loadConfig(paths);
    expect(after).toMatchObject({ email: 'alice@example.com', agents: config.agents });
    expect(after?.drive).toBeUndefined();
    expect(after?.chat).toBeUndefined();
  });

  it('goes on when a step fails, and says which one', async () => {
    const { paths, vault, config, device } = await signedIn();
    idp.close();
    const result = await logout({ paths, config, vault, http: { timeoutMs: 2000 } });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatch(/^Twake session: /);
    expect(synapse.loggedOut).toEqual([device.deviceId]);
    expect(await vault.get(OIDC_REFRESH_KEY)).toBeUndefined();
  });

  it('waits for a token being renewed by a server, then revokes the session', async () => {
    const { paths, vault, config, refresh } = await signedIn();
    // the server holds the lock for real before logout starts (a fixed delay is too short on a slow machine)
    let locked!: () => void;
    const acquired = new Promise<void>((resolve) => (locked = resolve));
    const held = withLock(paths.locksDir, OIDC_GRANT, () => {
      locked();
      return new Promise<void>((resolve) => setTimeout(resolve, 400));
    });
    await acquired;
    const out = logout({ paths, config, vault, http: {} });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(idp.revoked).toEqual([]);
    await held;
    expect((await out).failed).toEqual([]);
    expect(idp.revoked).toEqual([refresh]);
  });

  it('signs a device out with the fresh access token the broker cached, not the one kept at login', async () => {
    const { paths, vault, config, device } = await signedIn();
    synapse.expireIssuedAccessTokens();
    // a server renewed the session since: the refresh token kept at login is spent, the fresh access token is cached
    const renewed = await refreshMatrix(synapse.url, device.refreshToken, 'hermes');
    await writeCachedToken(paths, matrixGrant('hermes'), { accessToken: renewed.accessToken, expiresAt: Number.MAX_SAFE_INTEGER });
    expect((await logout({ paths, config, vault, http: {} })).failed).toEqual([]);
    expect(synapse.loggedOut).toEqual([device.deviceId]);
  });

  it('does not claim a revocation the identity provider cannot do', async () => {
    const { paths, vault, config } = await signedIn();
    const { revocation_endpoint: _none, ...oidc } = config.environment.oidc;
    const result = await logout({ paths, config: { ...config, environment: { ...config.environment, oidc } }, vault, http: {} });
    expect(result.done).not.toContain('Twake session revoked');
    expect(result.failed[0]).toMatch(/^Twake session: .*no revocation/);
    expect(await vault.get(OIDC_REFRESH_KEY)).toBeUndefined();
  });

  it('signs out a device whose access token has expired, after a refresh', async () => {
    const { paths, vault, config, device } = await signedIn();
    synapse.expireIssuedAccessTokens();
    expect((await logout({ paths, config, vault, http: {} })).failed).toEqual([]);
    expect(synapse.loggedOut).toEqual([device.deviceId]);
  });
});

describe('logout and the shared Chat server', () => {
  const started: AppPaths[] = [];
  afterEach(async () => {
    for (const paths of started.splice(0)) await stopSharedChat('hermes', { paths }).catch(() => 'none');
  });

  it("stops each agent's shared Chat server by its route, before its device is signed out", async () => {
    const { paths, vault, config, device } = await signedIn();
    started.push(paths);
    await installFakeMcp(paths, 'chat', FAKE_HTTP_MCP, undefined, { twake: { sharedHttp: 1 } });
    const server = await enterSharedChat('hermes', sharedDeps(paths, { agent: 'hermes', device: () => device.deviceId }));
    const result = await logout({ paths, config, vault, http: {} });
    expect(result.failed).toEqual([]);
    expect(result.chatServersLeft).toEqual([]);
    expect(result.done).toEqual(['Twake session revoked', 'Twake Drive access removed', 'Shared Twake Chat server of hermes stopped', 'Twake Chat device of hermes signed out']);
    const files = sharedChatFiles(paths, 'hermes');
    expect(await readFile(files.state, 'utf8').catch(() => 'gone')).toBe('gone');
    await expect.poll(() => alive(server.pid), { timeout: 10_000 }).toBe(false);
    expect(await readFile(join(files.dir, 'signals.log'), 'utf8').catch(() => 'none')).toBe('none');
  }, 30_000);

  it('says which server does not answer, by its pid, and still signs the device out', async () => {
    const { paths, vault, config, device } = await signedIn();
    const files = sharedChatFiles(paths, 'hermes');
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    // a port that takes connections and never answers: a server too busy to, or hung
    const silent = await new Promise<{ port: number; close(): void }>((resolve) => {
      const server = createTcpServer(() => {});
      server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, close: () => server.close() }));
    });
    try {
      const state = { version: 1, pid: stranger.pid, url: `http://127.0.0.1:${silent.port}/mcp`, token: 'f'.repeat(64), userId: '@alice:example.com', deviceId: device.deviceId, serverVersion: '0.7.0', startedAt: '' };
      await writeFile(files.state, JSON.stringify(state), { mode: 0o600 });
      const result = await logout({ paths, config, vault, http: {} });
      expect(result.failed).toEqual([expect.stringMatching(new RegExp(`^Twake Chat \\(hermes\\): .*pid ${stranger.pid}\\b`))]);
      expect(result.chatServersLeft).toEqual(['hermes']);
      expect(synapse.loggedOut).toEqual([device.deviceId]);
      expect(alive(stranger.pid!)).toBe(true);
    } finally {
      stranger.kill('SIGKILL');
      silent.close();
    }
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
