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
  /** where to say what the relay cannot pass on; never stdout, which carries JSON-RPC */
  log?: (line: string) => void;
}

/** True for the 404 the shared server answers once its idle sweep has closed our session ("initialize again"). */
function sessionGone(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 404;
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
  private pending: { id: RequestId; ours: boolean; answered: () => void } | undefined;
  /** messages are passed on one at a time, in the order the agent wrote them (a request, then its cancellation) */
  private steps: Promise<void> = Promise.resolve();
  private opened = false;
  /** the relay has completed the handshake: the agent's own `notifications/initialized` has nothing left to say */
  private handed = false;
  private replays = 0;

  constructor(
    private readonly stdio: StdioServerTransport,
    private readonly options: ProxyOptions,
  ) {
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
          await this.upstream?.send(message);
          return;
        } catch (error) {
          if (!sessionGone(error) || again) throw error;
          again = true;
          this.log(`the shared server closed its session: opening another one`);
          await this.closeUpstream();
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
      const transport = new StreamableHTTPClientTransport(new URL(this.options.url), {
        requestInit: { headers: { authorization: `Bearer ${this.options.token}` } },
      });
      transport.onmessage = (message) => this.fromUpstream(message);
      transport.onerror = (error) => this.report(undefined, error);
      try {
        await transport.start();
        const answered = this.expectAnswer(opening.id, forward === undefined);
        await transport.send(opening);
        // the server needs its handshake complete before anything else: an approval prompt would not find us otherwise
        await answered;
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

  /** Waits for the server's answer to an initialize: the relay's own is dropped, the agent's is passed on. */
  private expectAnswer(id: RequestId, ours: boolean): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, REPLAY_MS);
      this.pending = {
        id,
        ours,
        answered: () => {
          clearTimeout(timer);
          resolve();
        },
      };
    });
  }

  private fromUpstream(message: JSONRPCMessage): void {
    if (this.pending && 'id' in message && message.id === this.pending.id) {
      const waiting = this.pending;
      this.pending = undefined;
      waiting.answered();
      // the answer to an initialize the relay sent is its own: the agent answered its own long ago
      if (waiting.ours) return;
    }
    // the server tells which protocol version it speaks: every later request carries it
    if (this.initialize && 'id' in message && message.id === this.initialize.id) {
      const version = (message as { result?: { protocolVersion?: unknown } }).result?.protocolVersion;
      if (typeof version === 'string') this.upstream?.setProtocolVersion(version);
    }
    this.send(message);
  }

  private send(message: JSONRPCMessage): void {
    this.stdio.send(message).catch((error: unknown) => this.report(undefined, error));
  }

  private report(message: JSONRPCMessage | undefined, error: unknown): void {
    this.log(error instanceof Error ? error.message : String(error));
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

/** Bridges an agent's stdio to one MCP session of the shared backend until the agent closes its side of the pipe. */
export async function proxyShared(options: ProxyOptions): Promise<number> {
  const stdio = new StdioServerTransport();
  const relay = new Relay(stdio, options);
  await stdio.start();
  await new Promise<void>((resolve) => {
    process.stdin.once('end', resolve);
    process.stdin.once('close', resolve);
  });
  await relay.close();
  return 0;
}
