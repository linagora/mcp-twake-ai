import { readFile, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { journal, journalFile, mask, MAX_JOURNAL_BYTES } from '../src/journal.js';
import { tempPaths } from './helpers/tmp.js';

describe('mask', () => {
  it('hides tokens, codes and secrets, and nothing else', () => {
    expect(mask('POST /token refresh_token=r-123&client_id=twake-ai-agents')).toBe('POST /token refresh_token=***&client_id=twake-ai-agents');
    expect(mask('{"access_token":"eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl","expires_in":300}')).toBe('{"access_token":"***","expires_in":300}');
    expect(mask('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer ***');
    expect(mask('callback ?code=xyz&state=s1')).toBe('callback ?code=***&state=s1');
    expect(mask('client_secret: s3cr3t, registration_access_token: rat')).toBe('client_secret: ***, registration_access_token: ***');
    expect(mask('login --email jdoe@linagora.com')).toBe('login --email jdoe@linagora.com');
  });
});

describe('mask, beyond snake_case', () => {
  it('also hides camelCase names, escaped JSON and Matrix tokens, and leaves error codes readable', () => {
    expect(mask('{"refreshToken":"r-1","accessToken":"a-1"}')).toBe('{"refreshToken":"***","accessToken":"***"}');
    expect(mask('body {\\"refresh_token\\":\\"r-2\\"}')).toBe('body {\\"refresh_token\\":\\"***\\"}');
    expect(mask('token syt_YWxpY2U_abcdef_123 and syr_YWxpY2U_xyz_456')).toBe('token *** and ***');
    expect(mask('{"code":"M_UNKNOWN_TOKEN"}')).toBe('{"code":"M_UNKNOWN_TOKEN"}');
  });
});

describe('journal', () => {
  it('appends a private, masked line per call', async () => {
    const { paths } = await tempPaths();
    await journal(paths, 'login: sso.linagora.com refused refresh_token=r-1\nsecond line', new Date('2026-11-11T05:00:00Z'));
    await journal(paths, 'status: ok', new Date('2026-11-11T05:00:01Z'));
    expect(await readFile(journalFile(paths), 'utf8')).toBe(
      '2026-11-11T05:00:00.000Z login: sso.linagora.com refused refresh_token=*** second line\n2026-11-11T05:00:01.000Z status: ok\n',
    );
    if (process.platform !== 'win32') expect((await stat(journalFile(paths))).mode & 0o777).toBe(0o600);
  });

  it('starts a new file past 1 MB, keeping the previous one as .1', async () => {
    const { paths } = await tempPaths();
    await journal(paths, 'first');
    await writeFile(journalFile(paths), 'x'.repeat(MAX_JOURNAL_BYTES + 1));
    await journal(paths, 'after rotation');
    expect((await readFile(journalFile(paths), 'utf8')).endsWith(' after rotation\n')).toBe(true);
    expect((await stat(`${journalFile(paths)}.1`)).size).toBe(MAX_JOURNAL_BYTES + 1);
  });
});
