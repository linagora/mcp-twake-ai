import { z } from 'zod';
import { TwakeAiError } from './errors.js';
import { getJson, HttpError, parseAnswer, postJson, requestJson, type HttpOptions } from './http.js';
import { isSafeDeviceId } from './grants.js';
import type { OidcHttp } from './oidc.js';

const nowS = () => Math.floor(Date.now() / 1000);
const base = (homeserver: string) => homeserver.replace(/\/+$/, '');

const FlowsSchema = z.object({
  flows: z.array(z.object({ type: z.string(), identity_providers: z.array(z.object({ id: z.string() })).optional() })),
});

/** The identity provider of the homeserver's single sign-on (Twake Chat: `oidc-twake`). */
export async function ssoProvider(homeserver: string, http: HttpOptions = {}): Promise<string | undefined> {
  const url = `${base(homeserver)}/_matrix/client/v3/login`;
  const sso = parseAnswer(FlowsSchema, await getJson(url, http), url).flows.find((flow) => flow.type === 'm.login.sso');
  if (!sso) throw new TwakeAiError('unsupported', `${homeserver} does not offer single sign-on: Twake Chat cannot be connected.`);
  return sso.identity_providers?.[0]?.id;
}

export function ssoRedirectUrl(homeserver: string, idp: string | undefined, redirectUrl: string): string {
  const path = idp ? `/_matrix/client/v3/login/sso/redirect/${encodeURIComponent(idp)}` : '/_matrix/client/v3/login/sso/redirect';
  const url = new URL(`${base(homeserver)}${path}`);
  url.searchParams.set('redirectUrl', redirectUrl);
  return url.toString();
}

export interface MatrixSession {
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken?: string;
  /** epoch seconds; undefined: the token does not expire */
  expiresAt?: number;
}

const LoginSchema = z.object({
  user_id: z.string(),
  device_id: z.string().refine(isSafeDeviceId, 'not a usable device id'),
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in_ms: z.number().nullish(),
});

/** Creates the agent's own device: the end-to-end encryption store of mcp-twake-chat is bound to it. */
export async function loginWithToken(homeserver: string, loginToken: string, deviceName: string, http: OidcHttp = {}): Promise<MatrixSession> {
  const url = `${base(homeserver)}/_matrix/client/v3/login`;
  const body = { type: 'm.login.token', token: loginToken, refresh_token: true, initial_device_display_name: deviceName };
  let raw: unknown;
  try {
    raw = await postJson(url, body, http);
  } catch (error) {
    // Synapse login tokens are single use and last 2 minutes
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new TwakeAiError('login_cancelled', 'The Twake Chat sign-in took too long or was already used: start the connection again.');
    }
    throw error;
  }
  const answer = parseAnswer(LoginSchema, raw, url);
  const now = (http.now ?? nowS)();
  return {
    userId: answer.user_id,
    deviceId: answer.device_id,
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? undefined,
    expiresAt: answer.expires_in_ms ? now + Math.floor(answer.expires_in_ms / 1000) : undefined,
  };
}

const RefreshSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in_ms: z.number().nullish(),
});

export async function refreshMatrix(
  homeserver: string,
  refreshToken: string,
  agent: string,
  http: OidcHttp = {},
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const url = `${base(homeserver)}/_matrix/client/v3/refresh`;
  let raw: unknown;
  try {
    raw = await postJson(url, { refresh_token: refreshToken }, http);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new TwakeAiError('login_required', `The Twake Chat session of ${agent} has expired: run \`mcp-twake-ai login --chat --agent ${agent}\`.`);
    }
    throw error;
  }
  const answer = parseAnswer(RefreshSchema, raw, url);
  const now = (http.now ?? nowS)();
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? undefined,
    expiresAt: answer.expires_in_ms ? now + Math.floor(answer.expires_in_ms / 1000) : undefined,
  };
}

export async function logoutMatrix(homeserver: string, accessToken: string, http: HttpOptions = {}): Promise<void> {
  await requestJson(
    `${base(homeserver)}/_matrix/client/v3/logout`,
    { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: '{}' },
    http,
  );
}

/** Signs one device out, renewing its access token first if it has expired; throws when the device stays signed in. */
export async function logoutDevice(homeserver: string, agent: string, tokens: { accessToken?: string; refreshToken?: string }, http: OidcHttp = {}): Promise<void> {
  if (tokens.accessToken) {
    try {
      await logoutMatrix(homeserver, tokens.accessToken, http);
      return;
    } catch (error) {
      if (!tokens.refreshToken) throw error;
    }
  }
  if (!tokens.refreshToken) throw new TwakeAiError('login_required', `No Twake Chat session is kept for ${agent}.`);
  const renewed = await refreshMatrix(homeserver, tokens.refreshToken, agent, http);
  await logoutMatrix(homeserver, renewed.accessToken, http);
}
