import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { tokenCommand, type CatalogContext } from '../src/catalog.js';
import type { TwakeAiConfig } from '../src/config.js';
import { defaultServices, exportFiles, writeExport } from '../src/exporter.js';
import { serverDir } from '../src/installer.js';
import { installFakeMcp } from './helpers/fake-mcp.js';
import { tempDir, tempPaths } from './helpers/tmp.js';

const config: TwakeAiConfig = {
  version: 1,
  email: 'jdoe@linagora.com',
  vault: 'file',
  oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
  environment: {
    domain: 'linagora.com',
    oidc: { issuer: 'https://sso.linagora.com', authorization_endpoint: 'https://sso.linagora.com/a', token_endpoint: 'https://sso.linagora.com/t', userinfo_endpoint: 'https://sso.linagora.com/u' },
    matrix: { homeserver: 'https://matrix.linagora.com/' },
    services: {
      mail: { url: 'https://jmap.linagora.com/jmap/session', source: 'discovered' },
      project: { url: 'https://projects.linagora.com', source: 'convention' },
    },
    cozy: {},
  },
  chat: { zed: { userId: '@jdoe:linagora.com', deviceId: 'DEVICE7' } },
};

async function context(): Promise<CatalogContext> {
  const { paths } = await tempPaths();
  for (const service of ['mail', 'project', 'chat'] as const) await installFakeMcp(paths, service);
  return { config, paths, nodePath: '/usr/bin/node', cliPath: '/opt/twake-ai/build/bin.js', language: 'en', timezone: 'UTC' };
}

describe('exportFiles', () => {
  it('writes every format, each readable by its own parser, through the launcher', async () => {
    const files = await exportFiles({ agent: 'zed', services: ['mail', 'chat'], raw: false }, await context());
    expect(Object.keys(files).sort()).toEqual(['README.md', 'chat.env', 'claude-code.sh', 'codex.toml', 'commands.txt', 'hermes.yaml', 'mail.env', 'mcpServers.json', 'vscode-mcp.json']);
    const launcher = { command: '/usr/bin/node', args: ['/opt/twake-ai/build/bin.js', 'run', 'mail', '--agent', 'zed'] };
    expect(JSON.parse(files['mcpServers.json']!).mcpServers['twake-mail']).toEqual(launcher);
    expect(JSON.parse(files['vscode-mcp.json']!).servers['twake-mail']).toEqual({ type: 'stdio', ...launcher });
    expect((parseToml(files['codex.toml']!) as any).mcp_servers['twake-chat'].args).toEqual(['/opt/twake-ai/build/bin.js', 'run', 'chat', '--agent', 'zed']);
    expect(parseYaml(files['hermes.yaml']!).mcp_servers.twake_mail).toEqual({
      ...launcher,
      env: { JMAP_APPROVAL_TIMEOUT_MS: '330000' },
      timeout: 420,
      elicitation: { enabled: true, timeout: 300 },
    });
    expect(files['claude-code.sh']).toContain(`claude mcp add-json --scope user twake-mail '{"type":"stdio","command":"/usr/bin/node"`);
    expect(files['mail.env']).toContain(`JMAP_SESSION_URL='https://jmap.linagora.com/jmap/session'`);
    expect(files['README.md']).toContain('mcpServers.json');
  });

  it('gives the servers and their full environment with --raw', async () => {
    const ctx = await context();
    const files = await exportFiles({ agent: 'zed', services: ['project'], raw: true }, ctx);
    const entry = JSON.parse(files['mcpServers.json']!).mcpServers['twake-project'];
    expect(entry.args).toEqual([join(serverDir(ctx.paths, 'mcp-twake-project'), 'node_modules', 'mcp-twake-project', 'build', 'index.js')]);
    expect(entry.env).toMatchObject({ TWAKE_PROJECT_URL: 'https://projects.linagora.com', TWAKE_PROJECT_TOKEN_COMMAND: expect.stringContaining("'token' 'project'") });
  });

  it('refuses a service that is not connected, before writing anything', async () => {
    await expect(exportFiles({ agent: 'zed', services: ['drive'], raw: false }, await context())).rejects.toMatchObject({ code: 'login_required' });
  });
});

describe('defaultServices and writeExport', () => {
  it('offers what was found and connected, and Chat in any case', () => {
    expect(defaultServices(config)).toEqual(['mail', 'chat', 'project']);
  });

  it('writes the files, the script executable', async () => {
    const dir = join(await tempDir(), 'out');
    await writeExport(dir, { 'claude-code.sh': '#!/bin/sh\n', 'README.md': '# x\n' });
    expect(await readFile(join(dir, 'README.md'), 'utf8')).toBe('# x\n');
    if (process.platform !== 'win32') expect((await stat(join(dir, 'claude-code.sh'))).mode & 0o111).not.toBe(0);
  });
});

describe('exportFiles: safety and re-export', () => {
  it.skipIf(process.platform === 'win32')('writes .env files that a POSIX shell sources without running anything', async () => {
    const ctx = await context();
    const hostile = { ...ctx, config: { ...ctx.config, environment: { ...ctx.config.environment, services: { mail: { url: 'https://jmap.linagora.com/$(touch pwned)`touch pwned2`', source: 'discovered' as const } } } } };
    const files = await exportFiles({ agent: 'zed', services: ['mail'], raw: false }, hostile);
    const dir = await tempDir();
    await writeExport(dir, files);
    const read = (name: string) => execFileSync('/bin/sh', ['-c', `set -a; . ./mail.env; printf '%s' "$${name}"`], { cwd: dir, encoding: 'utf8' });
    expect(read('JMAP_SESSION_URL')).toBe('https://jmap.linagora.com/$(touch pwned)`touch pwned2`');
    expect(read('JMAP_TOKEN_COMMAND')).toBe(tokenCommand('mail', undefined, ctx));
    expect(existsSync(join(dir, 'pwned')) || existsSync(join(dir, 'pwned2'))).toBe(false);
  });

  it('carries TWAKE_AI_HOME into every entry, so the agent uses the same account', async () => {
    const ctx = await context();
    const launcher = await exportFiles({ agent: 'zed', services: ['mail'], raw: false, twakeAiHome: '/b' }, ctx);
    expect(JSON.parse(launcher['mcpServers.json']!).mcpServers['twake-mail'].env).toEqual({ TWAKE_AI_HOME: '/b' });
    const raw = await exportFiles({ agent: 'zed', services: ['mail'], raw: true, twakeAiHome: '/b' }, ctx);
    expect(JSON.parse(raw['mcpServers.json']!).mcpServers['twake-mail'].env).toMatchObject({ TWAKE_AI_HOME: '/b', JMAP_AUTH_METHOD: 'command' });
    expect(raw['mail.env']).toContain(`TWAKE_AI_HOME='/b'`);
  });

  it('writes a Claude Code script that can be run again', async () => {
    const files = await exportFiles({ agent: 'zed', services: ['mail'], raw: false }, await context());
    const script = files['claude-code.sh']!;
    const remove = script.indexOf('claude mcp remove --scope user twake-mail >/dev/null 2>&1 || true');
    expect(remove).toBeGreaterThan(-1);
    expect(script.indexOf('claude mcp add-json --scope user twake-mail')).toBeGreaterThan(remove);
  });
});
