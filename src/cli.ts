import { resolveSrv } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { getToken, isServiceId, SERVICE_IDS, type ServiceId } from './broker.js';
import { DEFAULT_CLIENT_ID, DEFAULT_SCOPE, loadConfig, type TwakeAiConfig } from './config.js';
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
import { fileURLToPath } from 'node:url';
import { detectLanguage, serviceEnv, systemTimezone, type CatalogContext } from './catalog.js';
import { needsConsent, planEntries, wantedEntries, type ActionKind, type EntryAction } from './agents/entries.js';
import { applyAgent, createAdapters, detectAgents, recordOwned } from './agents/index.js';
import { AGENT_IDS, isAgentId, type AgentAdapter, type AgentId } from './agents/types.js';
import { runService } from './launcher.js';
import { defaultServices, exportFiles, writeExport } from './exporter.js';
import { ensureInstalled, type Runner } from './installer.js';
import { resolve as resolvePath } from 'node:path';

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
  /** the user's home folder, where agents keep their settings */
  home: string;
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
  /** npm, replaceable in tests */
  runInstall?: Runner;
  /** absolute paths of node and of mcp-twake-ai's command, written into agent configurations and token commands */
  nodePath: string;
  cliPath: string;
  loopbackPorts?: number[];
}

export function defaultDeps(): CliDeps {
  return {
    paths: appPaths(),
    home: homedir(),
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
    readLine: (question) => readLineFrom(process.stdin, process.stdout, question),
    nodePath: process.execPath,
    cliPath: fileURLToPath(new URL('./bin.js', import.meta.url)),
  };
}

/** One line from `input`; refuses, instead of hanging, when the input closes first (no terminal, `< /dev/null`). */
export function readLineFrom(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input, output });
    let answered = false;
    // 'line' and 'close' are synchronous events: a line followed at once by the end of the input still counts
    rl.once('line', (line) => {
      answered = true;
      rl.close();
      resolve(line);
    });
    rl.once('close', () => {
      if (!answered) reject(new TwakeAiError('login_cancelled', 'No address was pasted (the input closed): run the command again in a terminal.'));
    });
    rl.setPrompt(question);
    rl.prompt();
  });
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

const USAGE = `usage:
  mcp-twake-ai setup --agents <ids|detected> [--services <list>] [--yes] [--force] [--no-browser]
  mcp-twake-ai login [--email <address>] [--no-browser] [--client-id <id>] [--scope <scopes>]
  mcp-twake-ai login --drive [--no-browser]
  mcp-twake-ai login --chat --agent <id> [--no-browser]
  mcp-twake-ai token <${SERVICE_IDS.join('|')}> [--agent <id>]
  mcp-twake-ai run <${SERVICE_IDS.join('|')}> --agent <id>
  mcp-twake-ai export --agent <id> [--services <list>] [--raw] [--out <dir>] [--no-browser]
  mcp-twake-ai --version
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
      case 'setup':
        return await setupCommand(args, io, deps);
      case 'login':
        return await loginCommand(args, io, deps);
      case 'token':
        return await tokenCommand(args, io, deps);
      case 'export':
        return await exportCommand(args, io, deps);
      case 'run':
        return await runCommand(args, deps);
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (error) {
    io.stderr(`mcp-twake-ai: ${describeError(error)}\n`);
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
  if (values.agent !== undefined && !values.chat) throw new TwakeAiError('usage', `--agent goes with --chat.\n\n${USAGE}`);
  if ((values.drive || values.chat) && (values.email !== undefined || values['client-id'] !== undefined || values.scope !== undefined)) {
    throw new TwakeAiError('usage', `--email, --client-id and --scope belong to the Twake sign-in, not to --drive or --chat.\n\n${USAGE}`);
  }
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
  if (!config) throw new TwakeAiError('login_required', 'Sign in first: run `mcp-twake-ai login --email <address>`.');
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
  if (!config) throw new TwakeAiError('login_required', 'mcp-twake-ai is not set up on this computer: run `mcp-twake-ai login --email <address>`.');
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

/** run <service> --agent <id>: what agent configurations start. stdout belongs to the MCP server. */
async function runCommand(args: string[], d: CliDeps): Promise<number> {
  const { positionals, values } = usageErrors(() =>
    parseArgs({ args, options: { agent: { type: 'string' } }, allowPositionals: true, strict: true }),
  );
  const [service, ...extra] = positionals;
  if (!service || !isServiceId(service) || extra.length > 0 || values.agent === undefined) throw new TwakeAiError('usage', USAGE);
  checkAgentId(values.agent);
  return runService(service, values.agent, {
    paths: d.paths,
    env: d.env,
    nodePath: d.nodePath,
    cliPath: d.cliPath,
    platform: d.platform,
    language: detectLanguage(d.env),
    timezone: systemTimezone(),
  });
}

/** export --agent <id>: the configuration files for any agent, after installing the servers they start. */
async function exportCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({
      args,
      options: { agent: { type: 'string' }, services: { type: 'string' }, raw: { type: 'boolean' }, out: { type: 'string' }, 'no-browser': { type: 'boolean' } },
      strict: true,
    }),
  );
  if (values.agent === undefined) throw new TwakeAiError('usage', `export needs --agent <id>: the agent these files are for.\n\n${USAGE}`);
  const agent = checkAgentId(values.agent);
  let config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'Sign in first: run `mcp-twake-ai login --email <address>`.');
  const services = values.services === undefined ? defaultServices(config) : values.services.split(',').map((s) => s.trim());
  for (const service of services) {
    if (!isServiceId(service)) throw new TwakeAiError('usage', `"${service}" is not a Twake.ai service (${SERVICE_IDS.join(', ')}).\n\n${USAGE}`);
  }
  const chosen = services as ServiceId[];
  // every other service is checked before anything is created or installed
  for (const service of chosen) if (service !== 'chat') serviceEnv(service, agent, catalogContext(config, d));
  if (chosen.includes('chat') && !config.chat?.[agent]) {
    if (values.services === undefined) io.stdout(`Twake Chat is included: its device for ${agent} is created now (choose other services with --services).\n`);
    // later, the token command runs inside the MCP server and cannot open a browser: the device is created now
    await connectService({ chat: true, agent, 'no-browser': values['no-browser'] }, io, d);
    config = (await loadConfig(d.paths)) ?? config;
  }
  const ctx = catalogContext(config, d);
  await ensureInstalled(d.paths, chosen, { run: d.runInstall, print: (line) => io.stdout(`${line}\n`) });
  const files = await exportFiles({ agent, services: chosen, raw: values.raw ?? false, twakeAiHome: d.env.TWAKE_AI_HOME }, ctx);
  const out = resolvePath(values.out ?? 'twake-ai-export');
  await writeExport(out, files);
  io.stdout(`Wrote ${Object.keys(files).length} files to ${out}: see its README.md.\n`);
  return 0;
}

function catalogContext(config: TwakeAiConfig, d: CliDeps): CatalogContext {
  return { config, paths: d.paths, nodePath: d.nodePath, cliPath: d.cliPath, platform: d.platform, language: detectLanguage(d.env), timezone: systemTimezone() };
}

const PLAN_LINE: Record<ActionKind, [string, string]> = {
  add: ['+', 'add'],
  update: ['~', 'update'],
  keep: ['=', 'unchanged'],
  remove: ['-', 'remove'],
  forget: ['·', 'already gone'],
  'replace-foreign': ['!', 'replaces an entry configured outside mcp-twake-ai'],
  'replace-modified': ['!', 'replaces an entry changed by hand since mcp-twake-ai wrote it'],
  'remove-modified': ['!', 'removes an entry changed by hand since mcp-twake-ai wrote it'],
};

function printPlan(io: Io, adapter: AgentAdapter, actions: EntryAction[], force: boolean): void {
  io.stdout(`${adapter.label} (${adapter.target})\n`);
  for (const action of actions) {
    const [symbol, words] = PLAN_LINE[action.kind];
    io.stdout(`  ${symbol} ${action.name.padEnd(14)} ${words}${needsConsent(action) && !force ? ': add --force to do it' : ''}\n`);
  }
  if (!adapter.capabilities.elicitation) io.stdout(`  ${adapter.label} cannot show approval requests: reads work, and every write is refused.\n`);
}

/** setup --agents …: writes the Twake.ai servers into the agents (spec §8, non-interactive; §10). */
async function setupCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({
      args,
      options: { agents: { type: 'string' }, services: { type: 'string' }, yes: { type: 'boolean' }, force: { type: 'boolean' }, 'no-browser': { type: 'boolean' } },
      strict: true,
    }),
  );
  const adapters = await createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  const detected = await detectAgents(adapters);
  if (values.agents === undefined) {
    throw new TwakeAiError('usage', `setup needs --agents: ${AGENT_IDS.join(', ')}, or "detected" (found here: ${detected.join(', ') || 'none'}).\n\n${USAGE}`);
  }
  const names = values.agents === 'detected' ? detected : [...new Set(values.agents.split(',').map((name) => name.trim()))];
  for (const name of names) {
    if (!isAgentId(name)) throw new TwakeAiError('usage', `"${name}" is not an agent mcp-twake-ai configures (${AGENT_IDS.join(', ')}): for any other one, use export.\n\n${USAGE}`);
  }
  if (names.length === 0) throw new TwakeAiError('usage', `No agent was found on this computer: name them with --agents.\n\n${USAGE}`);
  const config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'Sign in first: run `mcp-twake-ai login --email <address>`.');
  const services = values.services === undefined ? defaultServices(config) : values.services.split(',').map((s) => s.trim());
  for (const service of services) {
    if (!isServiceId(service)) throw new TwakeAiError('usage', `"${service}" is not a Twake.ai service (${SERVICE_IDS.join(', ')}).\n\n${USAGE}`);
  }
  const chosen = services as ServiceId[];
  const ctx = catalogContext(config, d);
  // what needs no new connection is checked before anything changes
  for (const agent of names) for (const service of chosen) if (service !== 'drive' && service !== 'chat') serviceEnv(service, agent, ctx);
  const env: Record<string, string> = d.env.TWAKE_AI_HOME ? { TWAKE_AI_HOME: d.env.TWAKE_AI_HOME } : {};
  const force = values.force ?? false;
  let failed = false;
  const plans: { adapter: AgentAdapter; owned: Record<string, string>; actions: EntryAction[] }[] = [];
  for (const agent of names as AgentId[]) {
    const adapter = adapters[agent];
    const owned = config.agents?.[agent]?.entries ?? {};
    // one agent's problem (unreadable file, broken entry) never stops the others
    try {
      if (!(await adapter.detect())) {
        io.stdout(`${adapter.label}: not found on this computer (${adapter.target}), left out.\n`);
        continue;
      }
      const actions = planEntries(await adapter.read(), wantedEntries(adapter, chosen, ctx, env), owned);
      plans.push({ adapter, owned, actions });
      printPlan(io, adapter, actions, force);
    } catch (error) {
      failed = true;
      io.stdout(`${adapter.label}: ${describeError(error)}\n`);
    }
  }
  const driveFirst = chosen.includes('drive') && !config.drive;
  const chatFor = chosen.includes('chat') ? plans.map((plan) => plan.adapter.id).filter((agent) => !config.chat?.[agent]) : [];
  if (driveFirst) io.stdout('Twake Drive is connected first, in the browser.\n');
  if (chatFor.length > 0) io.stdout(`Twake Chat gets a device for: ${chatFor.join(', ')}.\n`);
  if (!values.yes) {
    io.stdout('Nothing was changed: run the same command with --yes to apply it.\n');
    return failed ? 1 : 0;
  }
  if (plans.length === 0) return failed ? 1 : 0;
  if (driveFirst) await connectService({ drive: true, 'no-browser': values['no-browser'] }, io, d);
  for (const agent of chatFor) await connectService({ chat: true, agent, 'no-browser': values['no-browser'] }, io, d);
  await ensureInstalled(d.paths, chosen, { run: d.runInstall, print: (line) => io.stdout(`${line}\n`) });
  for (const { adapter, owned, actions } of plans) {
    const result = await applyAgent(adapter, actions, owned, () => force);
    if (result.status === 'failed') {
      failed = true;
      io.stdout(`${adapter.label}: not changed, ${result.error}\n`);
      continue;
    }
    try {
      await recordOwned(d.paths, adapter.id, result.owned);
    } catch (error) {
      failed = true;
      io.stdout(`${adapter.label}: written, but ${d.paths.configFile} could not record it: ${describeError(error)}\n`);
      continue;
    }
    if (result.status === 'unchanged') io.stdout(`${adapter.label}: already up to date.\n`);
    else io.stdout(`${adapter.label}: done${result.backup ? ` (previous file kept as ${result.backup})` : ''}. ${adapter.capabilities.reload}\n`);
    if (result.skipped.length > 0) io.stdout(`  left as they are: ${result.skipped.map((action) => action.name).join(', ')} (add --force to change them)\n`);
  }
  return failed ? 1 : 0;
}
