import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPaths } from './paths.js';

export const MAX_JOURNAL_BYTES = 1024 * 1024;

export const journalFile = (paths: AppPaths) => join(paths.stateDir, 'twake-ai.log');

const JWT = /\beyJ[\w-]*\.[\w-]+\.[\w-]+/g;
const BEARER = /\b([Bb]earer\s+|Basic\s+)[\w.~+/=-]+/g;
/** A value up to its end: an escaped slash (\/) stays part of it. */
const VALUE = String.raw`((?:\\\/|[^\s"'&,}\\])+)`;
// names that always hold a secret, however written: key=value, key: value, "key":"value" (escaped JSON too)
const SECRET = new RegExp(
  String.raw`\b(access_token|refresh_token|id_token|client_secret|client_assertion|registration_access_token|code_verifier|device_code|loginToken|accessToken|refreshToken|idToken|clientSecret)(\\?["']?\s*[:=]\s*\\?["']?)` + VALUE,
  'g',
);
// everyday words that hold a secret only as a parameter (token=…) or a JSON key ("token": …), not in a sentence
const BARE = new RegExp(String.raw`(\b(?:password|token|code)=|\\?["'](?:password|token|code)\\?["']\s*:\s*\\?["']?)` + VALUE, 'g');
// the same words after a colon (token: …): a password always, a token or a code only when it looks like one, not prose
const COLON = /\b(password\s*:\s*)[^\s"',}]+|\b((?:token|code)\s*:\s*)([\w.~+/=-]{16,})/gi;
// an authorization header, whatever the case of its name and scheme
const AUTHORIZATION = /\b(authorization\s*:\s*(?:bearer|basic)\s+)[\w.~+/=-]+/gi;
const MATRIX = /\bsy[tr]_[\w-]+/g;

/** Hides every token, code or secret a line may carry (spec §12.4). */
export function mask(text: string): string {
  return text
    .replace(SECRET, '$1$2***')
    .replace(BARE, '$1***')
    .replace(COLON, (_, password: string | undefined, name: string | undefined) => `${password ?? name}***`)
    .replace(AUTHORIZATION, '$1***')
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
