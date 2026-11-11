import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COZY_SCOPE,
  cozyAuthorizeUrl,
  cozyClientExists,
  deleteCozyClient,
  exchangeCozyCode,
  exchangeOidcForCozy,
  fetchPlatformApps,
  oidcExchangeEnabled,
  refreshCozy,
  registerCozyClient,
  tokenExpiry,
  type CozyClient,
} from '../src/cozy.js';
import { createPkce } from '../src/oidc.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';

let cozy: FakeCozy;
let client: CozyClient;

beforeEach(async () => {
  cozy = await startFakeCozy();
  client = await registerCozyClient(cozy.url, ['http://127.0.0.1:8765/callback']);
});
afterEach(() => cozy.close());

/** Plays the browser: cozy-stack redirects at once with the code. */
async function codeFor(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

async function signedIn(): Promise<{ accessToken: string; refreshToken: string }> {
  const pkce = createPkce();
  const code = await codeFor(cozyAuthorizeUrl(cozy.url, { clientId: client.clientId, redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: pkce.challenge }));
  const tokens = await exchangeCozyCode(cozy.url, client, { code, verifier: pkce.verifier });
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? '' };
}

describe('registration and authorization', () => {
  it('registers a client and keeps its secret and registration token', () => {
    expect(client).toEqual({
      clientId: expect.stringMatching(/^client-/),
      clientSecret: expect.stringMatching(/^secret-/),
      registrationToken: expect.stringMatching(/^registration-/),
    });
  });

  it('shows up as "Twake AI", a desktop client, with the software id of its repository', () => {
    expect(cozy.registered).toEqual([
      { redirect_uris: ['http://127.0.0.1:8765/callback'], client_name: 'Twake AI', software_id: 'github.com/linagora/mcp-twake-ai', client_kind: 'desktop' },
    ]);
  });

  it('builds the authorization URL with PKCE and the Drive scope', () => {
    const url = new URL(cozyAuthorizeUrl(cozy.url, { clientId: 'c', redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: 'ch' }));
    expect(url.pathname).toBe('/auth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'c',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      scope: COZY_SCOPE,
      state: 's',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges the code for tokens that expire with the JWT', async () => {
    const pkce = createPkce();
    const code = await codeFor(cozyAuthorizeUrl(cozy.url, { clientId: client.clientId, redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: pkce.challenge }));
    const tokens = await exchangeCozyCode(cozy.url, client, { code, verifier: pkce.verifier }, { now: () => 1000 });
    expect(tokens).toEqual({ accessToken: expect.stringMatching(/^cozy-access/), refreshToken: expect.stringMatching(/^cozy-refresh/), expiresAt: 4_000_000_000 });
  });

  it('refuses a code whose verifier does not match', async () => {
    const code = await codeFor(cozyAuthorizeUrl(cozy.url, { clientId: client.clientId, redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: createPkce().challenge }));
    await expect(exchangeCozyCode(cozy.url, client, { code, verifier: createPkce().verifier })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an instance in plain http outside this computer', async () => {
    await expect(registerCozyClient('http://alice.twake.example.com', [])).rejects.toMatchObject({ code: 'insecure_endpoint' });
  });
});

describe('tokens', () => {
  it('keeps the refresh token, which cozy-stack does not rotate', async () => {
    const { refreshToken } = await signedIn();
    const tokens = await refreshCozy(cozy.url, client, refreshToken);
    expect(tokens.refreshToken).toBe(refreshToken);
    expect(cozy.refreshCount).toBe(1);
  });

  it('asks to connect Drive again when the refresh token is refused', async () => {
    await expect(refreshCozy(cozy.url, client, 'cozy-refresh-unknown')).rejects.toMatchObject({
      code: 'login_required',
      message: expect.stringContaining('mcp-twake-ai login --drive'),
    });
  });

  it('computes the expiry from expires_in, else the JWT exp claim, else 5 minutes', () => {
    const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    expect(tokenExpiry('opaque', 3600, 1000)).toBe(4600);
    expect(tokenExpiry(jwt({ exp: 9000 }), undefined, 1000)).toBe(9000);
    expect(tokenExpiry(jwt({ exp: 500 }), undefined, 1000)).toBe(1300);
    expect(tokenExpiry('opaque', null, 1000)).toBe(1300);
  });
});

describe('IdP token exchange (allow_oauth_token)', () => {
  it('detects that the exchange is disabled, as on the LINAGORA SaaS', async () => {
    expect(await oidcExchangeEnabled(cozy.url)).toBe(false);
  });

  it('detects that it is enabled, and exchanges the IdP token', async () => {
    cozy.oidcExchange = true;
    expect(await oidcExchangeEnabled(cozy.url)).toBe(true);
    const tokens = await exchangeOidcForCozy(cozy.url, client, 'idp-access');
    expect(tokens.refreshToken).toMatch(/^cozy-refresh/);
    expect(cozy.oidcTokens).toEqual(['idp-access']);
  });
});

describe('context and unregistration', () => {
  it('reads the platform apps enabled for the organization', async () => {
    const { accessToken } = await signedIn();
    expect(await fetchPlatformApps(cozy.url, accessToken)).toEqual(['mail', 'chat', 'space', 'project']);
  });

  it('deletes the client with its registration token', async () => {
    await deleteCozyClient(cozy.url, client);
    expect(cozy.deleted).toEqual([client.clientId]);
  });
});

describe('review fixes', () => {
  it('does not take an unknown answer for an enabled exchange', async () => {
    cozy.oidcMissing = true;
    expect(await oidcExchangeEnabled(cozy.url)).toBe(false);
  });

  it('tells whether the registered client still exists', async () => {
    expect(await cozyClientExists(cozy.url, client)).toBe(true);
    await deleteCozyClient(cozy.url, client);
    expect(await cozyClientExists(cozy.url, client)).toBe(false);
  });
});
