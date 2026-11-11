import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { TwakeEnvironment } from '../src/discovery.js';
import { chooseLoginMode, loginOidc, OIDC_REFRESH_KEY, type LoginDeps } from '../src/login.js';
import { fetchOidcMetadata } from '../src/oidc.js';
import { readCachedToken, writeCachedToken } from '../src/token-cache.js';
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

describe('loginOidc: the calendar server', () => {
  const found = { url: 'https://dav.example.com/', source: 'discovered' as const };
  const withDav = () => ({ ...environment, services: { dav: found } });

  it('keeps the one that takes the Twake session, asking with the new access token', async () => {
    const side = { url: 'https://twcalendar.example.com/dav/', source: 'convention' as const, hrefPrefix: '/dav' };
    const asked: string[] = [];
    const d = await deps({ findDav: async (_env, token) => (asked.push(token), side) });
    const config = await loginOidc({ email: 'alice@example.com', environment: withDav(), client, mode: 'device' }, d);
    expect(config.environment.services.dav).toEqual(side);
    expect(asked).toEqual([expect.stringMatching(/^access-/)]);
    expect(d.lines.join('\n')).toContain('Twake Calendar: https://twcalendar.example.com/dav/');
  });

  it('says nothing when the one found takes the session', async () => {
    const d = await deps({ findDav: async () => found });
    await loginOidc({ email: 'alice@example.com', environment: withDav(), client, mode: 'device' }, d);
    expect(d.lines.join('\n')).not.toContain('Twake Calendar');
  });

  it('keeps the one found, with a warning, when none takes the session', async () => {
    const d = await deps({ findDav: async () => undefined });
    const config = await loginOidc({ email: 'alice@example.com', environment: withDav(), client, mode: 'device' }, d);
    expect(config.environment.services.dav).toEqual(found);
    expect(d.lines.join('\n')).toContain('✗ Twake Calendar: https://dav.example.com/ does not take your Twake session');
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

  it('keeps the record of the entries written into each agent, whatever the account', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    const agents = { cursor: { entries: { 'twake-mail': '0123456789abcdef' } } };
    await saveConfig(d.paths, { ...first, agents });
    expect((await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d)).agents).toEqual(agents);
    expect((await loginOidc({ email: 'bob@example.com', environment, client, mode: 'browser', ports: [0] }, d)).agents).toEqual(agents);
  });

  it('keeps the variables the user set with setup --env', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    const env = { dav: { DAV_DEFAULT_CALENDAR: 'XG' } };
    await saveConfig(d.paths, { ...first, env });
    // a later sign-in, same account or not, must not forget them silently
    expect((await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d)).env).toEqual(env);
    expect((await loginOidc({ email: 'bob@example.com', environment, client, mode: 'browser', ports: [0] }, d)).env).toEqual(env);
  });

  it('drops them when signing in to another domain', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    await saveConfig(d.paths, { ...first, drive: { clientId: 'client-1', apps: [] } });
    const other = await loginOidc({ email: 'alice@other.example', environment: { ...environment, domain: 'other.example' }, client, mode: 'browser', ports: [0] }, d);
    expect(other.drive).toBeUndefined();
  });
});

describe('signing in again with another account or vault', () => {
  it('drops Drive and Chat for another account, with their cached tokens', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    await saveConfig(d.paths, { ...first, drive: { clientId: 'client-1', apps: [] }, chat: { hermes: { userId: '@alice:example.com', deviceId: 'D1' } } });
    await writeCachedToken(d.paths, 'cozy', { accessToken: 'alice-drive', expiresAt: 9_000_000_000 });
    await writeCachedToken(d.paths, 'matrix-hermes', { accessToken: 'alice-chat', expiresAt: 9_000_000_000 });
    const bob = await loginOidc({ email: 'bob@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    expect(bob.drive).toBeUndefined();
    expect(bob.chat).toBeUndefined();
    expect(await readCachedToken(d.paths, 'cozy')).toBeUndefined();
    expect(await readCachedToken(d.paths, 'matrix-hermes')).toBeUndefined();
  });

  it('keeps them for the same account typed with capitals', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    await saveConfig(d.paths, { ...first, drive: { clientId: 'client-1', apps: [] } });
    const again = await loginOidc({ email: 'Alice@Example.com', environment, client, mode: 'browser', ports: [0] }, d);
    expect(again.drive).toEqual({ clientId: 'client-1', apps: [] });
  });

  it('drops them when the session moves to another vault', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    await saveConfig(d.paths, { ...first, vault: 'keyring', drive: { clientId: 'client-1', apps: [] } });
    const again = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    expect(again.vault).toBe('file');
    expect(again.drive).toBeUndefined();
  });
});
