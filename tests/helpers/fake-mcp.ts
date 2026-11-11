import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CATALOG } from '../../src/catalog.js';
import type { ServiceId } from '../../src/broker.js';
import { serverDir, type Runner } from '../../src/installer.js';
import type { AppPaths } from '../../src/paths.js';

/**
 * A stdio MCP server speaking newline-delimited JSON-RPC: it answers initialize, asks the client
 * for approval (elicitation/create) on tools/call and then reports the environment it was given;
 * method "quit" exits with params.code.
 */
export const FAKE_MCP = `import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let pending;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  }
  if (message.method === 'tools/call') {
    pending = message.id;
    return send({ jsonrpc: '2.0', id: 'approval-1', method: 'elicitation/create', params: { message: 'Do it?', requestedSchema: { type: 'object', properties: {} } } });
  }
  if (message.id === 'approval-1') {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(JMAP|DAV|TWAKE|MATRIX|TOM|USER)_/.test(key)));
    return send({ jsonrpc: '2.0', id: pending, result: { content: [{ type: 'text', text: JSON.stringify({ action: message.result.action, env }) }] } });
  }
  if (message.method === 'quit') process.exit(message.params.code);
});
rl.on('close', () => process.exit(0));
`;

/** Puts a package that looks like the pinned MCP server of `service` in the private prefix. */
export async function installFakeMcp(paths: AppPaths, service: ServiceId, script = FAKE_MCP, version = CATALOG[service].version): Promise<void> {
  const pkg = CATALOG[service];
  const dir = join(serverDir(paths, pkg.name), 'node_modules', pkg.name);
  await mkdir(join(dir, 'build'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version, type: 'module', bin: { [pkg.name]: 'build/index.js' } }));
  await writeFile(join(dir, 'build', 'index.js'), script);
}

/** An npm that records its arguments and "installs" fake packages. */
export function fakeNpm(paths: AppPaths): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (_command: string, args: string[]) => {
    calls.push(args);
    for (const spec of args.filter((arg) => arg.startsWith('mcp-twake-'))) {
      const service = (Object.keys(CATALOG) as ServiceId[]).find((s) => spec.startsWith(`${CATALOG[s].name}@`));
      if (service) await installFakeMcp(paths, service, FAKE_MCP, spec.split('@')[1]);
    }
  }) as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
}
