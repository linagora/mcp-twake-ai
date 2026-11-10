import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForCallback } from '../src/loopback.js';

const blockers: Server[] = [];
afterEach(() => {
  for (const server of blockers.splice(0)) server.close();
});

async function occupiedPort(): Promise<number> {
  const server = createServer();
  blockers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('waitForCallback', () => {
  it('returns the code sent back to the redirect URI', async () => {
    let page = '';
    const result = await waitForCallback({
      ports: [0],
      state: 'S1',
      timeoutMs: 5_000,
      onListening: async (redirectUri) => {
        const response = await fetch(`${redirectUri}?code=abc&state=S1`);
        page = await response.text();
      },
    });
    expect(result.code).toBe('abc');
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(page).toContain('signed in');
  });

  it('ignores a callback with another state and keeps waiting for the right one', async () => {
    const statuses: number[] = [];
    const result = await waitForCallback({
      ports: [0],
      state: 'GOOD',
      timeoutMs: 5_000,
      onListening: async (redirectUri) => {
        statuses.push((await fetch(`${redirectUri}?code=stale&state=OLD`)).status);
        statuses.push((await fetch(`${redirectUri}?code=fresh&state=GOOD`)).status);
      },
    });
    expect(statuses).toEqual([400, 200]);
    expect(result.code).toBe('fresh');
  });

  it('fails with login_cancelled when the IdP sends an error back', async () => {
    await expect(
      waitForCallback({
        ports: [0],
        state: 'S',
        timeoutMs: 5_000,
        onListening: async (redirectUri) => {
          await fetch(`${redirectUri}?error=access_denied&error_description=User%20refused&state=S`);
        },
      }),
    ).rejects.toMatchObject({ code: 'login_cancelled', message: expect.stringContaining('User refused') });
  });

  it('gives up after the timeout', async () => {
    await expect(waitForCallback({ ports: [0], state: 'S', timeoutMs: 100, onListening: () => undefined })).rejects.toMatchObject({
      code: 'login_cancelled',
    });
  });

  it('moves to the next port when one is taken', async () => {
    const busy = await occupiedPort();
    const result = await waitForCallback({
      ports: [busy, 0],
      state: 'S',
      timeoutMs: 5_000,
      onListening: async (redirectUri) => {
        await fetch(`${redirectUri}?code=c&state=S`);
      },
    });
    expect(result.redirectUri).not.toContain(`:${busy}/`);
  });

  it('fails with ports_busy when every port is taken', async () => {
    const busy = await occupiedPort();
    await expect(waitForCallback({ ports: [busy], state: 'S', timeoutMs: 1_000, onListening: () => undefined })).rejects.toMatchObject({
      code: 'ports_busy',
      message: expect.stringContaining(String(busy)),
    });
  });
});
