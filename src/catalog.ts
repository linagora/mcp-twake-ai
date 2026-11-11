import { join } from 'node:path';
import { isServiceId, SERVICE_IDS, type ServiceId } from './broker.js';
import type { TwakeAiConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { checkAgentId, isSafeDeviceId } from './grants.js';
import type { AppPaths } from './paths.js';

export interface McpPackage {
  name: string;
  version: string;
  /** prefix of its *_APPROVAL and *_APPROVAL_TIMEOUT_MS variables */
  approval: string;
}

/**
 * The six Twake.ai MCP servers, pinned: an agent never starts a version nobody tested with mcp-twake-ai.
 * These versions run *_TOKEN_COMMAND through the system shell, so they work on Windows too.
 */
export const CATALOG: Record<ServiceId, McpPackage> = {
  mail: { name: 'mcp-twake-mail', version: '4.1.1', approval: 'JMAP' },
  dav: { name: 'mcp-twake-dav', version: '4.2.1', approval: 'DAV' },
  drive: { name: 'mcp-twake-drive', version: '0.4.1', approval: 'TWAKE_DRIVE' },
  chat: { name: 'mcp-twake-chat', version: '0.6.1', approval: 'MATRIX' },
  space: { name: 'mcp-twake-space', version: '0.2.2', approval: 'TWAKE_SPACE' },
  project: { name: 'mcp-twake-project', version: '0.2.2', approval: 'TWAKE_PROJECT' },
};

/** Hermes waits 300 s for an answer: the server waits a little longer, so that Hermes, not the server, gives up first. */
export const HERMES_APPROVAL_TIMEOUT_MS = '330000';

export const entryName = (service: ServiceId) => `twake-${service}`;
export const hermesEntryName = (service: ServiceId) => `twake_${service}`;

export interface CatalogContext {
  config: TwakeAiConfig;
  paths: AppPaths;
  /** absolute paths of node and of mcp-twake-ai's command (build/bin.js) */
  nodePath: string;
  cliPath: string;
  /** the token command is written for this OS's shell */
  platform: NodeJS.Platform;
  language: 'en' | 'fr';
  timezone: string;
}

/** POSIX single quotes: the Twake.ai MCP servers run *_TOKEN_COMMAND through /bin/sh -c on macOS and Linux. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Double quotes for cmd.exe, which runs *_TOKEN_COMMAND on Windows. Inside them cmd.exe still expands %VAR% (and !VAR!
 * when delayed expansion is on), and nothing can escape a double quote: such a path is refused rather than changed.
 */
export function windowsQuote(value: string): string {
  if (/["%!\r\n]/.test(value)) {
    throw new TwakeAiError('unsupported', `${value} contains a character that cmd.exe would change (" % ! or a line break): install Node and mcp-twake-ai under another folder.`);
  }
  return `"${value}"`;
}

/** One command line for the shell of `platform`: cmd.exe on Windows, /bin/sh elsewhere. */
export function commandLine(parts: string[], platform: NodeJS.Platform): string {
  return parts.map(platform === 'win32' ? windowsQuote : shellQuote).join(' ');
}

export function tokenCommand(service: ServiceId, agent: string | undefined, ctx: CatalogContext): string {
  return commandLine([ctx.nodePath, ctx.cliPath, 'token', service, ...(agent ? ['--agent', agent] : [])], ctx.platform);
}

/** The variables first, then the system locale: Windows sets no LANG. */
export function detectLanguage(env: NodeJS.ProcessEnv, locale = Intl.DateTimeFormat().resolvedOptions().locale): 'en' | 'fr' {
  const tag = env.TWAKE_AI_LANGUAGE || env.LC_ALL || env.LC_MESSAGES || env.LANG || locale || '';
  return tag.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/**
 * The environment of one MCP server for one agent: URLs, token command, language, time zone, agent-specific settings,
 * then what the user added for this service (`setup --env dav.DAV_DEFAULT_CALENDAR=XG`), which has the last word.
 */
export function serviceEnv(service: ServiceId, agent: string, ctx: CatalogContext): Record<string, string> {
  checkAgentId(agent);
  const extra = ctx.config.env?.[service] ?? {};
  // a config.json edited by hand must not send a token to another server
  for (const name of Object.keys(extra)) {
    const refusal = envNameRefusal(name);
    if (refusal) {
      throw new TwakeAiError('unsupported', `${ctx.paths.configFile} sets ${name} for ${service}: ${refusal}. Remove it from ${ctx.paths.configFile}.`);
    }
  }
  return { ...builtinServiceEnv(service, agent, ctx), ...extra };
}

/** The environment mcp-twake-ai builds itself, before the user's own variables */
function builtinServiceEnv(service: ServiceId, agent: string, ctx: CatalogContext): Record<string, string> {
  const { config } = ctx;
  const env = config.environment;
  const common: Record<string, string> = { USER_LANGUAGE: ctx.language, USER_TIMEZONE: ctx.timezone };
  if (agent === 'hermes') common[`${CATALOG[service].approval}_APPROVAL_TIMEOUT_MS`] = HERMES_APPROVAL_TIMEOUT_MS;
  const notFound = (what: string) => new TwakeAiError('unsupported', `No ${what} was found for ${env.domain}: it cannot be configured.`);
  switch (service) {
    case 'mail': {
      const url = env.services.mail?.url;
      if (!url) throw notFound('Twake Mail (JMAP) server');
      return { JMAP_SESSION_URL: url, JMAP_AUTH_METHOD: 'command', JMAP_TOKEN_COMMAND: tokenCommand('mail', undefined, ctx), ...common };
    }
    case 'dav': {
      const url = env.services.dav?.url;
      if (!url) throw notFound('Twake Calendar (CalDAV) server');
      const prefix = env.services.dav?.hrefPrefix;
      return {
        DAV_URL: url,
        ...(prefix ? { DAV_HREF_PREFIX: prefix } : {}),
        DAV_AUTH_METHOD: 'command',
        DAV_TOKEN_COMMAND: tokenCommand('dav', undefined, ctx),
        // required with an SSO token: the server cannot tell the user's address from it
        DAV_ORGANIZER_EMAIL: config.email.trim().toLowerCase(),
        ...common,
      };
    }
    case 'drive': {
      const instance = env.cozy.instance;
      if (!instance || !config.drive) throw new TwakeAiError('login_required', 'Twake Drive is not connected: run `mcp-twake-ai login --drive`.');
      return { TWAKE_DRIVE_URL: instance, TWAKE_DRIVE_TOKEN_COMMAND: tokenCommand('drive', undefined, ctx), ...common };
    }
    case 'chat': {
      const device = config.chat?.[agent];
      if (!device) throw new TwakeAiError('login_required', `Twake Chat is not connected for ${agent}: run \`mcp-twake-ai login --chat --agent ${agent}\`.`);
      if (!isSafeDeviceId(device.deviceId)) {
        throw new TwakeAiError('bad_response', `The Twake Chat device id of ${agent} is not usable: run \`mcp-twake-ai login --chat --agent ${agent}\`.`);
      }
      return {
        MATRIX_USER_ID: device.userId,
        MATRIX_TOKEN_COMMAND: tokenCommand('chat', agent, ctx),
        MATRIX_HOMESERVER_URL: env.matrix.homeserver,
        ...(env.matrix.tom ? { TOM_URL: env.matrix.tom } : {}),
        MATRIX_E2EE_RECOVERY: 'tom',
        // the end-to-end encryption store belongs to one device: a new device gets a new store
        MATRIX_STORE_DIR: join(ctx.paths.dataDir, 'chat', agent, device.deviceId),
        ...common,
      };
    }
    case 'space': {
      const url = env.services.space?.url;
      if (!url) throw notFound('Twake Space server');
      return { TWAKE_SPACE_URL: url, TWAKE_SPACE_TOKEN_COMMAND: tokenCommand('space', undefined, ctx), TWAKE_SPACE_OIDC_ISSUER: env.oidc.issuer, ...common };
    }
    case 'project': {
      const url = env.services.project?.url;
      if (!url) throw notFound('Twake Project server');
      return { TWAKE_PROJECT_URL: url, TWAKE_PROJECT_TOKEN_COMMAND: tokenCommand('project', undefined, ctx), TWAKE_PROJECT_OIDC_ISSUER: env.oidc.issuer, ...common };
    }
  }
}

/** An environment variable name a user may set: upper case, digits and underscores, as the servers document them */
const EXTRA_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** A variable a user may not set: it names a server, or how to sign in to it, and comes from the account's discovery */
const SERVER_ENV_NAME = /(^|_)(URL|URI|HOMESERVER|AUTH_METHOD|OIDC_ISSUER|CLIENT_ID)($|_)/;

/** A variable a user may not set: it carries a secret, which mcp-twake-ai keeps in the keychain */
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|(^|_)KEYS?($|_)/;

/**
 * Why a variable name may not be set, if it may not
 *
 * @param name - the variable name, as it would be given to a server
 * @returns the reason, or undefined when the name is free
 */
export function envNameRefusal(name: string): string | undefined {
  if (SERVER_ENV_NAME.test(name)) return `${name} names a server or how to sign in to it: those come from the account, not from the user`;
  if (SECRET_ENV_NAME.test(name)) return `${name} may carry a secret: secrets stay in the keychain, and every server gets its own token command`;
  return undefined;
}

/** What `--env` asks for: variables to set, and variables to remove */
export interface EnvOptionChange {
  set: Record<string, Record<string, string>>;
  /** service → variable names */
  unset: Record<string, string[]>;
}

/**
 * Read `--env <service>.<VARIABLE>=<value>` options. An empty value (`dav.DAV_DEFAULT_CALENDAR=`) forgets the variable.
 *
 * @param values - one option per variable, as given on the command line
 * @returns the variables to set and to remove, per service
 * @throws TwakeAiError('usage') when an option is malformed, names an unknown service, or would set a reserved variable
 */
export function parseEnvOption(values: string[]): EnvOptionChange {
  const change: EnvOptionChange = { set: {}, unset: {} };
  for (const raw of values) {
    const equals = raw.indexOf('=');
    const target = equals < 0 ? '' : raw.slice(0, equals);
    const value = equals < 0 ? '' : raw.slice(equals + 1);
    const dot = target.indexOf('.');
    const service = dot < 0 ? '' : target.slice(0, dot);
    const name = dot < 0 ? '' : target.slice(dot + 1);
    if (!isServiceId(service) || !EXTRA_ENV_NAME.test(name)) {
      throw new TwakeAiError(
        'usage',
        `--env takes <service>.<VARIABLE>=<value>, with a service among ${SERVICE_IDS.join(', ')} and an upper-case variable name, not "${raw}".`,
      );
    }
    // an empty value removes the variable, which needs no check
    if (value === '') {
      change.unset[service] = [...(change.unset[service] ?? []), name];
      continue;
    }
    if (/[\r\n\0]/.test(value)) throw new TwakeAiError('usage', `--env ${service}.${name}: a value cannot hold a line break.`);
    const refusal = envNameRefusal(name);
    if (refusal) throw new TwakeAiError('usage', `--env ${service}.${name}: ${refusal}.`);
    change.set[service] = { ...(change.set[service] ?? {}), [name]: value };
  }
  return change;
}
