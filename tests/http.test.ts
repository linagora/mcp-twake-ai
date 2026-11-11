import { describe, expect, it } from 'vitest';
import { getJson, HttpError, requireSecureUrl } from '../src/http.js';

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

describe('requireSecureUrl', () => {
  it('accepts https anywhere and plain http only on this computer', () => {
    for (const ok of ['https://sso.example.com/token', 'http://127.0.0.1:8080/x', 'http://localhost/x', 'http://[::1]:9/x']) {
      expect(requireSecureUrl(ok, 'the token endpoint')).toBe(ok);
    }
  });

  it('refuses plain http elsewhere, other schemes and non-URLs, naming what it was', () => {
    for (const bad of ['http://sso.example.com/token', 'ftp://sso.example.com/x', 'not a url']) {
      expect(() => requireSecureUrl(bad, 'the token endpoint')).toThrow(
        expect.objectContaining({ code: 'insecure_endpoint', message: expect.stringContaining('the token endpoint') }),
      );
    }
  });
});

describe('error translation', () => {
  it('says a server is unavailable on 5xx, 408 and 429, naming its host', async () => {
    for (const status of [503, 502, 408, 429]) {
      await expect(getJson('https://sso.example.com/x', { fetch: fetchReturning(() => new Response('busy', { status })) })).rejects.toMatchObject({
        code: 'unavailable',
        message: expect.stringMatching(/sso\.example\.com.*try again/),
      });
    }
  });

  it('keeps the low-level cause of a network failure (TLS inspection, DNS…)', async () => {
    const failing = (async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('unable to get local issuer certificate'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }),
      });
    }) as unknown as typeof fetch;
    await expect(getJson('https://sso.example.com/x', { fetch: failing })).rejects.toMatchObject({
      code: 'network',
      message: expect.stringContaining('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'),
    });
  });

  it('refuses a JSON document reached through a redirect to plain http', async () => {
    const redirected = fetchReturning(() => {
      const response = Response.json({ ok: true });
      Object.defineProperty(response, 'redirected', { value: true });
      Object.defineProperty(response, 'url', { value: 'http://evil.example/doc' });
      return response;
    });
    await expect(getJson('https://example.com/doc', { fetch: redirected })).rejects.toMatchObject({ code: 'insecure_endpoint' });
  });
});
