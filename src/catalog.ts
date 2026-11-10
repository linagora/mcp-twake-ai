import { join } from 'node:path';
import type { ServiceId } from './broker.js';
import type { TwakeAiConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { checkAgentId } from './grants.js';
import type { AppPaths } from './paths.js';

export interface McpPackage {
  name: string;
  version: string;
  /** prefix of its *_APPROVAL and *_APPROVAL_TIMEOUT_MS variables */
  approval: string;
}

/** The six Twake.ai MCP servers, pinned: an agent never starts a version nobody tested with twake-ai. */
export const CATALOG: Record<ServiceId, McpPackage> = {
  mail: { name: 'mcp-twake-mail', version: '4.1.0', approval: 'JMAP' },
  dav: { name: 'mcp-twake-dav', version: '4.2.0', approval: 'DAV' },
  drive: { name: 'mcp-twake-drive', version: '0.4.0', approval: 'TWAKE_DRIVE' },
  chat: { name: 'mcp-twake-chat', version: '0.6.0', approval: 'MATRIX' },
  space: { name: 'mcp-twake-space', version: '0.2.1', approval: 'TWAKE_SPACE' },
  project: { name: 'mcp-twake-project', version: '0.2.1', approval: 'TWAKE_PROJECT' },
};

/** Hermes waits 300 s for an answer: the server waits a little longer, so that Hermes, not the server, gives up first. */
export const HERMES_APPROVAL_TIMEOUT_MS = '330000';

export const entryName = (service: ServiceId) => `twake-${service}`;
export const hermesEntryName = (service: ServiceId) => `twake_${service}`;

export interface CatalogContext {
  config: TwakeAiConfig;
  paths: AppPaths;
  /** absolute paths of node and of twake-ai's command (build/bin.js) */
  nodePath: string;
  cliPath: string;
  language: 'en' | 'fr';
  timezone: string;
}

/** POSIX single quotes: the Twake.ai MCP servers run *_TOKEN_COMMAND through /bin/sh -c. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function tokenCommand(service: ServiceId, agent: string | undefined, ctx: CatalogContext): string {
  return [ctx.nodePath, ctx.cliPath, 'token', service, ...(agent ? ['--agent', agent] : [])].map(shellQuote).join(' ');
}

export function detectLanguage(env: NodeJS.ProcessEnv): 'en' | 'fr' {
  const tag = env.TWAKE_AI_LANGUAGE || env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return tag.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The environment of one MCP server for one agent: URLs, token command, language, time zone, agent-specific settings. */
export function serviceEnv(service: ServiceId, agent: string, ctx: CatalogContext): Record<string, string> {
  checkAgentId(agent);
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
      return {
        DAV_URL: url,
        DAV_AUTH_METHOD: 'command',
        DAV_TOKEN_COMMAND: tokenCommand('dav', undefined, ctx),
        // required with an SSO token: the server cannot tell the user's address from it
        DAV_ORGANIZER_EMAIL: config.email.trim().toLowerCase(),
        ...common,
      };
    }
    case 'drive': {
      const instance = env.cozy.instance;
      if (!instance || !config.drive) throw new TwakeAiError('login_required', 'Twake Drive is not connected: run `twake-ai login --drive`.');
      return { TWAKE_DRIVE_URL: instance, TWAKE_DRIVE_TOKEN_COMMAND: tokenCommand('drive', undefined, ctx), ...common };
    }
    case 'chat': {
      const device = config.chat?.[agent];
      if (!device) throw new TwakeAiError('login_required', `Twake Chat is not connected for ${agent}: run \`twake-ai login --chat --agent ${agent}\`.`);
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
