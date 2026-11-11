import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPaths } from './paths.js';

export const MAX_JOURNAL_BYTES = 1024 * 1024;

export const journalFile = (paths: AppPaths) => join(paths.stateDir, 'twake-ai.log');

const JWT = /\beyJ[\w-]*\.[\w-]+\.[\w-]+/g;
const BEARER = /\b(Bearer\s+)[\w.~+/=-]+/gi;
const SECRET = /\b(access_token|refresh_token|id_token|client_secret|registration_access_token|code_verifier|device_code|loginToken|accessToken|refreshToken|idToken|clientSecret|code)(\\?["']?\s*[:=]\s*\\?["']?)([^\s"'&,}\\]+)/g;
const MATRIX = /\bsy[tr]_[\w-]+/g;

/** Hides every token, code or secret a line may carry (spec §12.4). */
export function mask(text: string): string {
  return text
    // an error code (M_UNKNOWN_TOKEN, INVALID_GRANT) is not a secret, and says what went wrong
    .replace(SECRET, (all, name: string, sep: string, value: string) => (name === 'code' && /^[A-Z_]+$/.test(value) ? all : `${name}${sep}***`))
    .replace(JWT, '***')
    .replace(BEARER, '$1***')
    .replace(MATRIX, '***');
}

/** Appends one masked line to twake-ai.log (private, rotated past 1 MB). The journal never stops a command. */
export async function journal(paths: AppPaths, line: string, now: Date = new Date()): Promise<void> {
  try {
    const file = journalFile(paths);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    try {
      if ((await stat(file)).size > MAX_JOURNAL_BYTES) await rename(file, `${file}.1`);
    } catch {
      // no journal yet
    }
    await appendFile(file, `${now.toISOString()} ${mask(line).replace(/\s*\n\s*/g, ' ')}\n`, { mode: 0o600 });
  } catch {
    // best effort
  }
}
