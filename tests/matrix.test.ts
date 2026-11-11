import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginWithToken, logoutMatrix, refreshMatrix, ssoProvider, ssoRedirectUrl } from '../src/matrix.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';

let synapse: FakeSynapse;
beforeEach(async () => {
  synapse = await startFakeSynapse();
});
afterEach(() => synapse.close());

/** Plays the browser through the SSO redirect and returns the login token sent back. */
async function loginTokenFor(idp: string | undefined): Promise<string> {
  const response = await fetch(ssoRedirectUrl(synapse.url, idp, 'http://127.0.0.1:8765/callback?state=S'), { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '').searchParams.get('loginToken') ?? '';
}

describe('single sign-on', () => {
  it('finds the identity provider of the SSO flow', async () => {
    expect(await ssoProvider(synapse.url)).toBe('oidc-twake');
    synapse.idpId = undefined;
    expect(await ssoProvider(synapse.url)).toBeUndefined();
  });

  it('says so when the homeserver offers no single sign-on', async () => {
    synapse.sso = false;
    await expect(ssoProvider(synapse.url)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('builds the redirect URL, with or without a named provider', () => {
    expect(ssoRedirectUrl('https://matrix.example.com/', 'oidc-twake', 'http://127.0.0.1:8765/callback?state=S')).toBe(
      'https://matrix.example.com/_matrix/client/v3/login/sso/redirect/oidc-twake?redirectUrl=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback%3Fstate%3DS',
    );
    expect(ssoRedirectUrl('https://matrix.example.com', undefined, 'http://x/cb')).toBe(
      'https://matrix.example.com/_matrix/client/v3/login/sso/redirect?redirectUrl=http%3A%2F%2Fx%2Fcb',
    );
  });
});

describe('sessions', () => {
  it('logs a new device in with the login token, asking for a refresh token', async () => {
    const session = await loginWithToken(synapse.url, await loginTokenFor('oidc-twake'), 'Twake AI · hermes', { now: () => 1000 });
    expect(session).toEqual({
      userId: '@alice:example.com',
      deviceId: 'DEVICE1',
      accessToken: expect.stringMatching(/^syt-/),
      refreshToken: expect.stringMatching(/^syr-/),
      expiresAt: 1300,
    });
    expect(synapse.deviceNames).toEqual({ DEVICE1: 'Twake AI · hermes' });
  });

  it('gets a token without expiry when the homeserver gives no refresh token', async () => {
    synapse.refreshableTokens = false;
    const session = await loginWithToken(synapse.url, await loginTokenFor('oidc-twake'), 'Twake AI · hermes');
    expect(session.refreshToken).toBeUndefined();
    expect(session.expiresAt).toBeUndefined();
  });

  it('refreshes the access token and rotates the refresh token', async () => {
    const session = await loginWithToken(synapse.url, await loginTokenFor('oidc-twake'), 'Twake AI · hermes');
    const renewed = await refreshMatrix(synapse.url, session.refreshToken ?? '', 'hermes', { now: () => 2000 });
    expect(renewed).toEqual({ accessToken: expect.stringMatching(/^syt-/), refreshToken: expect.stringMatching(/^syr-/), expiresAt: 2300 });
    expect(renewed.refreshToken).not.toBe(session.refreshToken);
  });

  it('asks to reconnect the agent when the refresh token is refused', async () => {
    await expect(refreshMatrix(synapse.url, 'syr-unknown', 'hermes')).rejects.toMatchObject({
      code: 'login_required',
      message: expect.stringContaining('twake-ai login --chat --agent hermes'),
    });
  });

  it('logs a device out', async () => {
    const session = await loginWithToken(synapse.url, await loginTokenFor('oidc-twake'), 'Twake AI · hermes');
    await logoutMatrix(synapse.url, session.accessToken);
    expect(synapse.loggedOut).toEqual(['DEVICE1']);
  });
});

describe('spent login tokens', () => {
  it('says the sign-in took too long when the login token is spent', async () => {
    await expect(loginWithToken(synapse.url, 'loginToken-spent', 'Twake AI · hermes')).rejects.toMatchObject({ code: 'login_cancelled' });
  });
});
