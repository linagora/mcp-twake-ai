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
  mail: { name: 'mcp-twake-mail', version: '4.2.0', approval: 'JMAP' },
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
 * The one folder where Mail saves attachments, and where Drive and Chat download files and take the ones they upload:
 * an attachment kept by Mail can go to the Drive or a room without passing through the model. `~` is the home folder.
 */
export const FILES_FOLDER = '~/Downloads/Twake';

/**
 * The environment of one MCP server for one agent: URLs, token command, language, time zone, agent-specific settings,
 * then what the user added for this service (`setup --env dav.DAV_DEFAULT_CALENDAR=XG`), which has the last word.
 */
export function serviceEnv(service: ServiceId, agent: string, ctx: CatalogContext): Record<string, string> {
  checkAgentId(agent);
  const extra = ctx.config.env?.[service] ?? {};
  // a config.json edited by hand must not send a token to another server, nor run code in the server
  for (const name of Object.keys(extra)) {
    const refusal = EXTRA_ENV_NAME.test(name) ? envNameRefusal(name, service) : `${name} is not an upper-case variable name`;
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
      return {
        JMAP_SESSION_URL: url,
        JMAP_AUTH_METHOD: 'command',
        JMAP_TOKEN_COMMAND: tokenCommand('mail', undefined, ctx),
        JMAP_DOWNLOAD_DIR: FILES_FOLDER,
        ...common,
      };
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
      // its upload folder defaults to its download folder
      return { TWAKE_DRIVE_URL: instance, TWAKE_DRIVE_TOKEN_COMMAND: tokenCommand('drive', undefined, ctx), TWAKE_DRIVE_DOWNLOAD_DIR: FILES_FOLDER, ...common };
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
        // its upload folder defaults to its download folder
        MATRIX_DOWNLOAD_DIR: FILES_FOLDER,
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

/** A variable a user may not set: it names a server, how to sign in to it, or whose account it is — the account's discovery says so */
const SERVER_ENV_NAME = /(^|_)(URL|URI|HOMESERVER|AUTH_METHOD|OIDC|HREF_PREFIX|ORGANIZER_EMAIL|USERNAME)($|_)/;

/** A variable a user may not set: it carries a secret, which mcp-twake-ai keeps in the keychain */
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|(^|_)KEYS?($|_)/;

/** The only logging variable the servers read */
const LOGGING_ENV_NAME = /^LOG_LEVEL$/;

/** A variable mcp-twake-ai manages itself for the agent: one encryption store per device */
const MANAGED_ENV_NAME = /^MATRIX_STORE_DIR$/;

/** A folder the servers write files into or read them from: FILES_FOLDER, shared by Mail, Drive and Chat */
const FILES_ENV_NAME = /_(DOWNLOAD|UPLOAD)_DIR$/;

/** A file the mail server reads and appends to every message: a pasted path would mail a private key */
const SIGNATURE_ENV_NAME = /^JMAP_SIGNATURE_PATH$/;

/** Any other variable naming a file the server reads: the same reach, whatever the file */
const FILE_ENV_NAME = /_(PATH|FILE)$/;

/** A variable that identifies the account, which comes from the sign-in */
const IDENTITY_ENV_NAME = /^MATRIX_USER_ID$/;

/** The prefix of a service's own variables: DAV_ for Twake Calendar, JMAP_ for Twake Mail… */
export function serviceEnvPrefix(service: ServiceId): string {
  return `${CATALOG[service].approval}_`;
}

/**
 * Why a variable name may not be set, if it may not
 *
 * Only the variables of the server itself (`DAV_…` for Twake Calendar), the `USER_…` ones and
 * `LOG_LEVEL` are accepted: listing the dangerous names of a process environment is a losing game
 * (LD_PRELOAD, DYLD_INSERT_LIBRARIES, COMSPEC, TWAKE_AI_HOME, NODE_OPTIONS…), and no server has a
 * business with any of them.
 *
 * @param name - the variable name, as it would be given to a server
 * @param service - the service whose environment receives it
 * @returns the reason, or undefined when the name is free
 */
export function envNameRefusal(name: string, service: ServiceId): string | undefined {
  const prefix = serviceEnvPrefix(service);
  if (!name.startsWith(prefix) && !name.startsWith('USER_') && !LOGGING_ENV_NAME.test(name)) {
    return `${name} is not a variable of ${CATALOG[service].name}: only ${prefix}…, USER_… and LOG_LEVEL may be set`;
  }
  if (MANAGED_ENV_NAME.test(name)) return `${name} is managed by mcp-twake-ai, which keeps one store per device`;
  // JMAP_DEFAULT_FROM is taken on purpose: the send tools already accept a sender per message, and
  // a user may send from one of their aliases. It is not an identity in the sense of MATRIX_USER_ID.
  if (FILES_ENV_NAME.test(name)) {
    return `${name} is managed by mcp-twake-ai: Mail, Drive and Chat share one folder for files, ${FILES_FOLDER}, and take and leave files there`;
  }
  if (SIGNATURE_ENV_NAME.test(name)) {
    return `${name} is read by the mail server and appended to every message it writes: a path given by mistake would send that file to every correspondent`;
  }
  if (FILE_ENV_NAME.test(name)) return `${name} names a file the server reads: a pasted path would give it access to a file of this computer`;
  if (IDENTITY_ENV_NAME.test(name)) return `${name} identifies the account: it comes from the sign-in, not from the user`;
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
  // the last option given for a variable wins, as on a command line
  const decisions = new Map<string, { service: string; name: string; value?: string }>();
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
        `--env takes <service>.<VARIABLE>=<value>, with a service among ${SERVICE_IDS.join(', ')}, and an upper-case variable name, not "${raw}".`,
      );
    }
    // an empty value forgets the variable, which needs no other check
    if (value === '') {
      decisions.set(`${service}.${name}`, { service, name });
      continue;
    }
    if (/[\r\n\0]/.test(value)) throw new TwakeAiError('usage', `--env ${service}.${name}: a value cannot hold a line break.`);
    const refusal = envNameRefusal(name, service);
    if (refusal) throw new TwakeAiError('usage', `--env ${service}.${name}: ${refusal}.`);
    decisions.set(`${service}.${name}`, { service, name, value });
  }

  const change: EnvOptionChange = { set: {}, unset: {} };
  for (const { service, name, value } of decisions.values()) {
    if (value === undefined) change.unset[service] = [...(change.unset[service] ?? []), name];
    else change.set[service] = { ...(change.set[service] ?? {}), [name]: value };
  }
  return change;
}
