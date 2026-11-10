import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type TwakeAiConfig } from '../src/config.js';
import { deleteCozyClient } from '../src/cozy.js';
import { COZY_KEYS } from '../src/grants.js';
import { loginDrive, type DriveLoginDeps } from '../src/login-drive.js';
import { readCachedToken } from '../src/token-cache.js';
import { MemoryVault } from '../src/vault.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';
import { tempPaths } from './helpers/tmp.js';

let cozy: FakeCozy;
beforeEach(async () => {
  cozy = await startFakeCozy();
});
afterEach(() => cozy.close());

async function setup(): Promise<{ config: TwakeAiConfig; deps: DriveLoginDeps & { lines: string[] } }> {
  const { paths } = await tempPaths();
  const config: TwakeAiConfig = {
    version: 1,
    email: 'alice@example.com',
    vault: 'file',
    oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
    environment: {
      domain: 'example.com',
      oidc: { issuer: 'https://sso.example.com', authorization_endpoint: 'https://sso.example.com/a', token_endpoint: 'https://sso.example.com/t', userinfo_endpoint: 'https://sso.example.com/u' },
      matrix: { homeserver: 'https://matrix.example.com/' },
      services: {},
      cozy: { instance: cozy.url },
    },
  };
  await saveConfig(paths, config);
  const lines: string[] = [];
  return {
    config,
    deps: {
      paths,
      vault: new MemoryVault(),
      http: {},
      lines,
      print: (line) => lines.push(line),
      // the browser: cozy-stack redirects at once to the loopback
      openUrl: async (url) => {
        const atCozy = await fetch(url, { redirect: 'manual' });
        await fetch(atCozy.headers.get('location') ?? '');
      },
      readLine: async () => '',
      oidcToken: async () => 'idp-access',
    },
  };
}

describe('loginDrive', () => {
  it('registers a client, signs in through the browser and records the apps of the organization', async () => {
    const { config, deps } = await setup();
    const updated = await loginDrive(config, 'browser', deps, [0]);
    expect(updated.drive).toEqual({ clientId: expect.stringMatching(/^client-/), apps: ['mail', 'chat', 'space', 'project'] });
    expect(await loadConfig(deps.paths)).toEqual(updated);
    expect(await deps.vault.get(COZY_KEYS.clientSecret)).toMatch(/^secret-/);
    expect(await deps.vault.get(COZY_KEYS.registrationToken)).toMatch(/^registration-/);
    expect(await deps.vault.get(COZY_KEYS.refreshToken)).toMatch(/^cozy-refresh/);
    expect(await readCachedToken(deps.paths, 'cozy')).toEqual({ accessToken: expect.stringMatching(/^cozy-access/), expiresAt: 4_000_000_000 });
  });

  it('signs in from another device with the pasted address', async () => {
    const { config, deps } = await setup();
    deps.readLine = async () => {
      const url = /(http:\/\/127\.0\.0\.1:\d+\/auth\/authorize\S+)/.exec(deps.lines.join('\n'))?.[1] ?? '';
      const atCozy = await fetch(url, { redirect: 'manual' });
      return atCozy.headers.get('location') ?? '';
    };
    const updated = await loginDrive(config, 'paste', deps, [8765]);
    expect(updated.drive?.clientId).toMatch(/^client-/);
  });

  it('does not register another client when the first authorization was abandoned', async () => {
    const { config, deps } = await setup();
    deps.openUrl = async () => undefined;
    await expect(loginDrive(config, 'browser', deps, [0], { timeoutMs: 200 })).rejects.toMatchObject({ code: 'login_cancelled' });
    const afterAbandon = (await loadConfig(deps.paths))!;
    deps.openUrl = async (url) => {
      const atCozy = await fetch(url, { redirect: 'manual' });
      await fetch(atCozy.headers.get('location') ?? '');
    };
    await loginDrive(afterAbandon, 'browser', deps, [0]);
    expect(cozy.registrations).toBe(1);
  }, 15_000);

  it('exchanges the IdP token without any browser when the instance allows it', async () => {
    cozy.oidcExchange = true;
    const { config, deps } = await setup();
    deps.openUrl = async () => {
      throw new Error('no browser expected');
    };
    const updated = await loginDrive(config, 'paste', deps, [8765]);
    expect(updated.drive?.apps).toEqual(['mail', 'chat', 'space', 'project']);
    expect(cozy.oidcTokens).toEqual(['idp-access']);
    expect(deps.lines).toEqual([]);
  });

  it('says so when the identity provider gave no Drive instance', async () => {
    const { config, deps } = await setup();
    const withoutInstance = { ...config, environment: { ...config.environment, cozy: {} } };
    await expect(loginDrive(withoutInstance, 'browser', deps, [0])).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('loginDrive after the review', () => {
  it('registers a new client when "Twake AI" was removed from the connected devices', async () => {
    const { config, deps } = await setup();
    const first = await loginDrive(config, 'browser', deps, [0]);
    const clientSecret = (await deps.vault.get(COZY_KEYS.clientSecret)) ?? '';
    const registrationToken = (await deps.vault.get(COZY_KEYS.registrationToken)) ?? '';
    await deleteCozyClient(cozy.url, { clientId: first.drive?.clientId ?? '', clientSecret, registrationToken });
    const again = await loginDrive(first, 'browser', deps, [0]);
    expect(again.drive?.clientId).not.toBe(first.drive?.clientId);
    expect(cozy.registrations).toBe(2);
  });

  it('falls back to the browser when the IdP token exchange fails', async () => {
    cozy.oidcExchange = true;
    cozy.oidcExchangeFails = true;
    const { config, deps } = await setup();
    const updated = await loginDrive(config, 'browser', deps, [0]);
    expect(updated.drive?.clientId).toMatch(/^client-/);
  });
});
