import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** The MCP SDK, imported by absolute URL: the fake package lives in a temporary folder, with no node_modules of its own. */
const sdk = (module: string) => pathToFileURL(join(fileURLToPath(new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url)), module)).href;

/**
 * A streamable-HTTP MCP server standing in for mcp-twake-chat's shared mode: it reads MCP_HTTP_HOST, MCP_HTTP_PORT and
 * MCP_HTTP_TOKEN_FILE, keeps one MCP session per client over one process, answers `whoami` with its pid and environment,
 * and asks the client (elicitation/create) before answering `ask`. `forget` closes the session of its caller, as the
 * server's 6-hour idle sweep does, and `wait` writes what became of it (cancelled or not) next to the token file.
 */
export const FAKE_HTTP_MCP = `import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { McpServer } from '${sdk('server/mcp.js')}';
import { StreamableHTTPServerTransport } from '${sdk('server/streamableHttp.js')}';

const token = readFileSync(process.env.MCP_HTTP_TOKEN_FILE, 'utf8').trim();
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(MATRIX|USER)_/.test(key)));
const started = Date.now();
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

function newServer() {
  const mcp = new McpServer({ name: 'fake-chat', version: '1' });
  mcp.registerTool('whoami', { description: 'who serves these tools' }, async () => text({ pid: process.pid, started, env: environment() }));
  mcp.registerTool('ask', { description: 'ask the client before answering' }, async () => {
    const answer = await mcp.server.elicitInput({ message: 'Do it?', requestedSchema: { type: 'object', properties: {} } });
    return text({ action: answer.action, pid: process.pid });
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
  if (!body || body.method !== 'initialize') return void res.writeHead(400).end();
  const mcp = newServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, { transport, mcp }) });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
});
http.listen(Number(process.env.MCP_HTTP_PORT), process.env.MCP_HTTP_HOST, () => process.stderr.write('fake-chat ready\\n'));
`;
