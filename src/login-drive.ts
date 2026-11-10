import { saveConfig, type TwakeAiConfig } from './config.js';
import {
  cozyAuthorizeUrl,
  exchangeCozyCode,
  exchangeOidcForCozy,
  fetchPlatformApps,
  oidcExchangeEnabled,
  registerCozyClient,
  type CozyClient,
} from './cozy.js';
import { TwakeAiError } from './errors.js';
import { COZY_GRANT, COZY_KEYS } from './grants.js';
import { requireSecureUrl } from './http.js';
import { withLock } from './lock.js';
import { LOOPBACK_PORTS, obtainCallback, type CallbackDeps, type CallbackMode } from './loopback.js';
import { createPkce, randomState, type OidcHttp, type TokenSet } from './oidc.js';
import type { AppPaths } from './paths.js';
import { writeCachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export interface DriveLoginDeps extends CallbackDeps {
  paths: AppPaths;
  vault: Vault;
  http: OidcHttp;
  /** a current IdP access token, for instances that accept it (allow_oauth_token) */
  oidcToken(): Promise<string>;
}

/** Connects Twake Drive: an OAuth client on the instance, then its tokens (IdP token exchange, or browser sign-in). */
export async function loginDrive(
  config: TwakeAiConfig,
  mode: CallbackMode,
  deps: DriveLoginDeps,
  ports: number[] = LOOPBACK_PORTS,
  options: { timeoutMs?: number } = {},
): Promise<TwakeAiConfig> {
  const instance = config.environment.cozy.instance;
  if (!instance) {
    throw new TwakeAiError('unsupported', 'Your identity provider did not say which Twake Drive instance is yours (workplaceFqdn): Twake Drive cannot be connected.');
  }
  requireSecureUrl(instance, 'The Twake Drive instance');
  const { client, config: registered } = await ensureClient(config, instance, ports, deps);
  const tokens = (await oidcExchangeEnabled(instance, deps.http))
    ? await exchangeOidcForCozy(instance, client, await deps.oidcToken(), deps.http)
    : await authorize(instance, client, mode, ports, options.timeoutMs ?? 5 * 60_000, deps);
  const refreshToken = tokens.refreshToken;
  if (!refreshToken) throw new TwakeAiError('unsupported', `${instance} gave no refresh token: Twake Drive cannot stay connected.`);
  await withLock(deps.paths.locksDir, COZY_GRANT, async () => {
    await deps.vault.set(COZY_KEYS.refreshToken, refreshToken);
    await writeCachedToken(deps.paths, COZY_GRANT, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
  });
  const apps = await fetchPlatformApps(instance, tokens.accessToken, deps.http);
  const updated: TwakeAiConfig = { ...registered, drive: { clientId: client.clientId, apps } };
  await saveConfig(deps.paths, updated);
  return updated;
}

/** Reuses the registered client; registers one, and records it at once, so a later attempt does not register another. */
async function ensureClient(
  config: TwakeAiConfig,
  instance: string,
  ports: number[],
  deps: DriveLoginDeps,
): Promise<{ client: CozyClient; config: TwakeAiConfig }> {
  const [clientSecret, registrationToken] = await Promise.all([deps.vault.get(COZY_KEYS.clientSecret), deps.vault.get(COZY_KEYS.registrationToken)]);
  if (config.drive && clientSecret && registrationToken) {
    return { client: { clientId: config.drive.clientId, clientSecret, registrationToken }, config };
  }
  const client = await registerCozyClient(instance, ports.map((port) => `http://127.0.0.1:${port}/callback`), deps.http);
  await deps.vault.set(COZY_KEYS.clientSecret, client.clientSecret);
  await deps.vault.set(COZY_KEYS.registrationToken, client.registrationToken);
  const registered: TwakeAiConfig = { ...config, drive: { clientId: client.clientId, apps: config.drive?.apps ?? [] } };
  await saveConfig(deps.paths, registered);
  return { client, config: registered };
}

async function authorize(
  instance: string,
  client: CozyClient,
  mode: CallbackMode,
  ports: number[],
  timeoutMs: number,
  deps: DriveLoginDeps,
): Promise<TokenSet> {
  const pkce = createPkce();
  const state = randomState();
  const { code } = await obtainCallback(
    {
      mode,
      ports,
      state,
      timeoutMs,
      param: 'code',
      what: 'Twake Drive',
      url: (redirectUri) => cozyAuthorizeUrl(instance, { clientId: client.clientId, redirectUri, state, challenge: pkce.challenge }),
    },
    deps,
  );
  return exchangeCozyCode(instance, client, { code, verifier: pkce.verifier }, deps.http);
}
