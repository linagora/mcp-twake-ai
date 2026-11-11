import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeState, claudeDesktopConfig, cursorConfig, hermesHome, vscodeConfig } from '../../src/agents/locations.js';
import { tempDir } from '../helpers/tmp.js';

const mac = { platform: 'darwin' as const, env: {}, home: '/Users/al' };
const linux = { platform: 'linux' as const, env: { XDG_CONFIG_HOME: '/x/conf' }, home: '/home/al' };
const win = { platform: 'win32' as const, env: { APPDATA: 'C:\\Users\\Al Ice\\AppData\\Roaming' }, home: 'C:\\Users\\Al Ice' };

describe('agent configuration files, by OS', () => {
  it('finds Claude Desktop', () => {
    expect(claudeDesktopConfig(mac)).toBe('/Users/al/Library/Application Support/Claude/claude_desktop_config.json');
    expect(claudeDesktopConfig(linux)).toBe('/x/conf/Claude/claude_desktop_config.json');
    expect(claudeDesktopConfig(win)).toBe('C:\\Users\\Al Ice\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
  });

  it('finds Cursor in the home folder', () => {
    expect(cursorConfig(mac)).toBe('/Users/al/.cursor/mcp.json');
    expect(cursorConfig(win)).toBe('C:\\Users\\Al Ice\\.cursor\\mcp.json');
  });

  it('finds the user mcp.json of VS Code, VSCODE_APPDATA first', () => {
    expect(vscodeConfig(mac)).toBe('/Users/al/Library/Application Support/Code/User/mcp.json');
    expect(vscodeConfig({ ...linux, env: {} })).toBe('/home/al/.config/Code/User/mcp.json');
    expect(vscodeConfig(win)).toBe('C:\\Users\\Al Ice\\AppData\\Roaming\\Code\\User\\mcp.json');
    expect(vscodeConfig({ ...linux, env: { VSCODE_APPDATA: '/data' } })).toBe('/data/Code/User/mcp.json');
  });
});

describe('the Hermes home', () => {
  it('is HERMES_HOME, else ~/.hermes, else %LOCALAPPDATA%\\hermes on Windows', async () => {
    expect(await hermesHome({ ...linux, env: { HERMES_HOME: '/srv/hermes' } })).toBe('/srv/hermes');
    expect(await hermesHome(mac)).toBe('/Users/al/.hermes');
    expect(await hermesHome({ ...win, env: { LOCALAPPDATA: 'C:\\Users\\Al Ice\\AppData\\Local' } })).toBe('C:\\Users\\Al Ice\\AppData\\Local\\hermes');
  });

  it('follows the active profile when its folder exists', async () => {
    const home = await tempDir();
    const p = { platform: process.platform, env: { LOCALAPPDATA: join(home, 'AppData', 'Local') }, home };
    const root = process.platform === 'win32' ? join(home, 'AppData', 'Local', 'hermes') : join(home, '.hermes');
    await mkdir(join(root, 'profiles', 'work'), { recursive: true });
    await writeFile(join(root, 'active_profile'), 'work\n');
    expect(await hermesHome(p)).toBe(join(root, 'profiles', 'work'));
    await writeFile(join(root, 'active_profile'), 'gone');
    expect(await hermesHome(p)).toBe(root);
    await writeFile(join(root, 'active_profile'), '../../etc');
    expect(await hermesHome(p)).toBe(root);
  });
});

describe('the Claude Code state file', () => {
  it('is ~/.claude.json, or in CLAUDE_CONFIG_DIR', () => {
    expect(claudeCodeState(mac)).toBe('/Users/al/.claude.json');
    expect(claudeCodeState(win)).toBe('C:\\Users\\Al Ice\\.claude.json');
    expect(claudeCodeState({ ...linux, env: { CLAUDE_CONFIG_DIR: '/cfg' } })).toBe('/cfg/.claude.json');
  });
});
