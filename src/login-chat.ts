import { saveConfig, type TwakeAiConfig } from './config.js';
import { checkAgentId, matrixGrant, matrixKey, NEVER_EXPIRES } from './grants.js';
import { withLock } from './lock.js';
import { LOOPBACK_PORTS, obtainCallback, type CallbackDeps, type CallbackMode } from './loopback.js';
import { loginWithToken, logoutDevice, ssoProvider, ssoRedirectUrl } from './matrix.js';
import { randomState, type OidcHttp } from './oidc.js';
import type { AppPaths } from './paths.js';
import { stopSharedChat } from './shared-chat.js';
import { deleteCachedToken, readCachedToken, writeCachedToken, type CachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export interface ChatLoginDeps extends CallbackDeps {
  paths: AppPaths;
  vault: Vault;
  http: OidcHttp;
  /** stops the agent's shared Chat server, still on the old device (default: by its route) */
  stopShared?: (agent: string) => Promise<unknown>;
}

/**
 * Gives the agent its own Matrix device through single sign-on, and logs the agent's previous device out (spec
 * shared-chat §3.3): the new device and its tokens are written first, so that any client starting from then on lands on
 * it; then the shared server, still on the old device, is stopped; then the old device is signed out. When that server
 * does not stop, the old configuration and tokens are put back and the new device is signed out: nothing changed.
 */
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
  const replaced = previous !== undefined && previous.deviceId !== session.deviceId;
  const keys = { access: matrixKey(agent, 'access_token'), refresh: matrixKey(agent, 'refresh_token') };
  const old = await withLock(deps.paths.locksDir, grant, async () => {
    // the previous device's credentials, read before they are replaced: to log that device out afterwards, or to put
    // them back if its shared server does not stop
    const kept = {
      cached: await readCachedToken(deps.paths, grant),
      access: await deps.vault.get(keys.access),
      refresh: await deps.vault.get(keys.refresh),
    };
    await deps.vault.set(keys.access, session.accessToken);
    if (session.refreshToken) await deps.vault.set(matrixKey(agent, 'refresh_token'), session.refreshToken);
    else await deps.vault.delete(matrixKey(agent, 'refresh_token'));
    await writeCachedToken(deps.paths, grant, { accessToken: session.accessToken, expiresAt: session.expiresAt ?? NEVER_EXPIRES });
    return kept;
  });
  // the new device id right after its token: an MCP server must not get the new token with the old device
  const updated: TwakeAiConfig = { ...config, chat: { ...config.chat, [agent]: { userId: session.userId, deviceId: session.deviceId } } };
  await saveConfig(deps.paths, updated);
  if (!replaced) return updated;
  try {
    await (deps.stopShared ?? ((id: string) => stopSharedChat(id, { paths: deps.paths })))(agent);
  } catch (error) {
    await putBack(config, grant, keys, old, deps);
    await logoutDevice(homeserver, agent, { accessToken: session.accessToken, refreshToken: session.refreshToken }, deps.http).catch(() => undefined);
    throw error;
  }
  // best effort: a device left behind can still be removed from Twake Chat
  await logoutDevice(homeserver, agent, { accessToken: old.cached?.accessToken ?? old.access, refreshToken: old.refresh }, deps.http).catch(() => undefined);
  return updated;
}

/** The configuration and tokens of the old device, as they were before this login. */
async function putBack(
  config: TwakeAiConfig,
  grant: string,
  keys: { access: string; refresh: string },
  old: { cached: CachedToken | undefined; access: string | undefined; refresh: string | undefined },
  deps: ChatLoginDeps,
): Promise<void> {
  await withLock(deps.paths.locksDir, grant, async () => {
    for (const [key, value] of [
      [keys.access, old.access],
      [keys.refresh, old.refresh],
    ] as const) {
      if (value === undefined) await deps.vault.delete(key);
      else await deps.vault.set(key, value);
    }
    if (old.cached) await writeCachedToken(deps.paths, grant, old.cached);
    else await deleteCachedToken(deps.paths, grant);
  });
  await saveConfig(deps.paths, config);
}

