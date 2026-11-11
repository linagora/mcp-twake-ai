import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathOf, type Place } from './agents/locations.js';
import { TwakeAiError } from './errors.js';
import { npmRunner, serverDir, type Runner } from './installer.js';
import type { AppPaths } from './paths.js';

const PACKAGE = 'mcp-twake-ai';

/** npx runs packages from a cache that npm may empty at any time: entries must not point there. */
export function isNpxCache(cliPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(cliPath);
}

/** Where selfInstall puts mcp-twake-ai's command: known before installing, so that a plan can show it. */
export function selfInstalledCli(paths: AppPaths): string {
  return join(serverDir(paths, PACKAGE), 'node_modules', PACKAGE, 'build', 'bin.js');
}

/** Installs this version of mcp-twake-ai into the private prefix (spec §5.3) and returns its command (build/bin.js). */
export async function selfInstall(paths: AppPaths, version: string, run: Runner = npmRunner): Promise<string> {
  const dir = serverDir(paths, PACKAGE);
  const pkgDir = join(dir, 'node_modules', PACKAGE);
  const installed = async () => {
    try {
      const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as { version?: string };
      return pkg.version;
    } catch {
      return undefined;
    }
  };
  if ((await installed()) !== version) {
    await mkdir(dir, { recursive: true });
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--save-exact', `${PACKAGE}@${version}`]);
    if ((await installed()) !== version) throw new TwakeAiError('unavailable', `npm did not install ${PACKAGE}@${version} into ${dir}.`);
  }
  return selfInstalledCli(paths);
}

/** ~/.local/bin/mcp-twake-ai, or %LOCALAPPDATA%\twake-ai\bin\mcp-twake-ai.cmd on Windows. */
export function shortcutPath(place: Place): string {
  const path = pathOf(place);
  if (place.platform === 'win32') return path.join(place.env.LOCALAPPDATA || path.join(place.home, 'AppData', 'Local'), 'twake-ai', 'bin', `${PACKAGE}.cmd`);
  return path.join(place.home, '.local', 'bin', PACKAGE);
}

const MARK = 'mcp-twake-ai shortcut';

/** What is at the shortcut path: nothing, the shortcut mcp-twake-ai wrote (marked), or a file or link someone else put there. */
async function shortcutState(path: string): Promise<'none' | 'ours' | 'foreign'> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return 'foreign';
    return (await readFile(path, 'utf8')).includes(MARK) ? 'ours' : 'foreign';
  } catch {
    return 'none';
  }
}

/** A command at a stable path for the user (the agents always use absolute paths). Another file there is left alone. */
export async function writeShortcut(place: Place, nodePath: string, cliPath: string): Promise<{ path: string; inPath: boolean; written: boolean }> {
  const path = shortcutPath(place);
  const p = pathOf(place);
  // inside double quotes, sh still expands $ and `, and cmd.exe %: such a path is refused rather than changed
  if (/["%$`\r\n]/.test(nodePath + cliPath)) throw new TwakeAiError('unsupported', `${cliPath} cannot be written into a shortcut: install mcp-twake-ai under another folder.`);
  // cmd.exe reads a .cmd in the OEM code page (accents come out wrong) and may expand !…!
  if (place.platform === 'win32' && /[^\x20-\x7e]|!/.test(nodePath + cliPath)) {
    throw new TwakeAiError('unsupported', `${cliPath} has characters cmd.exe would misread (accents or !): no shortcut is written; run mcp-twake-ai with its full path.`);
  }
  const dirs = (Object.entries(place.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '').split(p.delimiter);
  const inPath = dirs.some((dir) => dir && p.resolve(dir) === p.resolve(p.dirname(path)));
  if ((await shortcutState(path)) === 'foreign') return { path, inPath, written: false };
  await mkdir(p.dirname(path), { recursive: true });
  if (place.platform === 'win32') await writeFile(path, `@rem ${MARK}\r\n@"${nodePath}" "${cliPath}" %*\r\n`);
  else {
    await writeFile(path, `#!/bin/sh\n# ${MARK}\nexec "${nodePath}" "${cliPath}" "$@"\n`);
    await chmod(path, 0o755);
  }
  return { path, inPath, written: true };
}

/** Removes the shortcut mcp-twake-ai wrote, never a file someone else put at that path. */
export async function removeShortcut(place: Place): Promise<void> {
  const path = shortcutPath(place);
  if ((await shortcutState(path)) === 'ours') await rm(path, { force: true });
}
