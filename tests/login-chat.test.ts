import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type TwakeAiConfig } from '../src/config.js';
import { matrixKey, NEVER_EXPIRES } from '../src/grants.js';
import { loginChat, type ChatLoginDeps } from '../src/login-chat.js';
import { readCachedToken } from '../src/token-cache.js';
import { MemoryVault } from '../src/vault.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';
import { tempPaths } from './helpers/tmp.js';

let synapse: FakeSynapse;
beforeEach(async () => {
  synapse = await startFakeSynapse();
});
afterEach(() => synapse.close());

async function setup(): Promise<{ config: TwakeAiConfig; deps: ChatLoginDeps & { lines: string[] } }> {
  const { paths } = await tempPaths();
  const config: TwakeAiConfig = {
    version: 1,
    email: 'alice@example.com',
    vault: 'file',
    oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
    environment: {
      domain: 'example.com',
      oidc: { issuer: 'https://sso.example.com', authorization_endpoint: 'https://sso.example.com/a', token_endpoint: 'https://sso.example.com/t', userinfo_endpoint: 'https://sso.example.com/u' },
      matrix: { homeserver: synapse.url },
      services: {},
      cozy: {},
    },
  };
  await saveConfig(paths, config);
  const lines: string[] = [];
  return {
    config,
    deps: {
      paths,
      vault: new MemoryVault(),
      http: { now: () => 1000 },
      lines,
      print: (line) => lines.push(line),
      openUrl: async (url) => {
        const atSynapse = await fetch(url, { redirect: 'manual' });
        await fetch(atSynapse.headers.get('location') ?? '');
      },
      readLine: async () => '',
    },
  };
}

describe('loginChat', () => {
  it('creates a device for the agent through the browser and records it', async () => {
    const { config, deps } = await setup();
    const updated = await loginChat(config, 'hermes', 'browser', deps, [0]);
    expect(updated.chat).toEqual({ hermes: { userId: '@alice:example.com', deviceId: 'DEVICE1' } });
    expect(await loadConfig(deps.paths)).toEqual(updated);
    expect(synapse.deviceNames).toEqual({ DEVICE1: 'Twake AI · hermes' });
    expect(await deps.vault.get(matrixKey('hermes', 'refresh_token'))).toMatch(/^syr-/);
    expect(await readCachedToken(deps.paths, 'matrix-hermes')).toEqual({ accessToken: expect.stringMatching(/^syt-/), expiresAt: 1300 });
  });

  it('creates it from another device with the pasted address', async () => {
    const { config, deps } = await setup();
    deps.readLine = async () => {
      const url = /(http:\/\/127\.0\.0\.1:\d+\/_matrix\S+)/.exec(deps.lines.join('\n'))?.[1] ?? '';
      const atSynapse = await fetch(url, { redirect: 'manual' });
      return atSynapse.headers.get('location') ?? '';
    };
    const updated = await loginChat(config, 'claude-code', 'paste', deps, [8765]);
    expect(updated.chat?.['claude-code']?.deviceId).toBe('DEVICE1');
  });

  it('keeps a token without expiry when Synapse gives no refresh token', async () => {
    synapse.refreshableTokens = false;
    const { config, deps } = await setup();
    await loginChat(config, 'hermes', 'browser', deps, [0]);
    expect(await deps.vault.get(matrixKey('hermes', 'refresh_token'))).toBeUndefined();
    expect((await readCachedToken(deps.paths, 'matrix-hermes'))?.expiresAt).toBe(NEVER_EXPIRES);
  });

  it('gives each agent its own device, and logs the previous device of an agent out', async () => {
    const { config, deps } = await setup();
    const withHermes = await loginChat(config, 'hermes', 'browser', deps, [0]);
    const withBoth = await loginChat(withHermes, 'claude-code', 'browser', deps, [0]);
    expect(withBoth.chat).toEqual({
      hermes: { userId: '@alice:example.com', deviceId: 'DEVICE1' },
      'claude-code': { userId: '@alice:example.com', deviceId: 'DEVICE2' },
    });
    const again = await loginChat(withBoth, 'hermes', 'browser', deps, [0]);
    expect(again.chat?.hermes?.deviceId).toBe('DEVICE3');
    expect(synapse.loggedOut).toEqual(['DEVICE1']);
  });

  it('refuses an invalid agent id before anything else', async () => {
    const { config, deps } = await setup();
    await expect(loginChat(config, 'Claude Code', 'browser', deps, [0])).rejects.toMatchObject({ code: 'usage' });
    expect(synapse.deviceNames).toEqual({});
  });
});

describe('loginChat and the shared Chat server', () => {
  it('writes the new device first, then stops the old server, then signs the old device out', async () => {
    const { config, deps } = await setup();
    const first = await loginChat(config, 'hermes', 'browser', deps, [0]);
    const oldRefresh = await deps.vault.get(matrixKey('hermes', 'refresh_token'));
    const seen: { device?: string; refresh?: string; loggedOut: string[] }[] = [];
    deps.stopShared = async (agent) => {
      expect(agent).toBe('hermes');
      seen.push({ device: (await loadConfig(deps.paths))?.chat?.hermes?.deviceId, refresh: await deps.vault.get(matrixKey('hermes', 'refresh_token')), loggedOut: [...synapse.loggedOut] });
    };
    const again = await loginChat(first, 'hermes', 'browser', deps, [0]);
    expect(again.chat?.hermes?.deviceId).toBe('DEVICE2');
    // when the old server is stopped, a client that starts lands on the new device; the old one is still signed in
    expect(seen).toEqual([{ device: 'DEVICE2', refresh: expect.not.stringMatching(oldRefresh!), loggedOut: [] }]);
    expect(synapse.loggedOut).toEqual(['DEVICE1']);
  });

  it('puts everything back and signs the new device out when the old server does not stop', async () => {
    const { config, deps } = await setup();
    const first = await loginChat(config, 'hermes', 'browser', deps, [0]);
    const before = {
      config: await loadConfig(deps.paths),
      access: await deps.vault.get(matrixKey('hermes', 'access_token')),
      refresh: await deps.vault.get(matrixKey('hermes', 'refresh_token')),
      cached: await readCachedToken(deps.paths, 'matrix-hermes'),
    };
    deps.stopShared = async () => {
      throw new Error('the shared Chat server (pid 4242) does not answer');
    };
    await expect(loginChat(first, 'hermes', 'browser', deps, [0])).rejects.toThrow(/pid 4242/);
    expect(await loadConfig(deps.paths)).toEqual(before.config);
    expect(await deps.vault.get(matrixKey('hermes', 'access_token'))).toBe(before.access);
    expect(await deps.vault.get(matrixKey('hermes', 'refresh_token'))).toBe(before.refresh);
    expect(await readCachedToken(deps.paths, 'matrix-hermes')).toEqual(before.cached);
    // nothing changed: the new device is signed out, the old one kept
    expect(synapse.loggedOut).toEqual(['DEVICE2']);
  });

  it('stops nothing for a first device', async () => {
    const { config, deps } = await setup();
    let stops = 0;
    deps.stopShared = async () => void stops++;
    await loginChat(config, 'hermes', 'browser', deps, [0]);
    expect(stops).toBe(0);
  });
});

describe('loginChat after the review', () => {
  it('logs the previous device out even when its access token has expired', async () => {
    const { config, deps } = await setup();
    const first = await loginChat(config, 'hermes', 'browser', deps, [0]);
    synapse.expireIssuedAccessTokens();
    const again = await loginChat(first, 'hermes', 'browser', deps, [0]);
    expect(again.chat?.hermes?.deviceId).toBe('DEVICE2');
    expect(synapse.loggedOut).toEqual(['DEVICE1']);
  });
});
