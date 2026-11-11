import { rm } from 'node:fs/promises';
import { saveConfig, type TwakeAiConfig } from './config.js';
import { deleteCozyClient } from './cozy.js';
import { describeError } from './describe.js';
import { COZY_GRANT, COZY_KEYS, matrixGrant, matrixKey, OIDC_GRANT, OIDC_REFRESH_KEY } from './grants.js';
import { withLock } from './lock.js';
import { deleteCachedToken, readCachedToken } from './token-cache.js';
import { logoutDevice } from './matrix.js';
import type { OidcHttp } from './oidc.js';
import { revokeToken } from './oidc.js';
import type { AppPaths } from './paths.js';
import type { Vault } from './vault.js';

export interface LogoutDeps {
  paths: AppPaths;
  config: TwakeAiConfig;
  vault: Vault;
  http: OidcHttp;
}

/**
 * Revokes the Twake session, removes the Drive client, signs every Chat device out, then forgets the secrets and the
 * cached tokens (spec §7.3). Every step is tried even when another one fails.
 */
export async function logout(d: LogoutDeps): Promise<{ done: string[]; failed: string[] }> {
  const { config, vault, http } = d;
  const done: string[] = [];
  const failed: string[] = [];
  const attempt = async (label: string, what: string, step: () => Promise<void>) => {
    try {
      await step();
      done.push(label);
    } catch (error) {
      failed.push(`${what}: ${describeError(error)}`);
    }
  };
  // each authorization is read, revoked and forgotten under its own lock: a server renewing it at that very moment
  // cannot store a new token after it is gone (spec §7.2)
  const underLock = async (grant: string, what: string, step: () => Promise<void>) => {
    try {
      await withLock(d.paths.locksDir, grant, step);
    } catch (error) {
      failed.push(`${what}: ${describeError(error)}`);
    }
  };
  await underLock(OIDC_GRANT, 'Twake session', async () => {
    const refresh = await vault.get(OIDC_REFRESH_KEY);
    if (refresh) await attempt('Twake session revoked', 'Twake session', () => revokeToken(config.environment.oidc, config.oidc, refresh, http));
    await vault.delete(OIDC_REFRESH_KEY).catch(() => undefined);
    await deleteCachedToken(d.paths, OIDC_GRANT);
  });
  await underLock(COZY_GRANT, 'Twake Drive', async () => {
    const instance = config.environment.cozy.instance;
    if (config.drive && instance) {
      const client = { clientId: config.drive.clientId, clientSecret: (await vault.get(COZY_KEYS.clientSecret)) ?? '', registrationToken: (await vault.get(COZY_KEYS.registrationToken)) ?? '' };
      await attempt('Twake Drive access removed', 'Twake Drive', () => deleteCozyClient(instance, client, http));
    }
    for (const key of Object.values(COZY_KEYS)) await vault.delete(key).catch(() => undefined);
    await deleteCachedToken(d.paths, COZY_GRANT);
  });
  for (const agent of Object.keys(config.chat ?? {})) {
    await underLock(matrixGrant(agent), `Twake Chat (${agent})`, async () => {
      // the broker caches each renewed access token; the one kept at login is stale after a few minutes
      const cached = await readCachedToken(d.paths, matrixGrant(agent));
      const tokens = { accessToken: cached?.accessToken ?? (await vault.get(matrixKey(agent, 'access_token'))), refreshToken: await vault.get(matrixKey(agent, 'refresh_token')) };
      await attempt(`Twake Chat device of ${agent} signed out`, `Twake Chat (${agent})`, () => logoutDevice(config.environment.matrix.homeserver, agent, tokens, http));
      for (const key of [matrixKey(agent, 'access_token'), matrixKey(agent, 'refresh_token')]) await vault.delete(key).catch(() => undefined);
      await deleteCachedToken(d.paths, matrixGrant(agent));
    });
  }
  await rm(d.paths.tokensDir, { recursive: true, force: true });
  const { drive: _drive, chat: _chat, ...rest } = config;
  await saveConfig(d.paths, rest);
  return { done, failed };
}
