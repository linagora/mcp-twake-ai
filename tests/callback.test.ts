import { describe, expect, it } from 'vitest';
import { obtainCallback, parseCallbackUrl, waitForCallback, type CallbackDeps } from '../src/loopback.js';

describe('parseCallbackUrl', () => {
  it('reads the credential of the pasted address, spaces around included', () => {
    expect(parseCallbackUrl('  http://127.0.0.1:8765/callback?state=S&code=abc \n', 'S')).toBe('abc');
    expect(parseCallbackUrl('http://127.0.0.1:8765/callback?state=S&loginToken=lt', 'S', 'loginToken')).toBe('lt');
  });

  it('refuses the address of another attempt, an error and what is not an address', () => {
    expect(() => parseCallbackUrl('http://127.0.0.1:8765/callback?state=OLD&code=abc', 'S')).toThrow(
      expect.objectContaining({ code: 'login_cancelled', message: expect.stringContaining('another sign-in attempt') }),
    );
    expect(() => parseCallbackUrl('http://127.0.0.1:8765/callback?state=S&error=access_denied', 'S')).toThrow(
      expect.objectContaining({ code: 'login_cancelled', message: expect.stringContaining('access_denied') }),
    );
    expect(() => parseCallbackUrl('code=abc', 'S')).toThrow(expect.objectContaining({ code: 'login_cancelled' }));
  });
});

describe('waitForCallback with another parameter', () => {
  it('returns the Matrix login token', async () => {
    const result = await waitForCallback({
      ports: [0],
      state: 'S',
      timeoutMs: 5_000,
      param: 'loginToken',
      onListening: async (redirectUri) => {
        await fetch(`${redirectUri}?state=S&loginToken=lt-1`);
      },
    });
    expect(result.code).toBe('lt-1');
  });
});

describe('obtainCallback', () => {
  function deps(answer: string): CallbackDeps & { lines: string[]; opened: string[] } {
    const lines: string[] = [];
    const opened: string[] = [];
    return {
      lines,
      opened,
      openUrl: async (url) => {
        opened.push(url);
        await fetch(new URL(url).searchParams.get('back') ?? '');
      },
      print: (line) => lines.push(line),
      readLine: async () => answer,
    };
  }

  it('opens the browser and waits on the loopback in browser mode', async () => {
    const d = deps('');
    const result = await obtainCallback(
      {
        mode: 'browser',
        ports: [0],
        state: 'S',
        timeoutMs: 5_000,
        param: 'code',
        what: 'Twake Drive',
        url: (redirectUri) => `https://drive.example/authorize?back=${encodeURIComponent(`${redirectUri}?state=S&code=c1`)}`,
      },
      d,
    );
    expect(result.code).toBe('c1');
    expect(d.opened).toHaveLength(1);
  });

  it('prints the address to open elsewhere and reads the pasted one in paste mode', async () => {
    const d = deps('http://127.0.0.1:8765/callback?state=S&code=c2');
    const result = await obtainCallback(
      {
        mode: 'paste',
        ports: [8765, 8766],
        state: 'S',
        timeoutMs: 5_000,
        param: 'code',
        what: 'Twake Drive',
        url: (redirectUri) => `https://drive.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      },
      d,
    );
    expect(result).toEqual({ code: 'c2', redirectUri: 'http://127.0.0.1:8765/callback' });
    expect(d.lines.join('\n')).toContain('https://drive.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback');
    expect(d.opened).toEqual([]);
  });
});
