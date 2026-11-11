import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import { main, readLineFrom, type CliDeps, type Io } from '../src/cli.js';
import { writePrivateFile } from '../src/files.js';
import { chooseVault } from '../src/vault.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';
import { tempPaths } from './helpers/tmp.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';
import { fakeNpm } from './helpers/fake-mcp.js';
import { prefixDir } from '../src/installer.js';
import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readText } from '../src/agents/config-file.js';
import { journalFile } from '../src/journal.js';
import { cursorConfig, vscodeConfig } from '../src/agents/locations.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

function captureIo(): Io & { out: string; err: string } {
  const io = {
    out: '',
    err: '',
    stdout: (text: string) => {
      io.out += text;
    },
    stderr: (text: string) => {
      io.err += text;
    },
  };
  return io;
}

let idp: FakeIdp;
beforeEach(async () => {
  idp = await startFakeIdp();
});
afterEach(() => idp.close());

/** A desktop where example.com is a Twake.ai domain whose IdP is the fake one. */
async function testDeps(): Promise<CliDeps & { clock: { t: number } }> {
  const { root, paths } = await tempPaths();
  const clock = { t: 3_000_000 };
  const discovery = { 'm.homeserver': { base_url: 'https://matrix.example.com/' }, 'm.authentication': { issuer: idp.url } };
  return {
    clock,
    paths,
    home: join(root, 'home'),
    env: {},
    platform: 'darwin',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://example.com/.well-known/matrix/client') return Response.json(discovery);
      if (url.startsWith('http://127.0.0.1:')) return fetch(input, init);
      throw new TypeError('fetch failed');
    }) as typeof fetch,
    resolveSrv: async () => {
      throw new Error('ENOTFOUND');
    },
    openUrl: async (url) => {
      const atIdp = await fetch(url, { redirect: 'manual' });
      await fetch(atIdp.headers.get('location') ?? '');
    },
    chooseVault: (p) => chooseVault(p, { TWAKE_AI_VAULT: 'file' }),
    now: () => clock.t,
    sleep: async (ms) => void (clock.t += ms / 1000),
    loopbackPorts: [0],
    readLine: async () => '',
    nodePath: '/usr/bin/node',
    cliPath: '/opt/twake-ai/build/bin.js',
  };
}

describe('main', () => {
  it('prints the package version', async () => {
    const io = captureIo();
    expect(await main(['--version'], io, await testDeps())).toBe(0);
    expect(io.out).toBe(`${version}\n`);
  });

  it('prints the usage on stderr and exits 2 for an unknown command or option', async () => {
    for (const argv of [['frobnicate'], ['token'], ['token', 'calendar'], ['login', '--emial', 'x@example.com']]) {
      const io = captureIo();
      expect(await main(argv, io, await testDeps())).toBe(2);
      expect(io.err).toMatch(/usage:/);
      expect(io.out).toBe('');
    }
  });

  it('asks to sign in first when mcp-twake-ai is not set up, with nothing on stdout', async () => {
    const io = captureIo();
    expect(await main(['token', 'mail'], io, await testDeps())).toBe(1);
    expect(io.err).toMatch(/^mcp-twake-ai: .*mcp-twake-ai login/);
    expect(io.out).toBe('');
  });

  it('signs in, then serves tokens and renews them once expired', async () => {
    const deps = await testDeps();
    const login = captureIo();
    expect(await main(['login', '--email', 'alice@example.com'], login, deps)).toBe(0);
    expect(login.out).toContain('Signed in as alice@example.com');
    expect(login.out).toContain('https://alice.twake.example.com');

    const first = captureIo();
    expect(await main(['token', 'project'], first, deps)).toBe(0);
    expect(JSON.parse(first.out)).toEqual({ access_token: expect.stringMatching(/^access-/), expires_at: 3_000_300 });
    expect(first.out.endsWith('}\n')).toBe(true);
    expect(idp.refreshCount).toBe(0);

    deps.clock.t += 1_000;
    const second = captureIo();
    expect(await main(['token', 'mail'], second, deps)).toBe(0);
    expect(JSON.parse(second.out).access_token).not.toBe(JSON.parse(first.out).access_token);
    expect(idp.refreshCount).toBe(1);
  });

  it('signs in from another device with --no-browser', async () => {
    const io = captureIo();
    expect(await main(['login', '--email', 'alice@example.com', '--no-browser'], io, await testDeps())).toBe(0);
    expect(io.out).toContain('ABCD-EFGH');
  });

  it('tells a foreign domain apart', async () => {
    const io = captureIo();
    expect(await main(['login', '--email', 'bob@example.org'], io, await testDeps())).toBe(1);
    expect(io.err).toMatch(/example\.org/);
  });
});

describe('the mcp-twake-ai process', () => {
  it('exits 1 with the message on stderr and an empty stdout when not set up', { timeout: 30_000 }, async () => {
    const { root } = await tempPaths();
    const result = await run(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'token', 'mail'], {
      cwd: repoRoot,
      env: { ...process.env, TWAKE_AI_HOME: root },
    }).catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect((result as { stderr: string }).stderr).toContain('mcp-twake-ai login');
  });
});

describe('main: second sign-in and failures', () => {
  it('keeps a journal of commands and errors, without tokens', async () => {
    const deps = await testDeps();
    expect(await main(['login', '--email', 'alice@example.com'], captureIo(), deps)).toBe(0);
    expect(await main(['token', 'mail'], captureIo(), deps)).toBe(0);
    expect(await main(['token', 'chat'], captureIo(), deps)).toBe(2);
    const text = await readFile(journalFile(deps.paths), 'utf8');
    expect(text).toContain('login --email alice@example.com → 0');
    expect(text).not.toContain('token mail');
    expect(text).toContain('token chat → 2: A Twake Chat token belongs to an agent');
    expect(text).not.toMatch(/access_token|eyJ/);
  });

  it('signs in again with the client and scope used the first time', async () => {
    const deps = await testDeps();
    expect(await main(['login', '--email', 'alice@example.com', '--client-id', 'my-test-client', '--scope', 'openid offline_access'], captureIo(), deps)).toBe(0);
    idp.lastClientId = undefined;
    idp.lastScope = undefined;
    expect(await main(['login'], captureIo(), deps)).toBe(0);
    expect(idp.lastClientId).toBe('my-test-client');
    expect(idp.lastScope).toBe('openid offline_access');
  });

  it('says where the session is kept', async () => {
    const deps = await testDeps();
    const io = captureIo();
    expect(await main(['login', '--email', 'alice@example.com'], io, deps)).toBe(0);
    expect(io.out).toContain(deps.paths.vaultFile);
  });

  it('signs in even when the saved configuration is damaged', async () => {
    const deps = await testDeps();
    await writePrivateFile(deps.paths.configFile, '{"version":');
    expect(await main(['login', '--email', 'alice@example.com'], captureIo(), deps)).toBe(0);
  });

  it('names the damaged configuration when asked for a token', async () => {
    const deps = await testDeps();
    await writePrivateFile(deps.paths.configFile, '{"version":');
    const io = captureIo();
    expect(await main(['token', 'mail'], io, deps)).toBe(1);
    expect(io.err).toContain(deps.paths.configFile);
    expect(io.err).toContain('mcp-twake-ai login');
  });

  it('reports an identity provider outage on one line, with what to do', async () => {
    const deps = await testDeps();
    expect(await main(['login', '--email', 'alice@example.com'], captureIo(), deps)).toBe(0);
    idp.tokenFailureStatus = 503;
    deps.clock.t += 1_000;
    const io = captureIo();
    expect(await main(['token', 'mail'], io, deps)).toBe(1);
    expect(io.err).toMatch(/^mcp-twake-ai: .*127\.0\.0\.1.*try again.*\n$/);
    expect(io.err.trim()).not.toContain('\n');
    expect(io.out).toBe('');
  });

  it('prints an unexpected error on a single line', async () => {
    const deps = await testDeps();
    deps.chooseVault = async () => {
      throw new Error('first line\nsecond line');
    };
    const io = captureIo();
    expect(await main(['login', '--email', 'alice@example.com'], io, deps)).toBe(1);
    expect(io.err).toBe('mcp-twake-ai: unexpected error: first line\n');
  });
});

describe('main: Twake Drive and Twake Chat', () => {
  let cozy: FakeCozy;
  let synapse: FakeSynapse;
  beforeEach(async () => {
    cozy = await startFakeCozy();
    synapse = await startFakeSynapse();
  });
  afterEach(async () => {
    await cozy.close();
    await synapse.close();
  });

  /** Signed in, with the Drive instance and the homeserver pointing at the fakes. */
  async function signedIn(): Promise<CliDeps & { clock: { t: number } }> {
    const deps = await testDeps();
    expect(await main(['login', '--email', 'alice@example.com'], captureIo(), deps)).toBe(0);
    const config = (await loadConfig(deps.paths))!;
    await saveConfig(deps.paths, {
      ...config,
      environment: { ...config.environment, cozy: { ...config.environment.cozy, instance: cozy.url }, matrix: { homeserver: synapse.url } },
    });
    return deps;
  }

  it('connects Twake Drive in the browser, then serves Drive tokens', async () => {
    const deps = await signedIn();
    const io = captureIo();
    expect(await main(['login', '--drive'], io, deps)).toBe(0);
    expect(io.out).toContain(`Twake Drive connected: ${cozy.url}`);
    const token = captureIo();
    expect(await main(['token', 'drive'], token, deps)).toBe(0);
    expect(JSON.parse(token.out)).toMatchObject({ access_token: expect.stringMatching(/^cozy-access/) });
  });

  it('connects Twake Chat for an agent from another device, then serves its token with the device', async () => {
    const deps = await signedIn();
    deps.platform = 'linux';
    const io = captureIo();
    deps.readLine = async () => {
      const url = /(http:\/\/127\.0\.0\.1:\d+\/_matrix\S+)/.exec(io.out)?.[1] ?? '';
      const atSynapse = await fetch(url, { redirect: 'manual' });
      return atSynapse.headers.get('location') ?? '';
    };
    expect(await main(['login', '--chat', '--agent', 'hermes'], io, deps)).toBe(0);
    expect(io.out).toContain('Twake Chat connected for hermes as @alice:example.com (device DEVICE1)');
    const token = captureIo();
    expect(await main(['token', 'chat', '--agent', 'hermes'], token, deps)).toBe(0);
    expect(JSON.parse(token.out)).toMatchObject({ device_id: 'DEVICE1', user_id: '@alice:example.com' });
  });

  it('asks to sign in before connecting a service', async () => {
    const io = captureIo();
    expect(await main(['login', '--drive'], io, await testDeps())).toBe(1);
    expect(io.err).toContain('mcp-twake-ai login --email');
  });

  it('needs an agent for Chat, a valid one, and one service at a time', async () => {
    const deps = await signedIn();
    for (const argv of [['login', '--chat'], ['token', 'chat'], ['token', 'chat', '--agent', '../x'], ['login', '--drive', '--chat', '--agent', 'hermes']]) {
      const io = captureIo();
      expect(await main(argv, io, deps)).toBe(2);
      expect(io.out).toBe('');
    }
  });

  it('reports a missing --agent for Chat before anything else, even when nothing is set up', async () => {
    const io = captureIo();
    expect(await main(['token', 'chat'], io, await testDeps())).toBe(2);
    expect(io.err).toContain('--agent');
    expect(io.out).toBe('');
  });

  it('refuses flags that do not go together', async () => {
    const deps = await signedIn();
    for (const argv of [['login', '--agent', 'hermes'], ['login', '--drive', '--email', 'bob@example.com'], ['login', '--chat', '--agent', 'hermes', '--client-id', 'x']]) {
      const io = captureIo();
      expect(await main(argv, io, deps)).toBe(2);
      expect(io.out).toBe('');
    }
  });

  it('gives up cleanly when the input closes before an address is pasted', async () => {
    await expect(readLineFrom(Readable.from([]), new PassThrough(), 'Address: ')).rejects.toMatchObject({ code: 'login_cancelled' });
    expect(await readLineFrom(Readable.from(['http://127.0.0.1:8765/callback?x=1\n']), new PassThrough(), 'Address: ')).toBe(
      'http://127.0.0.1:8765/callback?x=1',
    );
  });

  it('exports for an agent, creating its Chat device and installing the servers first', async () => {
    const deps = await signedIn();
    const npm = fakeNpm(deps.paths);
    deps.runInstall = npm;
    const out = join(deps.paths.dataDir, '..', 'export');
    const io = captureIo();
    expect(await main(['export', '--agent', 'zed', '--services', 'chat', '--out', out], io, deps)).toBe(0);
    expect(io.out).toContain('Twake Chat connected for zed');
    expect(npm.calls[0]).toContain('mcp-twake-chat@0.6.1');
    const servers = JSON.parse(await readFile(join(out, 'mcpServers.json'), 'utf8')).mcpServers;
    expect(servers['twake-chat'].args).toEqual(['/opt/twake-ai/build/bin.js', 'run', 'chat', '--agent', 'zed']);
    expect(io.out).toContain(out);
  });

  it('checks every service before creating a Chat device or installing anything', async () => {
    const deps = await signedIn();
    const npm = fakeNpm(deps.paths);
    deps.runInstall = npm;
    const io = captureIo();
    expect(await main(['export', '--agent', 'zed', '--services', 'drive,chat', '--out', join(deps.paths.dataDir, '..', 'x')], io, deps)).toBe(1);
    expect(io.err).toContain('mcp-twake-ai login --drive');
    expect(synapse.deviceNames).toEqual({});
    expect(npm.calls).toEqual([]);
  });

  it('says how to leave Chat out when it comes by default', async () => {
    const deps = await signedIn();
    deps.runInstall = fakeNpm(deps.paths);
    const io = captureIo();
    expect(await main(['export', '--agent', 'zed', '--out', join(deps.paths.dataDir, '..', 'y')], io, deps)).toBe(0);
    expect(io.out).toContain('--services');
  });

  it('refuses an unknown service in --services', async () => {
    const io = captureIo();
    expect(await main(['export', '--agent', 'zed', '--services', 'mail,calendar'], io, await signedIn())).toBe(2);
  });

  it('asks to connect Drive before serving its tokens', async () => {
    const deps = await signedIn();
    const io = captureIo();
    expect(await main(['token', 'drive'], io, deps)).toBe(1);
    expect(io.err).toContain('mcp-twake-ai login --drive');
  });

  /** Signed in with Twake Mail found, Cursor and VS Code installed (macOS paths: testDeps uses platform darwin). */
  async function readyForSetup() {
    const deps = await signedIn();
    const config = (await loadConfig(deps.paths))!;
    await saveConfig(deps.paths, {
      ...config,
      environment: { ...config.environment, services: { mail: { url: 'https://jmap.example.com/jmap/session', source: 'discovered' } } },
    });
    deps.runInstall = fakeNpm(deps.paths);
    const place = { platform: deps.platform, env: deps.env, home: deps.home };
    const cursor = cursorConfig(place);
    const vscode = vscodeConfig(place);
    await mkdir(dirname(cursor), { recursive: true });
    await mkdir(dirname(vscode), { recursive: true });
    return { deps, cursor, vscode };
  }

  it('shows the plan of each agent and changes nothing without --yes', async () => {
    const { deps, cursor } = await readyForSetup();
    const io = captureIo();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail'], io, deps)).toBe(0);
    expect(io.out).toContain(`Cursor (${cursor})`);
    expect(io.out).toMatch(/\+ twake-mail\s+add/);
    expect(io.out).toContain('--yes');
    expect(await readText(cursor)).toBeUndefined();
  });

  it('writes the agents with --yes, then finds nothing to change', async () => {
    const { deps, cursor, vscode } = await readyForSetup();
    const io = captureIo();
    expect(await main(['setup', '--agents', 'cursor,vscode', '--services', 'mail', '--yes'], io, deps)).toBe(0);
    expect(JSON.parse((await readText(cursor))!).mcpServers['twake-mail']).toEqual({
      type: 'stdio',
      command: '/usr/bin/node',
      args: ['/opt/twake-ai/build/bin.js', 'run', 'mail', '--agent', 'cursor'],
    });
    expect(JSON.parse((await readText(vscode))!).servers['twake-mail'].args).toEqual(['/opt/twake-ai/build/bin.js', 'run', 'mail', '--agent', 'vscode']);
    expect(Object.keys((await loadConfig(deps.paths))!.agents!)).toEqual(['cursor', 'vscode']);
    const again = captureIo();
    expect(await main(['setup', '--agents', 'cursor,vscode', '--services', 'mail', '--yes'], again, deps)).toBe(0);
    expect(again.out).toMatch(/= twake-mail\s+unchanged/);
    expect(again.out).toContain('Cursor: already up to date.');
  });

  it('leaves an entry configured by hand unless --force', async () => {
    const { deps, cursor } = await readyForSetup();
    await writeFile(cursor, JSON.stringify({ mcpServers: { 'twake-mail': { command: 'my-mail' } } }));
    const io = captureIo();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail', '--yes'], io, deps)).toBe(0);
    expect(io.out).toContain('replaces an entry configured outside mcp-twake-ai: add --force');
    expect(JSON.parse((await readText(cursor))!).mcpServers['twake-mail']).toEqual({ command: 'my-mail' });
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail', '--yes', '--force'], captureIo(), deps)).toBe(0);
    expect(JSON.parse((await readText(cursor))!).mcpServers['twake-mail'].command).toBe('/usr/bin/node');
  });

  it('removes the entries of the services left out', async () => {
    const { deps, cursor } = await readyForSetup();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail,chat', '--yes'], captureIo(), deps)).toBe(0);
    expect(Object.keys(JSON.parse((await readText(cursor))!).mcpServers)).toEqual(['twake-chat', 'twake-mail']);
    const io = captureIo();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail', '--yes'], io, deps)).toBe(0);
    expect(io.out).toMatch(/- twake-chat\s+remove/);
    expect(Object.keys(JSON.parse((await readText(cursor))!).mcpServers)).toEqual(['twake-mail']);
  });

  it('creates the Chat device of each agent it configures', async () => {
    const { deps } = await readyForSetup();
    const io = captureIo();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'chat', '--yes'], io, deps)).toBe(0);
    expect(io.out).toContain('Twake Chat gets a device for: cursor.');
    expect(Object.values(synapse.deviceNames)).toEqual(['Twake AI · cursor']);
  });

  it('leaves out an agent that is not installed, and says which ones are', async () => {
    const { deps } = await readyForSetup();
    const io = captureIo();
    expect(await main(['setup', '--agents', 'claude-desktop,cursor', '--services', 'mail', '--yes'], io, deps)).toBe(0);
    expect(io.out).toContain('Claude Desktop: not found on this computer');
    const usage = captureIo();
    expect(await main(['setup'], usage, deps)).toBe(2);
    expect(usage.err).toContain('found here: cursor, vscode');
  });

  it('refuses an agent it does not configure, pointing to export', async () => {
    const io = captureIo();
    expect(await main(['setup', '--agents', 'zed'], io, (await readyForSetup()).deps)).toBe(2);
    expect(io.err).toContain('use export');
  });

  it('goes on with the other agents when one has an entry emptied by hand', async () => {
    const { deps, cursor } = await readyForSetup();
    await mkdir(join(deps.home, '.hermes'), { recursive: true });
    await writeFile(join(deps.home, '.hermes', 'config.yaml'), 'mcp_servers:\n  twake_mail:\n');
    const io = captureIo();
    expect(await main(['setup', '--agents', 'hermes,cursor', '--services', 'mail', '--yes'], io, deps)).toBe(0);
    expect(io.out).toMatch(/! twake_mail\s+replaces an entry configured outside mcp-twake-ai/);
    expect(JSON.parse((await readText(cursor))!).mcpServers).toHaveProperty('twake-mail');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('goes on with the other agents when a file cannot be read, naming it', async () => {
    const { deps, cursor, vscode } = await readyForSetup();
    await writeFile(cursor, '{}');
    await chmod(cursor, 0o000);
    try {
      const io = captureIo();
      expect(await main(['setup', '--agents', 'cursor,vscode', '--services', 'mail', '--yes'], io, deps)).toBe(1);
      expect(io.out).toContain(`Cursor: `);
      expect(io.out).toContain(cursor);
      expect(JSON.parse((await readText(vscode))!).servers).toHaveProperty('twake-mail');
    } finally {
      await chmod(cursor, 0o600);
    }
  });

  it('reports a damaged agent file and still writes the others', async () => {
    const { deps, cursor, vscode } = await readyForSetup();
    await writeFile(vscode, '{"servers": {');
    const io = captureIo();
    expect(await main(['setup', '--agents', 'cursor,vscode', '--services', 'mail', '--yes'], io, deps)).toBe(1);
    expect(io.out).toContain(`VS Code: ${vscode} is not valid JSON`);
    expect(JSON.parse((await readText(cursor))!).mcpServers).toHaveProperty('twake-mail');
    expect(await readText(vscode)).toBe('{"servers": {');
  });

  it('shows the health of the session, Drive, Chat and every entry', async () => {
    const { deps } = await readyForSetup();
    // an entry is only in place when its node exists: the real one, wherever this machine keeps it
    deps.nodePath = process.execPath;
    expect(await main(['login', '--drive'], captureIo(), deps)).toBe(0);
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail,chat', '--yes'], captureIo(), deps)).toBe(0);
    const io = captureIo();
    expect(await main(['status', '--no-start'], io, deps)).toBe(0);
    expect(io.out).toContain('✓ Twake session: alice@example.com');
    expect(io.out).toContain(`✓ Twake Drive: ${cozy.url}`);
    expect(io.out).toContain('Cursor');
    expect(io.out).toMatch(/✓ twake-mail\s+in place/);
    expect(io.out).toMatch(/✓ Twake Chat \(cursor\): @alice:example.com/);
  });

  it('says what is wrong, and exits with 1', async () => {
    const { deps, cursor } = await readyForSetup();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail', '--yes'], captureIo(), deps)).toBe(0);
    const servers = JSON.parse((await readText(cursor))!);
    servers.mcpServers['twake-mail'].args.push('--debug');
    await writeFile(cursor, JSON.stringify(servers));
    // no cached token: the session check asks the IdP, which refuses
    await rm(deps.paths.tokensDir, { recursive: true, force: true });
    idp.tokenFailureStatus = 400;
    const io = captureIo();
    expect(await main(['status', '--no-start'], io, deps)).toBe(1);
    expect(io.out).toMatch(/✗ Twake session: /);
    expect(io.out).toMatch(/! twake-mail\s+changed by hand/);
  });

  it('starts each server through its entry', async () => {
    const { deps } = await readyForSetup();
    deps.nodePath = process.execPath;
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail', '--yes'], captureIo(), deps)).toBe(0);
    const io = captureIo();
    expect(await main(['status', '--agents', 'cursor'], io, deps)).toBe(1);
    // the entry starts /opt/twake-ai/build/bin.js, which does not exist here: the handshake says so
    expect(io.out).toMatch(/✗ twake-mail\s+.*(Cannot find module|MODULE_NOT_FOUND|stopped)/);
  });

  it('says when an agent is not installed or has no Twake.ai entry, and exits with 1', async () => {
    const { deps } = await readyForSetup();
    const io = captureIo();
    expect(await main(['status', '--agents', 'claude-desktop,cursor', '--no-start'], io, deps)).toBe(1);
    expect(io.out).toMatch(/Claude Desktop .*\n  ✗ not found on this computer/);
    expect(io.out).toMatch(/Cursor .*\n  no Twake.ai entry: run setup/);
  });

  it('logs out with exit code 1 when a revocation fails, naming it', async () => {
    const { deps } = await readyForSetup();
    idp.close();
    const io = captureIo();
    expect(await main(['logout'], io, deps)).toBe(1);
    expect(io.out).toMatch(/✗ Twake session: /);
  });

  it('prints the environment run would build', async () => {
    const { deps } = await readyForSetup();
    const io = captureIo();
    expect(await main(['status', '--env', 'mail', '--agent', 'cursor'], io, deps)).toBe(0);
    expect(io.out).toContain('JMAP_SESSION_URL=https://jmap.example.com/jmap/session\n');
    expect(io.out).toContain("JMAP_TOKEN_COMMAND='/usr/bin/node' '/opt/twake-ai/build/bin.js' 'token' 'mail'\n");
  });

  it('logs out of everything, then token asks to sign in again', async () => {
    const deps = await signedIn();
    expect(await main(['login', '--drive'], captureIo(), deps)).toBe(0);
    expect(await main(['login', '--chat', '--agent', 'hermes'], captureIo(), deps)).toBe(0);
    const io = captureIo();
    expect(await main(['logout'], io, deps)).toBe(0);
    expect(io.out).toContain('✓ Twake session revoked');
    expect(io.out).toContain('✓ Twake Chat device of hermes signed out');
    expect(cozy.deleted).toHaveLength(1);
    const token = captureIo();
    expect(await main(['token', 'mail'], token, deps)).toBe(1);
    expect(token.err).toContain('mcp-twake-ai login');
  });

  it('shows what uninstall removes, then removes it with --yes', async () => {
    const { deps, cursor } = await readyForSetup();
    expect(await main(['setup', '--agents', 'cursor,vscode', '--services', 'mail,chat', '--yes'], captureIo(), deps)).toBe(0);
    await mkdir(join(deps.paths.dataDir, 'chat', 'cursor', 'DEVICE1'), { recursive: true });
    const plan = captureIo();
    expect(await main(['uninstall'], plan, deps)).toBe(0);
    expect(plan.out).toMatch(/- twake-mail\s+remove/);
    expect(plan.out).toContain('Nothing was changed');
    expect(JSON.parse((await readText(cursor))!).mcpServers).toHaveProperty('twake-mail');
    const io = captureIo();
    expect(await main(['uninstall', '--yes'], io, deps)).toBe(0);
    expect(JSON.parse((await readText(cursor))!).mcpServers).toEqual({});
    expect(await loadConfig(deps.paths)).toBeUndefined();
    expect(await readText(join(prefixDir(deps.paths), 'mcp-twake-mail', 'package.json'))).toBeUndefined();
    expect(io.out).toContain(`Twake Chat stores kept in ${join(deps.paths.dataDir, 'chat')}`);
    expect(synapse.loggedOut).toHaveLength(2);
    // the journal goes with the rest, and the uninstall itself does not bring it back
    expect(await stat(journalFile(deps.paths)).then(() => true, () => false)).toBe(false);
  });

  it('keeps an entry changed by hand unless --force, and the Chat stores unless asked', async () => {
    const { deps, cursor } = await readyForSetup();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail', '--yes'], captureIo(), deps)).toBe(0);
    const servers = JSON.parse((await readText(cursor))!);
    servers.mcpServers['twake-mail'].env = { DEBUG: '1' };
    await writeFile(cursor, JSON.stringify(servers));
    await mkdir(join(deps.paths.dataDir, 'chat', 'cursor'), { recursive: true });
    const io = captureIo();
    expect(await main(['uninstall', '--yes', '--delete-chat-stores'], io, deps)).toBe(1);
    expect(io.out).toContain('left as they are: twake-mail');
    expect(JSON.parse((await readText(cursor))!).mcpServers['twake-mail'].env).toEqual({ DEBUG: '1' });
    expect(await stat(join(deps.paths.dataDir, 'chat')).then(() => true, () => false)).toBe(false);
    // what is left stays recorded, so that --force can still remove it
    expect((await loadConfig(deps.paths))?.agents?.cursor?.entries).toHaveProperty('twake-mail');
    expect(await main(['uninstall', '--yes', '--force'], captureIo(), deps)).toBe(0);
    expect(JSON.parse((await readText(cursor))!).mcpServers).toEqual({});
    expect(await loadConfig(deps.paths)).toBeUndefined();
  });

  it('refuses to uninstall over a configuration it cannot read, unless --force', async () => {
    const { deps } = await readyForSetup();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail', '--yes'], captureIo(), deps)).toBe(0);
    await writeFile(deps.paths.configFile, '{ damaged');
    const io = captureIo();
    expect(await main(['uninstall', '--yes'], io, deps)).toBe(1);
    expect(io.err).toContain('--force');
    expect(await stat(prefixDir(deps.paths)).then(() => true, () => false)).toBe(true);
    expect(await main(['uninstall', '--yes', '--force'], captureIo(), deps)).toBe(0);
    expect(await stat(prefixDir(deps.paths)).then(() => true, () => false)).toBe(false);
    expect(await stat(deps.paths.configFile).then(() => true, () => false)).toBe(false);
  });

  it('signs in first with --email when there is no session yet', async () => {
    const deps = await testDeps();
    await mkdir(join(deps.home, '.cursor'), { recursive: true });
    deps.runInstall = fakeNpm(deps.paths);
    const io = captureIo();
    expect(await main(['setup', '--email', 'alice@example.com', '--agents', 'cursor', '--services', 'chat'], io, deps)).toBe(0);
    expect(io.out).toContain('Signed in as alice@example.com');
    expect(io.out).toContain('Nothing was changed');
  });
});

describe('main: run', () => {
  it('needs a service and an agent', async () => {
    for (const argv of [['run'], ['run', 'mail'], ['run', 'calendar', '--agent', 'hermes'], ['run', 'mail', '--agent', '../x']]) {
      const io = captureIo();
      expect(await main(argv, io, await testDeps())).toBe(2);
      expect(io.out).toBe('');
    }
  });
});
