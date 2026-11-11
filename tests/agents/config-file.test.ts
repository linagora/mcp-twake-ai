import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupFile, backupName, readText, restoreFile, writeFileAtomic } from '../../src/agents/config-file.js';
import { tempDir } from '../helpers/tmp.js';

const now = new Date('2026-11-11T05:34:05.123Z');
const windows = process.platform === 'win32';

describe('agent configuration files', () => {
  it('names a backup after the file and the UTC time, as Hermes does', () => {
    expect(backupName('/h/.hermes/config.yaml', now)).toBe('/h/.hermes/config.yaml.bak-20261111T053405Z');
  });

  it('copies the file before a change, without overwriting an earlier copy', async () => {
    const file = join(await tempDir(), 'mcp.json');
    expect(await backupFile(file, now)).toBeUndefined();
    await writeFile(file, '{"a":1}');
    const first = await backupFile(file, now);
    const second = await backupFile(file, now);
    expect(first).toBe(`${file}.bak-20261111T053405Z`);
    expect(second).toBe(`${file}.bak-20261111T053405Z-2`);
    expect(await readFile(second!, 'utf8')).toBe('{"a":1}');
  });

  it('replaces a file in one step, creating its folder, private when new', async () => {
    const dir = await tempDir();
    const file = join(dir, 'Code', 'User', 'mcp.json');
    expect(await readText(file)).toBeUndefined();
    await writeFileAtomic(file, '{}\n');
    expect(await readText(file)).toBe('{}\n');
    if (!windows) expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(dir, 'Code', 'User'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(windows)('keeps the permissions of an existing file', async () => {
    const file = join(await tempDir(), 'claude_desktop_config.json');
    await writeFile(file, '{}');
    await chmod(file, 0o644);
    await writeFileAtomic(file, '{"mcpServers":{}}');
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it.skipIf(windows)('writes through a symbolic link instead of replacing it (dotfiles)', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'dotfiles'));
    await mkdir(join(dir, '.cursor'));
    const real = join(dir, 'dotfiles', 'mcp.json');
    const link = join(dir, '.cursor', 'mcp.json');
    await writeFile(real, '{}');
    await symlink(real, link);
    await writeFileAtomic(link, '{"mcpServers":{}}');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('{"mcpServers":{}}');
  });

  it('puts the copy back, or removes a file that did not exist', async () => {
    const file = join(await tempDir(), 'mcp.json');
    await writeFile(file, 'before');
    const backup = await backupFile(file, now);
    await writeFileAtomic(file, 'after');
    await restoreFile(file, backup);
    expect(await readText(file)).toBe('before');
    await restoreFile(file, undefined);
    expect(await readText(file)).toBeUndefined();
  });
});
