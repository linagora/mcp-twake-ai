/**
 * `proxyShared` on this process's stdio, for tests/proxy.test.ts: the relay reads process.stdin and writes
 * process.stdout, so it runs in a child. PROXY_URL and PROXY_TOKEN name the first server; each reconnection appends a
 * line to PROXY_RECONNECTS and reads where the next server is from PROXY_NEXT ({ url, token }), waiting up to 10 s for
 * it, as `run chat` waits for a server that starts.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { proxyShared } from '../../src/proxy.js';

const env = process.env as Record<string, string>;
const code = await proxyShared({
  url: env.PROXY_URL,
  token: env.PROXY_TOKEN,
  name: 'test-relay',
  version: '0',
  readyMs: env.PROXY_READY_MS ? Number(env.PROXY_READY_MS) : undefined,
  reconnect: async () => {
    await appendFile(env.PROXY_RECONNECTS, 'reconnect\n');
    for (let tries = 0; ; tries++) {
      try {
        return JSON.parse(await readFile(env.PROXY_NEXT, 'utf8')) as { url: string; token: string };
      } catch (error) {
        if (tries >= 100) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  },
});
process.exit(code);
