import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Loopback is shared by every account of the machine: once the shared Chat server is gone, anyone can listen on its
 * port and answer as it would. Before the token goes anywhere (a ping, a shutdown, every request of the relay), the
 * server proves it holds the token without it travelling: GET <url>/proof?nonce=<fresh hex> must answer
 * HMAC-SHA256(token, "twake-chat-proof:" + nonce + ":" + port) (mcp-twake-chat 0.7.0), the port being the one of the URL
 * we talk to: a program on another port that passes our nonce on to the real server gets a proof that does not hold.
 * The server also gives its pid: compared with server.json's, it is a consistency check, not a proof.
 */
const PROOF_MS = 2000;

/** What answered on the server's port could not prove it holds the token: nothing was sent to it. */
export class NotOurServer extends Error {
  constructor(url: string) {
    super(`what listens on ${url} is not the shared Chat server any more`);
    this.name = 'NotOurServer';
  }
}

export async function proves(url: string, token: string, expected: { pid?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const nonce = randomBytes(16).toString('hex');
  try {
    const endpoint = new URL(url);
    const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
    const response = await fetch(`${url.replace(/\/+$/, '')}/proof?nonce=${nonce}`, { signal: AbortSignal.timeout(expected.timeoutMs ?? PROOF_MS), redirect: 'error' });
    if (response.status !== 200) return false;
    const answer = (await response.json()) as { proof?: unknown; pid?: unknown } | null;
    if (typeof answer?.proof !== 'string') return false;
    if (expected.pid !== undefined && answer.pid !== expected.pid) return false;
    const given = Buffer.from(answer.proof);
    const want = Buffer.from(createHmac('sha256', token).update(`twake-chat-proof:${nonce}:${port}`).digest('hex'));
    return given.length === want.length && timingSafeEqual(given, want);
  } catch {
    return false;
  }
}
