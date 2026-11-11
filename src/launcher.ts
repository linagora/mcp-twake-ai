import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { ServiceId } from './broker.js';
import { CATALOG, serviceEnv } from './catalog.js';
import { loadConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { checkAgentId } from './grants.js';
import { entryPoint } from './installer.js';
import type { AppPaths } from './paths.js';

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
export async function runService(service: ServiceId, agent: string, deps: LaunchDeps): Promise<number> {
  checkAgentId(agent);
  const config = await loadConfig(deps.paths);
  if (!config) throw new TwakeAiError('login_required', 'mcp-twake-ai is not set up on this computer: run `mcp-twake-ai login --email <address>`.');
  const built = serviceEnv(service, agent, { config, paths: deps.paths, nodePath: deps.nodePath, cliPath: deps.cliPath, platform: deps.platform, language: deps.language, timezone: deps.timezone });
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
