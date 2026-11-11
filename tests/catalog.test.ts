import { exec, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { CATALOG, detectLanguage, entryName, hermesEntryName, parseEnvOption, serviceEnv, shellQuote, tokenCommand, type CatalogContext } from '../src/catalog.js';
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
  platform: 'linux',
  language: 'fr',
  timezone: 'Europe/Paris',
};

const cmd = (service: string, agent?: string) => `'/usr/bin/node' '/opt/twake-ai/build/bin.js' 'token' '${service}'${agent ? ` '--agent' '${agent}'` : ''}`;

describe('catalog', () => {
  it('pins the six MCP servers', () => {
    expect(Object.fromEntries(Object.entries(CATALOG).map(([service, pkg]) => [service, `${pkg.name}@${pkg.version}`]))).toEqual({
      mail: 'mcp-twake-mail@4.1.1',
      dav: 'mcp-twake-dav@4.2.1',
      drive: 'mcp-twake-drive@0.4.1',
      chat: 'mcp-twake-chat@0.6.1',
      space: 'mcp-twake-space@0.2.2',
      project: 'mcp-twake-project@0.2.2',
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

  it('puts every argument in double quotes for cmd.exe on Windows', () => {
    const win = {
      ...ctx,
      platform: 'win32' as const,
      nodePath: 'C:\\Program Files\\nodejs\\node.exe',
      cliPath: 'C:\\Users\\Al Ice\\AppData\\Roaming\\npm\\node_modules\\mcp-twake-ai\\build\\bin.js',
    };
    expect(tokenCommand('chat', 'hermes', win)).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Al Ice\\AppData\\Roaming\\npm\\node_modules\\mcp-twake-ai\\build\\bin.js" "token" "chat" "--agent" "hermes"',
    );
  });

  it('refuses on Windows a path that cmd.exe would change', () => {
    for (const cliPath of ['C:\\Users\\100%\\bin.js', 'C:\\Users\\a!b\\bin.js', 'C:\\a"b\\bin.js', 'C:\\a\nb\\bin.js']) {
      expect(() => tokenCommand('mail', undefined, { ...ctx, platform: 'win32', cliPath })).toThrow(expect.objectContaining({ code: 'unsupported' }));
    }
  });

  it('runs through the system shell of this computer, as the Twake.ai servers do', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp twake ai '));
    const cliPath = join(dir, 'bin.cjs');
    await writeFile(cliPath, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const line = tokenCommand('chat', 'hermes', { ...ctx, platform: process.platform, nodePath: process.execPath, cliPath });
    const { stdout } = await promisify(exec)(line, { windowsHide: true });
    expect(JSON.parse(stdout)).toEqual(['token', 'chat', '--agent', 'hermes']);
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
    const sideService = { ...ctx, config: { ...config, environment: { ...config.environment, services: { dav: { url: 'https://twcalendar.linagora.com/dav/', source: 'convention' as const, hrefPrefix: '/dav' } } } } };
    expect(serviceEnv('dav', 'claude-code', sideService)).toMatchObject({ DAV_URL: 'https://twcalendar.linagora.com/dav/', DAV_HREF_PREFIX: '/dav' });
    expect(serviceEnv('dav', 'claude-code', ctx)).not.toHaveProperty('DAV_HREF_PREFIX');
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
    expect(detectLanguage({}, 'en-US')).toBe('en');
  });

  it('falls back to the system locale when no variable is set, as on Windows', () => {
    expect(detectLanguage({}, 'fr-FR')).toBe('fr');
    expect(detectLanguage({ LANG: 'en_US.UTF-8' }, 'fr-FR')).toBe('en');
  });
});

describe('serviceEnv: Chat device ids', () => {
  it('refuses a device id that could name another folder', () => {
    const hostile = { ...ctx, config: { ...config, chat: { hermes: { userId: '@jdoe:linagora.com', deviceId: '../../x' } } } };
    expect(() => serviceEnv('chat', 'hermes', hostile)).toThrow(expect.objectContaining({ code: 'bad_response' }));
  });
});

describe('serviceEnv: the user\'s own variables', () => {
  const withEnv = { ...ctx, config: { ...config, env: { dav: { DAV_DEFAULT_CALENDAR: 'XG' }, mail: { JMAP_DEFAULT_FROM: 'jdoe@linagora.com' } } } };

  it('adds the variables of this service, after the ones mcp-twake-ai builds', () => {
    const env = serviceEnv('dav', 'cursor', withEnv);
    expect(env.DAV_DEFAULT_CALENDAR).toBe('XG');
    expect(env.DAV_URL).toBe('https://dav.linagora.com/');
    expect(env.USER_TIMEZONE).toBe('Europe/Paris');
  });

  it('leaves the other services alone', () => {
    expect(serviceEnv('space', 'cursor', withEnv)).not.toHaveProperty('DAV_DEFAULT_CALENDAR');
    expect(serviceEnv('mail', 'cursor', withEnv).JMAP_DEFAULT_FROM).toBe('jdoe@linagora.com');
  });

  it('lets the user override a variable mcp-twake-ai sets', () => {
    const override = { ...ctx, config: { ...config, env: { dav: { USER_TIMEZONE: 'America/New_York' } } } };
    expect(serviceEnv('dav', 'cursor', override).USER_TIMEZONE).toBe('America/New_York');
  });

  it('refuses a config.json edited by hand that names a server, a secret, or another program', () => {
    const hostileSets = [
      { DAV_URL: 'https://evil.example/' },
      { DAV_TOKEN_COMMAND: 'echo x' },
      { DAV_AUTH_METHOD: 'bearer' },
      { LD_PRELOAD: '/tmp/x.so' },
      { NODE_OPTIONS: '--require=/tmp/x.js' },
      { node_options: '--require=/tmp/x.js' },
    ];
    for (const variables of hostileSets) {
      const hostile = { ...ctx, config: { ...config, env: { dav: variables } } };
      expect(() => serviceEnv('dav', 'cursor', hostile), JSON.stringify(variables)).toThrow(/Remove it from/);
    }
  });
});

describe('parseEnvOption', () => {
  it('reads one option per variable', () => {
    expect(parseEnvOption(['dav.DAV_DEFAULT_CALENDAR=XG', 'mail.JMAP_DEFAULT_FROM=jdoe@linagora.com', 'dav.DAV_RECURRING_WRITES=false'])).toEqual({
      set: { dav: { DAV_DEFAULT_CALENDAR: 'XG', DAV_RECURRING_WRITES: 'false' }, mail: { JMAP_DEFAULT_FROM: 'jdoe@linagora.com' } },
      unset: {},
    });
  });

  it('keeps the value, equal signs included', () => {
    expect(parseEnvOption(['dav.DAV_SOMETHING=a=b']).set).toEqual({ dav: { DAV_SOMETHING: 'a=b' } });
  });

  it('reads an empty value as a variable to forget', () => {
    expect(parseEnvOption(['dav.DAV_DEFAULT_CALENDAR='])).toEqual({ set: {}, unset: { dav: ['DAV_DEFAULT_CALENDAR'] } });
  });

  it('refuses an unknown service, a lower-case name or a missing equal sign', () => {
    expect(() => parseEnvOption(['calendar.FOO=1'])).toThrow(/--env takes/);
    expect(() => parseEnvOption(['dav.lower=1'])).toThrow(/--env takes/);
    expect(() => parseEnvOption(['dav.NO_EQUALS'])).toThrow(/--env takes/);
    expect(() => parseEnvOption(['dav.WITH_BREAK=a\nb'])).toThrow(/line break/);
  });

  it('refuses the variables that name a server or carry a secret', () => {
    for (const option of ['dav.DAV_URL=https://evil.example/', 'dav.DAV_TOKEN_COMMAND=x', 'mail.JMAP_PASSWORD=x', 'space.TWAKE_SPACE_CLIENT_SECRET=x', 'space.TWAKE_SPACE_API_KEY=x', 'dav.DAV_AUTH_METHOD=bearer']) {
      expect(() => parseEnvOption([option]), option).toThrow(/--env /);
    }
  });

  it('lets the last option given for a variable win', () => {
    expect(parseEnvOption(['dav.DAV_X=1', 'dav.DAV_X='])).toEqual({ set: {}, unset: { dav: ['DAV_X'] } });
    expect(parseEnvOption(['dav.DAV_X=', 'dav.DAV_X=1'])).toEqual({ set: { dav: { DAV_X: '1' } }, unset: {} });
  });

  it('refuses the variables Node.js reads before the server', () => {
    for (const option of ['dav.NODE_OPTIONS=--require=/tmp/x.js', 'mail.NODE_TLS_REJECT_UNAUTHORIZED=0', 'space.HTTPS_PROXY=http://127.0.0.1:1']) {
      expect(() => parseEnvOption([option]), option).toThrow(/is not a variable of|Node\.js itself/);
    }
  });

  it('accepts only the variables of the server itself, and the USER_ ones', () => {
    for (const option of ['dav.LD_PRELOAD=/tmp/x.so', 'dav.DYLD_INSERT_LIBRARIES=/tmp/x.dylib', 'dav.COMSPEC=cmd.exe', 'dav.TWAKE_AI_HOME=/tmp/x', 'mail.DAV_DEFAULT_CALENDAR=XG']) {
      expect(() => parseEnvOption([option]), option).toThrow(/is not a variable of/);
    }
    expect(parseEnvOption(['dav.USER_LANGUAGE=en', 'space.USER_TIMEZONE=UTC']).set).toEqual({ dav: { USER_LANGUAGE: 'en' }, space: { USER_TIMEZONE: 'UTC' } });
  });

  it('refuses the store directory mcp-twake-ai keeps per device', () => {
    expect(() => parseEnvOption(['chat.MATRIX_STORE_DIR=/tmp/x'])).toThrow(/managed by mcp-twake-ai/);
  });

  it('accepts the settings the servers document', () => {
    expect(parseEnvOption(['dav.DAV_DEFAULT_CALENDAR=XG', 'mail.JMAP_DEFAULT_FROM=jdoe@linagora.com', 'dav.USER_TIMEZONE=America/New_York']).unset).toEqual({});
  });
});
