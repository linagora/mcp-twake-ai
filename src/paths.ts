import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export interface PlatformInfo {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

export interface AppPaths {
  configDir: string;
  cacheDir: string;
  dataDir: string;
  stateDir: string;
  configFile: string;
  vaultFile: string;
  tokensDir: string;
  locksDir: string;
}

export function currentPlatform(): PlatformInfo {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/** Where twake-ai keeps its files. TWAKE_AI_HOME groups them all under one directory (tests, several accounts). */
export function appPaths(p: PlatformInfo = currentPlatform()): AppPaths {
  const path = p.platform === 'win32' ? win32 : posix;
  let configDir: string;
  let cacheDir: string;
  let dataDir: string;
  let stateDir: string;
  const root = p.env.TWAKE_AI_HOME;
  if (root) {
    configDir = path.join(root, 'config');
    cacheDir = path.join(root, 'cache');
    dataDir = path.join(root, 'data');
    stateDir = path.join(root, 'state');
  } else if (p.platform === 'win32') {
    const roaming = p.env.APPDATA || path.join(p.home, 'AppData', 'Roaming');
    const local = p.env.LOCALAPPDATA || path.join(p.home, 'AppData', 'Local');
    configDir = path.join(roaming, 'twake-ai');
    dataDir = path.join(local, 'twake-ai');
    cacheDir = path.join(local, 'twake-ai', 'cache');
    stateDir = path.join(local, 'twake-ai', 'state');
  } else {
    configDir = path.join(p.env.XDG_CONFIG_HOME || path.join(p.home, '.config'), 'twake-ai');
    cacheDir = path.join(p.env.XDG_CACHE_HOME || path.join(p.home, '.cache'), 'twake-ai');
    dataDir = path.join(p.env.XDG_DATA_HOME || path.join(p.home, '.local', 'share'), 'twake-ai');
    stateDir = path.join(p.env.XDG_STATE_HOME || path.join(p.home, '.local', 'state'), 'twake-ai');
  }
  return {
    configDir,
    cacheDir,
    dataDir,
    stateDir,
    configFile: path.join(configDir, 'config.json'),
    vaultFile: path.join(configDir, 'secrets.json'),
    tokensDir: path.join(cacheDir, 'tokens'),
    locksDir: path.join(stateDir, 'locks'),
  };
}
