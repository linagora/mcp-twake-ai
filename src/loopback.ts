import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TwakeAiError } from './errors.js';

/** Registered at the IdP for the twake-ai-agents client: LemonLDAP may not ignore the loopback port (RFC 8252 §7.3). */
export const LOOPBACK_PORTS = [8765, 8766, 8767];

export interface LoopbackOptions {
  ports: number[];
  state: string;
  timeoutMs: number;
  /** Called once the server listens, with the redirect URI to put in the authorization request. */
  onListening(redirectUri: string): Promise<void> | void;
}

export interface CallbackResult {
  code: string;
  redirectUri: string;
}

const page = (title: string) =>
  `<!doctype html><meta charset="utf-8"><title>Twake.ai</title><body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>You can close this tab and go back to the terminal.</p>`;

/** Serves http://127.0.0.1:<port>/callback until the IdP sends the user back with a code. */
export async function waitForCallback(options: LoopbackOptions): Promise<CallbackResult> {
  let settle!: { resolve: (result: CallbackResult) => void; reject: (error: Error) => void };
  const result = new Promise<CallbackResult>((resolve, reject) => (settle = { resolve, reject }));
  result.catch(() => undefined); // rejected before anyone awaits it: not an unhandled rejection
  let redirectUri = '';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const html = (status: number, title: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(title));
    };
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.searchParams.get('state') !== options.state) {
      html(400, 'This sign-in link is not the current one');
      return;
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error || !code) {
      html(400, 'Sign-in was not completed');
      const reason = url.searchParams.get('error_description') ?? error ?? 'no authorization code';
      settle.reject(new TwakeAiError('login_cancelled', `Sign-in was not completed: ${reason}.`));
      return;
    }
    html(200, 'You are signed in to Twake.ai');
    settle.resolve({ code, redirectUri });
  });

  const port = await listenOnFirstFreePort(server, options.ports);
  redirectUri = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => {
    const minutes = Math.max(1, Math.round(options.timeoutMs / 60_000));
    settle.reject(new TwakeAiError('login_cancelled', `No sign-in within ${minutes} minute(s): run twake-ai login again.`));
  }, options.timeoutMs);
  try {
    await options.onListening(redirectUri);
    return await result;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
  }
}

async function listenOnFirstFreePort(server: Server, ports: number[]): Promise<number> {
  for (const port of ports) {
    const listening = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (listening) return (server.address() as AddressInfo).port;
  }
  throw new TwakeAiError(
    'ports_busy',
    `Ports ${ports.join(', ')} are all in use on 127.0.0.1: free one of them, or run twake-ai login --no-browser.`,
  );
}
