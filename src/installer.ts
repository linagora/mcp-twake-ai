import { exec, execFile, type ExecException } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceId } from './broker.js';
import { CATALOG, commandLine, type McpPackage } from './catalog.js';
import { TwakeAiError } from './errors.js';
import type { AppPaths } from './paths.js';

export type Runner = (command: string, args: string[]) => Promise<void>;

/** The private prefix the pinned MCP servers are installed into: agents start them from there, never through npx. */
export function prefixDir(paths: AppPaths): string {
  return join(paths.dataDir, 'prefix');
}

/**
 * One folder per server under the prefix: their dependency trees never mix. Hoisted together, matrix-js-sdk's
 * @babel/runtime 8 replaced the 7 that cozy-client (mcp-twake-drive) imports without declaring it.
 */
export function serverDir(paths: AppPaths, name: string): string {
  return join(prefixDir(paths), name);
}

const packageDir = (paths: AppPaths, name: string) => join(serverDir(paths, name), 'node_modules', name);

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
    throw new TwakeAiError('unsupported', `${pkg.name} is not installed for mcp-twake-ai: run \`mcp-twake-ai export --agent <id>\`.`);
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin?.[pkg.name] ?? Object.values(manifest.bin ?? {})[0]);
  if (!bin) throw new TwakeAiError('bad_response', `${pkg.name} declares no command to start.`);
  return join(packageDir(paths, pkg.name), bin);
}

/** The useful part of npm's error output: its `npm error` lines, without the pointer to the log file. */
export function npmFailure(stderr: string): string {
  const errors = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^npm (error|ERR!)/.test(line) && !/complete log of this run/i.test(line))
    .map((line) => line.replace(/^npm (error|ERR!)\s*/, ''));
  return errors.slice(0, 3).join(' — ') || stderr.trim().split('\n').at(-1) || '';
}

/** npm 11 blocks install scripts and refuses --allow-scripts for a project: the prefix's package.json allows sqlite3's (the native module of mcp-twake-chat). */
async function allowSqliteBuild(dir: string): Promise<void> {
  const file = join(dir, 'package.json');
  let manifest: Record<string, unknown> = {};
  try {
    manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  } catch {
    // first install
  }
  const allowScripts = { ...((manifest.allowScripts as Record<string, boolean> | undefined) ?? {}), sqlite3: true };
  await writeFile(file, `${JSON.stringify({ name: 'twake-ai-servers', ...manifest, private: true, allowScripts }, null, 2)}\n`);
}

export const npmRunner: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    const done = (error: ExecException | null, _stdout: string, stderr: string) => {
      if (!error) return resolve();
      reject(new TwakeAiError('unavailable', `npm could not install the Twake.ai MCP servers: ${npmFailure(String(stderr)) || error.message}`));
    };
    const options = { maxBuffer: 16 * 1024 * 1024, windowsHide: true };
    // npm is npm.cmd on Windows, which only starts through cmd.exe: one command line, each argument quoted
    if (process.platform === 'win32') exec(commandLine([command, ...args], 'win32'), options, done);
    else execFile(command, args, options, done);
  });

/** Installs the pinned servers that are missing or at another version, and says what it installed. */
export async function ensureInstalled(paths: AppPaths, services: ServiceId[], deps: { run?: Runner; print(line: string): void }): Promise<string[]> {
  const missing: McpPackage[] = [];
  for (const service of [...new Set(services)]) {
    const pkg = CATALOG[service];
    if ((await installedVersion(paths, pkg.name)) !== pkg.version) missing.push(pkg);
  }
  if (missing.length === 0) return [];
  deps.print(`Installing ${missing.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ')}…`);
  for (const pkg of missing) {
    const dir = serverDir(paths, pkg.name);
    await mkdir(dir, { recursive: true });
    await allowSqliteBuild(dir);
    await (deps.run ?? npmRunner)(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
      'install',
      '--prefix',
      dir,
      '--no-audit',
      '--no-fund',
      '--save-exact',
      `${pkg.name}@${pkg.version}`,
    ]);
  }
  return missing.map((pkg) => `${pkg.name}@${pkg.version}`);
}
