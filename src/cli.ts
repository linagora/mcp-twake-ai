import { resolveSrv } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getToken, isServiceId, SERVICE_IDS } from './broker.js';
import { DEFAULT_CLIENT_ID, DEFAULT_SCOPE, loadConfig } from './config.js';
import { discover, type DiscoveryDeps } from './discovery.js';
import { TwakeAiError } from './errors.js';
import { hostOf, HttpError } from './http.js';
import { chooseLoginMode, loginOidc } from './login.js';
import { appPaths, type AppPaths } from './paths.js';
import { chooseVault, openVault, type Vault } from './vault.js';
import { createInterface } from 'node:readline/promises';
import { checkAgentId } from './grants.js';
import { loginChat } from './login-chat.js';
import { loginDrive } from './login-drive.js';
import { LOOPBACK_PORTS } from './loopback.js';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processIo: Io = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export interface CliDeps {
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  resolveSrv: DiscoveryDeps['resolveSrv'];
  openUrl(url: string): Promise<void>;
  chooseVault(paths: AppPaths): Promise<Vault>;
  /** epoch seconds */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** reads one line typed by the user (the address pasted back when there is no browser) */
  readLine(question: string): Promise<string>;
  loopbackPorts?: number[];
}

export function defaultDeps(): CliDeps {
  return {
    paths: appPaths(),
    env: process.env,
    platform: process.platform,
    fetch: globalThis.fetch,
    resolveSrv,
    openUrl: async (url) => {
      const { default: open } = await import('open');
      await open(url);
    },
    chooseVault: (paths) => chooseVault(paths),
    now: () => Math.floor(Date.now() / 1000),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    readLine: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

const USAGE = `usage:
  twake-ai login [--email <address>] [--no-browser] [--client-id <id>] [--scope <scopes>]
  twake-ai login --drive [--no-browser]
  twake-ai login --chat --agent <id> [--no-browser]
  twake-ai token <${SERVICE_IDS.join('|')}> [--agent <id>]
  twake-ai --version
`;

function usageErrors<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new TwakeAiError('usage', `${(error as Error).message}\n\n${USAGE}`);
  }
}

export async function main(argv: string[], io: Io, deps: CliDeps = defaultDeps()): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case '--version':
      case '-v':
        io.stdout(`${packageVersion()}\n`);
        return 0;
      case 'login':
        return await loginCommand(args, io, deps);
      case 'token':
        return await tokenCommand(args, io, deps);
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (error) {
    io.stderr(`twake-ai: ${describeError(error)}\n`);
    return error instanceof TwakeAiError && error.code === 'usage' ? 2 : 1;
  }
}

/** One line for the user (an MCP server shows only the last line of stderr). Usage errors keep the usage text. */
function describeError(error: unknown): string {
  if (error instanceof TwakeAiError) return error.message;
  if (error instanceof HttpError) {
    return `${hostOf(error.url)} refused the request (HTTP ${error.status}${error.oauthError ? `, ${error.oauthError}` : ''}).`;
  }
  return `unexpected error: ${String((error as Error)?.message ?? error).split('\n')[0]}`;
}

async function loginCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({
      args,
      options: {
        email: { type: 'string' },
        'no-browser': { type: 'boolean' },
        'client-id': { type: 'string' },
        scope: { type: 'string' },
        drive: { type: 'boolean' },
        chat: { type: 'boolean' },
        agent: { type: 'string' },
      },
      strict: true,
    }),
  );
  if (values.drive || values.chat) return connectService(values, io, d);
  // a damaged configuration must not stop the sign-in that repairs it
  const saved = await loadConfig(d.paths).catch(() => undefined);
  const email = values.email ?? saved?.email;
  if (!email) throw new TwakeAiError('usage', `--email is required the first time.\n\n${USAGE}`);
  io.stdout(`Looking up the Twake.ai services of ${email.trim()}…\n`);
  const environment = await discover(email, { fetch: d.fetch, resolveSrv: d.resolveSrv });
  for (const [service, endpoint] of Object.entries(environment.services)) {
    if (!endpoint) continue;
    io.stdout(`  ${endpoint.source === 'convention' ? '~' : '✓'} ${service.padEnd(8)} ${endpoint.url}\n`);
  }
  const vault = await d.chooseVault(d.paths);
  const config = await loginOidc(
    {
      email,
      environment,
      client: {
        clientId: values['client-id'] ?? d.env.TWAKE_AI_OIDC_CLIENT_ID ?? saved?.oidc.clientId ?? DEFAULT_CLIENT_ID,
        scope: values.scope ?? saved?.oidc.scope ?? DEFAULT_SCOPE,
      },
      mode: chooseLoginMode({ noBrowser: values['no-browser'] ?? false, env: d.env, platform: d.platform }),
      ports: d.loopbackPorts,
    },
    {
      paths: d.paths,
      vault,
      http: { fetch: d.fetch, now: d.now, sleep: d.sleep },
      openUrl: d.openUrl,
      print: (line) => io.stdout(`${line}\n`),
    },
  );
  const drive = config.environment.cozy.instance;
  io.stdout(`Signed in as ${config.email}.${drive ? ` Twake Drive: ${drive}` : ''}\n`);
  io.stdout(vault.kind === 'keyring' ? 'Session kept in the system keychain.\n' : `Session kept in ${d.paths.vaultFile} (readable by you only).\n`);
  return 0;
}

/** login --drive / login --chat --agent <id>: connects one service on top of the Twake session. */
async function connectService(
  values: { drive?: boolean; chat?: boolean; agent?: string; 'no-browser'?: boolean },
  io: Io,
  d: CliDeps,
): Promise<number> {
  if (values.drive && values.chat) throw new TwakeAiError('usage', `Connect one service at a time.\n\n${USAGE}`);
  if (values.chat && values.agent === undefined) throw new TwakeAiError('usage', `Twake Chat is connected for one agent: add --agent <id>.\n\n${USAGE}`);
  if (values.agent !== undefined) checkAgentId(values.agent);
  const config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'Sign in first: run `twake-ai login --email <address>`.');
  const vault = await openVault(config.vault, d.paths);
  const http = { fetch: d.fetch, now: d.now, sleep: d.sleep };
  const mode = chooseLoginMode({ noBrowser: values['no-browser'] ?? false, env: d.env, platform: d.platform }) === 'browser' ? 'browser' : 'paste';
  const common = { paths: d.paths, vault, http, openUrl: d.openUrl, print: (line: string) => io.stdout(`${line}\n`), readLine: d.readLine };
  const ports = d.loopbackPorts ?? LOOPBACK_PORTS;
  if (values.drive) {
    const oidcToken = async () => (await getToken('mail', { paths: d.paths, config, vault, http: { fetch: d.fetch }, now: d.now })).access_token;
    const updated = await loginDrive(config, mode, { ...common, oidcToken }, ports);
    io.stdout(`Twake Drive connected: ${updated.environment.cozy.instance}\n`);
    return 0;
  }
  const agent = values.agent ?? '';
  const updated = await loginChat(config, agent, mode, common, ports);
  const device = updated.chat?.[agent];
  io.stdout(`Twake Chat connected for ${agent} as ${device?.userId} (device ${device?.deviceId}).\n`);
  return 0;
}

async function tokenCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { positionals, values } = usageErrors(() =>
    parseArgs({ args, options: { agent: { type: 'string' } }, allowPositionals: true, strict: true }),
  );
  if (values.agent !== undefined) checkAgentId(values.agent);
  const [service, ...extra] = positionals;
  if (!service || !isServiceId(service) || extra.length > 0) throw new TwakeAiError('usage', USAGE);
  if (service === 'chat' && values.agent === undefined) {
    throw new TwakeAiError('usage', `A Twake Chat token belongs to an agent: add --agent <id>.\n\n${USAGE}`);
  }
  const config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'twake-ai is not set up on this computer: run `twake-ai login --email <address>`.');
  const token = await getToken(service, {
    paths: d.paths,
    config,
    vault: await openVault(config.vault, d.paths),
    http: { fetch: d.fetch },
    now: d.now,
  }, values.agent);
  io.stdout(`${JSON.stringify(token)}\n`);
  return 0;
}
