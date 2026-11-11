import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorAgent } from '../src/agents/json-config.js';
import { fingerprint } from '../src/agents/entries.js';
import { entryStates, handshake, serviceOfEntry } from '../src/status.js';
import { tempDir } from './helpers/tmp.js';

const HELLO = `const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  const send = (x) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hello', version: '1' } } });
  if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'a' }, { name: 'b' }] } });
});`;

async function script(text: string): Promise<string> {
  const file = join(await tempDir(), 'server.cjs');
  await writeFile(file, text);
  return file;
}

describe('handshake', () => {
  it('starts the server, lists its tools, and stops it', async () => {
    expect(await handshake({ command: process.execPath, args: [await script(HELLO)] }, process.env)).toEqual({ ok: true, detail: '2 tools' });
  });

  it('reports the last line of stderr when the server stops at once', async () => {
    const dying = await script("process.stderr.write('starting\\ntoken command failed: No Twake session on this computer\\n'); process.exit(1);");
    expect(await handshake({ command: process.execPath, args: [dying] }, process.env)).toEqual({ ok: false, detail: 'token command failed: No Twake session on this computer' });
  });

  it('gives up on a server that never answers', async () => {
    const mute = await script('setInterval(() => {}, 1000);');
    expect(await handshake({ command: process.execPath, args: [mute] }, process.env, 300)).toEqual({ ok: false, detail: 'no answer within 0.3 s' });
  });

  it('reports a command that cannot start', async () => {
    const check = await handshake({ command: join(await tempDir(), 'no-node'), args: [] }, process.env);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/ENOENT/);
  });
});

describe('entryStates', () => {
  it('compares each entry with what mcp-twake-ai wrote, and checks its node', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.cursor'));
    const cursor = cursorAgent({ platform: process.platform, env: {}, home }, () => new Date());
    const mine = (service: string) => ({ type: 'stdio', command: process.execPath, args: ['/cli.js', 'run', service, '--agent', 'cursor'] });
    await writeFile(
      cursor.target,
      JSON.stringify({
        mcpServers: {
          'twake-mail': mine('mail'),
          'twake-dav': { ...mine('dav'), args: ['edited'] },
          'twake-drive': { command: join(home, 'gone', 'node'), args: [] },
          'twake-space': { command: 'my-space' },
        },
      }),
    );
    const owned = { 'twake-mail': fingerprint(mine('mail')), 'twake-dav': fingerprint(mine('dav')), 'twake-drive': fingerprint({ command: join(home, 'gone', 'node'), args: [] }), 'twake-chat': 'abc' };
    expect((await entryStates(cursor, owned)).map((e) => [e.name, e.service, e.state])).toEqual([
      ['twake-chat', 'chat', 'missing'],
      ['twake-dav', 'dav', 'modified'],
      ['twake-drive', 'drive', 'no-node'],
      ['twake-mail', 'mail', 'ok'],
      ['twake-space', 'space', 'foreign'],
    ]);
    expect(serviceOfEntry('twake_project')).toBe('project');
    expect(serviceOfEntry('github')).toBeUndefined();
  });
});
