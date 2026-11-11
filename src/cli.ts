import { resolveSrv } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { getToken, isServiceId, SERVICE_IDS, type ServiceId } from './broker.js';
import { DEFAULT_CLIENT_ID, DEFAULT_SCOPE, loadConfig, saveConfig, type TwakeAiConfig } from './config.js';
import { chooseDav, discover, type DiscoveryDeps } from './discovery.js';
import { TwakeAiError } from './errors.js';
import { describeError } from './describe.js';
import { journal } from './journal.js';
import { logout } from './logout.js';
import { renderBanner, wantsColor } from './banner.js';
import { clackPrompter, type Prompter } from './prompter.js';
import { runWizard, type WizardKit } from './wizard.js';
import { isNpxCache, removeShortcut, selfInstall, selfInstalledCli, writeShortcut } from './self-install.js';
import { forgetSecrets, removeFiles, uninstallPlan } from './uninstall.js';
import { checkChat, checkDrive, checkSession, entryStates, handshake, type Check, type EntryState } from './status.js';
import { chooseLoginMode, loginOidc } from './login.js';
import { appPaths, type AppPaths } from './paths.js';
import { chooseVault, openVault, type Vault } from './vault.js';
import { createInterface } from 'node:readline/promises';
import { checkAgentId, OIDC_GRANT, OIDC_REFRESH_KEY } from './grants.js';
import { revokeToken } from './oidc.js';
import { deleteCachedToken } from './token-cache.js';
import { rm, stat } from 'node:fs/promises';
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
import { ensureInstalled, prefixDir, type Runner } from './installer.js';
import { join, posix, resolve as resolvePath, win32 } from 'node:path';

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
  /** the questions of the guided setup; undefined: clack on the terminal */
  prompter?: Prompter;
  /** stdin and stdout are a terminal: setup without --agents guides the user */
  interactive: boolean;
  /** absolute paths of node and of mcp-twake-ai's command, written into agent configurations and token commands */
  nodePath: string;
  cliPath: string;
  loopbackPorts?: number[];
}

export function defaultDeps(): CliDeps {
  return {
    paths: appPaths(),
    home: homedir(),
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
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
  mcp-twake-ai setup [--email <address>] --agents <ids|detected> [--services <list>] [--yes] [--force] [--no-browser]
  mcp-twake-ai login [--email <address>] [--no-browser] [--client-id <id>] [--scope <scopes>]
  mcp-twake-ai login --drive [--no-browser]
  mcp-twake-ai login --chat --agent <id> [--no-browser]
  mcp-twake-ai token <${SERVICE_IDS.join('|')}> [--agent <id>]
  mcp-twake-ai run <${SERVICE_IDS.join('|')}> --agent <id>
  mcp-twake-ai export --agent <id> [--services <list>] [--raw] [--out <dir>] [--no-browser]
  mcp-twake-ai status [--agents <ids>] [--no-start]
  mcp-twake-ai status --print-env <service> [--agent <id>]
  mcp-twake-ai logout
  mcp-twake-ai uninstall [--yes] [--force] [--delete-chat-stores]
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
  let code: number;
  let failure: string | undefined;
  try {
    code = await dispatch(command, args, io, deps);
  } catch (error) {
    failure = describeError(error);
    io.stderr(`mcp-twake-ai: ${failure}\n`);
    code = error instanceof TwakeAiError && error.code === 'usage' ? 2 : 1;
  }
  // token and run are called all day long by the servers: only their failures are worth a line
  // a finished uninstall has removed the journal: it must not come back
  // whatever its exit code (a revocation may have failed), once config.json is gone uninstall has removed its files
  const uninstalled = command === 'uninstall' && args.includes('--yes') && !(await stat(deps.paths.configFile).then(() => true, () => false));
  if (!uninstalled && (code !== 0 || (command !== 'token' && command !== 'run'))) {
    await journal(deps.paths, `${[command, ...args].join(' ')} → ${code}${failure ? `: ${failure.split('\n')[0]}` : ''}`);
  }
  return code;
}

async function dispatch(command: string | undefined, args: string[], io: Io, deps: CliDeps): Promise<number> {
  switch (command) {
    case '--version':
    case '-v':
      io.stdout(`${packageVersion()}\n`);
      return 0;
    case 'setup':
      return await setupCommand(args, io, deps);
    case 'status':
      return await statusCommand(args, io, deps);
    case 'logout':
      return await logoutCommand(io, deps);
    case 'uninstall':
      return await uninstallCommand(args, io, deps);
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
      findDav: (env, accessToken) => chooseDav(env, accessToken, { fetch: d.fetch }),
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
  if (isNpxCache(d.cliPath)) await selfInstall(d.paths, packageVersion(), d.runInstall);
  await ensureInstalled(d.paths, chosen, { run: d.runInstall, print: (line) => io.stdout(`${line}\n`) });
  const files = await exportFiles({ agent, services: chosen, raw: values.raw ?? false, twakeAiHome: d.env.TWAKE_AI_HOME }, ctx);
  const out = resolvePath(values.out ?? 'twake-ai-export');
  await writeExport(out, files);
  io.stdout(`Wrote ${Object.keys(files).length} files to ${out}: see its README.md.\n`);
  return 0;
}

/** The command agents and token commands run: under npx, the copy installed in the prefix, never npx's cache (spec §5.3). */
function agentCliPath(d: CliDeps): string {
  return isNpxCache(d.cliPath) ? selfInstalledCli(d.paths) : d.cliPath;
}

function catalogContext(config: TwakeAiConfig, d: CliDeps): CatalogContext {
  return { config, paths: d.paths, nodePath: d.nodePath, cliPath: agentCliPath(d), platform: d.platform, language: detectLanguage(d.env), timezone: systemTimezone() };
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

/** hints: whether to suggest --force (not in the guided setup, which asks entry by entry). */
function printPlan(io: Io, adapter: AgentAdapter, actions: EntryAction[], consent: (action: EntryAction) => boolean, hints = true): void {
  io.stdout(`${adapter.label} (${adapter.target})\n`);
  for (const action of actions) {
    const [symbol, words] = PLAN_LINE[action.kind];
    io.stdout(`  ${symbol} ${action.name.padEnd(14)} ${words}${hints && needsConsent(action) && !consent(action) ? ': add --force to do it' : ''}\n`);
  }
  if (!adapter.capabilities.elicitation) io.stdout(`  ${adapter.label} cannot show approval requests: reads work, and every write is refused.\n`);
}

/** setup --agents …: writes the Twake.ai servers into the agents (spec §8, non-interactive; §10). */
interface SetupRequest {
  agents: AgentId[];
  /** undefined: the services found for the account */
  services?: ServiceId[];
  apply: boolean;
  /** an entry mcp-twake-ai did not write, or one changed since, is replaced or removed only with consent */
  consent(agent: AgentId, action: EntryAction): boolean;
  noBrowser?: boolean;
  /** no "run with --yes" hint: the guided setup asks instead */
  quiet?: boolean;
}

/** setup --agents …: the non-interactive setup (spec §8). */
async function setupCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({
      args,
      options: {
        agents: { type: 'string' },
        services: { type: 'string' },
        yes: { type: 'boolean' },
        force: { type: 'boolean' },
        'no-browser': { type: 'boolean' },
        email: { type: 'string' },
      },
      strict: true,
    }),
  );
  const guided = values.agents === undefined && !values.yes && d.interactive;
  if (guided && (values.services !== undefined || values.force)) {
    throw new TwakeAiError('usage', `--services and --force go with --agents: without them, setup asks.\n\n${USAGE}`);
  }
  if (guided) {
    const kit = wizardKit(io, d, { noBrowser: values['no-browser'] });
    return runWizard(kit, d.prompter ?? clackPrompter(), process.versions.node, { email: values.email?.trim() });
  }
  if (values.email !== undefined) {
    // config.json outlives a logout: only a refresh token in the vault is a session, and it must be this account's
    const session = await currentSession(d);
    if (!session || session.email.toLowerCase() !== values.email.trim().toLowerCase()) {
      const code = await loginCommand(['--email', values.email, ...(values['no-browser'] ? ['--no-browser'] : [])], io, d);
      if (code !== 0) return code;
    }
  }
  const adapters = await createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  const detected = await detectAgents(adapters);
  if (values.agents === undefined) {
    throw new TwakeAiError(
      'usage',
      `setup needs --agents: ${AGENT_IDS.join(', ')}, or "detected" (found here: ${detected.join(', ') || 'none'}) — or run it in a terminal for the guided setup.\n\n${USAGE}`,
    );
  }
  const names = values.agents === 'detected' ? detected : [...new Set(values.agents.split(',').map((name) => name.trim()))];
  for (const name of names) {
    if (!isAgentId(name)) throw new TwakeAiError('usage', `"${name}" is not an agent mcp-twake-ai configures (${AGENT_IDS.join(', ')}): for any other one, use export.\n\n${USAGE}`);
  }
  if (names.length === 0) throw new TwakeAiError('usage', `No agent was found on this computer: name them with --agents.\n\n${USAGE}`);
  const services = values.services === undefined ? undefined : values.services.split(',').map((service) => service.trim());
  for (const service of services ?? []) {
    if (!isServiceId(service)) throw new TwakeAiError('usage', `"${service}" is not a Twake.ai service (${SERVICE_IDS.join(', ')}).\n\n${USAGE}`);
  }
  const force = values.force ?? false;
  const request = { agents: names as AgentId[], services: services as ServiceId[] | undefined, apply: values.yes ?? false, consent: () => force, noBrowser: values['no-browser'] };
  return (await runSetup(request, io, d)).code;
}

/** Plans, and with apply connects, installs and writes, the agents of a setup; shared by both setups. */
async function runSetup(request: SetupRequest, io: Io, d: CliDeps): Promise<{ code: number; conflicts: { agent: AgentId; action: EntryAction }[]; written: AgentId[] }> {
  const config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'Sign in first: run `mcp-twake-ai login --email <address>`.');
  const chosen = request.services ?? defaultServices(config);
  const names = request.agents;
  const adapters = await createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  // under npx the entries must not point into npx's cache: mcp-twake-ai installs itself into the prefix (spec §5.3)
  const fromNpx = isNpxCache(d.cliPath);
  const cliPath = agentCliPath(d);
  const ctx = catalogContext(config, d);
  // what needs no new connection is checked before anything changes
  for (const agent of names) for (const service of chosen) if (service !== 'drive' && service !== 'chat') serviceEnv(service, agent, ctx);
  const env: Record<string, string> = d.env.TWAKE_AI_HOME ? { TWAKE_AI_HOME: d.env.TWAKE_AI_HOME } : {};
  let failed = false;
  const plans: { adapter: AgentAdapter; owned: Record<string, string>; actions: EntryAction[] }[] = [];
  for (const agent of names) {
    const adapter = adapters[agent];
    const owned = config.agents?.[agent]?.entries ?? {};
    // one agent's problem (unreadable file, broken entry) never stops the others
    try {
      if (!(await adapter.detect())) {
        // an agent asked for and not set up: the setup is not complete
        failed = true;
        io.stdout(adapter.id === 'claude-code' ? 'Claude Code: the claude command is not in PATH, left out.\n' : `${adapter.label}: not found on this computer (${adapter.target}), left out.\n`);
        continue;
      }
      const actions = planEntries(await adapter.read(), wantedEntries(adapter, chosen, ctx, env), owned);
      plans.push({ adapter, owned, actions });
      printPlan(io, adapter, actions, (action) => request.consent(adapter.id, action), !request.quiet);
    } catch (error) {
      failed = true;
      io.stdout(`${adapter.label}: ${describeError(error)}\n`);
    }
  }
  const driveFirst = chosen.includes('drive') && !config.drive;
  const chatFor = chosen.includes('chat') ? plans.map((plan) => plan.adapter.id).filter((agent) => !config.chat?.[agent]) : [];
  if (driveFirst) io.stdout('Twake Drive is connected first, in the browser.\n');
  if (chatFor.length > 0) io.stdout(`Twake Chat gets a device for: ${chatFor.join(', ')}.\n`);
  const conflicts = plans.flatMap((plan) => plan.actions.filter(needsConsent).map((action) => ({ agent: plan.adapter.id, action })));
  const written: AgentId[] = [];
  const result = (code: number) => ({ code, conflicts, written });
  if (!request.apply) {
    if (!request.quiet && plans.length > 0) io.stdout('Nothing was changed: run the same command with --yes to apply it.\n');
    return result(failed ? 1 : 0);
  }
  if (plans.length === 0) return result(failed ? 1 : 0);
  if (driveFirst) await connectService({ drive: true, 'no-browser': request.noBrowser }, io, d);
  for (const agent of chatFor) await connectService({ chat: true, agent, 'no-browser': request.noBrowser }, io, d);
  if (fromNpx) await selfInstall(d.paths, packageVersion(), d.runInstall);
  await ensureInstalled(d.paths, chosen, { run: d.runInstall, print: (line) => io.stdout(`${line}\n`) });
  for (const { adapter, owned, actions } of plans) {
    const result = await applyAgent(adapter, actions, owned, (action) => request.consent(adapter.id, action));
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
    written.push(adapter.id);
    if (result.status === 'unchanged') io.stdout(`${adapter.label}: already up to date.\n`);
    else io.stdout(`${adapter.label}: done${result.backup ? ` (previous file kept as ${result.backup})` : ''}. ${adapter.capabilities.reload}\n`);
    if (result.skipped.length > 0) {
      // in the guided setup an entry left alone is the user's own answer, not a failure
      if (!request.quiet) failed = true;
      io.stdout(`  left as they are: ${result.skipped.map((action) => action.name).join(', ')}${request.quiet ? '' : ' (add --force to change them)'}\n`);
    }
  }
  if (fromNpx && written.length > 0) {
    // a convenience: its failure never fails the setup
    try {
      const shortcut = await writeShortcut({ platform: d.platform, env: d.env, home: d.home }, d.nodePath, cliPath);
      if (!shortcut.written) io.stdout(`${shortcut.path} is not mcp-twake-ai's: it is left as it is.\n`);
      else io.stdout(`The mcp-twake-ai command is in ${shortcut.path}.${shortcut.inPath ? '' : ` Add ${pathOfPlatform(d.platform).dirname(shortcut.path)} to your PATH to type it from anywhere.`}\n`);
    } catch (error) {
      io.stdout(`${describeError(error)}\n`);
    }
  }
  return result(failed ? 1 : 0);
}

const STATE_LINE: Record<EntryState['state'], [string, string]> = {
  ok: ['✓', 'in place'],
  missing: ['✗', 'missing: run setup again'],
  modified: ['!', 'changed by hand since mcp-twake-ai wrote it'],
  foreign: ['!', 'configured outside mcp-twake-ai'],
  'no-node': ['✗', 'its node is gone (updated with nvm?): run setup again'],
};

const mark = (check: Check) => (check.ok ? '✓' : '✗');

/** status: the session, Drive, each agent's entries and Chat device, and a handshake with each server (spec §12.2). */
async function statusCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({
      args,
      // --env is kept as a deprecated alias: setup --env sets a variable, status --print-env shows one
      options: { agents: { type: 'string' }, 'no-start': { type: 'boolean' }, 'print-env': { type: 'string' }, env: { type: 'string' }, agent: { type: 'string' } },
      strict: true,
    }),
  );
  const config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'mcp-twake-ai is not set up on this computer: run `mcp-twake-ai login --email <address>`.');
  const printed = values['print-env'] ?? values.env;
  if (printed !== undefined) {
    if (!isServiceId(printed)) throw new TwakeAiError('usage', `"${printed}" is not a Twake.ai service (${SERVICE_IDS.join(', ')}).\n\n${USAGE}`);
    const env = serviceEnv(printed, checkAgentId(values.agent ?? 'agent'), catalogContext(config, d));
    for (const [key, value] of Object.entries(env)) io.stdout(`${key}=${value}\n`);
    return 0;
  }
  const vault = await openVault(config.vault, d.paths);
  const broker = { paths: d.paths, config, vault, http: { fetch: d.fetch, now: d.now, sleep: d.sleep }, now: d.now };
  let healthy = true;
  const report = (check: Check, label: string) => {
    healthy &&= check.ok;
    io.stdout(`${mark(check)} ${label}: ${check.detail}\n`);
  };
  report(await checkSession(broker), 'Twake session');
  if (config.drive) report(await checkDrive(broker), 'Twake Drive');
  const adapters = await createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  const wanted = values.agents === undefined ? (Object.keys(config.agents ?? {}).filter(isAgentId) as AgentId[]) : values.agents.split(',').map((name) => name.trim());
  for (const name of wanted) {
    if (!isAgentId(name)) throw new TwakeAiError('usage', `"${name}" is not an agent mcp-twake-ai configures (${AGENT_IDS.join(', ')}).\n\n${USAGE}`);
    const adapter = adapters[name];
    io.stdout(`${adapter.label} (${adapter.target})\n`);
    if (!(await adapter.detect())) {
      healthy = false;
      io.stdout('  ✗ not found on this computer\n');
      continue;
    }
    let states: EntryState[];
    try {
      states = await entryStates(adapter, config.agents?.[name]?.entries ?? {});
    } catch (error) {
      healthy = false;
      io.stdout(`  ✗ ${describeError(error)}\n`);
      continue;
    }
    if (states.length === 0) io.stdout('  no Twake.ai entry: run setup\n');
    for (const state of states) {
      let [symbol, words] = STATE_LINE[state.state];
      if (state.state === 'ok' && !values['no-start']) {
        const started = await handshake(state.entry as { command: string; args: string[]; env?: Record<string, string> }, d.env);
        [symbol, words] = started.ok ? ['✓', `starts, ${started.detail}`] : ['✗', started.detail];
      }
      healthy &&= symbol === '✓';
      io.stdout(`  ${symbol} ${state.name.padEnd(14)} ${words}\n`);
    }
    if (states.some((state) => state.service === 'chat')) {
      const chat = await checkChat(broker, name);
      healthy &&= chat.ok;
      io.stdout(`  ${mark(chat)} Twake Chat (${name}): ${chat.detail}\n`);
    }
  }
  return healthy ? 0 : 1;
}

/** logout: revokes every authorization and forgets the secrets (spec §7.3). */
async function logoutCommand(io: Io, d: CliDeps): Promise<number> {
  const config = await loadConfig(d.paths);
  if (!config) {
    io.stdout('Nothing to sign out of: mcp-twake-ai is not set up on this computer.\n');
    return 0;
  }
  const vault = await openVault(config.vault, d.paths);
  const { done, failed } = await logout({ paths: d.paths, config, vault, http: { fetch: d.fetch, now: d.now, sleep: d.sleep } });
  for (const line of done) io.stdout(`✓ ${line}\n`);
  for (const line of failed) io.stdout(`✗ ${line}\n`);
  io.stdout(failed.length ? 'The secrets are forgotten here; what could not be revoked expires on its own, or can be removed from your Twake account.\n' : 'Signed out. Run mcp-twake-ai login to sign in again.\n');
  return failed.length ? 1 : 0;
}

/** uninstall: removes the entries written, signs out, deletes what mcp-twake-ai installed (spec §12.3). */
async function uninstallCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({ args, options: { yes: { type: 'boolean' }, force: { type: 'boolean' }, 'delete-chat-stores': { type: 'boolean' } }, strict: true }),
  );
  const force = values.force ?? false;
  let config: TwakeAiConfig | undefined;
  let unreadable = false;
  try {
    config = await loadConfig(d.paths);
  } catch (error) {
    // without it, nothing tells which entries and authorizations are mcp-twake-ai's
    if (!force) {
      throw new TwakeAiError(
        'damaged_file',
        `${d.paths.configFile} cannot be read (${describeError(error)}): fix it, or run uninstall --yes --force to remove mcp-twake-ai's files anyway (the agents keep their entries).`,
      );
    }
    unreadable = true;
  }
  const adapters = await createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  const plans = config ? await uninstallPlan(config, adapters) : [];
  for (const { adapter, actions } of plans) printPlan(io, adapter, actions, () => force);
  const chat = join(d.paths.dataDir, 'chat');
  io.stdout(`${config ? 'Sign out of Twake.ai, then remove' : 'Remove'} ${prefixDir(d.paths)}, the configuration, the cache and the journal.\n`);
  io.stdout(values['delete-chat-stores'] ? `Delete the Twake Chat stores in ${chat}.\n` : `Twake Chat stores kept in ${chat} (add --delete-chat-stores to delete them).\n`);
  if (!values.yes) {
    io.stdout('Nothing was changed: run the same command with --yes to do it.\n');
    return 0;
  }
  // the entries an agent still has (skipped, or its write failed) stay recorded
  const left: Record<string, { entries: Record<string, string> }> = {};
  let revocationFailed = false;
  for (const { adapter, owned, actions } of plans) {
    const result = await applyAgent(adapter, actions, owned, () => force);
    if (result.status === 'failed') {
      left[adapter.id] = { entries: owned };
      io.stdout(`${adapter.label}: not changed, ${result.error}\n`);
      continue;
    }
    io.stdout(`${adapter.label}: ${result.status === 'written' ? 'entries removed' : 'nothing to remove'}.\n`);
    if (result.skipped.length > 0) {
      left[adapter.id] = { entries: result.owned };
      io.stdout(`  left as they are: ${result.skipped.map((action) => action.name).join(', ')} (add --force to remove them)\n`);
    }
  }
  if (config) {
    const vault = await openVault(config.vault, d.paths);
    const { done: revoked, failed: notRevoked } = await logout({ paths: d.paths, config, vault, http: { fetch: d.fetch, now: d.now, sleep: d.sleep } });
    for (const line of revoked) io.stdout(`✓ ${line}\n`);
    for (const line of notRevoked) io.stdout(`✗ ${line}\n`);
    revocationFailed = notRevoked.length > 0;
  }
  if (unreadable) await forgetSecrets(d.paths);
  const keepConfig = Object.keys(left).length > 0;
  if (keepConfig) {
    const remaining = await loadConfig(d.paths);
    if (remaining) await saveConfig(d.paths, { ...remaining, agents: left });
  }
  await removeFiles(d.paths, values['delete-chat-stores'] ?? false, keepConfig);
  await removeShortcut({ platform: d.platform, env: d.env, home: d.home });
  if (keepConfig) {
    io.stdout(`Some entries are still in place and recorded in ${d.paths.configFile}: run uninstall --yes --force to remove them, or remove them by hand.\n`);
    return 1;
  }
  // run from npx's cache, there is no global install to remove
  const command = isNpxCache(d.cliPath) ? '' : ' Remove the command itself with: npm uninstall -g mcp-twake-ai';
  io.stdout(`mcp-twake-ai is uninstalled.${values['delete-chat-stores'] ? '' : ` Twake Chat stores kept in ${chat}.`}${command}\n`);
  // the files are gone, but an authorization may still be alive at the server: say so with the exit code
  return revocationFailed ? 1 : 0;
}

const SERVICE_LABELS: Record<ServiceId, string> = { mail: 'Mail', dav: 'Calendar & contacts', drive: 'Drive', chat: 'Chat', space: 'Space', project: 'Project' };

/** What the guided setup uses: signing in, planning and writing go through the very code of the commands. */
/** The signed-in account, only when the vault still holds its refresh token (config.json outlives a logout). */
async function currentSession(d: CliDeps): Promise<TwakeAiConfig | undefined> {
  const config = await loadConfig(d.paths).catch(() => undefined);
  if (!config) return undefined;
  try {
    return (await (await openVault(config.vault, d.paths)).get(OIDC_REFRESH_KEY)) ? config : undefined;
  } catch {
    return undefined;
  }
}

function wizardKit(io: Io, d: CliDeps, options: { noBrowser?: boolean } = {}): WizardKit {
  // what was there before this setup signed in: giving up puts it back
  let before: { config?: TwakeAiConfig; refresh?: string } | undefined;
  const adaptersOf = () => createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  const capture = (): Io & { text: string } => {
    const captured = {
      text: '',
      stdout: (text: string) => {
        captured.text += text;
      },
      stderr: (text: string) => {
        captured.text += text;
      },
    };
    return captured;
  };
  return {
    // setup speaks English; French only when asked for (the servers still follow the system's language)
    lang: d.env.TWAKE_AI_LANGUAGE === 'fr' ? 'fr' : 'en',
    banner: () => renderBanner({ version: packageVersion(), color: wantsColor(d.env, Boolean(process.stdout.isTTY)) }),
    session: async () => {
      const config = await currentSession(d);
      return config ? { email: config.email } : undefined;
    },
    signIn: async (email) => {
      if (!before) {
        const config = await loadConfig(d.paths).catch(() => undefined);
        const refresh = config ? await openVault(config.vault, d.paths).then((vault) => vault.get(OIDC_REFRESH_KEY)).catch(() => undefined) : undefined;
        before = { config, refresh };
      }
      const code = await loginCommand(['--email', email, ...(options.noBrowser ? ['--no-browser'] : [])], io, d);
      const config = await loadConfig(d.paths);
      if (code !== 0 || !config) throw new TwakeAiError('login_cancelled', `The sign-in of ${email} did not complete.`);
      return { email: config.email };
    },
    agents: async () => {
      const adapters = await adaptersOf();
      const detected = new Set(await detectAgents(adapters));
      return AGENT_IDS.map((id) => ({ id, label: adapters[id].label, detected: detected.has(id), elicitation: adapters[id].capabilities.elicitation }));
    },
    services: async () => {
      const config = await loadConfig(d.paths);
      const preselected = new Set<ServiceId>(config ? defaultServices(config) : []);
      const found = config?.environment.services ?? {};
      // only what exists for the account: Mail, Calendar, Space and Project once found, Drive with an instance, Chat always
      const available = SERVICE_IDS.filter((id) => {
        if (id === 'chat') return true;
        if (id === 'drive') return Boolean(config?.environment.cozy.instance);
        return found[id] !== undefined;
      });
      if (config?.environment.cozy.instance) preselected.add('drive');
      return available.map((id) => ({ id, label: SERVICE_LABELS[id], preselected: preselected.has(id) }));
    },
    plan: async (agents, services) => {
      const out = capture();
      const planned = await runSetup({ agents, services, apply: false, consent: () => false, quiet: true }, out, d);
      const adapters = await adaptersOf();
      const conflicts = planned.conflicts.map(({ agent, action }) => ({
        agent,
        label: adapters[agent].label,
        name: action.name,
        key: `${agent}/${action.name}`,
        removal: action.kind === 'remove-modified',
      }));
      return { text: out.text.trimEnd(), conflicts };
    },
    apply: async (agents, services, accepted) => {
      const consent = (agent: AgentId, action: EntryAction) => accepted.has(`${agent}/${action.name}`);
      const applied = await runSetup({ agents, services, apply: true, consent, noBrowser: options.noBrowser, quiet: true }, io, d);
      const adapters = await adaptersOf();
      return { code: applied.code, reload: applied.written.map((agent) => `${adapters[agent].label}: ${adapters[agent].capabilities.reload}`) };
    },
    check: async (agents) => {
      const config = await loadConfig(d.paths);
      const adapters = await adaptersOf();
      const lines: { ok: boolean; line: string }[] = [];
      for (const agent of agents) {
        const adapter = adapters[agent];
        let states: EntryState[];
        try {
          states = await entryStates(adapter, config?.agents?.[agent]?.entries ?? {});
        } catch (error) {
          lines.push({ ok: false, line: `✗ ${adapter.label}: ${describeError(error)}` });
          continue;
        }
        for (const state of states.filter((candidate) => candidate.state === 'ok')) {
          const started = await handshake(state.entry as { command: string; args: string[]; env?: Record<string, string> }, d.env);
          lines.push({ ok: started.ok, line: `${started.ok ? '✓' : '✗'} ${adapter.label} · ${state.name} ${started.ok ? `starts, ${started.detail}` : started.detail}` });
        }
      }
      return lines;
    },
    revoke: async () => {
      // only the sign-in made by this setup: the session, Drive client and Chat devices from before stay as they were
      const config = await loadConfig(d.paths).catch(() => undefined);
      if (!config) return;
      const vault = await openVault(config.vault, d.paths);
      const minted = await vault.get(OIDC_REFRESH_KEY);
      if (minted && minted !== before?.refresh) await revokeToken(config.environment.oidc, config.oidc, minted, { fetch: d.fetch }).catch(() => undefined);
      await deleteCachedToken(d.paths, OIDC_GRANT);
      if (before?.config) {
        await saveConfig(d.paths, before.config);
        if (before.config.vault !== config.vault) await vault.delete(OIDC_REFRESH_KEY).catch(() => undefined);
        const previous = await openVault(before.config.vault, d.paths);
        if (before.refresh) await previous.set(OIDC_REFRESH_KEY, before.refresh);
        else await previous.delete(OIDC_REFRESH_KEY).catch(() => undefined);
      } else {
        await vault.delete(OIDC_REFRESH_KEY).catch(() => undefined);
        await rm(d.paths.configFile, { force: true });
      }
    },
    describe: describeError,
  };
}

const pathOfPlatform = (platform: NodeJS.Platform) => (platform === 'win32' ? win32 : posix);
