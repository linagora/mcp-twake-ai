import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TwakeAiError } from './errors.js';

/** Writes `data` to `path` atomically (temporary file, then rename), readable by the owner only. */
export async function writePrivateFile(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Refuses a file that other users can read or write. POSIX only: Windows protects files with ACLs. */
export async function assertPrivateFile(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return;
  const { mode } = await stat(path);
  if ((mode & 0o077) !== 0) {
    throw new TwakeAiError('insecure_file', `${path} must not be readable by other users: run chmod 600 "${path}"`);
  }
}

/** Reads a private JSON file; `undefined` when it does not exist. */
export async function readPrivateJson(path: string): Promise<unknown> {
  try {
    await assertPrivateFile(path);
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
