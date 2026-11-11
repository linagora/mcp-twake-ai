import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TwakeAiError } from './errors.js';
import { getJson, HttpError, parseAnswer, postForm, requireSecureUrl, type HttpOptions } from './http.js';

export const OidcMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  userinfo_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
  device_authorization_endpoint: z.string().optional(),
});
export type OidcMetadata = z.infer<typeof OidcMetadataSchema>;

export interface OidcClient {
  clientId: string;
  scope: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** epoch seconds */
  expiresAt: number;
}

export type OidcHttp = HttpOptions & {
  /** epoch seconds */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Lifetime assumed when the IdP does not give expires_in (it is optional in RFC 6749). */
const DEFAULT_TTL_S = 300;

const nowS = () => Math.floor(Date.now() / 1000);

const ENDPOINTS = ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint', 'revocation_endpoint', 'device_authorization_endpoint'] as const;

/** The IdP metadata, refused unless it speaks for this issuer (OpenID Connect Discovery §4.3) and every endpoint is HTTPS. */
export async function fetchOidcMetadata(issuer: string, http?: HttpOptions): Promise<OidcMetadata> {
  const wanted = requireSecureUrl(issuer, 'The identity provider').replace(/\/+$/, '');
  const url = `${wanted}/.well-known/openid-configuration`;
  const meta = parseAnswer(OidcMetadataSchema, await getJson(url, http), url);
  if (meta.issuer.replace(/\/+$/, '') !== wanted) {
    throw new TwakeAiError('bad_response', `${url} speaks for ${meta.issuer}, not ${wanted}: refusing it.`);
  }
  for (const key of ENDPOINTS) {
    const endpoint = meta[key];
    if (endpoint) requireSecureUrl(endpoint, `The ${key.replaceAll('_', ' ')} of ${wanted}`);
  }
  return meta;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function randomState(): string {
  return randomBytes(16).toString('base64url');
}

export function authorizeUrl(
  meta: OidcMetadata,
  client: OidcClient,
  p: { redirectUri: string; state: string; challenge: string; loginHint?: string },
): string {
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: p.redirectUri,
    scope: client.scope,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  }).toString();
  return url.toString();
}

const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  // some IdPs send the lifetime as a numeric string
  expires_in: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).nullish(),
});

function toTokenSet(raw: unknown, now: number, url: string): TokenSet {
  const t = parseAnswer(TokenResponseSchema, raw, url);
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? undefined, expiresAt: now + (t.expires_in ?? DEFAULT_TTL_S) };
}

export async function exchangeCode(
  meta: OidcMetadata,
  client: OidcClient,
  p: { code: string; redirectUri: string; verifier: string },
  http: OidcHttp = {},
): Promise<TokenSet> {
  const raw = await postForm(
    meta.token_endpoint,
    { grant_type: 'authorization_code', client_id: client.clientId, code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier },
    http,
  );
  return toTokenSet(raw, (http.now ?? nowS)(), meta.token_endpoint);
}

/** Renews the access token. Keeps the old refresh token when the IdP does not rotate it. */
export async function refreshTokens(meta: OidcMetadata, client: OidcClient, refreshToken: string, http: OidcHttp = {}): Promise<TokenSet> {
  let raw: unknown;
  try {
    raw = await postForm(meta.token_endpoint, { grant_type: 'refresh_token', client_id: client.clientId, refresh_token: refreshToken }, http);
  } catch (error) {
    if (error instanceof HttpError && error.oauthError === 'invalid_client') {
      throw new TwakeAiError(
        'login_required',
        `The identity provider no longer accepts the client "${client.clientId}": run \`mcp-twake-ai login\`, or ask your administrator.`,
      );
    }
    if (error instanceof HttpError && (error.oauthError === 'invalid_grant' || error.status === 401)) {
      throw new TwakeAiError('login_required', 'Your Twake session has expired: run `mcp-twake-ai login`.');
    }
    throw error;
  }
  const tokens = toTokenSet(raw, (http.now ?? nowS)(), meta.token_endpoint);
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

export async function revokeToken(meta: OidcMetadata, client: OidcClient, token: string, http: HttpOptions = {}): Promise<void> {
  if (!meta.revocation_endpoint) return;
  await postForm(meta.revocation_endpoint, { client_id: client.clientId, token, token_type_hint: 'refresh_token' }, http);
}

export async function fetchUserinfo(meta: OidcMetadata, accessToken: string, http: HttpOptions = {}): Promise<Record<string, unknown>> {
  return (await getJson(meta.userinfo_endpoint, http, { authorization: `Bearer ${accessToken}` })) as Record<string, unknown>;
}

const DeviceAuthorizationSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number().optional(),
});
/** What the identity provider answered, and the PKCE verifier to present when polling. */
export type DeviceAuthorization = z.infer<typeof DeviceAuthorizationSchema> & { verifier: string };

export async function startDeviceAuthorization(meta: OidcMetadata, client: OidcClient, http: HttpOptions = {}): Promise<DeviceAuthorization> {
  if (!meta.device_authorization_endpoint) {
    throw new TwakeAiError('unsupported', `${meta.issuer} does not offer sign-in from another device: run mcp-twake-ai login on a computer with a browser.`);
  }
  const url = meta.device_authorization_endpoint;
  // PKCE here too: LemonLDAP::NG requires it of a public client in the device flow, as in the browser one
  const pkce = createPkce();
  const answer = await postForm(url, { client_id: client.clientId, scope: client.scope, code_challenge: pkce.challenge, code_challenge_method: 'S256' }, http);
  const device = { ...parseAnswer(DeviceAuthorizationSchema, answer, url), verifier: pkce.verifier };
  requireSecureUrl(device.verification_uri, 'The sign-in page');
  if (device.verification_uri_complete) requireSecureUrl(device.verification_uri_complete, 'The sign-in page');
  return device;
}

/** Waits for the user to approve the device code (RFC 8628 §3.4–3.5). */
export async function pollDeviceToken(meta: OidcMetadata, client: OidcClient, device: DeviceAuthorization, http: OidcHttp = {}): Promise<TokenSet> {
  const now = http.now ?? nowS;
  const sleep = http.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const expired = new TwakeAiError('login_cancelled', 'The sign-in code has expired: run mcp-twake-ai login again.');
  const deadline = now() + device.expires_in;
  let interval = device.interval ?? 5;
  while (now() < deadline) {
    await sleep(interval * 1000);
    try {
      const raw = await postForm(
        meta.token_endpoint,
        { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: client.clientId, code_verifier: device.verifier },
        http,
      );
      return toTokenSet(raw, now(), meta.token_endpoint);
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.oauthError === 'authorization_pending') continue;
      if (error.oauthError === 'slow_down') {
        interval += 5;
        continue;
      }
      if (error.oauthError === 'access_denied') throw new TwakeAiError('login_cancelled', 'Sign-in was refused on the other device.');
      if (error.oauthError === 'expired_token') throw expired;
      throw error;
    }
  }
  throw expired;
}
