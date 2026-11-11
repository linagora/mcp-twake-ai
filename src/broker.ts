import type { TwakeAiConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { withLock } from './lock.js';
import { OIDC_GRANT, OIDC_REFRESH_KEY } from './login.js';
import { refreshTokens, type OidcHttp } from './oidc.js';
import type { AppPaths } from './paths.js';
import { readCachedToken, writeCachedToken, type CachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export const SERVICE_IDS = ['mail', 'dav', 'drive', 'chat', 'space', 'project'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export function isServiceId(value: string): value is ServiceId {
  return (SERVICE_IDS as readonly string[]).includes(value);
}

/** A token handed to an MCP server stays valid at least this long. */
export const EXPIRY_MARGIN_S = 60;

/** What `twake-ai token` prints: the format every Twake.ai MCP server reads from *_TOKEN_COMMAND. */
export interface TokenOutput {
  access_token: string;
  expires_at: number;
}

export interface BrokerDeps {
  paths: AppPaths;
  config: TwakeAiConfig;
  vault: Vault;
  http: OidcHttp;
  /** epoch seconds */
  now(): number;
}

export async function getToken(service: ServiceId, deps: BrokerDeps): Promise<TokenOutput> {
  if (service === 'drive' || service === 'chat') {
    throw new TwakeAiError('unsupported', `This version of twake-ai does not serve ${service} tokens yet.`);
  }
  const token = await oidcAccessToken(deps);
  return { access_token: token.accessToken, expires_at: token.expiresAt };
}

/** Mail, calendar, Space and Project share one access token: the twake-ai-agents client carries their four audiences. */
async function oidcAccessToken(d: BrokerDeps): Promise<CachedToken> {
  const fresh = (token: CachedToken | undefined): token is CachedToken => token !== undefined && token.expiresAt - EXPIRY_MARGIN_S > d.now();
  const cached = await readCachedToken(d.paths, OIDC_GRANT);
  if (fresh(cached)) return cached;
  return withLock(d.paths.locksDir, OIDC_GRANT, async () => {
    // another process may have refreshed while we waited for the lock
    const again = await readCachedToken(d.paths, OIDC_GRANT);
    if (fresh(again)) return again;
    const refreshToken = await d.vault.get(OIDC_REFRESH_KEY);
    if (!refreshToken) throw new TwakeAiError('login_required', 'No Twake session on this computer: run `twake-ai login`.');
    const tokens = await refreshTokens(d.config.environment.oidc, d.config.oidc, refreshToken, { ...d.http, now: d.now });
    // the new refresh token first: once the IdP has rotated it, the old one is spent
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) await d.vault.set(OIDC_REFRESH_KEY, tokens.refreshToken);
    const token = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
    await writeCachedToken(d.paths, OIDC_GRANT, token);
    return token;
  });
}
