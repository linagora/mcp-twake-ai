import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { appPaths, type AppPaths } from '../../src/paths.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'twake-ai-test-'));
  created.push(dir);
  return dir;
}

export async function tempPaths(): Promise<{ root: string; paths: AppPaths }> {
  const root = await tempDir();
  return { root, paths: appPaths({ platform: process.platform, env: { TWAKE_AI_HOME: root }, home: root }) };
}
