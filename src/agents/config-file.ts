import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** An agent's configuration file, or undefined when there is none yet. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The file a symbolic link points to (dotfiles kept in a repository): that file is replaced, never the link. */
async function target(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** `<file>.bak-<YYYYMMDDTHHMMSSZ>` in UTC, the name Hermes gives its own backups. */
export function backupName(path: string, now: Date): string {
  return `${path}.bak-${now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')}`;
}

/** Copies the file next to itself before its first change; undefined when there is no file yet. */
export async function backupFile(path: string, now: Date): Promise<string | undefined> {
  const source = await target(path);
  if ((await readText(source)) === undefined) return undefined;
  const name = backupName(path, now);
  for (let n = 1; ; n++) {
    const backup = n === 1 ? name : `${name}-${n}`;
    try {
      await copyFile(source, backup, constants.COPYFILE_EXCL);
      return backup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/** Replaces the file in one step (temporary file in its folder, then rename), keeping its permissions; a new file is private. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const file = await target(path);
  let mode = 0o600;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {
    await mkdir(dirname(file), { recursive: true });
  }
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'wx', mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Puts back the copy made by backupFile, or removes the file when there was none before. */
export async function restoreFile(path: string, backup: string | undefined): Promise<void> {
  if (backup === undefined) await rm(await target(path), { force: true });
  else await writeFileAtomic(path, await readFile(backup, 'utf8'));
}
