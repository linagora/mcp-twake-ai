import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { TwakeAiError } from './errors.js';

/**
 * Runs `fn` while holding a lock shared by every mcp-twake-ai process of this user.
 * Token refreshes run under it: two processes must never spend the same refresh token.
 */
export async function withLock<T>(
  locksDir: string,
  name: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  await mkdir(locksDir, { recursive: true, mode: 0o700 });
  const target = join(locksDir, name);
  await writeFile(target, '', { flag: 'a', mode: 0o600 });
  let release: () => Promise<void>;
  try {
    release = await lock(target, {
      stale: 30_000,
      retries: { retries: Math.max(1, Math.ceil(timeoutMs / 100)), factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new TwakeAiError(
        'lock_timeout',
        `Another mcp-twake-ai process has held the "${name}" lock for more than ${Math.round(timeoutMs / 1000)} s: try again, or delete ${target}.lock if no mcp-twake-ai process is running.`,
      );
    }
    throw error;
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}
