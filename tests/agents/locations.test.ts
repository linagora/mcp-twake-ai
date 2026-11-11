import { describe, expect, it } from 'vitest';
import { claudeDesktopConfig, cursorConfig, vscodeConfig } from '../../src/agents/locations.js';

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
