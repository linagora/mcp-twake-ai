import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAgent, createAdapters } from '../../src/agents/index.js';
import { planEntries, wantedEntries } from '../../src/agents/entries.js';
import { BATCH_SKILL_DIR, batchSkillText } from '../../src/agents/skill.js';
import type { AgentAdapter } from '../../src/agents/types.js';
import type { CatalogContext } from '../../src/catalog.js';
import type { TwakeAiConfig } from '../../src/config.js';
import { exportFiles, writeExport } from '../../src/exporter.js';
import { installFakeClaude, withPath } from '../helpers/fake-claude.js';
import { installFakeMcp } from '../helpers/fake-mcp.js';
import { tempDir, tempPaths } from '../helpers/tmp.js';

const config: TwakeAiConfig = {
  version: 1,
  email: 'jdoe@linagora.com',
  vault: 'file',
  oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
  environment: {
    domain: 'linagora.com',
    oidc: { issuer: 'https://sso.linagora.com', authorization_endpoint: 'https://sso.linagora.com/a', token_endpoint: 'https://sso.linagora.com/t', userinfo_endpoint: 'https://sso.linagora.com/u' },
    matrix: { homeserver: 'https://matrix.linagora.com/' },
    services: { project: { url: 'https://projects.linagora.com', source: 'convention' } },
    cozy: {},
  },
};

async function context(): Promise<CatalogContext> {
  const { paths } = await tempPaths();
  await installFakeMcp(paths, 'project');
  return { config, paths, nodePath: '/usr/bin/node', cliPath: '/opt/twake-ai/build/bin.js', platform: 'linux', language: 'en', timezone: 'UTC' };
}

const exists = (path: string) => stat(path).then(() => true, () => false);

/** setup for one agent: the plan from what it has, what is wanted and what was written before, then applied. */
async function setup(adapter: AgentAdapter, owned: Record<string, string>, ctx: CatalogContext, force = false) {
  const actions = planEntries(await adapter.read(), wantedEntries(adapter, ['project'], ctx, {}), owned);
  return { actions, result: await applyAgent(adapter, actions, owned, () => force) };
}

async function uninstall(adapter: AgentAdapter, owned: Record<string, string>, force = false) {
  const actions = planEntries(await adapter.read(), {}, owned);
  return { actions, result: await applyAgent(adapter, actions, owned, () => force) };
}

async function agents() {
  const dir = await tempDir();
  const fake = await installFakeClaude(dir);
  const hermesHome = join(dir, 'hermes home');
  const env = withPath(fake.binDir, { CLAUDE_CONFIG_DIR: fake.configDir, HERMES_HOME: hermesHome });
  const adapters = await createAdapters({ platform: process.platform, env, home: dir, now: () => new Date('2026-11-20T10:00:00Z') });
  return { dir, fake, hermesHome, adapters };
}

describe('the twake-batch-approval skill', () => {
  it('ships the skill with mcp-twake-ai', async () => {
    const text = await batchSkillText();
    expect(text).toMatch(/^---\nname: twake-batch-approval\n/);
    expect(text).toContain('approve_batch');
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as { files: string[] };
    expect(pkg.files).toContain('skills');
  });

  it('setup writes it for Claude Code, in its skills folder, as an entry of its own', async () => {
    const { fake, adapters } = await agents();
    const ctx = await context();
    const { actions, result } = await setup(adapters['claude-code'], {}, ctx);
    expect(actions.map((a) => [a.name, a.kind])).toContainEqual([`skill:${BATCH_SKILL_DIR}`, 'add']);
    expect(result.status).toBe('written');
    const file = join(fake.configDir, 'skills', BATCH_SKILL_DIR, 'SKILL.md');
    expect(await readFile(file, 'utf8')).toBe(await batchSkillText());
    expect(result.owned).toHaveProperty(`skill:${BATCH_SKILL_DIR}`);
    expect(result.owned).toHaveProperty('twake-project');
  });

  it('puts the Claude Code skill in ~/.claude/skills without CLAUDE_CONFIG_DIR', async () => {
    const dir = await tempDir();
    const ctx = await context();
    const claude = (await createAdapters({ platform: process.platform, env: {}, home: dir, now: () => new Date() }))['claude-code'];
    const skill = wantedEntries(claude, [], ctx, {});
    // only the skill: no claude command is needed for it
    await claude.write({ set: skill, remove: [] });
    expect(await readFile(join(dir, '.claude', 'skills', BATCH_SKILL_DIR, 'SKILL.md'), 'utf8')).toBe(await batchSkillText());
  });

  it('setup writes it for Hermes, in the skills folder of its home', async () => {
    const { hermesHome, adapters } = await agents();
    const ctx = await context();
    const { result } = await setup(adapters.hermes, {}, ctx);
    expect(result.status).toBe('written');
    expect(await readFile(join(hermesHome, 'skills', BATCH_SKILL_DIR, 'SKILL.md'), 'utf8')).toBe(await batchSkillText());
    expect(adapters.hermes.target).toBe(join(hermesHome, 'config.yaml'));
  });

  it('a second setup changes nothing', async () => {
    const { adapters } = await agents();
    const ctx = await context();
    for (const id of ['claude-code', 'hermes'] as const) {
      const first = await setup(adapters[id], {}, ctx);
      const again = await setup(adapters[id], first.result.owned, ctx);
      expect(again.actions.every((a) => a.kind === 'keep'), id).toBe(true);
      expect(again.result.status).toBe('unchanged');
    }
  });

  it('uninstall removes it, but not a SKILL.md changed by hand without --force', async () => {
    const { fake, hermesHome, adapters } = await agents();
    const ctx = await context();
    const claude = await setup(adapters['claude-code'], {}, ctx);
    const claudeFile = join(fake.configDir, 'skills', BATCH_SKILL_DIR, 'SKILL.md');
    expect((await uninstall(adapters['claude-code'], claude.result.owned)).result.status).toBe('written');
    expect(await exists(claudeFile)).toBe(false);
    expect(await exists(join(fake.configDir, 'skills', BATCH_SKILL_DIR))).toBe(false);

    const hermes = await setup(adapters.hermes, {}, ctx);
    const hermesFile = join(hermesHome, 'skills', BATCH_SKILL_DIR, 'SKILL.md');
    await writeFile(hermesFile, `${await readFile(hermesFile, 'utf8')}\n9. My own rule.\n`);
    const kept = await uninstall(adapters.hermes, hermes.result.owned);
    expect(kept.actions.find((a) => a.name === `skill:${BATCH_SKILL_DIR}`)?.kind).toBe('remove-modified');
    expect(kept.result.skipped.map((a) => a.name)).toEqual([`skill:${BATCH_SKILL_DIR}`]);
    expect(await readFile(hermesFile, 'utf8')).toContain('My own rule');
    await uninstall(adapters.hermes, kept.result.owned, true);
    expect(await exists(hermesFile)).toBe(false);
  });

  it('export puts it in the exported folder', async () => {
    const ctx = await context();
    const files = await exportFiles({ agent: 'zed', services: ['project'], raw: false }, ctx);
    expect(files[`skills/${BATCH_SKILL_DIR}/SKILL.md`]).toBe(await batchSkillText());
    const out = join(await tempDir(), 'export');
    await writeExport(out, files);
    expect(await readFile(join(out, 'skills', BATCH_SKILL_DIR, 'SKILL.md'), 'utf8')).toBe(await batchSkillText());
    expect(files['README.md']).toContain('twake-batch-approval');
  });
});
