import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { posix, join, win32 } from 'node:path';
import { isServiceId, SERVICE_IDS, type ServiceId } from './broker.js';
import { CATALOG, serviceEnv, type CatalogContext } from './catalog.js';
import type { TwakeAiConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { readPrivateJson, writePrivateFile } from './files.js';
import { entryPoint, ensureInstalled, serverDir, type Runner } from './installer.js';
import type { AppPaths } from './paths.js';

/**
 * `mcp-twake-ai call|tools <service> …`: the installed server's own command line, started with the Twake.ai
 * sign-in, its server being `mcp-twake-ai run <service> --agent cli` as agents start it (spec CLI §4).
 */
export const CLI_AGENT = 'cli';

/**
 * cli.json, as the six servers find it: in the account's home folder as the system knows it, never under
 * TWAKE_AI_HOME or another variable (a command could otherwise be handed a list of its own).
 */
export function cliSettingsFile(platform: NodeJS.Platform, accountHome: string): string {
  return platform === 'win32'
    ? win32.join(accountHome, 'AppData', 'Roaming', 'twake-ai', 'cli.json')
    : posix.join(accountHome, '.config', 'twake-ai', 'cli.json');
}

export interface CliSettings {
  version: 1;
  allowedUnattended: string[];
  agentMarkers: string[];
}

export const UNATTENDED_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The same rules as the servers': a damaged file is an error, never an empty list written over it. */
export async function readCliSettings(file: string): Promise<CliSettings> {
  const damaged = new TwakeAiError('damaged_file', `${file} is damaged: fix it, or delete it to start again with no allowed names.`);
  let raw: unknown;
  try {
    raw = await readPrivateJson(file);
  } catch (error) {
    if (error instanceof SyntaxError) throw damaged;
    throw error;
  }
  if (raw === undefined) return { version: 1, allowedUnattended: [], agentMarkers: [] };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw damaged;
  const { version, allowedUnattended = [], agentMarkers = [] } = raw as Record<string, unknown>;
  const strings = (value: unknown, pattern: RegExp) => Array.isArray(value) && value.every((v) => typeof v === 'string' && pattern.test(v));
  if (version !== 1 || !strings(allowedUnattended, UNATTENDED_NAME) || !strings(agentMarkers, /^[A-Za-z_][A-Za-z0-9_]*$/)) throw damaged;
  return { version: 1, allowedUnattended: allowedUnattended as string[], agentMarkers: agentMarkers as string[] };
}

export async function writeCliSettings(file: string, settings: CliSettings): Promise<void> {
  await writePrivateFile(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** logout: nobody writes without a terminal any more; the agent markers stay. */
export async function forgetUnattended(file: string): Promise<void> {
  const settings = await readCliSettings(file);
  if (settings.allowedUnattended.length > 0) await writeCliSettings(file, { ...settings, allowedUnattended: [] });
}

/** The server's package.json says it has a command line: `"twake": { "commandLine": 1 }`. */
export async function hasCommandLine(paths: AppPaths, service: ServiceId): Promise<boolean> {
  const pkg = CATALOG[service];
  try {
    const json = JSON.parse(await readFile(join(serverDir(paths, pkg.name), 'node_modules', pkg.name, 'package.json'), 'utf8')) as {
      twake?: { commandLine?: number };
    };
    return (json.twake?.commandLine ?? 0) >= 1;
  } catch {
    return false;
  }
}

export interface DelegateDeps {
  paths: AppPaths;
  config: TwakeAiConfig | undefined;
  context(config: TwakeAiConfig): CatalogContext;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  nodeArgs: string[];
  /** the mcp-twake-ai command agents run (never npx's cache) */
  cliPath: string;
  runInstall?: Runner;
  /** 'inherit' in production; tests read the child's output through stdout/stderr */
  stdio: 'inherit' | 'pipe';
  stdout(text: string): void;
  stderr(text: string): void;
}

export async function delegateCall(command: 'call' | 'tools', args: string[], d: DelegateDeps): Promise<number> {
  const [service, ...rest] = args;
  if (service === undefined || !isServiceId(service)) {
    throw new TwakeAiError('usage', `"${service ?? ''}" is not a Twake.ai service (${SERVICE_IDS.join(', ')}).`);
  }
  if (!d.config) throw new TwakeAiError('login_required', 'mcp-twake-ai is not set up on this computer: run `mcp-twake-ai login --email <address>`.');
  if (service === 'chat' && !d.config.chat?.[CLI_AGENT]) {
    throw new TwakeAiError('login_required', `Twake Chat needs its own device for the command line: run \`mcp-twake-ai login --chat --agent ${CLI_AGENT}\` once.`);
  }
  // said on stderr: stdout is the tool's result
  await ensureInstalled(d.paths, [service], { run: d.runInstall, print: (line) => d.stderr(`${line}\n`) });
  if (!(await hasCommandLine(d.paths, service))) {
    const pkg = CATALOG[service];
    throw new TwakeAiError('unavailable', `${pkg.name} ${pkg.version} has no command line: update mcp-twake-ai, then run \`mcp-twake-ai setup\` again.`);
  }
  const entry = await entryPoint(d.paths, service);
  const env = {
    ...d.env,
    ...serviceEnv(service, CLI_AGENT, d.context(d.config)),
    TWAKE_MCP_CLI_SERVER: JSON.stringify([d.nodePath, ...d.nodeArgs, d.cliPath, 'run', service, '--agent', CLI_AGENT]),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(d.nodePath, [entry, command, ...rest], { stdio: d.stdio, env, windowsHide: true });
    if (d.stdio === 'pipe') {
      child.stdout?.on('data', (chunk: Buffer) => d.stdout(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => d.stderr(chunk.toString('utf8')));
    }
    const forwarded = (['SIGINT', 'SIGTERM'] as const).map((signal) => [signal, () => child.kill(signal)] as const);
    for (const [signal, handler] of forwarded) process.on(signal, handler);
    const cleanup = () => {
      for (const [signal, handler] of forwarded) process.off(signal, handler);
    };
    child.once('error', (error) => {
      cleanup();
      reject(new TwakeAiError('unavailable', `${CATALOG[service].name} could not start: ${error.message}`));
    });
    child.once('close', (code) => {
      cleanup();
      resolve(code ?? 4);
    });
  });
}
