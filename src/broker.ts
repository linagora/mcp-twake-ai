import type { TwakeAiConfig } from './config.js';
import { refreshCozy } from './cozy.js';
import { TwakeAiError } from './errors.js';
import { COZY_GRANT, COZY_KEYS, matrixGrant, matrixKey, NEVER_EXPIRES, OIDC_GRANT, OIDC_REFRESH_KEY } from './grants.js';
import { withLock } from './lock.js';
import { refreshMatrix } from './matrix.js';
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

/** An MCP server asks again at least every hour, so a long-lived token that was revoked is noticed. */
export const MAX_ADVERTISED_TTL_S = 3600;

/** What `mcp-twake-ai token` prints: the format every Twake.ai MCP server reads from *_TOKEN_COMMAND. */
export interface TokenOutput {
  access_token: string;
  expires_at: number;
  /** Twake Chat only: the device the encryption store is bound to */
  device_id?: string;
  user_id?: string;
}

export interface BrokerDeps {
  paths: AppPaths;
  config: TwakeAiConfig;
  vault: Vault;
  http: OidcHttp;
  /** epoch seconds */
  now(): number;
}

export async function getToken(service: ServiceId, deps: BrokerDeps, agent?: string): Promise<TokenOutput> {
  if (service === 'drive') return advertise(await cozyAccessToken(deps), deps);
  if (service === 'chat') {
    if (agent === undefined) throw new TwakeAiError('usage', 'A Twake Chat token belongs to an agent: run `mcp-twake-ai token chat --agent <id>`.');
    const grant = matrixGrant(agent);
    const device = deps.config.chat?.[agent];
    if (!device) throw new TwakeAiError('login_required', `Twake Chat is not connected for ${agent}: run \`mcp-twake-ai login --chat --agent ${agent}\`.`);
    return { ...advertise(await matrixAccessToken(agent, grant, deps), deps), device_id: device.deviceId, user_id: device.userId };
  }
  return advertise(await oidcAccessToken(deps), deps);
}

function advertise(token: CachedToken, d: BrokerDeps): TokenOutput {
  return { access_token: token.accessToken, expires_at: Math.min(token.expiresAt, d.now() + MAX_ADVERTISED_TTL_S) };
}

/** The cached token of a grant, or one renewal shared by every process waiting on the grant's lock. */
async function cachedOrRenewed(d: BrokerDeps, grant: string, renew: () => Promise<CachedToken>): Promise<CachedToken> {
  const fresh = (token: CachedToken | undefined): token is CachedToken => token !== undefined && token.expiresAt - EXPIRY_MARGIN_S > d.now();
  const cached = await readCachedToken(d.paths, grant);
  if (fresh(cached)) return cached;
  return withLock(d.paths.locksDir, grant, async () => {
    // another process may have renewed while we waited for the lock
    const again = await readCachedToken(d.paths, grant);
    if (fresh(again)) return again;
    const token = await renew();
    await writeCachedToken(d.paths, grant, token);
    return token;
  });
}

/** Mail, calendar, Space and Project share one access token: the twake-ai-agents client carries their four audiences. */
function oidcAccessToken(d: BrokerDeps): Promise<CachedToken> {
  return cachedOrRenewed(d, OIDC_GRANT, async () => {
    const refreshToken = await d.vault.get(OIDC_REFRESH_KEY);
    if (!refreshToken) throw new TwakeAiError('login_required', 'No Twake session on this computer: run `mcp-twake-ai login`.');
    const tokens = await refreshTokens(d.config.environment.oidc, d.config.oidc, refreshToken, { ...d.http, now: d.now });
    // the new refresh token first: once the IdP has rotated it, the old one is spent
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) await d.vault.set(OIDC_REFRESH_KEY, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  });
}

function cozyAccessToken(d: BrokerDeps): Promise<CachedToken> {
  const instance = d.config.environment.cozy.instance;
  const drive = d.config.drive;
  const notConnected = new TwakeAiError('login_required', 'Twake Drive is not connected on this computer: run `mcp-twake-ai login --drive`.');
  if (!instance || !drive) return Promise.reject(notConnected);
  return cachedOrRenewed(d, COZY_GRANT, async () => {
    const [clientSecret, registrationToken, refreshToken] = await Promise.all([
      d.vault.get(COZY_KEYS.clientSecret),
      d.vault.get(COZY_KEYS.registrationToken),
      d.vault.get(COZY_KEYS.refreshToken),
    ]);
    if (!clientSecret || !refreshToken) throw notConnected;
    const client = { clientId: drive.clientId, clientSecret, registrationToken: registrationToken ?? '' };
    const tokens = await refreshCozy(instance, client, refreshToken, { ...d.http, now: d.now });
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) await d.vault.set(COZY_KEYS.refreshToken, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  });
}

function matrixAccessToken(agent: string, grant: string, d: BrokerDeps): Promise<CachedToken> {
  return cachedOrRenewed(d, grant, async () => {
    const refreshToken = await d.vault.get(matrixKey(agent, 'refresh_token'));
    if (refreshToken) {
      const renewed = await refreshMatrix(d.config.environment.matrix.homeserver, refreshToken, agent, { ...d.http, now: d.now });
      if (renewed.refreshToken && renewed.refreshToken !== refreshToken) await d.vault.set(matrixKey(agent, 'refresh_token'), renewed.refreshToken);
      return { accessToken: renewed.accessToken, expiresAt: renewed.expiresAt ?? NEVER_EXPIRES };
    }
    const accessToken = await d.vault.get(matrixKey(agent, 'access_token'));
    if (!accessToken) throw new TwakeAiError('login_required', `Twake Chat is not connected for ${agent}: run \`mcp-twake-ai login --chat --agent ${agent}\`.`);
    return { accessToken, expiresAt: NEVER_EXPIRES };
  });
}
