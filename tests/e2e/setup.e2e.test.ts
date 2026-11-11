import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { findExecutable } from '../../src/agents/claude-code.js';
import { saveConfig } from '../../src/config.js';
import { appPaths } from '../../src/paths.js';
import { installFakeClaude, withPath } from '../helpers/fake-claude.js';
import { installFakeMcp } from '../helpers/fake-mcp.js';
import { sampleConfig } from '../helpers/sample-config.js';
import { tempDir } from '../helpers/tmp.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(repo, 'build', 'bin.js');

/** A server that answers initialize and tools/list, as an agent's health check needs. */
const HELLO_MCP = `import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hello', version: '1' } } });
  else if (message.method === 'tools/list') send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'hello_' + process.env.USER_TIMEZONE.replace(/\\W/g, '_'), inputSchema: { type: 'object' } }] } });
  else if (message.id !== undefined && message.method) send({ jsonrpc: '2.0', id: message.id, result: {} });
});
`;

/** Starts an agent entry as the agent would, and returns the tools its server lists. */
async function toolsOf(entry: { command: string; args: string[]; env?: Record<string, string> }, env: NodeJS.ProcessEnv): Promise<string[]> {
  const child = spawn(entry.command, entry.args, { env: { ...env, ...entry.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout! });
  const replies = lines[Symbol.asyncIterator]();
  const ask = async (message: object) => {
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    return JSON.parse(String((await replies.next()).value)) as { result: { tools?: { name: string }[] } };
  };
  await ask({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } });
  const listed = await ask({ id: 2, method: 'tools/list', params: {} });
  child.stdin!.end();
  return (listed.result.tools ?? []).map((tool) => tool.name);
}

/** A computer with mcp-twake-ai signed in (TWAKE_AI_HOME), the Mail server installed, Cursor, VS Code and Hermes present. */
async function computer() {
  const root = await tempDir();
  const home = join(root, 'home dir');
  const twakeAiHome = join(root, 'twake ai');
  const paths = appPaths({ platform: process.platform, env: { TWAKE_AI_HOME: twakeAiHome }, home });
  await saveConfig(paths, sampleConfig);
  await installFakeMcp(paths, 'mail', HELLO_MCP);
  const claude = await installFakeClaude(root);
  const env = withPath([claude.binDir, process.env.PATH ?? ''].join(delimiter), {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    TWAKE_AI_HOME: twakeAiHome,
    CLAUDE_CONFIG_DIR: claude.configDir,
    TZ: 'Europe/Paris',
  });
  delete env.HERMES_HOME;
  delete env.VSCODE_APPDATA;
  await mkdir(join(home, '.cursor'), { recursive: true });
  await mkdir(join(home, '.hermes'), { recursive: true });
  await writeFile(join(home, '.hermes', 'config.yaml'), 'model: x\n');
  return { home, env, claude };
}

const setup = (env: NodeJS.ProcessEnv, ...args: string[]) => execFileSync(process.execPath, [cli, 'setup', ...args], { env, encoding: 'utf8' });

describe('mcp-twake-ai setup, end to end', () => {
  beforeAll(() => {
    execFileSync(process.execPath, [join(repo, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', repo], { stdio: 'inherit' });
  }, 120_000);

  it('writes entries that start their server, for Cursor, Hermes and Claude Code', { timeout: 60_000 }, async () => {
    const { home, env, claude } = await computer();
    const out = setup(env, '--agents', 'cursor,hermes,claude-code', '--services', 'mail', '--yes');
    expect(out).toContain('Cursor: done.');
    const cursor = JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers['twake-mail'];
    expect(cursor.args).toEqual([cli, 'run', 'mail', '--agent', 'cursor']);
    expect(await toolsOf(cursor, env)).toEqual(['hello_Europe_Paris']);
    const { parse } = await import('yaml');
    const hermes = parse(await readFile(join(home, '.hermes', 'config.yaml'), 'utf8')).mcp_servers.twake_mail;
    expect(hermes).toMatchObject({ timeout: 420, elicitation: { enabled: true, timeout: 300 } });
    expect(await toolsOf(hermes, env)).toEqual(['hello_Europe_Paris']);
    const code = JSON.parse(await readFile(join(claude.configDir, '.claude.json'), 'utf8')).mcpServers['twake-mail'];
    expect(await toolsOf(code, env)).toEqual(['hello_Europe_Paris']);
    expect(setup(env, '--agents', 'cursor,hermes,claude-code', '--services', 'mail', '--yes')).toContain('Cursor: already up to date.');
  });

  it.runIf(process.env.MCP_TWAKE_AI_E2E === '1')('is accepted by the real Claude Code, which connects to the server', { timeout: 120_000 }, async () => {
    const real = await findExecutable('claude', { platform: process.platform, env: process.env, home: '' });
    expect(real, 'claude must be installed for MCP_TWAKE_AI_E2E=1').toBeDefined();
    const { env } = await computer();
    const configDir = join(await tempDir(), 'real claude');
    await mkdir(configDir);
    const realEnv = { ...env, PATH: process.env.PATH ?? '', CLAUDE_CONFIG_DIR: configDir };
    expect(setup(realEnv, '--agents', 'claude-code', '--services', 'mail', '--yes')).toContain('Claude Code: done.');
    const shown = execFileSync(real!, ['mcp', 'get', 'twake-mail'], { env: realEnv, encoding: 'utf8' });
    expect(shown).toContain('Connected');
  });
});
