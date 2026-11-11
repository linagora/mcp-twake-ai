import { saveConfig, type TwakeAiConfig } from './config.js';
import { completeFromUserinfo, type TwakeEnvironment } from './discovery.js';
import { TwakeAiError } from './errors.js';
import { withLock } from './lock.js';
import { LOOPBACK_PORTS, waitForCallback } from './loopback.js';
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  fetchUserinfo,
  pollDeviceToken,
  randomState,
  startDeviceAuthorization,
  type OidcClient,
  type OidcHttp,
  type TokenSet,
} from './oidc.js';
import type { AppPaths } from './paths.js';
import { writeCachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export const OIDC_GRANT = 'oidc';
export const OIDC_REFRESH_KEY = 'oidc.refresh_token';

export type LoginMode = 'browser' | 'device';

/** Browser sign-in when a browser can open here; otherwise sign-in from another device (RFC 8628). */
export function chooseLoginMode(o: { noBrowser: boolean; env: NodeJS.ProcessEnv; platform: NodeJS.Platform }): LoginMode {
  if (o.noBrowser || o.env.SSH_CONNECTION || o.env.SSH_TTY) return 'device';
  if (o.platform === 'linux' && !o.env.DISPLAY && !o.env.WAYLAND_DISPLAY) return 'device';
  return 'browser';
}

export interface LoginRequest {
  email: string;
  environment: TwakeEnvironment;
  client: OidcClient;
  mode: LoginMode;
  ports?: number[];
  timeoutMs?: number;
}

export interface LoginDeps {
  paths: AppPaths;
  vault: Vault;
  http: OidcHttp;
  openUrl(url: string): Promise<void>;
  print(line: string): void;
}

/** Signs in once at the IdP, keeps the refresh token in the vault and saves the completed configuration. */
export async function loginOidc(request: LoginRequest, deps: LoginDeps): Promise<TwakeAiConfig> {
  const meta = request.environment.oidc;
  const tokens = request.mode === 'browser' ? await browserLogin(request, deps) : await deviceLogin(request, deps);
  const refreshToken = tokens.refreshToken;
  if (!refreshToken) {
    throw new TwakeAiError(
      'unsupported',
      `${meta.issuer} gave no refresh token: the client "${request.client.clientId}" needs the offline_access scope.`,
    );
  }
  const userinfo = await fetchUserinfo(meta, tokens.accessToken, deps.http);
  await withLock(deps.paths.locksDir, OIDC_GRANT, async () => {
    await deps.vault.set(OIDC_REFRESH_KEY, refreshToken);
    await writeCachedToken(deps.paths, OIDC_GRANT, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
  });
  const config: TwakeAiConfig = {
    version: 1,
    email: request.email.trim(),
    vault: deps.vault.kind === 'keyring' ? 'keyring' : 'file',
    oidc: { clientId: request.client.clientId, scope: request.client.scope },
    environment: completeFromUserinfo(request.environment, userinfo, request.email),
  };
  await saveConfig(deps.paths, config);
  return config;
}

async function browserLogin(request: LoginRequest, deps: LoginDeps): Promise<TokenSet> {
  const pkce = createPkce();
  const state = randomState();
  const { code, redirectUri } = await waitForCallback({
    ports: request.ports ?? LOOPBACK_PORTS,
    state,
    timeoutMs: request.timeoutMs ?? 5 * 60_000,
    onListening: async (redirectUri) => {
      const url = authorizeUrl(request.environment.oidc, request.client, {
        redirectUri,
        state,
        challenge: pkce.challenge,
        loginHint: request.email.trim(),
      });
      deps.print(`Opening your browser to sign in. If it does not open, visit:\n  ${url}`);
      await deps.openUrl(url).catch(() => undefined);
    },
  });
  return exchangeCode(request.environment.oidc, request.client, { code, redirectUri, verifier: pkce.verifier }, deps.http);
}

async function deviceLogin(request: LoginRequest, deps: LoginDeps): Promise<TokenSet> {
  const device = await startDeviceAuthorization(request.environment.oidc, request.client, deps.http);
  deps.print(`To sign in, open ${device.verification_uri} on a phone or a computer and enter the code ${device.user_code}`);
  if (device.verification_uri_complete) deps.print(`(or open ${device.verification_uri_complete} directly)`);
  return pollDeviceToken(request.environment.oidc, request.client, device, deps.http);
}
