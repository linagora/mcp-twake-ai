import { stat } from 'node:fs/promises';
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
