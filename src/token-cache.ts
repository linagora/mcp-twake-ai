import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readPrivateJson, writePrivateFile } from './files.js';
import type { AppPaths } from './paths.js';

export interface CachedToken {
  accessToken: string;
  /** epoch seconds */
  expiresAt: number;
}

const file = (paths: AppPaths, grant: string) => join(paths.tokensDir, `${grant}.json`);

/** The cached access token of a grant; `undefined` when missing or unreadable (the caller then refreshes). */
export async function readCachedToken(paths: AppPaths, grant: string): Promise<CachedToken | undefined> {
  let raw: unknown;
  try {
    raw = await readPrivateJson(file(paths, grant));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const token = raw as Partial<CachedToken> | undefined;
  return typeof token?.accessToken === 'string' && typeof token.expiresAt === 'number'
    ? { accessToken: token.accessToken, expiresAt: token.expiresAt }
    : undefined;
}

export async function writeCachedToken(paths: AppPaths, grant: string, token: CachedToken): Promise<void> {
  await writePrivateFile(file(paths, grant), JSON.stringify(token));
}

export async function deleteCachedToken(paths: AppPaths, grant: string): Promise<void> {
  await rm(file(paths, grant), { force: true });
}
