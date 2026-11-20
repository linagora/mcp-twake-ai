import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { main, type CliDeps } from '../src/cli.js';
import { cliSettingsFile } from '../src/cli-call.js';
import { saveConfig } from '../src/config.js';
import { journalFile } from '../src/journal.js';
import { fakeNpm, installFakeCliMcp } from './helpers/fake-mcp.js';
import { captureIo, cliDeps } from './helpers/cli-deps.js';
import { sampleConfig } from './helpers/sample-config.js';

async function ready(overrides: Partial<CliDeps> = {}, withCommandLine = true) {
  const d = await cliDeps(overrides);
  d.runInstall = fakeNpm(d.paths);
  await saveConfig(d.paths, sampleConfig);
  await installFakeCliMcp(d.paths, 'mail', withCommandLine);
  return d;
}

async function cli(args: string[], d: CliDeps) {
  const io = captureIo();
  return { code: await main(args, io, d), out: io.out, err: io.err };
}

async function allowedIn(d: CliDeps): Promise<string[]> {
  return (JSON.parse(await readFile(cliSettingsFile(d.platform, d.accountHome!), 'utf8')) as { allowedUnattended: string[] }).allowedUnattended;
}

describe('mcp-twake-ai call / tools', { timeout: 30_000 }, () => {
  it("runs the installed server's call with its arguments, and the server started as agents start it", async () => {
    const d = await ready();
    const r = await cli(['call', 'mail', 'search_emails', '--arg', 'participant=bob@x', '--yes', '--as', 'cron'], d);
    expect(r.code).toBe(0);
    const seen = JSON.parse(r.out) as { sub: string; rest: string[]; server: string; lang: string; home: string };
    expect(seen.sub).toBe('call');
    expect(seen.rest).toEqual(['search_emails', '--arg', 'participant=bob@x', '--yes', '--as', 'cron']);
    expect(JSON.parse(seen.server)).toEqual([d.nodePath, ...(d.nodeArgs ?? []), d.cliPath, 'run', 'mail', '--agent', 'cli']);
    expect(seen.lang).toBe('en');
    expect(seen.home).toBe(d.env.TWAKE_AI_HOME);
  });

  it('passes tools, and gives back the exit code of the server', async () => {
    const d = await ready();
    expect(JSON.parse((await cli(['tools', 'mail', 'search_emails'], d)).out)).toMatchObject({ sub: 'tools', rest: ['search_emails'] });
    d.env.FAKE_CALL_EXIT = '3';
    expect((await cli(['call', 'mail', 'send_email'], d)).code).toBe(3);
  });

  it('exits 4 for a server version without a command line', async () => {
    const r = await cli(['call', 'mail', 'search_emails'], await ready({}, false));
    expect(r.code).toBe(4);
    expect(r.err).toContain('setup');
  });

  it('exits 2 for an unknown service, 4 when not signed in or without a Chat device', async () => {
    expect((await cli(['call', 'calendar', 'x'], await ready())).code).toBe(2);
    expect((await cli(['call', 'mail', 'x'], await cliDeps())).code).toBe(4);
    const r = await cli(['call', 'chat', 'list_rooms'], await ready());
    expect(r.code).toBe(4);
    expect(r.err).toContain('mcp-twake-ai login --chat --agent cli');
  });

  it('never writes the arguments into the journal', async () => {
    const d = await ready();
    d.env.FAKE_CALL_EXIT = '1';
    await cli(['call', 'mail', 'send_email', '--json', '{"body":"SECRET"}'], d);
    const journal = await readFile(journalFile(d.paths), 'utf8');
    expect(journal).toContain('call mail send_email → 1');
    expect(journal).not.toContain('SECRET');
  });
});

describe('mcp-twake-ai allow-unattended', () => {
  it('writes the cli.json the servers read, only after a yes typed in a terminal', async () => {
    const d = await ready({ promptable: true, readAnswer: async () => 'y' });
    expect((await cli(['allow-unattended', 'cron-agenda'], d)).code).toBe(0);
    expect(await allowedIn(d)).toEqual(['cron-agenda']);
    expect((await cli(['allow-unattended', 'cron-agenda', '--revoke'], { ...d, promptable: false })).code).toBe(0);
    expect(await allowedIn(d)).toEqual([]);
    const nope = await ready({ promptable: false, readAnswer: async () => 'y' });
    expect((await cli(['allow-unattended', 'cron-agenda'], nope)).code).toBe(2);
    expect((await cli(['allow-unattended', 'Bad Name'], d)).code).toBe(2);
  });

  it('is listed by status and forgotten by logout', async () => {
    const d = await ready({ promptable: true, readAnswer: async () => 'y' });
    await saveConfig(d.paths, { ...sampleConfig, drive: undefined, chat: undefined });
    await cli(['allow-unattended', 'cron-agenda'], d);
    expect((await cli(['status', '--no-start'], d)).out).toContain('Allowed to write without a terminal: cron-agenda');
    await cli(['logout'], d);
    expect(await allowedIn(d)).toEqual([]);
  });
});
