import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPrivateJson, writePrivateFile } from '../src/files.js';
import { tempDir } from './helpers/tmp.js';

describe('writePrivateFile', () => {
  it('creates the missing directories and writes the file with mode 0600', async () => {
    const file = join(await tempDir(), 'a', 'b', 'secret.json');
    await writePrivateFile(file, '{"x":1}');
    expect(await readFile(file, 'utf8')).toBe('{"x":1}');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('replaces an existing file and leaves no temporary file behind', async () => {
    const dir = await tempDir();
    const file = join(dir, 'secret.json');
    await writePrivateFile(file, 'one');
    await writePrivateFile(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(dir)).toEqual(['secret.json']);
  });
});

describe('readPrivateJson', () => {
  it('returns undefined when the file does not exist', async () => {
    expect(await readPrivateJson(join(await tempDir(), 'missing.json'))).toBeUndefined();
  });

  it('parses a private file', async () => {
    const file = join(await tempDir(), 'ok.json');
    await writePrivateFile(file, '{"a":"b"}');
    expect(await readPrivateJson(file)).toEqual({ a: 'b' });
  });

  it.skipIf(process.platform === 'win32')('refuses a file that other users can read', async () => {
    const file = join(await tempDir(), 'open.json');
    await writeFile(file, '{}');
    await chmod(file, 0o644);
    await expect(readPrivateJson(file)).rejects.toMatchObject({ code: 'insecure_file', message: expect.stringMatching(/chmod 600/) });
  });
});
