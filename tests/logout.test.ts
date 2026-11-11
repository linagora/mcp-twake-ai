import { readdir } from 'node:fs/promises';
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
    const held = withLock(paths.locksDir, OIDC_GRANT, () => new Promise<void>((resolve) => setTimeout(resolve, 400)));
    await new Promise((resolve) => setTimeout(resolve, 50));
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

  it('signs out a device whose access token has expired, after a refresh', async () => {
    const { paths, vault, config, device } = await signedIn();
    synapse.expireIssuedAccessTokens();
    expect((await logout({ paths, config, vault, http: {} })).failed).toEqual([]);
    expect(synapse.loggedOut).toEqual([device.deviceId]);
  });
});
