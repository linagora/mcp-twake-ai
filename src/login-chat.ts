import { saveConfig, type TwakeAiConfig } from './config.js';
import { checkAgentId, matrixGrant, matrixKey, NEVER_EXPIRES } from './grants.js';
import { withLock } from './lock.js';
import { LOOPBACK_PORTS, obtainCallback, type CallbackDeps, type CallbackMode } from './loopback.js';
import { loginWithToken, logoutMatrix, ssoProvider, ssoRedirectUrl } from './matrix.js';
import { randomState, type OidcHttp } from './oidc.js';
import type { AppPaths } from './paths.js';
import { readCachedToken, writeCachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export interface ChatLoginDeps extends CallbackDeps {
  paths: AppPaths;
  vault: Vault;
  http: OidcHttp;
}

/** Gives the agent its own Matrix device through single sign-on, and logs the agent's previous device out. */
export async function loginChat(
  config: TwakeAiConfig,
  agent: string,
  mode: CallbackMode,
  deps: ChatLoginDeps,
  ports: number[] = LOOPBACK_PORTS,
): Promise<TwakeAiConfig> {
  const grant = matrixGrant(checkAgentId(agent));
  const homeserver = config.environment.matrix.homeserver;
  const idp = await ssoProvider(homeserver, deps.http);
  const state = randomState();
  const { code: loginToken } = await obtainCallback(
    {
      mode,
      ports,
      state,
      timeoutMs: 5 * 60_000,
      param: 'loginToken',
      what: `Twake Chat for ${agent}`,
      url: (redirectUri) => ssoRedirectUrl(homeserver, idp, `${redirectUri}?state=${encodeURIComponent(state)}`),
    },
    deps,
  );
  const session = await loginWithToken(homeserver, loginToken, `Twake AI · ${agent}`, deps.http);
  const previous = config.chat?.[agent];
  await withLock(deps.paths.locksDir, grant, async () => {
    const previousToken = previous ? ((await readCachedToken(deps.paths, grant))?.accessToken ?? (await deps.vault.get(matrixKey(agent, 'access_token')))) : undefined;
    await deps.vault.set(matrixKey(agent, 'access_token'), session.accessToken);
    if (session.refreshToken) await deps.vault.set(matrixKey(agent, 'refresh_token'), session.refreshToken);
    else await deps.vault.delete(matrixKey(agent, 'refresh_token'));
    await writeCachedToken(deps.paths, grant, { accessToken: session.accessToken, expiresAt: session.expiresAt ?? NEVER_EXPIRES });
    // best effort: an old device left behind only clutters the session list
    if (previousToken && previous?.deviceId !== session.deviceId) await logoutMatrix(homeserver, previousToken, deps.http).catch(() => undefined);
  });
  const updated: TwakeAiConfig = { ...config, chat: { ...config.chat, [agent]: { userId: session.userId, deviceId: session.deviceId } } };
  await saveConfig(deps.paths, updated);
  return updated;
}
