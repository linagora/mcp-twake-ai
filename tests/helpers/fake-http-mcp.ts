import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** The MCP SDK, imported by absolute URL: the fake package lives in a temporary folder, with no node_modules of its own. */
const sdk = (module: string) => pathToFileURL(join(fileURLToPath(new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url)), module)).href;

/**
 * A streamable-HTTP MCP server standing in for mcp-twake-chat's shared mode: it reads MCP_HTTP_HOST, MCP_HTTP_PORT and
 * MCP_HTTP_TOKEN_FILE, keeps one MCP session per client over one process, answers `whoami` with its pid and environment,
 * and asks the client (elicitation/create) before answering `ask`; `headers` tells the protocol version a call came
 * with, `sessions` how many sessions are open, and `pause` stops listening for a moment. `forget` closes the session of its caller, as the server's 6-hour idle sweep does, and `wait` writes what became
 * of it (cancelled or not) next to the token file. A request with no session is served statelessly, as the real server
 * does.
 */
export const FAKE_HTTP_MCP = `import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { McpServer } from '${sdk('server/mcp.js')}';
import { StreamableHTTPServerTransport } from '${sdk('server/streamableHttp.js')}';

const token = readFileSync(process.env.MCP_HTTP_TOKEN_FILE, 'utf8').trim();
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(MATRIX_|USER_|TOM_|MCP_|LOG_LEVEL$)/.test(key)));
const started = Date.now();
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function newServer() {
  const mcp = new McpServer({ name: 'fake-chat', version: '1' });
  mcp.registerTool('whoami', { description: 'who serves these tools' }, async () => text({ pid: process.pid, started, env: environment() }));
  mcp.registerTool('ask', { description: 'ask the client before answering' }, async () => {
    const answer = await mcp.server.elicitInput({ message: 'Do it?', requestedSchema: { type: 'object', properties: {} } });
    return text({ action: answer.action, pid: process.pid });
  });
  mcp.registerTool('headers', { description: 'the MCP headers of the request that called it' }, async (extra) =>
    text({ protocol: extra.requestInfo?.headers['mcp-protocol-version'] ?? null }),
  );
  mcp.registerTool('sessions', { description: 'how many sessions are open' }, async () => text({ sessions: sessions.size }));
  mcp.registerTool('pause', { description: 'stop listening for a moment, then listen again on the same port' }, async () => {
    setTimeout(() => {
      http.close(() => setTimeout(() => http.listen(Number(process.env.MCP_HTTP_PORT), process.env.MCP_HTTP_HOST), 1_500));
      http.closeAllConnections();
    }, 100);
    return text({ paused: true });
  });
  mcp.registerTool('forget', { description: 'close the session of its caller, as the idle sweep does' }, async (extra) => {
    if (extra.sessionId) sessions.delete(extra.sessionId);
    return text({ forgotten: true });
  });
  mcp.registerTool('wait', { description: 'wait until the client cancels the call' }, async (extra) => {
    await new Promise((resolve) => {
      if (extra.signal.aborted) return resolve();
      extra.signal.addEventListener('abort', resolve, { once: true });
      setTimeout(resolve, 20_000).unref();
    });
    writeFileSync(join(dirname(process.env.MCP_HTTP_TOKEN_FILE), 'wait'), extra.signal.aborted ? 'cancelled' : 'timeout');
    return text({ aborted: extra.signal.aborted });
  });
  return mcp;
}

const sessions = new Map();
const http = createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) return void res.writeHead(401).end();
  if (!req.url?.startsWith('/mcp')) return void res.writeHead(404).end();
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : undefined;
  const sid = req.headers['mcp-session-id'];
  const session = sid ? sessions.get(String(sid)) : undefined;
  // the real server closes a session that stays idle for hours, and says how to go on
  if (sid && !session)
    return void res
      .writeHead(404, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found: initialize again' }, id: null }));
  if (session) {
    if (req.method === 'DELETE') sessions.delete(String(sid));
    return void (await session.transport.handleRequest(req, res, body));
  }
  // as the real server: a request with no session (the ping that tells our server from a stranger) is served statelessly
  if (!body || body.method !== 'initialize') {
    const mcp = newServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => void transport.close());
    await mcp.connect(transport);
    return void (await transport.handleRequest(req, res, body));
  }
  const mcp = newServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, { transport, mcp }) });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
});
// FAKE_SYNC_MS: the Matrix sign-in and first sync the real server goes through before it listens
setTimeout(() => http.listen(Number(process.env.MCP_HTTP_PORT), process.env.MCP_HTTP_HOST, () => process.stderr.write('fake-chat ready\\n')), Number(process.env.FAKE_SYNC_MS ?? 0));
`;
