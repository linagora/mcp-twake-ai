import { z } from 'zod';
import { TwakeAiError } from './errors.js';
import { getJson, HttpError, parseAnswer, postForm, postJson, requestJson, requireSecureUrl, type HttpOptions } from './http.js';
import type { OidcHttp, TokenSet } from './oidc.js';

/** The permissions mcp-twake-drive needs (its README). */
export const COZY_SCOPE =
  'io.cozy.files io.cozy.files.* io.cozy.notes io.cozy.permissions io.cozy.sharings:GET io.cozy.settings:GET io.cozy.contacts:GET';
export const COZY_SOFTWARE_ID = 'github.com/linagora/mcp-twake-wizard';

export interface CozyClient {
  clientId: string;
  clientSecret: string;
  registrationToken: string;
}

const nowS = () => Math.floor(Date.now() / 1000);
const DEFAULT_TTL_S = 300;

const RegistrationSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  registration_access_token: z.string(),
});

/** Registers twake-ai on the Twake Drive instance: it shows up as "Twake AI" in the connected devices. */
export async function registerCozyClient(instance: string, redirectUris: string[], http: HttpOptions = {}): Promise<CozyClient> {
  const url = `${requireSecureUrl(instance, 'The Twake Drive instance')}/auth/register`;
  const body = { redirect_uris: redirectUris, client_name: 'Twake AI', software_id: COZY_SOFTWARE_ID, client_kind: 'desktop' };
  const answer = parseAnswer(RegistrationSchema, await postJson(url, body, http), url);
  return { clientId: answer.client_id, clientSecret: answer.client_secret, registrationToken: answer.registration_access_token };
}

export function cozyAuthorizeUrl(instance: string, p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(`${instance}/auth/authorize`);
  const params = {
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: COZY_SCOPE,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

const CozyTokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).nullish(),
});

/** cozy-stack rarely sends expires_in: its access tokens are JWTs that carry their own exp claim. */
export function tokenExpiry(accessToken: string, expiresIn: number | null | undefined, now: number): number {
  if (expiresIn) return now + expiresIn;
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp === 'number' && payload.exp > now) return payload.exp;
  } catch {
    // not a JWT
  }
  return now + DEFAULT_TTL_S;
}

function toTokens(raw: unknown, now: number, url: string): TokenSet {
  const t = parseAnswer(CozyTokenSchema, raw, url);
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? undefined, expiresAt: tokenExpiry(t.access_token, t.expires_in, now) };
}

export async function exchangeCozyCode(instance: string, client: CozyClient, p: { code: string; verifier: string }, http: OidcHttp = {}): Promise<TokenSet> {
  const url = `${instance}/auth/access_token`;
  const form = {
    grant_type: 'authorization_code',
    code: p.code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code_verifier: p.verifier,
  };
  return toTokens(await postForm(url, form, http), (http.now ?? nowS)(), url);
}

export async function refreshCozy(instance: string, client: CozyClient, refreshToken: string, http: OidcHttp = {}): Promise<TokenSet> {
  const url = `${instance}/auth/access_token`;
  let raw: unknown;
  try {
    raw = await postForm(url, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }, http);
  } catch (error) {
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      throw new TwakeAiError('login_required', 'Your Twake Drive connection has expired or was revoked: run `twake-ai login --drive`.');
    }
    throw error;
  }
  const tokens = toTokens(raw, (http.now ?? nowS)(), url);
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

/** allow_oauth_token: when the instance accepts an IdP token, Drive connects without a browser. Probed with dummy values. */
export async function oidcExchangeEnabled(instance: string, http: HttpOptions = {}): Promise<boolean> {
  try {
    await postJson(`${instance}/oidc/access_token`, { client_id: 'probe', client_secret: 'probe', scope: COZY_SCOPE, oidc_token: 'probe' }, http);
    return true;
  } catch (error) {
    // enabled: the stack rejects the dummy token itself (400); anything else (404, 403, network…) means no
    return error instanceof HttpError && error.status === 400 && !error.body.includes('this endpoint is not enabled');
  }
}

export async function exchangeOidcForCozy(instance: string, client: CozyClient, oidcToken: string, http: OidcHttp = {}): Promise<TokenSet> {
  const url = `${instance}/oidc/access_token`;
  const body = { client_id: client.clientId, client_secret: client.clientSecret, scope: COZY_SCOPE, oidc_token: oidcToken };
  return toTokens(await postJson(url, body, http), (http.now ?? nowS)(), url);
}

/** Whether the client registered by twake-ai still exists: the user may have removed "Twake AI" from the connected devices. */
export async function cozyClientExists(instance: string, client: CozyClient, http: HttpOptions = {}): Promise<boolean> {
  try {
    await getJson(`${instance}/auth/register/${encodeURIComponent(client.clientId)}`, http, { authorization: `Bearer ${client.registrationToken}` });
    return true;
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 404)) return false;
    throw error;
  }
}

export async function deleteCozyClient(instance: string, client: CozyClient, http: HttpOptions = {}): Promise<void> {
  await requestJson(
    `${instance}/auth/register/${encodeURIComponent(client.clientId)}`,
    { method: 'DELETE', redirect: 'manual', headers: { authorization: `Bearer ${client.registrationToken}` } },
    http,
  );
}

const ContextSchema = z.object({
  data: z.object({ attributes: z.object({ additional_platform_apps: z.array(z.string()).optional() }) }),
});

/** The Twake.ai apps enabled for the organization (mail, chat, space, project…). */
export async function fetchPlatformApps(instance: string, accessToken: string, http: HttpOptions = {}): Promise<string[]> {
  const url = `${instance}/settings/context`;
  const answer = parseAnswer(ContextSchema, await getJson(url, http, { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.api+json' }), url);
  return answer.data.attributes.additional_platform_apps ?? [];
}
