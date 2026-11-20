import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { ServiceId } from './broker.js';
import { CATALOG, serviceEnv } from './catalog.js';
import { loadConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { checkAgentId } from './grants.js';
import { entryPoint } from './installer.js';
import type { AppPaths } from './paths.js';
import { proxyShared } from './proxy.js';
import { enterSharedChat, sharedChatEnv, supportsSharedHttp, type SharedChatDeps } from './shared-chat.js';

export interface LaunchDeps {
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  platform: NodeJS.Platform;
  language: 'en' | 'fr';
  timezone: string;
}

/**
 * Starts one MCP server for one agent. Its stdio is the agent's (inherited, so approval requests go both ways untouched);
 * signals are passed on, and its exit code becomes ours. Nothing is ever written to stdout here: that is the MCP channel.
 */
async function requireConfig(paths: AppPaths) {
  const config = await loadConfig(paths);
  if (!config) throw new TwakeAiError('login_required', 'mcp-twake-ai is not set up on this computer: run `mcp-twake-ai login --email <address>`.');
  return config;
}

/** The variables that configure mcp-twake-chat: a shared server takes them from mcp-twake-ai only, never from a client. */
const CHAT_CONFIG_ENV = /^(MATRIX_|MCP_|TOM_|USER_|LOG_LEVEL$)/;

export async function runService(service: ServiceId, agent: string, deps: LaunchDeps): Promise<number> {
  checkAgentId(agent);
  const config = await requireConfig(deps.paths);
  const ctx = (c: typeof config) => ({ config: c, paths: deps.paths, nodePath: deps.nodePath, cliPath: deps.cliPath, platform: deps.platform, language: deps.language, timezone: deps.timezone });
  if (service === 'chat' && (await supportsSharedHttp(deps.paths))) return runSharedChat(agent, deps, ctx);
  const built = serviceEnv(service, agent, ctx(config));
  // what the agent's environment already sets wins (spec §9)
  const env = { ...built, ...deps.env };
  const entry = await entryPoint(deps.paths, service);
  return new Promise((resolve, reject) => {
    const child = spawn(deps.nodePath, [entry], { stdio: 'inherit', env, windowsHide: true });
    const forwarded = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => [signal, () => child.kill(signal)] as const);
    for (const [signal, handler] of forwarded) process.on(signal, handler);
    const cleanup = () => {
      for (const [signal, handler] of forwarded) process.off(signal, handler);
    };
    child.once('error', (error) => {
      cleanup();
      reject(new TwakeAiError('unavailable', `Cannot start ${CATALOG[service].name}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
  });
}

/**
 * `run chat` with a mcp-twake-chat that has the shared mode (spec shared-chat §3): this client joins the agent's one
 * server, started by the first client, and relays its stdio to it until the agent closes it.
 */
async function runSharedChat(agent: string, deps: LaunchDeps, ctx: (config: NonNullable<Awaited<ReturnType<typeof loadConfig>>>) => Parameters<typeof serviceEnv>[2]): Promise<number> {
  // the server serves every client of the agent alike: what one client's environment says about Chat is left out
  const own: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [name, value] of Object.entries(deps.env)) {
    if (value === undefined) continue;
    if (CHAT_CONFIG_ENV.test(name)) ignored.push(name);
    else own[name] = value;
  }
  if (ignored.length > 0) {
    process.stderr.write(`mcp-twake-ai: the shared Twake Chat server ignores ${ignored.sort().join(', ')} from this client's environment: it serves every client of ${agent} alike.\n`);
  }
  const shared: SharedChatDeps = {
    paths: deps.paths,
    env: deps.env,
    nodePath: deps.nodePath,
    // read again at each entry: login --chat may have given the agent another device meanwhile
    buildEnv: async () => ({ ...own, ...serviceEnv('chat', agent, ctx(await requireConfig(deps.paths))), ...sharedChatEnv(deps.paths, agent) }),
    deviceId: async () => (await requireConfig(deps.paths)).chat?.[agent]?.deviceId ?? '',
    stderr: (text) => void process.stderr.write(text),
  };
  const first = await enterSharedChat(agent, shared);
  return proxyShared({
    url: first.url,
    token: first.token,
    name: CATALOG.chat.name,
    version: CATALOG.chat.version,
    reconnect: async () => {
      const next = await enterSharedChat(agent, shared);
      return { url: next.url, token: next.token };
    },
    log: (line) => void process.stderr.write(`mcp-twake-ai: ${line}\n`),
  });
}
