import { saveConfig, type TwakeAiConfig } from './config.js';
import { checkAgentId, matrixGrant, matrixKey, NEVER_EXPIRES } from './grants.js';
import { withLock } from './lock.js';
import { LOOPBACK_PORTS, obtainCallback, type CallbackDeps, type CallbackMode } from './loopback.js';
import { loginWithToken, logoutDevice, ssoProvider, ssoRedirectUrl } from './matrix.js';
import { randomState, type OidcHttp } from './oidc.js';
import type { AppPaths } from './paths.js';
import { withSharedStopped } from './shared.js';
import { readCachedToken, writeCachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export interface ChatLoginDeps extends CallbackDeps {
  paths: AppPaths;
  vault: Vault;
  http: OidcHttp;
  /** how long the agent's shared server is asked again when it does not answer, before the login gives up */
  busyMs?: number;
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
  // the agent's shared server goes first, and none starts before the new device is recorded: it would sync the old
  // device's store with the new device's token
  let swapping = false;
  const swapped = withSharedStopped(deps.paths, 'chat', agent, async () => {
    swapping = true;
    const old = await withLock(deps.paths.locksDir, grant, async () => {
      // the previous device's credentials, read before they are replaced, to log that device out afterwards
      const oldDevice =
        previous && previous.deviceId !== session.deviceId
          ? {
              accessToken: (await readCachedToken(deps.paths, grant))?.accessToken ?? (await deps.vault.get(matrixKey(agent, 'access_token'))),
              refreshToken: await deps.vault.get(matrixKey(agent, 'refresh_token')),
            }
          : undefined;
      await deps.vault.set(matrixKey(agent, 'access_token'), session.accessToken);
      if (session.refreshToken) await deps.vault.set(matrixKey(agent, 'refresh_token'), session.refreshToken);
      else await deps.vault.delete(matrixKey(agent, 'refresh_token'));
      await writeCachedToken(deps.paths, grant, { accessToken: session.accessToken, expiresAt: session.expiresAt ?? NEVER_EXPIRES });
      return oldDevice;
    });
    // the new device id right after its token: an MCP server must not get the new token with the old device
    const updated: TwakeAiConfig = { ...config, chat: { ...config.chat, [agent]: { userId: session.userId, deviceId: session.deviceId } } };
    await saveConfig(deps.paths, updated);
    return { old, updated };
  }, { busyMs: deps.busyMs });
  const { old, updated } = await swapped.catch(async (error: unknown) => {
    // the server could not be stopped, so nothing was swapped: the device just created would stay in the account, one
    // more at every try, with nothing that knows of it (best effort: Twake Chat lists it otherwise)
    if (!swapping) await logoutDevice(homeserver, agent, { accessToken: session.accessToken, refreshToken: session.refreshToken }, deps.http).catch(() => undefined);
    throw error;
  });
  // best effort: a device left behind can still be removed from Twake Chat
  if (old) await logoutDevice(homeserver, agent, old, deps.http).catch(() => undefined);
  return updated;
}

