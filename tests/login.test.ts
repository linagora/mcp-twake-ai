import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { TwakeEnvironment } from '../src/discovery.js';
import { chooseLoginMode, loginOidc, OIDC_REFRESH_KEY, type LoginDeps } from '../src/login.js';
import { fetchOidcMetadata } from '../src/oidc.js';
import { readCachedToken } from '../src/token-cache.js';
import { MemoryVault } from '../src/vault.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';
import { tempPaths } from './helpers/tmp.js';
import { saveConfig } from '../src/config.js';

let idp: FakeIdp;
let environment: TwakeEnvironment;

beforeEach(async () => {
  idp = await startFakeIdp();
  environment = {
    domain: 'example.com',
    oidc: await fetchOidcMetadata(idp.url),
    matrix: { homeserver: 'https://matrix.example.com/' },
    services: {},
    cozy: { pattern: 'https://{username}.twake.example.com' },
  };
});
afterEach(() => idp.close());

const client = { clientId: 'twake-ai-agents', scope: 'openid email offline_access workplaceFqdn' };

/** Plays the browser: the IdP redirects at once to the loopback callback. */
async function browser(url: string): Promise<void> {
  const atIdp = await fetch(url, { redirect: 'manual' });
  await fetch(atIdp.headers.get('location') ?? '');
}

async function deps(overrides: Partial<LoginDeps> = {}): Promise<LoginDeps & { lines: string[] }> {
  const { paths } = await tempPaths();
  const lines: string[] = [];
  let t = 1_000_000;
  return {
    paths,
    vault: new MemoryVault(),
    http: { now: () => t, sleep: async (ms) => void (t += ms / 1000) },
    openUrl: browser,
    print: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

describe('loginOidc', () => {
  it('signs in through the browser, keeps the refresh token and saves the completed configuration', async () => {
    const d = await deps();
    const config = await loginOidc({ email: ' alice@example.com ', environment, client, mode: 'browser', ports: [0] }, d);
    expect(config).toMatchObject({
      version: 1,
      email: 'alice@example.com',
      oidc: client,
      environment: { cozy: { instance: 'https://alice.twake.example.com' } },
    });
    expect(await loadConfig(d.paths)).toEqual(config);
    expect(await d.vault.get(OIDC_REFRESH_KEY)).toMatch(/^refresh-/);
    expect(await readCachedToken(d.paths, 'oidc')).toEqual({ accessToken: expect.stringMatching(/^access-/), expiresAt: 1_000_300 });
    expect(d.lines.join('\n')).toContain(`${idp.url}/authorize?`);
  });

  it('still prints the URL to open when the browser cannot be opened', async () => {
    const d = await deps({
      openUrl: async () => {
        throw new Error('no browser');
      },
    });
    const login = loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0], timeoutMs: 2_000 }, d);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const url = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/.exec(d.lines.join('\n'))?.[1];
    expect(url).toBeDefined();
    await browser(url!);
    await expect(login).resolves.toMatchObject({ email: 'alice@example.com' });
  });

  it('signs in from another device and shows the code to enter', async () => {
    const d = await deps();
    const config = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'device' }, d);
    expect(config.environment.cozy.instance).toBe('https://alice.twake.example.com');
    expect(d.lines.join('\n')).toContain('ABCD-EFGH');
    expect(await d.vault.get(OIDC_REFRESH_KEY)).toMatch(/^refresh-/);
  });

  it('refuses a sign-in that gives no refresh token, and saves nothing', async () => {
    idp.offlineAccess = false;
    const d = await deps();
    await expect(loginOidc({ email: 'alice@example.com', environment, client, mode: 'device' }, d)).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('offline_access'),
    });
    expect(await loadConfig(d.paths)).toBeUndefined();
  });
});

describe('chooseLoginMode', () => {
  it('uses the browser on a desktop', () => {
    expect(chooseLoginMode({ noBrowser: false, env: {}, platform: 'darwin' })).toBe('browser');
    expect(chooseLoginMode({ noBrowser: false, env: {}, platform: 'win32' })).toBe('browser');
    expect(chooseLoginMode({ noBrowser: false, env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' })).toBe('browser');
  });

  it('signs in from another device over SSH, without a display, or when asked', () => {
    expect(chooseLoginMode({ noBrowser: false, env: { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22', DISPLAY: ':0' }, platform: 'linux' })).toBe('device');
    expect(chooseLoginMode({ noBrowser: false, env: {}, platform: 'linux' })).toBe('device');
    expect(chooseLoginMode({ noBrowser: true, env: {}, platform: 'darwin' })).toBe('device');
  });
});

describe('signing in again', () => {
  it('keeps the Drive and Chat connections', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    await saveConfig(d.paths, { ...first, drive: { clientId: 'client-1', apps: ['mail'] }, chat: { hermes: { userId: '@alice:example.com', deviceId: 'D1' } } });
    const again = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    expect(again.drive).toEqual({ clientId: 'client-1', apps: ['mail'] });
    expect(again.chat).toEqual({ hermes: { userId: '@alice:example.com', deviceId: 'D1' } });
  });

  it('drops them when signing in to another domain', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    await saveConfig(d.paths, { ...first, drive: { clientId: 'client-1', apps: [] } });
    const other = await loginOidc({ email: 'alice@other.example', environment: { ...environment, domain: 'other.example' }, client, mode: 'browser', ports: [0] }, d);
    expect(other.drive).toBeUndefined();
  });
});
