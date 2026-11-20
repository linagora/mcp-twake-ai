import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * What can answer on the port a `backend.json` names: our server (`mcp` answers a ping with the token of that start), a
 * server that is too busy to answer (`busy` accepts the connection and says nothing), or something else that holds the
 * port (`html` answers 200 to anyone, `401` turns our token down, `garbage` speaks no HTTP at all).
 */
export type FakeBackendMode = 'mcp' | 'busy' | 'html' | '401' | 'garbage';

export interface FakeBackendOptions {
  /** the server listens only after that long, as a backend in its Matrix sign-in and first sync; never when null */
  listenAfterMs?: number | null;
  /** what `backend.json` says of the start: when it began, and how long it was given to answer */
  startedAt?: number;
  readyMs?: number;
}

const SCRIPT = `const http = require('node:http');
const net = require('node:net');
const [mode, token, port, after] = process.argv.slice(1);
const server =
  mode === 'garbage'
    ? net.createServer((socket) => socket.end('SSH-2.0-OpenSSH_9.6\\r\\n'))
    : http.createServer((req, res) => {
        if (mode === 'busy') return;
        if (mode === '401' || req.headers.authorization !== 'Bearer ' + token) return void res.writeHead(401).end();
        if (mode === 'html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<html>hello</html>');
        let raw = '';
        req.on('data', (chunk) => (raw += chunk));
        req.on('end', () => {
          const body = raw ? JSON.parse(raw) : {};
          res.writeHead(200, { 'content-type': 'text/event-stream' }).end('event: message\\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id ?? null, result: {} }) + '\\n\\n');
        });
      });
// the port is printed once it answers, or at once when the server is to wait
if (after === '0') server.listen(Number(port), '127.0.0.1', () => console.log(port));
else console.log(port);
if (after !== '0' && after !== 'never') setTimeout(() => server.listen(Number(port), '127.0.0.1'), Number(after));
setInterval(() => {}, 1000);
`;

/** A loopback port nobody holds right now. */
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A process that stands where a shared backend of that folder would be: its pid and port go into `backend.json`, and a
 * token into `token`, as `startBackend` writes them. The caller kills it.
 */
export async function fakeBackend(dir: string, mode: FakeBackendMode, options: FakeBackendOptions = {}): Promise<{ child: ChildProcess; pid: number; port: number }> {
  const token = 'the token of this start';
  const after = options.listenAfterMs === null ? 'never' : String(options.listenAfterMs ?? 0);
  const child = spawn(process.execPath, ['-e', SCRIPT, mode, token, String(await freePort()), after], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const port = await new Promise<number>((resolve) => createInterface({ input: child.stdout! }).once('line', (line) => resolve(Number(line))));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const start = options.startedAt === undefined ? {} : { startedAt: options.startedAt, readyMs: options.readyMs };
  await writeFile(join(dir, 'backend.json'), JSON.stringify({ pid: child.pid, port, ...start }));
  await writeFile(join(dir, 'token'), `${token}\n`);
  return { child, pid: child.pid!, port };
}
