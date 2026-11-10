import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { withLock } from '../src/lock.js';
import { tempPaths } from './helpers/tmp.js';

describe('withLock', () => {
  it('runs the callers one at a time', async () => {
    const { paths } = await tempPaths();
    const events: string[] = [];
    const job = (id: string) =>
      withLock(paths.locksDir, 'oidc', async () => {
        events.push(`start ${id}`);
        await sleep(50);
        events.push(`end ${id}`);
      });
    await Promise.all([job('a'), job('b')]);
    expect(events).toHaveLength(4);
    expect(events[1]).toBe(events[0]!.replace('start', 'end'));
    expect(events[3]).toBe(events[2]!.replace('start', 'end'));
  });

  it('returns the value of the callback', async () => {
    const { paths } = await tempPaths();
    expect(await withLock(paths.locksDir, 'oidc', async () => 42)).toBe(42);
  });

  it('fails with lock_timeout while another holder keeps the lock', async () => {
    const { paths } = await tempPaths();
    let releaseOuter!: () => void;
    let acquired!: () => void;
    const isAcquired = new Promise<void>((resolve) => (acquired = resolve));
    const outer = withLock(paths.locksDir, 'oidc', () => new Promise<void>((resolve) => {
      releaseOuter = resolve;
      acquired();
    }));
    await isAcquired;
    await expect(withLock(paths.locksDir, 'oidc', async () => 1, { timeoutMs: 300 })).rejects.toMatchObject({ code: 'lock_timeout' });
    releaseOuter();
    await outer;
  });

  it('releases the lock when the callback throws', async () => {
    const { paths } = await tempPaths();
    await expect(withLock(paths.locksDir, 'oidc', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await withLock(paths.locksDir, 'oidc', async () => 'free', { timeoutMs: 300 })).toBe('free');
  });

  it('does not block between different names', async () => {
    const { paths } = await tempPaths();
    const result = await withLock(paths.locksDir, 'oidc', () => withLock(paths.locksDir, 'vault-file', async () => 'nested', { timeoutMs: 300 }));
    expect(result).toBe('nested');
  });
});
