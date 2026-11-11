import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planEntries } from '../../src/agents/entries.js';
import { applyAgent, createAdapters, detectAgents, recordOwned } from '../../src/agents/index.js';
import { AGENT_IDS, type AgentAdapter } from '../../src/agents/types.js';
import { loadConfig, saveConfig } from '../../src/config.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { tempDir, tempPaths } from '../helpers/tmp.js';

const now = () => new Date('2026-11-11T05:34:05Z');

async function computer() {
  const home = await tempDir();
  const env = { APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), PATH: join(home, 'no-bin') };
  return { home, adapters: await createAdapters({ platform: process.platform, env, home, now }) };
}

const mail = (agent: string) => ({ type: 'stdio', command: '/usr/bin/node', args: ['/opt/cli.js', 'run', 'mail', '--agent', agent] });

describe('the agents', () => {
  it('are the five of the spec, detected from what is installed', async () => {
    const { home, adapters } = await computer();
    expect(Object.keys(adapters)).toEqual([...AGENT_IDS]);
    expect(await detectAgents(adapters)).toEqual([]);
    await mkdir(join(home, '.cursor'));
    await mkdir(dirname(adapters.hermes.target), { recursive: true });
    await writeFile(adapters.hermes.target, 'model: x\n');
    expect(await detectAgents(adapters)).toEqual(['hermes', 'cursor']);
  });

  it('count an agent whose detection fails as present, so that its plan reports the problem', async () => {
    const { adapters } = await computer();
    const broken = { ...adapters, cursor: { ...adapters.cursor, detect: async () => { throw new Error('EACCES: permission denied'); } } };
    expect(await detectAgents(broken)).toEqual(['cursor']);
  });

  it('are written once, then left as they are on the next run', async () => {
    const { home, adapters } = await computer();
    await mkdir(join(home, '.cursor'));
    const cursor = adapters.cursor;
    const wanted = { 'twake-mail': mail('cursor') };
    const first = await applyAgent(cursor, planEntries(await cursor.read(), wanted, {}), {}, () => false);
    expect(first).toMatchObject({ agent: 'cursor', status: 'written', skipped: [] });
    const second = await applyAgent(cursor, planEntries(await cursor.read(), wanted, first.owned), first.owned, () => false);
    expect(second).toMatchObject({ status: 'unchanged', owned: first.owned });
    expect((await readdir(join(home, '.cursor'))).filter((name) => name.includes('.bak-'))).toEqual([]);
  });

  it('leave an entry configured by hand alone without consent', async () => {
    const { home, adapters } = await computer();
    const cursor = adapters.cursor;
    await mkdir(join(home, '.cursor'));
    await writeFile(cursor.target, JSON.stringify({ mcpServers: { 'twake-mail': { command: 'my-mail' } } }));
    const result = await applyAgent(cursor, planEntries(await cursor.read(), { 'twake-mail': mail('cursor') }, {}), {}, () => false);
    expect(result).toMatchObject({ status: 'unchanged', owned: {} });
    expect(result.skipped.map((action) => action.kind)).toEqual(['replace-foreign']);
    expect((await cursor.read())['twake-mail']).toEqual({ command: 'my-mail' });
  });

  it('report a failure without throwing, keeping what was owned', async () => {
    const broken: AgentAdapter = {
      ...(await computer()).adapters.vscode,
      read: async () => ({}),
      write: async () => {
        throw new Error('disk full');
      },
    };
    const result = await applyAgent(broken, planEntries({}, { 'twake-mail': mail('vscode') }, {}), { 'twake-old': 'abc' }, () => false);
    expect(result).toMatchObject({ agent: 'vscode', status: 'failed', error: 'disk full', owned: { 'twake-old': 'abc' } });
  });

  it('note in config.json the entries mcp-twake-ai owns', async () => {
    const { paths } = await tempPaths();
    await saveConfig(paths, sampleConfig);
    await recordOwned(paths, 'cursor', { 'twake-mail': '0123456789abcdef' });
    await recordOwned(paths, 'hermes', {});
    expect((await loadConfig(paths))?.agents).toEqual({ cursor: { entries: { 'twake-mail': '0123456789abcdef' } }, hermes: { entries: {} } });
  });
});
