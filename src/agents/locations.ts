import { readFile, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

/** The computer an agent is looked for on: OS, environment and home folder (replaceable in tests). */
export interface Place {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

export const pathOf = (p: Place) => (p.platform === 'win32' ? win32 : posix);

/** The settings folder of a desktop application: Application Support, %APPDATA% or $XDG_CONFIG_HOME. */
function appConfigDir(p: Place, name: string): string {
  if (p.platform === 'darwin') return posix.join(p.home, 'Library', 'Application Support', name);
  if (p.platform === 'win32') return win32.join(p.env.APPDATA || win32.join(p.home, 'AppData', 'Roaming'), name);
  return posix.join(p.env.XDG_CONFIG_HOME || posix.join(p.home, '.config'), name);
}

export const claudeDesktopConfig = (p: Place) => pathOf(p).join(appConfigDir(p, 'Claude'), 'claude_desktop_config.json');

/** Claude Code keeps its user-scope servers in .claude.json, in CLAUDE_CONFIG_DIR or the home folder. */
export const claudeCodeState = (p: Place) => pathOf(p).join(p.env.CLAUDE_CONFIG_DIR || p.home, '.claude.json');

export const cursorConfig = (p: Place) => pathOf(p).join(p.home, '.cursor', 'mcp.json');

/** The default profile's mcp.json; VSCODE_APPDATA moves the whole user data folder. */
export function vscodeConfig(p: Place): string {
  const path = pathOf(p);
  const base = p.env.VSCODE_APPDATA ? path.join(p.env.VSCODE_APPDATA, 'Code') : appConfigDir(p, 'Code');
  return path.join(base, 'User', 'mcp.json');
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Hermes' home: HERMES_HOME, else ~/.hermes (%LOCALAPPDATA%\hermes on Windows), or the active profile in it. */
export async function hermesHome(p: Place): Promise<string> {
  const set = p.env.HERMES_HOME?.trim();
  if (set) return set;
  const path = pathOf(p);
  const root = p.platform === 'win32' ? path.join(p.env.LOCALAPPDATA || path.join(p.home, 'AppData', 'Local'), 'hermes') : path.join(p.home, '.hermes');
  let active = '';
  try {
    active = (await readFile(path.join(root, 'active_profile'), 'utf8')).trim();
  } catch {
    // no profile chosen
  }
  if (/^[A-Za-z0-9_][\w.-]*$/.test(active) && active !== 'default') {
    const profile = path.join(root, 'profiles', active);
    if (await isDirectory(profile)) return profile;
  }
  return root;
}
