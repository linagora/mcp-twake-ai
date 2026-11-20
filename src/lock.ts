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
  options: { timeoutMs?: number; staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  // a lock whose holder did not refresh it for that long is taken for abandoned (a crash, a kill)
  const stale = options.staleMs ?? 30_000;
  // set when another process took the lock while this one held it (a long sleep or a clock jump past `stale`): the
  // default of proper-lockfile is to throw from a timer, which would crash the process
  let compromised: Error | undefined;
  await mkdir(locksDir, { recursive: true, mode: 0o700 });
  const target = join(locksDir, name);
  await writeFile(target, '', { flag: 'a', mode: 0o600 });
  let release: () => Promise<void>;
  try {
    release = await lock(target, {
      stale,
      retries: { retries: Math.max(1, Math.ceil(timeoutMs / 100)), factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: (error) => {
        compromised = error;
      },
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
  let result: T;
  try {
    result = await fn();
  } finally {
    // a lock taken away has nothing left to release
    await release().catch((error: unknown) => {
      if (!compromised) throw error;
    });
  }
  // what ran may have run beside another holder: the caller is told, instead of going on as if it had not
  if (compromised) {
    throw new TwakeAiError(
      'lock_timeout',
      `The "${name}" lock was lost while this process held it (${compromised.message}): another mcp-twake-ai process may have taken it after a long pause. Try again.`,
    );
  }
  return result;
}
