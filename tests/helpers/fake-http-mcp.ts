import { fileURLToPath } from 'node:url';

/** The MCP SDK, imported by absolute path: the fake package lives in a temporary folder, with no node_modules of its own. */
const sdkRoot = fileURLToPath(new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url));

/**
 * A streamable-HTTP MCP server standing in for mcp-twake-chat's shared mode: it reads MCP_HTTP_HOST, MCP_HTTP_PORT and
 * MCP_HTTP_TOKEN_FILE, keeps one MCP session per client over one process, answers `whoami` with its pid and environment,
 * and asks the client (elicitation/create) before answering `ask`.
 */
export const FAKE_HTTP_MCP = `import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { McpServer } from '${sdkRoot}server/mcp.js';
import { StreamableHTTPServerTransport } from '${sdkRoot}server/streamableHttp.js';

const token = readFileSync(process.env.MCP_HTTP_TOKEN_FILE, 'utf8').trim();
const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(MATRIX|USER)_/.test(key)));
const started = Date.now();

function newServer() {
  const mcp = new McpServer({ name: 'fake-chat', version: '1' });
  mcp.registerTool('whoami', { description: 'who serves these tools' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ pid: process.pid, started, env: environment() }) }],
  }));
  mcp.registerTool('ask', { description: 'ask the client before answering' }, async () => {
    const answer = await mcp.server.elicitInput({ message: 'Do it?', requestedSchema: { type: 'object', properties: {} } });
    return { content: [{ type: 'text', text: JSON.stringify({ action: answer.action, pid: process.pid }) }] };
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
  if (session) return void (await session.transport.handleRequest(req, res, body));
  if (!body || body.method !== 'initialize') return void res.writeHead(400).end();
  const mcp = newServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => sessions.set(id, { transport, mcp }) });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, body);
});
http.listen(Number(process.env.MCP_HTTP_PORT), process.env.MCP_HTTP_HOST, () => process.stderr.write('fake-chat ready\\n'));
`;
