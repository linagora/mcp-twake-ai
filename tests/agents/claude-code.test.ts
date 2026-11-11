import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCodeAgent } from '../../src/agents/claude-code.js';
import { fingerprint } from '../../src/agents/entries.js';
import { installFakeClaude, withPath } from '../helpers/fake-claude.js';
import { tempDir } from '../helpers/tmp.js';

async function claudeHere(extra: Record<string, string> = {}) {
  const dir = await tempDir();
  const fake = await installFakeClaude(dir);
  const env = withPath(fake.binDir, { CLAUDE_CONFIG_DIR: fake.configDir, ...extra });
  return { dir, fake, claude: claudeCodeAgent({ platform: process.platform, env, home: dir }) };
}

describe('Claude Code', () => {
  it('finds claude in PATH, and says so when it is not there', async () => {
    const { claude, dir } = await claudeHere();
    expect(await claude.detect()).toBe(true);
    const nowhere = claudeCodeAgent({ platform: process.platform, env: withPath(join(dir, 'nothing')), home: dir });
    expect(await nowhere.detect()).toBe(false);
    await expect(nowhere.write({ set: { 'twake-mail': { command: 'node' } }, remove: [] })).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('adds, replaces and removes entries with claude mcp, in the user scope', async () => {
    const { claude, fake, dir } = await claudeHere();
    const github = { type: 'http', url: 'https://api.githubcopilot.com/mcp/' };
    await writeFile(join(fake.configDir, '.claude.json'), JSON.stringify({ mcpServers: { github, 'twake-dav': { type: 'stdio', command: 'old', args: [] } } }));
    const node = join(dir, 'my node', 'node');
    const mail = claude.shape({ command: node, args: ['/opt/cli.js', 'run', 'mail', '--agent', 'claude-code'], env: { TWAKE_AI_HOME: join(dir, 'work account') } });
    const dav = claude.shape({ command: node, args: ['/opt/cli.js', 'run', 'dav', '--agent', 'claude-code'], env: {} });
    expect(await claude.write({ set: { 'twake-mail': mail, 'twake-dav': dav }, remove: [] })).toEqual({});
    const now = await claude.read();
    expect(now.github).toEqual(github);
    expect(fingerprint(now['twake-mail']!)).toBe(fingerprint(mail));
    expect(fingerprint(now['twake-dav']!)).toBe(fingerprint(dav));
    expect(await fake.calls()).toEqual([
      ['mcp', 'remove', '--scope', 'user', 'twake-dav'],
      ['mcp', 'add', '--scope', 'user', 'twake-mail', '-e', `TWAKE_AI_HOME=${join(dir, 'work account')}`, '--', node, '/opt/cli.js', 'run', 'mail', '--agent', 'claude-code'],
      ['mcp', 'add', '--scope', 'user', 'twake-dav', '--', node, '/opt/cli.js', 'run', 'dav', '--agent', 'claude-code'],
    ]);
    await claude.write({ set: {}, remove: ['twake-mail'] });
    expect(Object.keys(await claude.read()).sort()).toEqual(['github', 'twake-dav']);
  });

  it('puts the entries back as they were when claude fails halfway', async () => {
    const { claude, fake } = await claudeHere({ FAKE_CLAUDE_FAIL_ON: 'twake-mail' });
    const hand = { type: 'stdio', command: 'my-dav', args: ['--fast'], env: {} };
    await writeFile(join(fake.configDir, '.claude.json'), JSON.stringify({ mcpServers: { 'twake-dav': hand } }));
    const write = claude.write({ set: { 'twake-dav': { command: 'node', args: ['dav'] }, 'twake-mail': { command: 'node', args: ['mail'] } }, remove: [] });
    await expect(write).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('disk full') });
    const now = await claude.read();
    expect(fingerprint(now['twake-dav']!)).toBe(fingerprint(hand));
    expect(now['twake-mail']).toBeUndefined();
  });

  it('reads nothing when Claude Code has no state file yet', async () => {
    const { claude } = await claudeHere();
    expect(await claude.read()).toEqual({});
  });
});
