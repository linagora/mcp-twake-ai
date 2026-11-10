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
