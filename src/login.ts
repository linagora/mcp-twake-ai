import { loadConfig, saveConfig, type TwakeAiConfig } from './config.js';
import { completeFromUserinfo, type Endpoint, type TwakeEnvironment } from './discovery.js';
import { TwakeAiError } from './errors.js';
import { COZY_GRANT, matrixGrant, OIDC_GRANT, OIDC_REFRESH_KEY } from './grants.js';
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
import { deleteCachedToken, writeCachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export { OIDC_GRANT, OIDC_REFRESH_KEY };

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
  /** The calendar server that takes the Twake session (chooseDav); left as discovered without it. */
  findDav?(environment: TwakeEnvironment, accessToken: string): Promise<Endpoint | undefined>;
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
  const previous = await loadConfig(deps.paths).catch(() => undefined);
  const vault = deps.vault.kind === 'keyring' ? 'keyring' : 'file';
  let environment = completeFromUserinfo(request.environment, userinfo, request.email);
  if (deps.findDav) {
    const found = environment.services.dav;
    const dav = await deps.findDav(environment, tokens.accessToken);
    if (dav && dav.url !== found?.url) deps.print(`Twake Calendar: ${dav.url}`);
    if (dav) environment = { ...environment, services: { ...environment.services, dav } };
    else if (found) deps.print(`✗ Twake Calendar: ${found.url} does not take your Twake session, the calendar may not work.`);
  }
  let drive: TwakeAiConfig['drive'];
  let chat: TwakeAiConfig['chat'];
  if (previous) {
    // Drive and Chat stay connected only for the same account, whose secrets are in the same vault, on the same servers
    const sameAccount =
      previous.email.trim().toLowerCase() === request.email.trim().toLowerCase() && previous.vault === vault && previous.environment.domain === environment.domain;
    drive = sameAccount && previous.environment.cozy.instance === environment.cozy.instance ? previous.drive : undefined;
    chat = sameAccount && previous.environment.matrix.homeserver === environment.matrix.homeserver ? previous.chat : undefined;
    // a dropped connection's cached tokens must not be served to the new account
    if (previous.drive && !drive) await deleteCachedToken(deps.paths, COZY_GRANT);
    for (const agent of previous.chat && !chat ? Object.keys(previous.chat) : []) await deleteCachedToken(deps.paths, matrixGrant(agent));
  }
  const config: TwakeAiConfig = {
    version: 1,
    email: request.email.trim(),
    vault,
    oidc: { clientId: request.client.clientId, scope: request.client.scope },
    environment,
    drive,
    chat,
    // the entries written into the agents start the launcher, whatever the account: they stay ours
    agents: previous?.agents,
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
