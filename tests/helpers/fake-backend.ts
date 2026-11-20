import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * What can answer on the port a `backend.json` names: our server (`mcp` answers a ping with the token of that start), a
 * server that is too busy to answer (`busy` accepts the connection and says nothing), or something else that holds the
 * port (`html` answers 200 to anyone, `401` turns our token down).
 */
export type FakeBackendMode = 'mcp' | 'busy' | 'html' | '401';

const SCRIPT = `const { createServer } = require('node:http');
const [mode, token] = process.argv.slice(1);
const http = createServer((req, res) => {
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
http.listen(0, '127.0.0.1', () => console.log(http.address().port));
`;

/**
 * A process that stands where a shared backend of that folder would be: its pid and port go into `backend.json`, and a
 * token into `token`, as `startBackend` writes them. The caller kills it.
 */
export async function fakeBackend(dir: string, mode: FakeBackendMode): Promise<{ child: ChildProcess; pid: number; port: number }> {
  const token = 'the token of this start';
  const child = spawn(process.execPath, ['-e', SCRIPT, mode, token], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  const port = await new Promise<number>((resolve) => createInterface({ input: child.stdout! }).once('line', (line) => resolve(Number(line))));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, 'backend.json'), JSON.stringify({ pid: child.pid, port }));
  await writeFile(join(dir, 'token'), `${token}\n`);
  return { child, pid: child.pid!, port };
}
