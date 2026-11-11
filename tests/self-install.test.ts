import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNpxCache, removeShortcut, selfInstall, shortcutPath, writeShortcut } from '../src/self-install.js';
import { serverDir } from '../src/installer.js';
import { tempDir, tempPaths } from './helpers/tmp.js';

describe('self-install', () => {
  it('recognizes the npx cache', () => {
    expect(isNpxCache('/home/j/.npm/_npx/4f1c2d/node_modules/mcp-twake-ai/build/bin.js')).toBe(true);
    expect(isNpxCache('C:\\Users\\j\\AppData\\Local\\npm-cache\\_npx\\4f1c\\node_modules\\mcp-twake-ai\\build\\bin.js')).toBe(true);
    expect(isNpxCache('/usr/lib/node_modules/mcp-twake-ai/build/bin.js')).toBe(false);
  });

  it('installs its own version into the private prefix, once', async () => {
    const { paths } = await tempPaths();
    const calls: string[][] = [];
    const run = async (_command: string, args: string[]) => {
      calls.push(args);
      const dir = join(serverDir(paths, 'mcp-twake-ai'), 'node_modules', 'mcp-twake-ai');
      await mkdir(join(dir, 'build'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'mcp-twake-ai', version: '1.2.3', bin: { 'mcp-twake-ai': 'build/bin.js' } }));
      await writeFile(join(dir, 'build', 'bin.js'), '');
    };
    const cli = await selfInstall(paths, '1.2.3', run);
    expect(cli).toBe(join(serverDir(paths, 'mcp-twake-ai'), 'node_modules', 'mcp-twake-ai', 'build', 'bin.js'));
    expect(calls[0]).toContain('mcp-twake-ai@1.2.3');
    expect(await selfInstall(paths, '1.2.3', run)).toBe(cli);
    expect(calls).toHaveLength(1);
  });

  it('writes a shortcut that starts the installed command, and says whether it is in PATH', async () => {
    const home = await tempDir();
    const place = { platform: process.platform, env: { LOCALAPPDATA: join(home, 'AppData', 'Local'), PATH: '' }, home };
    const { path, inPath } = await writeShortcut(place, '/usr/bin/node', '/prefix/mcp-twake-ai/build/bin.js');
    expect(path).toBe(shortcutPath(place));
    expect(inPath).toBe(false);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('"/usr/bin/node" "/prefix/mcp-twake-ai/build/bin.js"');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o111).not.toBe(0);
    const again = await writeShortcut({ ...place, env: { ...place.env, PATH: ['/usr/bin', join(path, '..')].join(delimiter) } }, '/usr/bin/node', '/x.js');
    expect(again.inPath).toBe(true);
    await removeShortcut(place);
    await expect(stat(path)).rejects.toThrow();
  });
});
