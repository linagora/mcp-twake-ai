import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  fetchOidcMetadata,
  fetchUserinfo,
  pollDeviceToken,
  refreshTokens,
  revokeToken,
  startDeviceAuthorization,
  type OidcClient,
  type OidcMetadata,
} from '../src/oidc.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';

const client: OidcClient = { clientId: 'twake-ai-agents', scope: 'openid email offline_access' };
let idp: FakeIdp;
let meta: OidcMetadata;

beforeEach(async () => {
  idp = await startFakeIdp();
  meta = await fetchOidcMetadata(idp.url);
});
afterEach(() => idp.close());

/** Plays the browser: follows the authorization URL and returns the code sent back. */
async function codeFor(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

function virtualClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms / 1000) };
  return clock;
}

describe('PKCE and authorization URL', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toHaveLength(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('builds the authorization URL with PKCE, state and login hint', () => {
    const url = new URL(authorizeUrl(meta, client, { redirectUri: 'http://127.0.0.1:8765/callback', state: 's1', challenge: 'c1', loginHint: 'alice@example.com' }));
    expect(url.origin + url.pathname).toBe(`${idp.url}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'twake-ai-agents',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      scope: 'openid email offline_access',
      state: 's1',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
      login_hint: 'alice@example.com',
    });
  });
});

describe('code exchange', () => {
  it('exchanges the code for tokens that expire expires_in seconds from now', async () => {
    const pkce = createPkce();
    const redirectUri = 'http://127.0.0.1:1/callback';
    const code = await codeFor(authorizeUrl(meta, client, { redirectUri, state: 's', challenge: pkce.challenge }));
    const tokens = await exchangeCode(meta, client, { code, redirectUri, verifier: pkce.verifier }, { now: () => 1000 });
    expect(tokens.accessToken).toMatch(/^access-/);
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    expect(tokens.expiresAt).toBe(1300);
  });

  it('fails when the verifier does not match the challenge', async () => {
    const redirectUri = 'http://127.0.0.1:1/callback';
    const code = await codeFor(authorizeUrl(meta, client, { redirectUri, state: 's', challenge: createPkce().challenge }));
    await expect(exchangeCode(meta, client, { code, redirectUri, verifier: createPkce().verifier })).rejects.toMatchObject({ oauthError: 'invalid_grant' });
  });
});

describe('refresh', () => {
  it('returns the rotated refresh token', async () => {
    const old = idp.issueRefreshToken();
    const tokens = await refreshTokens(meta, client, old, { now: () => 2000 });
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    expect(tokens.refreshToken).not.toBe(old);
    expect(tokens.expiresAt).toBe(2300);
  });

  it('keeps the old refresh token when the IdP does not rotate, and assumes 300 s without expires_in', async () => {
    idp.rotateRefreshTokens = false;
    idp.expiresIn = undefined;
    const old = idp.issueRefreshToken();
    const tokens = await refreshTokens(meta, client, old, { now: () => 2000 });
    expect(tokens.refreshToken).toBe(old);
    expect(tokens.expiresAt).toBe(2300);
  });

  it('asks to sign in again when the refresh token is no longer valid', async () => {
    await expect(refreshTokens(meta, client, 'refresh-unknown')).rejects.toMatchObject({
      code: 'login_required',
      message: expect.stringContaining('twake-ai login'),
    });
  });
});

describe('userinfo and revocation', () => {
  it('reads the userinfo with the access token', async () => {
    const tokens = await refreshTokens(meta, client, idp.issueRefreshToken());
    expect(await fetchUserinfo(meta, tokens.accessToken)).toMatchObject({ workplaceFqdn: 'alice.twake.example.com' });
  });

  it('revokes a refresh token, and does nothing without a revocation endpoint', async () => {
    const refresh = idp.issueRefreshToken();
    await revokeToken(meta, client, refresh);
    expect(idp.revoked).toEqual([refresh]);
    await revokeToken({ ...meta, revocation_endpoint: undefined }, client, 'other');
    expect(idp.revoked).toEqual([refresh]);
  });
});

describe('device flow', () => {
  it('polls until the user approves, slowing down when asked', async () => {
    idp.deviceSlowDownFirst = true;
    const clock = virtualClock();
    const device = await startDeviceAuthorization(meta, client);
    expect(device.user_code).toBe('ABCD-EFGH');
    const tokens = await pollDeviceToken(meta, client, device, clock);
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    // 5 s, slow_down (+5), 10 s pending, 10 s approved
    expect(clock.t - 1_000_000).toBe(25);
  });

  it('stops when the user refuses', async () => {
    idp.deviceDenied = true;
    const device = await startDeviceAuthorization(meta, client);
    await expect(pollDeviceToken(meta, client, device, virtualClock())).rejects.toMatchObject({ code: 'login_cancelled' });
  });

  it('stops when the code expires', async () => {
    idp.devicePendingPolls = 1_000;
    const device = await startDeviceAuthorization(meta, client);
    await expect(pollDeviceToken(meta, client, device, virtualClock())).rejects.toMatchObject({
      code: 'login_cancelled',
      message: expect.stringContaining('expired'),
    });
  });

  it('says so when the IdP offers no device flow', async () => {
    await expect(startDeviceAuthorization({ ...meta, device_authorization_endpoint: undefined }, client)).rejects.toMatchObject({ code: 'unsupported' });
  });
});
