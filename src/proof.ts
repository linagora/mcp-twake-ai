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
  return (await probe(url, token, expected)) === 'ours';
}

/**
 * What listens at url: 'ours' proved it holds the token; 'gone' refused the connection, or answered without the proof
 * (another program took the port: ours is gone, since it never listens without answering it); 'silent' did not answer
 * in time, or the connection broke (a server too busy to answer may still be ours).
 */
export async function probe(url: string, token: string, expected: { pid?: number; timeoutMs?: number } = {}): Promise<'ours' | 'gone' | 'silent'> {
  const nonce = randomBytes(16).toString('hex');
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/+$/, '')}/proof?nonce=${nonce}`, { signal: AbortSignal.timeout(expected.timeoutMs ?? PROOF_MS), redirect: 'error' });
  } catch (error) {
    const cause = (error as { cause?: { code?: unknown } }).cause;
    return cause?.code === 'ECONNREFUSED' ? 'gone' : 'silent';
  }
  try {
    const endpoint = new URL(url);
    const port = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
    if (response.status !== 200) return 'gone';
    const answer = (await response.json()) as { proof?: unknown; pid?: unknown } | null;
    if (typeof answer?.proof !== 'string') return 'gone';
    if (expected.pid !== undefined && answer.pid !== expected.pid) return 'gone';
    const given = Buffer.from(answer.proof);
    const want = Buffer.from(createHmac('sha256', token).update(`twake-chat-proof:${nonce}:${port}`).digest('hex'));
    return given.length === want.length && timingSafeEqual(given, want) ? 'ours' : 'gone';
  } catch (error) {
    // an answer cut off on the way, or that is not JSON: not ours, unless it broke on the way
    return error instanceof SyntaxError ? 'gone' : 'silent';
  }
}
