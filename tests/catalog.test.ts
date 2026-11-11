import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG, detectLanguage, entryName, hermesEntryName, serviceEnv, shellQuote, tokenCommand, type CatalogContext } from '../src/catalog.js';
import type { TwakeAiConfig } from '../src/config.js';
import { appPaths } from '../src/paths.js';

const config: TwakeAiConfig = {
  version: 1,
  email: 'JDoe@linagora.com',
  vault: 'file',
  oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
  environment: {
    domain: 'linagora.com',
    oidc: { issuer: 'https://sso.linagora.com', authorization_endpoint: 'https://sso.linagora.com/a', token_endpoint: 'https://sso.linagora.com/t', userinfo_endpoint: 'https://sso.linagora.com/u' },
    matrix: { homeserver: 'https://matrix.linagora.com/', tom: 'https://tom.linagora.com/' },
    services: {
      mail: { url: 'https://jmap.linagora.com/jmap/session', source: 'discovered' },
      dav: { url: 'https://dav.linagora.com/', source: 'discovered' },
      space: { url: 'https://space.linagora.com', source: 'convention' },
      project: { url: 'https://projects.linagora.com', source: 'convention' },
    },
    cozy: { instance: 'https://jdoe.twake.linagora.com' },
  },
  drive: { clientId: 'client-1', apps: ['mail'] },
  chat: { hermes: { userId: '@jdoe:linagora.com', deviceId: 'DEVICE1' } },
};

const ctx: CatalogContext = {
  config,
  paths: appPaths({ platform: 'linux', env: { TWAKE_AI_HOME: '/t' }, home: '/home/j' }),
  nodePath: '/usr/bin/node',
  cliPath: '/opt/twake-ai/build/bin.js',
  language: 'fr',
  timezone: 'Europe/Paris',
};

const cmd = (service: string, agent?: string) => `'/usr/bin/node' '/opt/twake-ai/build/bin.js' 'token' '${service}'${agent ? ` '--agent' '${agent}'` : ''}`;

describe('catalog', () => {
  it('pins the six MCP servers', () => {
    expect(Object.fromEntries(Object.entries(CATALOG).map(([service, pkg]) => [service, `${pkg.name}@${pkg.version}`]))).toEqual({
      mail: 'mcp-twake-mail@4.1.0',
      dav: 'mcp-twake-dav@4.2.0',
      drive: 'mcp-twake-drive@0.4.0',
      chat: 'mcp-twake-chat@0.6.0',
      space: 'mcp-twake-space@0.2.1',
      project: 'mcp-twake-project@0.2.1',
    });
    expect(entryName('mail')).toBe('twake-mail');
    expect(hermesEntryName('project')).toBe('twake_project');
  });
});

describe('tokenCommand', () => {
  it('quotes every argument for /bin/sh -c', () => {
    expect(tokenCommand('chat', 'hermes', ctx)).toBe(cmd('chat', 'hermes'));
    expect(shellQuote("o'brien")).toBe(`'o'\\''brien'`);
  });

  it.skipIf(process.platform === 'win32')('survives spaces and quotes in paths through /bin/sh -c', () => {
    const odd = { ...ctx, nodePath: '/opt/my node/bin/node', cliPath: "/home/o'brien/cli.js" };
    const printed = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${tokenCommand('mail', undefined, odd)}`], { encoding: 'utf8' });
    expect(printed.split('\n').slice(0, 4)).toEqual(['/opt/my node/bin/node', "/home/o'brien/cli.js", 'token', 'mail']);
  });
});

describe('serviceEnv', () => {
  it('builds the environment of each service', () => {
    const common = { USER_LANGUAGE: 'fr', USER_TIMEZONE: 'Europe/Paris' };
    expect(serviceEnv('mail', 'claude-code', ctx)).toEqual({
      JMAP_SESSION_URL: 'https://jmap.linagora.com/jmap/session',
      JMAP_AUTH_METHOD: 'command',
      JMAP_TOKEN_COMMAND: cmd('mail'),
      ...common,
    });
    expect(serviceEnv('dav', 'claude-code', ctx)).toEqual({
      DAV_URL: 'https://dav.linagora.com/',
      DAV_AUTH_METHOD: 'command',
      DAV_TOKEN_COMMAND: cmd('dav'),
      DAV_ORGANIZER_EMAIL: 'jdoe@linagora.com',
      ...common,
    });
    expect(serviceEnv('drive', 'claude-code', ctx)).toEqual({ TWAKE_DRIVE_URL: 'https://jdoe.twake.linagora.com', TWAKE_DRIVE_TOKEN_COMMAND: cmd('drive'), ...common });
    expect(serviceEnv('space', 'claude-code', ctx)).toEqual({
      TWAKE_SPACE_URL: 'https://space.linagora.com',
      TWAKE_SPACE_TOKEN_COMMAND: cmd('space'),
      TWAKE_SPACE_OIDC_ISSUER: 'https://sso.linagora.com',
      ...common,
    });
    expect(serviceEnv('project', 'claude-code', ctx)).toEqual({
      TWAKE_PROJECT_URL: 'https://projects.linagora.com',
      TWAKE_PROJECT_TOKEN_COMMAND: cmd('project'),
      TWAKE_PROJECT_OIDC_ISSUER: 'https://sso.linagora.com',
      ...common,
    });
  });

  it("gives Chat the agent's device, its own store and the ToM recovery", () => {
    expect(serviceEnv('chat', 'hermes', ctx)).toMatchObject({
      MATRIX_USER_ID: '@jdoe:linagora.com',
      MATRIX_TOKEN_COMMAND: cmd('chat', 'hermes'),
      MATRIX_HOMESERVER_URL: 'https://matrix.linagora.com/',
      TOM_URL: 'https://tom.linagora.com/',
      MATRIX_E2EE_RECOVERY: 'tom',
      MATRIX_STORE_DIR: join('/t/data', 'chat', 'hermes', 'DEVICE1'),
    });
  });

  it('lets the approval wait a little longer than Hermes', () => {
    expect(serviceEnv('mail', 'hermes', ctx).JMAP_APPROVAL_TIMEOUT_MS).toBe('330000');
    expect(serviceEnv('chat', 'hermes', ctx).MATRIX_APPROVAL_TIMEOUT_MS).toBe('330000');
    expect(serviceEnv('mail', 'claude-code', ctx).JMAP_APPROVAL_TIMEOUT_MS).toBeUndefined();
  });

  it('says what is missing', () => {
    const bare = { ...ctx, config: { ...config, drive: undefined, chat: undefined, environment: { ...config.environment, services: {} } } };
    expect(() => serviceEnv('mail', 'claude-code', bare)).toThrow(expect.objectContaining({ code: 'unsupported' }));
    expect(() => serviceEnv('drive', 'claude-code', bare)).toThrow(expect.objectContaining({ code: 'login_required', message: expect.stringContaining('login --drive') }));
    expect(() => serviceEnv('chat', 'cursor', ctx)).toThrow(expect.objectContaining({ code: 'login_required', message: expect.stringContaining('--agent cursor') }));
    expect(() => serviceEnv('mail', 'Claude Code', ctx)).toThrow(expect.objectContaining({ code: 'usage' }));
  });
});

describe('detectLanguage', () => {
  it('reads TWAKE_AI_LANGUAGE, then the locale', () => {
    expect(detectLanguage({ TWAKE_AI_LANGUAGE: 'en', LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(detectLanguage({ LANG: 'fr_FR.UTF-8' })).toBe('fr');
    expect(detectLanguage({ LC_ALL: 'de_DE.UTF-8', LANG: 'fr_FR' })).toBe('en');
    expect(detectLanguage({})).toBe('en');
  });
});

describe('serviceEnv: Chat device ids', () => {
  it('refuses a device id that could name another folder', () => {
    const hostile = { ...ctx, config: { ...config, chat: { hermes: { userId: '@jdoe:linagora.com', deviceId: '../../x' } } } };
    expect(() => serviceEnv('chat', 'hermes', hostile)).toThrow(expect.objectContaining({ code: 'bad_response' }));
  });
});
