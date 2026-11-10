import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureInstalled, entryPoint, installedVersion, prefixDir } from '../src/installer.js';
import { fakeNpm, installFakeMcp } from './helpers/fake-mcp.js';
import { tempPaths } from './helpers/tmp.js';

describe('ensureInstalled', () => {
  it('installs the missing servers at their pinned versions, allowing the sqlite3 build of mcp-twake-chat', async () => {
    const { paths } = await tempPaths();
    const npm = fakeNpm(paths);
    const lines: string[] = [];
    expect(await ensureInstalled(paths, ['mail', 'chat', 'mail'], { run: npm, print: (line) => lines.push(line) })).toEqual([
      'mcp-twake-mail@4.1.0',
      'mcp-twake-chat@0.6.0',
    ]);
    expect(npm.calls).toEqual([
      ['install', '--prefix', prefixDir(paths), '--no-audit', '--no-fund', '--save-exact', '--allow-scripts=sqlite3', 'mcp-twake-mail@4.1.0', 'mcp-twake-chat@0.6.0'],
    ]);
    expect(lines.join('\n')).toContain('mcp-twake-chat@0.6.0');
    expect(await installedVersion(paths, 'mcp-twake-chat')).toBe('0.6.0');
  });

  it('does nothing when everything is installed, and replaces another version', async () => {
    const { paths } = await tempPaths();
    await installFakeMcp(paths, 'mail');
    await installFakeMcp(paths, 'dav', undefined, '4.0.0');
    const npm = fakeNpm(paths);
    expect(await ensureInstalled(paths, ['mail', 'dav'], { run: npm, print: () => undefined })).toEqual(['mcp-twake-dav@4.2.0']);
    expect(await ensureInstalled(paths, ['mail', 'dav'], { run: npm, print: () => undefined })).toEqual([]);
    expect(npm.calls).toHaveLength(1);
  });
});

describe('entryPoint', () => {
  it("resolves the package's command", async () => {
    const { paths } = await tempPaths();
    await installFakeMcp(paths, 'project');
    expect(await entryPoint(paths, 'project')).toBe(join(prefixDir(paths), 'node_modules', 'mcp-twake-project', 'build', 'index.js'));
  });

  it('says how to install a missing server', async () => {
    const { paths } = await tempPaths();
    await expect(entryPoint(paths, 'space')).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('mcp-twake-space') });
  });
});
