import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { proves } from '../src/proof.js';

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serve(
  answer: (req: IncomingMessage, port: number) => { status: number; body: string } | Promise<{ status: number; body: string }>,
): Promise<{ url: string; port: number; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  let port = 0;
  const server = createServer(async (req, res) => {
    seen.push(req);
    const { status, body } = await answer(req, port);
    res.writeHead(status, { 'content-type': 'application/json' }).end(body);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/mcp`, port, seen };
}

const nonceOf = (req: IncomingMessage) => new URL(req.url!, 'http://x').searchParams.get('nonce');
/** what mcp-twake-chat 0.7.0 answers, on the port it listens on */
const proofOf = (token: string, req: IncomingMessage, port: number) => createHmac('sha256', token).update(`twake-chat-proof:${nonceOf(req)}:${port}`).digest('hex');
const chat = (token: string, pid = 4242) => (req: IncomingMessage, port: number) => ({ status: 200, body: JSON.stringify({ proof: proofOf(token, req, port), pid }) });

describe('proves', () => {
  it('accepts a server that proves the token, which never travels', async () => {
    const s = await serve(chat('the-token'));
    expect(await proves(s.url, 'the-token')).toBe(true);
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0].method).toBe('GET');
    expect(s.seen[0].url).toMatch(/^\/mcp\/proof\?nonce=[0-9a-f]{32,}$/);
    expect(JSON.stringify(s.seen[0].headers)).not.toContain('the-token');
  });

  it('draws a new nonce each time', async () => {
    const s = await serve(chat('t'));
    await proves(s.url, 't');
    await proves(s.url, 't');
    expect(s.seen[0].url).not.toBe(s.seen[1].url);
  });

  it('rejects a wrong proof, a proof of another token, and whatever answers 200 to everything', async () => {
    expect(await proves((await serve(() => ({ status: 200, body: JSON.stringify({ proof: 'f'.repeat(64) }) }))).url, 't')).toBe(false);
    expect(await proves((await serve(chat('other'))).url, 't')).toBe(false);
    // a proof without the port (or of another port)
    expect(await proves((await serve((req) => ({ status: 200, body: JSON.stringify({ proof: createHmac('sha256', 't').update(`twake-chat-proof:${nonceOf(req)}`).digest('hex') }) }))).url, 't')).toBe(false);
    expect(await proves((await serve(() => ({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":{}}' }))).url, 't')).toBe(false);
    expect(await proves((await serve(() => ({ status: 401, body: '' }))).url, 't')).toBe(false);
    expect(await proves((await serve(() => ({ status: 200, body: 'not json' }))).url, 't')).toBe(false);
  });

  it('rejects a program on another port that passes the nonce on to the real server', async () => {
    const real = await serve(chat('t'));
    const relay = await serve(async (req) => {
      const answer = await fetch(`${real.url}/proof?nonce=${nonceOf(req)}`);
      return { status: answer.status, body: await answer.text() };
    });
    expect(await proves(real.url, 't')).toBe(true);
    expect(await proves(relay.url, 't')).toBe(false);
    expect(real.seen.length).toBe(2);
  });

  it('checks the pid the server gives against the one expected, when one is', async () => {
    const s = await serve(chat('t', 4242));
    expect(await proves(s.url, 't', { pid: 4242 })).toBe(true);
    expect(await proves(s.url, 't', { pid: 4243 })).toBe(false);
  });

  it('rejects a port where nothing listens', async () => {
    const s = await serve(() => ({ status: 200, body: '' }));
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await proves(s.url, 't')).toBe(false);
  });
});
