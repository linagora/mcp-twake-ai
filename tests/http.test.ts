import { describe, expect, it } from 'vitest';
import { getJson, HttpError } from '../src/http.js';

const fetchReturning = (response: () => Response) => (async () => response()) as unknown as typeof fetch;

describe('HttpError', () => {
  it('exposes the OAuth error code of the body', () => {
    expect(new HttpError(400, 'https://x/token', '{"error":"invalid_grant"}').oauthError).toBe('invalid_grant');
    expect(new HttpError(500, 'https://x/token', '<html>').oauthError).toBeUndefined();
  });
});

describe('getJson', () => {
  it('parses a JSON answer', async () => {
    expect(await getJson('https://x.example/a', { fetch: fetchReturning(() => Response.json({ ok: true })) })).toEqual({ ok: true });
  });

  it('throws HttpError with the body on an HTTP error', async () => {
    const error = await getJson('https://x.example/a', { fetch: fetchReturning(() => new Response('{"error":"nope"}', { status: 403 })) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 403, oauthError: 'nope' });
  });

  it('turns a network failure into a network error naming the host', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(getJson('https://sso.example.com/x', { fetch: failing })).rejects.toMatchObject({
      code: 'network',
      message: expect.stringContaining('sso.example.com'),
    });
  });

  it('refuses an answer that is not JSON', async () => {
    await expect(getJson('https://x.example/a', { fetch: fetchReturning(() => new Response('<html>')) })).rejects.toMatchObject({ code: 'bad_response' });
  });
});
