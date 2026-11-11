import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getToken, type BrokerDeps } from '../src/broker.js';
import { saveConfig, type TwakeAiConfig } from '../src/config.js';
import { OIDC_REFRESH_KEY } from '../src/login.js';
import { fetchOidcMetadata } from '../src/oidc.js';
import { readCachedToken, writeCachedToken } from '../src/token-cache.js';
import { FileVault } from '../src/vault.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';
import { tempPaths } from './helpers/tmp.js';
import { COZY_KEYS, matrixKey, NEVER_EXPIRES } from '../src/grants.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';
import { createPkce } from '../src/oidc.js';
import { cozyAuthorizeUrl, exchangeCozyCode, registerCozyClient } from '../src/cozy.js';
import { loginWithToken, ssoRedirectUrl } from '../src/matrix.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const NOW = 2_000_000;

let idp: FakeIdp;
beforeEach(async () => {
  idp = await startFakeIdp();
});
afterEach(() => idp.close());

/** A machine where `twake-ai login` has run: configuration saved, refresh token in a file vault, no cached token. */
async function signedIn(): Promise<BrokerDeps & { root: string }> {
  const { root, paths } = await tempPaths();
  const config: TwakeAiConfig = {
    version: 1,
    email: 'alice@example.com',
    vault: 'file',
    oidc: { clientId: 'twake-ai-agents', scope: 'openid offline_access' },
    environment: {
      domain: 'example.com',
      oidc: await fetchOidcMetadata(idp.url),
      matrix: { homeserver: 'https://matrix.example.com/' },
      services: {},
      cozy: {},
    },
  };
  await saveConfig(paths, config);
  const vault = new FileVault(paths);
  await vault.set(OIDC_REFRESH_KEY, idp.issueRefreshToken());
  return { root, paths, config, vault, http: {}, now: () => NOW };
}

describe('getToken', () => {
  it('serves the cached token without contacting the IdP', async () => {
    const d = await signedIn();
    await writeCachedToken(d.paths, 'oidc', { accessToken: 'cached', expiresAt: NOW + 600 });
    expect(await getToken('project', d)).toEqual({ access_token: 'cached', expires_at: NOW + 600 });
    expect(idp.refreshCount).toBe(0);
  });

  it('refreshes when nothing is cached, keeps the rotated refresh token and caches the access token', async () => {
    const d = await signedIn();
    const before = await d.vault.get(OIDC_REFRESH_KEY);
    const token = await getToken('mail', d);
    expect(token).toEqual({ access_token: expect.stringMatching(/^access-/), expires_at: NOW + 300 });
    expect(idp.refreshCount).toBe(1);
    expect(await d.vault.get(OIDC_REFRESH_KEY)).not.toBe(before);
    expect(await readCachedToken(d.paths, 'oidc')).toEqual({ accessToken: token.access_token, expiresAt: NOW + 300 });
    expect(await getToken('dav', d)).toEqual(token);
    expect(idp.refreshCount).toBe(1);
  });

  it('refreshes a cached token that expires within 60 s', async () => {
    const d = await signedIn();
    await writeCachedToken(d.paths, 'oidc', { accessToken: 'almost-expired', expiresAt: NOW + 59 });
    expect((await getToken('space', d)).access_token).not.toBe('almost-expired');
    expect(idp.refreshCount).toBe(1);
  });

  it('refreshes instead of failing when the cache file is corrupted', async () => {
    const d = await signedIn();
    await writeCachedToken(d.paths, 'oidc', { accessToken: 'x', expiresAt: NOW + 600 });
    await writeFile(join(d.paths.tokensDir, 'oidc.json'), '{"accessToken":"x","expi');
    expect((await getToken('mail', d)).access_token).toMatch(/^access-/);
  });

  it('asks to sign in when the vault holds no refresh token', async () => {
    const d = await signedIn();
    await d.vault.delete(OIDC_REFRESH_KEY);
    await expect(getToken('mail', d)).rejects.toMatchObject({ code: 'login_required', message: expect.stringContaining('twake-ai login') });
  });

  it('asks to sign in when the IdP no longer accepts the refresh token', async () => {
    const d = await signedIn();
    await d.vault.set(OIDC_REFRESH_KEY, 'refresh-revoked');
    await expect(getToken('mail', d)).rejects.toMatchObject({ code: 'login_required' });
  });


  it('refreshes once when eight processes ask at the same moment', { timeout: 60_000 }, async () => {
    const d = await signedIn();
    const worker = join(repoRoot, 'tests', 'helpers', 'token-worker.ts');
    const outputs = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(process.execPath, ['--import', 'tsx', worker], { cwd: repoRoot, env: { ...process.env, TWAKE_AI_HOME: d.root } }),
      ),
    );
    const tokens = outputs.map(({ stdout }) => (JSON.parse(stdout) as { access_token: string }).access_token);
    expect(new Set(tokens).size).toBe(1);
    expect(idp.refreshCount).toBe(1);
  });
});

describe('getToken for Drive and Chat', () => {
  let cozy: FakeCozy;
  let synapse: FakeSynapse;
  beforeEach(async () => {
    cozy = await startFakeCozy();
    synapse = await startFakeSynapse();
  });
  afterEach(async () => {
    await cozy.close();
    await synapse.close();
  });

  /** signedIn() plus a connected Twake Drive whose cached token is gone. */
  async function withDrive(): Promise<BrokerDeps> {
    const d = await signedIn();
    const client = await registerCozyClient(cozy.url, ['http://127.0.0.1:8765/callback']);
    const pkce = createPkce();
    const atCozy = await fetch(cozyAuthorizeUrl(cozy.url, { clientId: client.clientId, redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: pkce.challenge }), { redirect: 'manual' });
    const code = new URL(atCozy.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokens = await exchangeCozyCode(cozy.url, client, { code, verifier: pkce.verifier });
    await d.vault.set(COZY_KEYS.clientSecret, client.clientSecret);
    await d.vault.set(COZY_KEYS.registrationToken, client.registrationToken);
    await d.vault.set(COZY_KEYS.refreshToken, tokens.refreshToken ?? '');
    const config = { ...d.config, environment: { ...d.config.environment, cozy: { instance: cozy.url } }, drive: { clientId: client.clientId, apps: [] } };
    await saveConfig(d.paths, config);
    return { ...d, config };
  }

  /** signedIn() plus a Chat device for hermes. */
  async function withChat(refreshable: boolean): Promise<BrokerDeps> {
    const d = await signedIn();
    synapse.refreshableTokens = refreshable;
    const atSynapse = await fetch(ssoRedirectUrl(synapse.url, 'oidc-twake', 'http://127.0.0.1:8765/callback?state=S'), { redirect: 'manual' });
    const loginToken = new URL(atSynapse.headers.get('location') ?? '').searchParams.get('loginToken') ?? '';
    const session = await loginWithToken(synapse.url, loginToken, 'Twake AI · hermes');
    await d.vault.set(matrixKey('hermes', 'access_token'), session.accessToken);
    if (session.refreshToken) await d.vault.set(matrixKey('hermes', 'refresh_token'), session.refreshToken);
    const config = {
      ...d.config,
      environment: { ...d.config.environment, matrix: { homeserver: synapse.url } },
      chat: { hermes: { userId: session.userId, deviceId: session.deviceId } },
    };
    await saveConfig(d.paths, config);
    return { ...d, config };
  }

  it('renews the Drive token once and announces it for one hour at most', async () => {
    const d = await withDrive();
    const token = await getToken('drive', d);
    expect(token).toEqual({ access_token: expect.stringMatching(/^cozy-access/), expires_at: NOW + 3600 });
    expect(await getToken('drive', d)).toEqual(token);
    expect(cozy.refreshCount).toBe(1);
  });

  it('asks to connect Drive when it is not', async () => {
    const d = await signedIn();
    await expect(getToken('drive', d)).rejects.toMatchObject({ code: 'login_required', message: expect.stringContaining('twake-ai login --drive') });
  });

  it('serves the Chat token of an agent with its device and user', async () => {
    const d = await withChat(true);
    const token = await getToken('chat', d, 'hermes');
    expect(token).toEqual({ access_token: expect.stringMatching(/^syt-/), expires_at: NOW + 300, device_id: 'DEVICE1', user_id: '@alice:example.com' });
    expect(synapse.refreshCount).toBe(1);
  });

  it('serves a Chat token without expiry, announced for one hour, when Synapse gives no refresh token', async () => {
    const d = await withChat(false);
    const token = await getToken('chat', d, 'hermes');
    expect(token).toMatchObject({ expires_at: NOW + 3600, device_id: 'DEVICE1' });
    expect(await readCachedToken(d.paths, 'matrix-hermes')).toEqual({ accessToken: token.access_token, expiresAt: NEVER_EXPIRES });
  });

  it('needs the agent for a Chat token, and a connected one', async () => {
    const d = await withChat(true);
    await expect(getToken('chat', d)).rejects.toMatchObject({ code: 'usage' });
    await expect(getToken('chat', d, 'cursor')).rejects.toMatchObject({ code: 'login_required', message: expect.stringContaining('--agent cursor') });
    await expect(getToken('chat', d, '../x')).rejects.toMatchObject({ code: 'usage' });
  });
});
