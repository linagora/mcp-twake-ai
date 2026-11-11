import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeDesktopAgent, cursorAgent, vscodeAgent } from '../../src/agents/json-config.js';
import { tempDir } from '../helpers/tmp.js';

const now = () => new Date('2026-11-11T05:34:05Z');
const windows = process.platform === 'win32';
const root = !windows && process.getuid?.() === 0;

async function place() {
  const home = await tempDir();
  return { platform: process.platform, env: { APPDATA: join(home, 'AppData', 'Roaming') }, home };
}

const mail = { type: 'stdio', command: '/usr/bin/node', args: ['/opt/cli.js', 'run', 'mail', '--agent', 'x'] };

const VSCODE = `{
  // my servers
  "servers": {
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
  },
  "inputs": [{ "type": "promptString", "id": "token", "password": true }]
}
`;

describe('VS Code', () => {
  it('keeps comments, trailing commas, inputs and the other servers', async () => {
    const vscode = vscodeAgent(await place(), now);
    expect(await vscode.detect()).toBe(false);
    await mkdir(dirname(vscode.target), { recursive: true });
    await writeFile(vscode.target, VSCODE);
    expect(await vscode.detect()).toBe(true);
    expect(Object.keys(await vscode.read())).toEqual(['github']);
    const { backup } = await vscode.write({ set: { 'twake-mail': mail }, remove: [] });
    const text = await readFile(vscode.target, 'utf8');
    expect(text).toContain('// my servers');
    expect(text).toContain('"password": true');
    expect(Object.keys(await vscode.read())).toEqual(['github', 'twake-mail']);
    expect((await vscode.read())['twake-mail']).toEqual(mail);
    expect(await readFile(backup!, 'utf8')).toBe(VSCODE);
  });
});

describe('Cursor', () => {
  it('creates mcp.json when there is none, then removes an entry', async () => {
    const p = await place();
    const cursor = cursorAgent(p, now);
    expect(cursor.target).toBe(join(p.home, '.cursor', 'mcp.json'));
    expect(await cursor.detect()).toBe(false);
    await mkdir(join(p.home, '.cursor'));
    expect(await cursor.detect()).toBe(true);
    expect(await cursor.read()).toEqual({});
    expect(await cursor.write({ set: { 'twake-mail': mail, 'twake-dav': mail }, remove: [] })).toEqual({ backup: undefined });
    expect(JSON.parse(await readFile(cursor.target, 'utf8'))).toEqual({ mcpServers: { 'twake-mail': mail, 'twake-dav': mail } });
    await cursor.write({ set: {}, remove: ['twake-dav'] });
    expect(Object.keys(await cursor.read())).toEqual(['twake-mail']);
  });
});

describe('Claude Desktop', () => {
  it('keeps its own settings and the servers configured by hand', async () => {
    const desktop = claudeDesktopAgent(await place(), now);
    await mkdir(dirname(desktop.target), { recursive: true });
    await writeFile(desktop.target, JSON.stringify({ globalShortcut: 'Alt+Space', mcpServers: { 'twake-drive': { command: 'my-drive' } } }, null, 2));
    expect(desktop.capabilities.elicitation).toBe(false);
    await desktop.write({ set: { 'twake-mail': { command: '/usr/bin/node', args: ['/opt/cli.js'] } }, remove: [] });
    const saved = JSON.parse(await readFile(desktop.target, 'utf8'));
    expect(saved.globalShortcut).toBe('Alt+Space');
    expect(Object.keys(saved.mcpServers)).toEqual(['twake-drive', 'twake-mail']);
  });
});

describe('a damaged file', () => {
  it('is refused, named, and left as it is', async () => {
    const cursor = cursorAgent(await place(), now);
    await mkdir(dirname(cursor.target), { recursive: true });
    await writeFile(cursor.target, '{"mcpServers": {');
    await expect(cursor.read()).rejects.toMatchObject({ code: 'damaged_file', message: expect.stringContaining(cursor.target) });
    await expect(cursor.write({ set: { 'twake-mail': mail }, remove: [] })).rejects.toMatchObject({ code: 'damaged_file' });
    expect(await readFile(cursor.target, 'utf8')).toBe('{"mcpServers": {');
    expect(await readdir(dirname(cursor.target))).toEqual(['mcp.json']);
  });

  it('is refused when its servers are not an object', async () => {
    const cursor = cursorAgent(await place(), now);
    await mkdir(dirname(cursor.target), { recursive: true });
    await writeFile(cursor.target, '{"mcpServers": []}');
    await expect(cursor.read()).rejects.toMatchObject({ code: 'damaged_file', message: expect.stringContaining('mcpServers') });
  });

  it.skipIf(windows || root)('stays as it was when it cannot be written', async () => {
    const cursor = cursorAgent(await place(), now);
    const dir = dirname(cursor.target);
    await mkdir(dir, { recursive: true });
    await writeFile(cursor.target, '{}');
    await chmod(dir, 0o500);
    try {
      await expect(cursor.write({ set: { 'twake-mail': mail }, remove: [] })).rejects.toThrow();
      expect(await readFile(cursor.target, 'utf8')).toBe('{}');
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
