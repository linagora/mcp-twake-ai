import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { isJSONRPCRequest, type JSONRPCMessage, type JSONRPCRequest, type RequestId } from '@modelcontextprotocol/sdk/types.js';

/** The one message of the MCP handshake the proxy sends itself, when it opens a session on its own. */
const INITIALIZED: JSONRPCMessage = { jsonrpc: '2.0', method: 'notifications/initialized' };

/** How long a session opened again may take to answer the replayed initialize before the relay goes on without it. */
const REPLAY_MS = 10_000;

export interface ProxyOptions {
  /** the loopback endpoint of the shared backend, such as http://127.0.0.1:41234/mcp */
  url: string;
  /** the backend's bearer token, read from its 0600 file */
  token: string;
  /** what the relay calls itself when it has to open a session before the agent said anything */
  name: string;
  version: string;
  /** how long the first session may take to open (the backend is listening, its first Matrix sync may still run) */
  readyMs?: number;
  /** the id of the upstream session, as it opens and when it is closed: `stop` deletes them before stopping the server */
  onSession?: (sessionId: string | undefined) => void;
  /**
   * where the shared server is now, once ours stopped answering (stopped by `login --chat`, a crash, the watchdog):
   * found, or started, as `run` did at first. When it fails, the relay ends and `run` exits, so the agent starts it again
   */
  reconnect?: () => Promise<{ url: string; token: string }>;
  /** where to say what the relay cannot pass on; never stdout, which carries JSON-RPC */
  log?: (line: string) => void;
}

/** True for the 404 the shared server answers once its idle sweep has closed our session ("initialize again"). */
function sessionGone(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
}

/**
 * True when our server is no longer there, and the request never reached it: nothing listens on its port any more, or
 * what listens there now turns our token down (another start, with a token of its own). A connection reset is not one:
 * the server may have run the request before it went (the SDK dispatches it before it answers), and sent again, a
 * message would be posted twice.
 */
function serverGone(error: unknown): boolean {
  if (error instanceof StreamableHTTPError) return error.code === 401;
  const cause = error instanceof Error ? (error.cause as { code?: unknown } | undefined) : undefined;
  return error instanceof TypeError && cause?.code === 'ECONNREFUSED';
}

/** The id of the request a POST carries, when it carries one (not a notification, not an answer, not a batch). */
function requestIdOf(init: RequestInit | undefined): RequestId | undefined {
  if (typeof init?.body !== 'string') return undefined;
  try {
    const message = JSON.parse(init.body) as JSONRPCMessage;
    return isJSONRPCRequest(message) ? message.id : undefined;
  } catch {
    return undefined;
  }
}

function isInitialize(message: JSONRPCMessage): message is JSONRPCRequest {
  return isJSONRPCRequest(message) && message.method === 'initialize';
}

/** The notification that completes the handshake: the agent sends it once, after the server answered its initialize. */
function isInitialized(message: JSONRPCMessage): boolean {
  return 'method' in message && !('id' in message) && message.method === 'notifications/initialized';
}

/** A JSON-RPC error for a request the relay could not pass on: the agent gets an answer instead of waiting for ever. */
function failure(message: JSONRPCMessage, error: unknown): JSONRPCMessage | undefined {
  if (!isJSONRPCRequest(message)) return undefined;
  const text = error instanceof Error ? error.message : String(error);
  return { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: `The shared server could not be reached: ${text}` } };
}

/**
 * Relays JSON-RPC between an agent's stdio and one session of the shared backend, message by message, as they are.
 *
 * Nothing is rebuilt method by method: `notifications/cancelled`, progress, `ping`, `logging/setLevel` and whatever MCP
 * adds next cross both ways, and the agent's own `initialize` goes upstream, so the server sees the capabilities of the
 * client it really talks to, not those of the relay.
 *
 * The server closes a session that stays idle for 6 h and answers 404 "Session not found: initialize again" after that:
 * the relay then replays the agent's `initialize` and the message that failed. An approval request still reaches the
 * client that made the call, since every client has a session of its own.
 */
class Relay {
  private upstream: StreamableHTTPClientTransport | undefined;
  /** the agent's initialize, replayed when the server has closed our session */
  private initialize: JSONRPCRequest | undefined;
  /** the answer to an initialize the relay sent: it is ours, unless it is the agent's own */
  private pending: { id: RequestId; ours: boolean; answered: (message: JSONRPCMessage) => void } | undefined;
  /** messages are passed on one at a time, in the order the agent wrote them (a request, then its cancellation) */
  private steps: Promise<void> = Promise.resolve();
  private opened = false;
  /** the relay has completed the handshake: the agent's own `notifications/initialized` has nothing left to say */
  private handed = false;
  private replays = 0;
  /** where the server is: it changes when ours went and another one was found */
  private url: string;
  private token: string;
  /** resolved with the exit code when the relay cannot go on: no server could be found any more */
  readonly ended: Promise<number>;
  private end: (code: number) => void = () => {};
  /** the agent's requests sent upstream and not answered yet: each gets an answer, from the server or from the relay */
  private readonly inflight = new Set<RequestId>();

  constructor(
    private readonly stdio: StdioServerTransport,
    private readonly options: ProxyOptions,
  ) {
    this.url = options.url;
    this.token = options.token;
    this.ended = new Promise((resolve) => (this.end = resolve));
    stdio.onmessage = (message) => this.enqueue(message);
  }

  /** The agent may write while an earlier message still waits for the server: keep the order, never wait for the agent. */
  private enqueue(message: JSONRPCMessage): void {
    this.steps = this.steps.then(() => this.forward(message)).catch((error: unknown) => this.report(message, error));
  }

  private async forward(message: JSONRPCMessage): Promise<void> {
    if (isInitialize(message)) this.initialize = message;
    // the relay completed the handshake itself: the agent's message would be a second `initialized`, which the spec forbids
    if (this.handed && isInitialized(message)) {
      this.handed = false;
      return;
    }
    for (let again = false; ; ) {
      const opens = this.upstream === undefined;
      if (opens) await this.open(isInitialize(message) ? message : undefined);
      // the message that opened the session has been sent by open()
      if (!opens || !isInitialize(message)) {
        try {
          if (isJSONRPCRequest(message)) this.inflight.add(message.id);
          await this.upstream?.send(message);
          return;
        } catch (error) {
          if (again || !(sessionGone(error) || (serverGone(error) && this.options.reconnect))) throw error;
          again = true;
          await this.closeUpstream();
          if (sessionGone(error)) {
            this.log(`the shared server closed its session: opening another one`);
          } else {
            this.log(`the shared server is gone: looking for the next one`);
            await this.findServer();
          }
        }
      } else {
        return;
      }
    }
  }

  /** Opens one session, the first one from the agent's own initialize, the next ones from a replay of it. */
  private async open(forward: JSONRPCRequest | undefined): Promise<void> {
    const opening = forward ?? this.replay();
    const deadline = this.opened ? Date.now() : Date.now() + (this.options.readyMs ?? 30_000);
    for (;;) {
      const transport = new StreamableHTTPClientTransport(new URL(this.url), {
        requestInit: { headers: { authorization: `Bearer ${this.token}` } },
        fetch: (url, init) => this.watchedFetch(url, init),
      });
      transport.onmessage = (message) => this.fromUpstream(message);
      transport.onerror = (error) => this.report(undefined, error);
      try {
        await transport.start();
        const answered = this.expectAnswer(opening.id, forward === undefined);
        await transport.send(opening);
        // the server needs its handshake complete before anything else: an approval prompt would not find us otherwise
        const answer = await answered;
        // the version the server agreed on goes with every later request of this session, as the spec wants
        const version = (answer as { result?: { protocolVersion?: unknown } } | undefined)?.result?.protocolVersion;
        if (typeof version === 'string') transport.setProtocolVersion(version);
        await transport.send(INITIALIZED);
        this.handed = true;
      } catch (error) {
        transport.onmessage = undefined;
        transport.onerror = undefined;
        await transport.close().catch(() => {});
        this.pending = undefined;
        // the backend is listening but may still be settling: the first client waits a little, the others do not
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
        continue;
      }
      this.upstream = transport;
      this.opened = true;
      this.options.onSession?.(transport.sessionId);
      return;
    }
  }

  /** Moves to the server `run` finds now, or ends the relay when there is none: the message still gets its error. */
  private async findServer(): Promise<void> {
    try {
      const found = await this.options.reconnect!();
      this.url = found.url;
      this.token = found.token;
    } catch (error) {
      this.end(1);
      throw error;
    }
  }

  /** the agent's initialize, under an id of our own, to open a session the server closed behind our back. */
  private replay(): JSONRPCRequest {
    const initialize: JSONRPCRequest = this.initialize ?? {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.options.name, version: this.options.version } },
    };
    return { ...initialize, id: `mcp-twake-ai-replay-${++this.replays}` } as JSONRPCRequest;
  }

  /**
   * Waits for the server's answer to an initialize, undefined when none came in time: the relay's own is dropped, the
   * agent's is passed on.
   */
  private expectAnswer(id: RequestId, ours: boolean): Promise<JSONRPCMessage | undefined> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), REPLAY_MS);
      this.pending = {
        id,
        ours,
        answered: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
    });
  }

  /**
   * fetch, with an eye on the stream that carries the answer to a request: when it ends, or breaks, before the answer
   * came (the server stopped, crashed, closed the session), the request is answered with an error instead of never.
   */
  private async watchedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, init);
    const id = requestIdOf(init);
    if (id === undefined || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
    const reader = response.body.getReader();
    // the SDK reads what came before the end first: give it that moment, then look whether the answer was among it
    const ended = () => void setTimeout(() => this.unanswered(id), 100);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { value, done } = await reader.read();
          if (done) {
            controller.close();
            ended();
          } else controller.enqueue(value);
        } catch (error) {
          controller.error(error);
          ended();
        }
      },
      cancel(reason) {
        ended();
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }

  private unanswered(id: RequestId): void {
    if (!this.inflight.delete(id)) return;
    this.send({ jsonrpc: '2.0', id, error: { code: -32603, message: 'The shared server went away before it answered: the call may or may not have run.' } });
  }

  private fromUpstream(message: JSONRPCMessage): void {
    if (('result' in message || 'error' in message) && 'id' in message && message.id !== undefined && message.id !== null) this.inflight.delete(message.id);
    if (this.pending && 'id' in message && message.id === this.pending.id) {
      const waiting = this.pending;
      this.pending = undefined;
      waiting.answered(message);
      // the answer to an initialize the relay sent is its own: the agent answered its own long ago
      if (waiting.ours) return;
    }
    this.send(message);
  }

  private send(message: JSONRPCMessage): void {
    this.stdio.send(message).catch((error: unknown) => this.report(undefined, error));
  }

  private report(message: JSONRPCMessage | undefined, error: unknown): void {
    this.log(error instanceof Error ? error.message : String(error));
    // answered here: no stream carries an answer to it
    if (message && isJSONRPCRequest(message)) this.inflight.delete(message.id);
    const answer = message ? failure(message, error) : undefined;
    if (answer) this.send(answer);
  }

  private log(line: string): void {
    (this.options.log ?? ((text: string) => process.stderr.write(`mcp-twake-ai: ${text}\n`)))(line);
  }

  private async closeUpstream(): Promise<void> {
    const upstream = this.upstream;
    this.upstream = undefined;
    this.options.onSession?.(undefined);
    if (upstream) {
      // a server that is gone has nothing more to say: its stream's last error is no news
      upstream.onmessage = undefined;
      upstream.onerror = undefined;
    }
    await upstream?.close().catch(() => {});
  }

  /** Ends this client's session on the server, then the relay: the backend closes with its last client. */
  async close(): Promise<void> {
    await this.steps.catch(() => {});
    const upstream = this.upstream;
    this.upstream = undefined;
    this.options.onSession?.(undefined);
    if (!upstream) return;
    // DELETE: the server closes this session at once, instead of waiting for its idle sweep
    await upstream.terminateSession().catch(() => {});
    await upstream.close().catch(() => {});
  }
}

/**
 * Bridges an agent's stdio to one MCP session of the shared backend until the agent closes its side of the pipe (0), or
 * until no server can be found any more (1): the agent then sees its server exit, and starts it again.
 */
export async function proxyShared(options: ProxyOptions): Promise<number> {
  const stdio = new StdioServerTransport();
  const relay = new Relay(stdio, options);
  await stdio.start();
  const code = await Promise.race([
    new Promise<number>((resolve) => {
      process.stdin.once('end', () => resolve(0));
      process.stdin.once('close', () => resolve(0));
    }),
    relay.ended,
  ]);
  await relay.close();
  // stdin is no longer read: a relay that ended while the agent still holds the pipe lets the process exit
  await stdio.close();
  return code;
}
