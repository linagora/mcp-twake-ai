import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TwakeAiError } from './errors.js';

/** Registered at the IdP for the twake-ai-agents client: LemonLDAP may not ignore the loopback port (RFC 8252 §7.3). */
export const LOOPBACK_PORTS = [8765, 8766, 8767];

export interface LoopbackOptions {
  ports: number[];
  state: string;
  timeoutMs: number;
  /** query parameter carrying the one-time credential: `code` (OAuth, default) or `loginToken` (Matrix SSO) */
  param?: string;
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
    const code = url.searchParams.get(options.param ?? 'code');
    const error = url.searchParams.get('error');
    if (error || !code) {
      html(400, 'Sign-in was not completed');
      const reason = url.searchParams.get('error_description') ?? error ?? `no ${options.param ?? 'code'} in the answer`;
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

/** The credential of an address pasted by the user, after checking it belongs to this attempt. */
export function parseCallbackUrl(pasted: string, state: string, param = 'code'): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new TwakeAiError('login_cancelled', 'This is not the address of the page: run the command again and paste the whole address.');
  }
  if (url.searchParams.get('state') !== state) {
    throw new TwakeAiError('login_cancelled', 'This address belongs to another sign-in attempt: run the command again.');
  }
  const value = url.searchParams.get(param);
  const error = url.searchParams.get('error');
  if (error || !value) {
    throw new TwakeAiError('login_cancelled', `Sign-in was not completed: ${url.searchParams.get('error_description') ?? error ?? `no ${param} in the address`}.`);
  }
  return value;
}

export type CallbackMode = 'browser' | 'paste';

export interface CallbackRequest {
  mode: CallbackMode;
  ports: number[];
  state: string;
  timeoutMs: number;
  param: string;
  /** what is being connected, for the messages ("Twake Drive", "Twake Chat for hermes") */
  what: string;
  /** the address to open, built from the redirect URI */
  url(redirectUri: string): string;
}

export interface CallbackDeps {
  openUrl(url: string): Promise<void>;
  print(line: string): void;
  readLine(question: string): Promise<string>;
}

/** With a browser: loopback callback. Without: the user opens the address elsewhere and pastes the final one back. */
export async function obtainCallback(request: CallbackRequest, deps: CallbackDeps): Promise<CallbackResult> {
  if (request.mode === 'paste') {
    const redirectUri = `http://127.0.0.1:${request.ports[0]}/callback`;
    deps.print(`To connect ${request.what}, open this address on a phone or a computer:\n  ${request.url(redirectUri)}`);
    deps.print('After signing in, the browser ends on a page that cannot load: copy its address from the address bar.');
    const pasted = await deps.readLine('Address of that page: ');
    return { code: parseCallbackUrl(pasted, request.state, request.param), redirectUri };
  }
  return waitForCallback({
    ports: request.ports,
    state: request.state,
    timeoutMs: request.timeoutMs,
    param: request.param,
    onListening: async (redirectUri) => {
      const url = request.url(redirectUri);
      deps.print(`Opening your browser to connect ${request.what}. If it does not open, visit:\n  ${url}`);
      await deps.openUrl(url).catch(() => undefined);
    },
  });
}
