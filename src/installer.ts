import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceId } from './broker.js';
import { CATALOG } from './catalog.js';
import { TwakeAiError } from './errors.js';
import type { AppPaths } from './paths.js';

export type Runner = (command: string, args: string[]) => Promise<void>;

/** The private prefix the pinned MCP servers are installed into: agents start them from there, never through npx. */
export function prefixDir(paths: AppPaths): string {
  return join(paths.dataDir, 'prefix');
}

const packageDir = (paths: AppPaths, name: string) => join(prefixDir(paths), 'node_modules', name);

export async function installedVersion(paths: AppPaths, name: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(join(packageDir(paths, name), 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** The JS file that starts an installed MCP server: its package's bin. */
export async function entryPoint(paths: AppPaths, service: ServiceId): Promise<string> {
  const pkg = CATALOG[service];
  let manifest: { bin?: string | Record<string, string> };
  try {
    manifest = JSON.parse(await readFile(join(packageDir(paths, pkg.name), 'package.json'), 'utf8')) as typeof manifest;
  } catch {
    throw new TwakeAiError('unsupported', `${pkg.name} is not installed for twake-ai: run \`twake-ai export --agent <id>\`.`);
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin?.[pkg.name] ?? Object.values(manifest.bin ?? {})[0]);
  if (!bin) throw new TwakeAiError('bad_response', `${pkg.name} declares no command to start.`);
  return join(packageDir(paths, pkg.name), bin);
}

const npmRunner: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    // npm is npm.cmd on Windows, which Node only starts through a shell
    execFile(command, args, { shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail = String(stderr).trim().split('\n').at(-1) || error.message;
      reject(new TwakeAiError('unavailable', `npm could not install the Twake.ai MCP servers: ${detail}`));
    });
  });

/** Installs the pinned servers that are missing or at another version, and says what it installed. */
export async function ensureInstalled(paths: AppPaths, services: ServiceId[], deps: { run?: Runner; print(line: string): void }): Promise<string[]> {
  const missing: string[] = [];
  for (const service of [...new Set(services)]) {
    const pkg = CATALOG[service];
    if ((await installedVersion(paths, pkg.name)) !== pkg.version) missing.push(`${pkg.name}@${pkg.version}`);
  }
  if (missing.length === 0) return [];
  const prefix = prefixDir(paths);
  await mkdir(prefix, { recursive: true });
  deps.print(`Installing ${missing.join(', ')}…`);
  const windows = process.platform === 'win32';
  await (deps.run ?? npmRunner)(windows ? 'npm.cmd' : 'npm', [
    'install',
    '--prefix',
    windows ? `"${prefix}"` : prefix,
    '--no-audit',
    '--no-fund',
    '--save-exact',
    // npm 11 blocks install scripts; mcp-twake-chat needs the one of sqlite3 (its native module)
    '--allow-scripts=sqlite3',
    ...missing,
  ]);
  return missing;
}
