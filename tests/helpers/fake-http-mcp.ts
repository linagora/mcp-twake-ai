import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

/** The MCP SDK, imported by absolute URL: the fake package lives in a temporary folder, with no node_modules of its own. */
const sdk = (module: string) => pathToFileURL(join(fileURLToPath(new URL('../../node_modules/@modelcontextprotocol/sdk/dist/esm/', import.meta.url)), module)).href;

/**
 * A streamable-HTTP MCP server standing in for mcp-twake-chat's HTTP mode: it reads MCP_HTTP_HOST, MCP_HTTP_PORT and
 * MCP_HTTP_TOKEN_FILE, keeps one MCP session per client over one process, answers `whoami` with its pid and environment,
 * and asks the client (elicitation/create) before answering `ask`; `headers` tells the protocol version a call came
 * with, `sessions` how many sessions are open, and `pause` stops listening for a moment. `forget` closes the session of its caller, as the server's 6-hour idle sweep does, and `wait` writes what became
 * of it (cancelled or not) next to the token file. A request with no session is served statelessly, as the real server
 * does.
 *
 * With MCP_HTTP_STATE_FILE it plays mcp-twake-chat 0.7.0's shared mode: it locks MATRIX_STORE_DIR/.lock in its pid (held
 * by a living pid: "already used by process N" on stderr, exit 75), draws its token, listens on MCP_HTTP_PORT (0) after
 * FAKE_SYNC_MS, then writes the state file (its device is the last segment of MATRIX_STORE_DIR). POST /mcp/shutdown with
 * the token answers 202, removes the state file and exits 0, as MCP_HTTP_EXIT_WHEN_IDLE_MS without a session does; a
 * SIGTERM or SIGINT is written into signals.log next to the state file before it stops.
 */
export const FAKE_HTTP_MCP = `import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { McpServer } from '${sdk('server/mcp.js')}';
import { StreamableHTTPServerTransport } from '${sdk('server/streamableHttp.js')}';

const stateFile = process.env.MCP_HTTP_STATE_FILE;
const here = dirname(stateFile ?? process.env.MCP_HTTP_TOKEN_FILE);
let lockFile;
if (stateFile) {
  const store = process.env.MATRIX_STORE_DIR;
  mkdirSync(store, { recursive: true });
  lockFile = join(store, '.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt > 0) throw error;
      const holder = Number(readFileSync(lockFile, 'utf8'));
      let living = false;
      try {
        process.kill(holder, 0);
        living = true;
      } catch (e) {
        living = e.code === 'EPERM';
      }
      if (holder && living) {
        process.stderr.write('the Matrix device store ' + store + ' is already used by process ' + holder + '\\n');
        process.exit(75);
      }
      unlinkSync(lockFile);
    }
  }
}
const token = stateFile ? randomBytes(32).toString('hex') : readFileSync(process.env.MCP_HTTP_TOKEN_FILE, 'utf8').trim();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  try {
    if (JSON.parse(readFileSync(stateFile, 'utf8')).pid === process.pid) unlinkSync(stateFile);
  } catch {}
  try {
    if (readFileSync(lockFile, 'utf8').trim() === String(process.pid)) unlinkSync(lockFile);
  } catch {}
  process.exit(code);
}
if (stateFile) {
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      appendFileSync(join(here, 'signals.log'), signal + '\\n');
      stop(0);
    });
  }
}
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
      const port = http.address().port;
      http.close(() => setTimeout(() => http.listen(port, process.env.MCP_HTTP_HOST), 1_500));
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
    writeFileSync(join(here, 'wait'), extra.signal.aborted ? 'cancelled' : 'timeout');
    return text({ aborted: extra.signal.aborted });
  });
  return mcp;
}

const sessions = new Map();
const http = createServer(async (req, res) => {
  // as mcp-twake-chat 0.7.0: the server proves it holds the token, without it
  if (req.method === 'GET' && req.url?.startsWith('/mcp/proof?')) {
    const nonce = new URL(req.url, 'http://localhost').searchParams.get('nonce') ?? '';
    const proof = createHmac('sha256', token).update('twake-chat-proof:' + nonce + ':' + http.address().port).digest('hex');
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ proof, pid: process.pid }));
  }
  if (req.headers.authorization !== 'Bearer ' + token) return void res.writeHead(401).end();
  if (!req.url?.startsWith('/mcp')) return void res.writeHead(404).end();
  if (stateFile && req.url === '/mcp/shutdown' && req.method === 'POST') {
    req.resume();
    res.writeHead(202).end();
    return void setTimeout(() => stop(0), 10);
  }
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
setTimeout(
  () =>
    http.listen(Number(process.env.MCP_HTTP_PORT), process.env.MCP_HTTP_HOST, () => {
      if (stateFile) {
        const port = http.address().port;
        const state = { version: 1, pid: process.pid, url: 'http://127.0.0.1:' + port + '/mcp', token, userId: process.env.MATRIX_USER_ID ?? '', deviceId: basename(process.env.MATRIX_STORE_DIR), serverVersion: 'fake', startedAt: new Date().toISOString() };
        mkdirSync(dirname(stateFile), { recursive: true });
        const temporary = stateFile + '.' + process.pid + '.tmp';
        writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
        renameSync(temporary, stateFile);
      }
      process.stderr.write('fake-chat ready\\n');
    }),
  Number(process.env.FAKE_SYNC_MS ?? 0),
);
const idleMs = Number(process.env.MCP_HTTP_EXIT_WHEN_IDLE_MS ?? 0);
let emptySince = Date.now();
if (stateFile && idleMs > 0) {
  setInterval(() => {
    if (sessions.size > 0) emptySince = Date.now();
    else if (Date.now() - emptySince >= idleMs) stop(0);
  }, 100);
}
`;
