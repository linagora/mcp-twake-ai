import { describe, expect, it } from 'vitest';
import { appPaths } from '../src/paths.js';

describe('appPaths', () => {
  it('follows the XDG defaults on Linux and macOS', () => {
    const p = appPaths({ platform: 'linux', env: {}, home: '/home/alice' });
    expect(p.configFile).toBe('/home/alice/.config/twake-ai/config.json');
    expect(p.vaultFile).toBe('/home/alice/.config/twake-ai/secrets.json');
    expect(p.tokensDir).toBe('/home/alice/.cache/twake-ai/tokens');
    expect(p.dataDir).toBe('/home/alice/.local/share/twake-ai');
    expect(p.locksDir).toBe('/home/alice/.local/state/twake-ai/locks');
    expect(appPaths({ platform: 'darwin', env: {}, home: '/Users/alice' }).configDir).toBe('/Users/alice/.config/twake-ai');
  });

  it('honours the XDG variables', () => {
    const p = appPaths({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/conf', XDG_CACHE_HOME: '/x/cache' }, home: '/home/alice' });
    expect(p.configFile).toBe('/x/conf/twake-ai/config.json');
    expect(p.tokensDir).toBe('/x/cache/twake-ai/tokens');
  });

  it('uses APPDATA and LOCALAPPDATA on Windows, spaces included', () => {
    const p = appPaths({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\Al Ice\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Al Ice\\AppData\\Local' },
      home: 'C:\\Users\\Al Ice',
    });
    expect(p.configFile).toBe('C:\\Users\\Al Ice\\AppData\\Roaming\\twake-ai\\config.json');
    expect(p.dataDir).toBe('C:\\Users\\Al Ice\\AppData\\Local\\twake-ai');
    expect(p.tokensDir).toBe('C:\\Users\\Al Ice\\AppData\\Local\\twake-ai\\cache\\tokens');
  });

  it('groups everything under TWAKE_AI_HOME', () => {
    const p = appPaths({ platform: 'linux', env: { TWAKE_AI_HOME: '/tmp/t' }, home: '/home/alice' });
    expect(p.configFile).toBe('/tmp/t/config/config.json');
    expect(p.tokensDir).toBe('/tmp/t/cache/tokens');
    expect(p.locksDir).toBe('/tmp/t/state/locks');
  });
});
