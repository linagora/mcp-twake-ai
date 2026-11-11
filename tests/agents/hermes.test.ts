import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hermesAgent } from '../../src/agents/hermes.js';
import { tempDir } from '../helpers/tmp.js';

const now = () => new Date('2026-11-11T05:34:05Z');

const CONFIG = `# Hermes configuration
model: anthropic/claude-sonnet # the default model
mcp_servers:
  github:
    command: npx # official server
    args: [-y, '@modelcontextprotocol/server-github']
  twake_drive:
    command: /usr/local/bin/my-drive
toolsets:
  - web
`;

describe('Hermes', () => {
  it('adds an entry with its timeouts, keeping comments, layout and other servers', async () => {
    const home = await tempDir();
    const hermes = hermesAgent(home, now);
    expect(hermes.target).toBe(join(home, 'config.yaml'));
    expect(await hermes.detect()).toBe(false);
    await writeFile(hermes.target, CONFIG);
    expect(await hermes.detect()).toBe(true);
    expect(Object.keys(await hermes.read())).toEqual(['github', 'twake_drive']);
    const entry = hermes.shape({ command: '/usr/bin/node', args: ['/opt/cli.js', 'run', 'mail', '--agent', 'hermes'], env: {} });
    expect(entry).toEqual({
      command: '/usr/bin/node',
      args: ['/opt/cli.js', 'run', 'mail', '--agent', 'hermes'],
      timeout: 420,
      elicitation: { enabled: true, timeout: 300 },
    });
    const { backup } = await hermes.write({ set: { twake_mail: entry }, remove: [] });
    expect(backup).toBe(`${hermes.target}.bak-20261111T053405Z`);
    const text = await readFile(hermes.target, 'utf8');
    expect(text).toContain('model: anthropic/claude-sonnet # the default model');
    expect(text).toContain("args: [-y, '@modelcontextprotocol/server-github']");
    expect(text).toContain('toolsets:\n  - web');
    expect((await hermes.read()).twake_mail).toEqual(entry);
  });

  it('removes its entry and leaves the others', async () => {
    const home = await tempDir();
    const hermes = hermesAgent(home, now);
    await writeFile(hermes.target, CONFIG);
    await hermes.write({ set: {}, remove: ['twake_drive'] });
    expect(Object.keys(await hermes.read())).toEqual(['github']);
    expect(await readFile(hermes.target, 'utf8')).toContain('# Hermes configuration');
  });

  it('fills an empty mcp_servers', async () => {
    const home = await tempDir();
    const hermes = hermesAgent(home, now);
    await writeFile(hermes.target, 'model: x\nmcp_servers:\n');
    await hermes.write({ set: { twake_dav: { command: 'node', args: [] } }, remove: [] });
    expect(await hermes.read()).toEqual({ twake_dav: { command: 'node', args: [] } });
  });

  it('refuses a file that is not valid YAML, and leaves it as it is', async () => {
    const home = await tempDir();
    const hermes = hermesAgent(home, now);
    await writeFile(hermes.target, 'mcp_servers:\n  github:\n   command: npx\n  args: [\n');
    await expect(hermes.write({ set: { twake_mail: { command: 'node' } }, remove: [] })).rejects.toMatchObject({
      code: 'damaged_file',
      message: expect.stringContaining(hermes.target),
    });
    expect(await readFile(hermes.target, 'utf8')).toBe('mcp_servers:\n  github:\n   command: npx\n  args: [\n');
  });
});
