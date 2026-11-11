# mcp-twake-ai, plan 3b : adaptateurs d'agents et `setup` non interactif

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mcp-twake-ai setup --agents claude-code,hermes,claude-desktop,cursor,vscode [--services …] [--yes] [--force]` écrit, met à jour ou retire les entrées Twake.ai de chaque agent. L'outil ne touche qu'aux entrées qu'il a écrites, sauvegarde chaque fichier avant de le modifier, et remet un agent dans son état antérieur si son écriture échoue.

**Architecture:**
- **`src/agents/`**, un module par rôle.
  - **`types.ts`** : l'interface commune `AgentAdapter` (`detect`, `read`, `write`, `shape`, `entryName`, `capabilities`).
  - **`entries.ts`** : les entrées voulues, leur empreinte, et le plan (ajouter, garder, mettre à jour, retirer, ou demander), commun aux cinq agents.
  - **`config-file.ts`** : sauvegarde horodatée, écriture atomique qui suit les liens symboliques, restauration.
  - **`locations.ts`** : les chemins selon l'OS.
  - **`json-config.ts`** : Claude Desktop, Cursor et VS Code, par `jsonc-parser`, qui garde commentaires et clés inconnues.
  - **`hermes.ts`** : Hermes, par l'API Document de `yaml`.
  - **`claude-code.ts`** : Claude Code, par `claude mcp add/remove --scope user`.
  - **`index.ts`** : le registre, la détection, l'application isolée par agent, et l'enregistrement des empreintes dans `config.json`.
- **`src/run-file.ts`** : lance un programme sans shell, sauf un `.cmd` ou `.bat` sous Windows, qui passe par `cmd.exe` avec des guillemets. npm et Claude Code s'en servent.
- **`setup`** dans la CLI : il affiche le plan, puis, avec `--yes`, connecte Drive et les devices Chat qui manquent, installe les serveurs et écrit les agents.

**Tech Stack:** celle des plans 1 à 3a, plus `jsonc-parser` 3.3.1. Les tests de bout en bout lancent la CLI construite (`build/bin.js`) et, si `MCP_TWAKE_AI_E2E=1` et que `claude` est installé, le vrai Claude Code.

**Spec:** `docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md`, sections 5.1 (commandes), 8 (parcours, mode non interactif), 10 (adaptateurs) et 13.1 (tests des agents). Feuille de route : `docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md`.

## Global Constraints

- **Contraintes reprises :** toutes celles des plans 1, 2 et 3a, avec les noms à jour : commande et paquet `mcp-twake-ai` ; dossiers de données, variables `TWAKE_AI_*` et service du trousseau toujours `twake-ai`.
- **Noms d'entrées :** `twake-<service>`, et `twake_<service>` pour Hermes.
- **Une entrée ne contient que le lanceur :** `command` = chemin absolu de Node ; `args` = `[<cli>, "run", "<service>", "--agent", "<agent>"]`. Elle porte `env` seulement si `TWAKE_AI_HOME` est défini. Aucun secret.
- **Forme par agent :**

  | Agent (`id`) | Fichier / méthode | Clé | Forme d'une entrée |
  |---|---|---|---|
  | Claude Code (`claude-code`) | `claude mcp add --scope user <nom> [-e K=V] -- <command> <args…>` et `claude mcp remove --scope user <nom>` ; lecture seule de `$CLAUDE_CONFIG_DIR/.claude.json` ou `~/.claude.json` | `mcpServers` | `{type: "stdio", command, args[, env]}` |
  | Hermes (`hermes`) | `$HERMES_HOME/config.yaml`, sinon `~/.hermes` (`%LOCALAPPDATA%\hermes` sous Windows), ou son profil actif (`active_profile` → `profiles/<nom>`) | `mcp_servers` | `{command, args[, env], timeout: 420, elicitation: {enabled: true, timeout: 300}}` |
  | Claude Desktop (`claude-desktop`) | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\…`, Linux `$XDG_CONFIG_HOME` ou `~/.config/Claude/…` | `mcpServers` | `{command, args[, env]}` |
  | Cursor (`cursor`) | `~/.cursor/mcp.json` (`%USERPROFILE%\.cursor\mcp.json`) | `mcpServers` | `{type: "stdio", command, args[, env]}` |
  | VS Code (`vscode`) | `<base>/Code/User/mcp.json`, où `<base>` = `$VSCODE_APPDATA`, sinon Application Support, `%APPDATA%` ou `$XDG_CONFIG_HOME`/`~/.config` ; profil par défaut seulement | `servers` | `{type: "stdio", command, args[, env]}` |

- **Élicitation** (spec 10.2, vérifiée le 2026-11-11) : Claude Code, Hermes, Cursor (depuis 1.5) et VS Code (depuis 1.102) la gèrent. Pour Claude Desktop, aucune source ne la confirme : il est traité comme ne la gérant pas, et le plan l'annonce (« les lectures marchent, chaque écriture est refusée »).
- **Écriture :**
  - Fichier temporaire dans le même dossier, puis renommage. Les permissions du fichier sont gardées ; un nouveau fichier est en `0600`.
  - Un lien symbolique est suivi : c'est le fichier pointé qui est remplacé.
  - Avant la modification, une copie `<fichier>.bak-<AAAAMMJJTHHMMSSZ>` (UTC) est faite, avec `-2`, `-3`… si ce nom existe déjà.
  - Un fichier JSON ou YAML invalide n'est jamais réécrit : erreur `damaged_file` qui nomme le fichier et dit « Nothing was changed ».
- **Propriété :** `config.json` → `agents.<id>.entries.<nom>` = empreinte (16 caractères hexadécimaux, SHA-256 du JSON canonique de l'entrée, sans `type: "stdio"` ni `env` vide). Une entrée identique à celle voulue est adoptée sans question. Une entrée du même nom écrite à la main, ou modifiée depuis, n'est remplacée ou retirée qu'avec `--force`.
- **Échec chez un agent :** l'agent est remis dans son état antérieur (copie du fichier, ou entrées Claude Code ré-ajoutées), l'erreur est affichée, les autres agents sont écrits quand même, et le code de sortie vaut 1.
- **Claude Code :** jamais d'écriture directe de `~/.claude.json`. Sous Windows, `claude.cmd` passe par `cmd.exe` avec `windowsQuote` : aucun JSON sur la ligne de commande, d'où `claude mcp add … -- <command>` plutôt que `add-json`.
- **Messages :** en anglais, une ligne qui dit quoi faire, comme le reste de la CLI. La langue française arrive avec le `setup` interactif du plan 4.

## Review Focus

- **Fichier de configuration qui est un lien symbolique** (dotfiles dans un dépôt) : l'écriture passe par le lien, qui reste un lien. Test dans la tâche 1.
- **Fichier d'agent invalide, édité à la main** (`{"mcpServers": {`, YAML mal indenté) : rien n'est écrit, et le message nomme le fichier. Tests dans les tâches 3 et 4.
- **`mcp.json` de VS Code avec commentaires, virgules finales et `inputs`** : tout est gardé. Test dans la tâche 3.
- **`claude.cmd` (shim npm) sous Windows, avec une espace dans les chemins** : la ligne passe par `cmd.exe` sans être coupée. Test dans la tâche 5 avec un faux `claude` dans un dossier « bin dir », exécuté par la CI Windows.
- **Entrée identique mais inconnue de `config.json`** (configuration perdue, ou export collé à la main) : elle est adoptée et non signalée comme conflit. Test dans la tâche 2.

---

### Task 1 : fichiers de configuration des agents, et `agents` dans `config.json`

**Files:**
- Create: `src/agents/config-file.ts`
- Modify: `src/config.ts` (champ `agents` de `ConfigSchema`)
- Create: `tests/helpers/sample-config.ts`
- Test: `tests/agents/config-file.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces: `readText(path): Promise<string | undefined>`, `backupName(path, now: Date): string`, `backupFile(path, now): Promise<string | undefined>`, `writeFileAtomic(path, text): Promise<void>`, `restoreFile(path, backup: string | undefined): Promise<void>` ; `TwakeAiConfig.agents?: Record<string, { entries: Record<string, string> }>` ; `sampleConfig: TwakeAiConfig`, `sampleContext(paths, platform?): CatalogContext`.

- [ ] **Step 1: Write the failing tests**

`tests/helpers/sample-config.ts` :

```ts
import type { CatalogContext } from '../../src/catalog.js';
import type { TwakeAiConfig } from '../../src/config.js';
import type { AppPaths } from '../../src/paths.js';

/** A signed-in account on linagora.com, with Mail, Calendar, Space and Project found, Drive and a Chat device for hermes. */
export const sampleConfig: TwakeAiConfig = {
  version: 1,
  email: 'jdoe@linagora.com',
  vault: 'file',
  oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
  environment: {
    domain: 'linagora.com',
    oidc: { issuer: 'https://sso.linagora.com', authorization_endpoint: 'https://sso.linagora.com/a', token_endpoint: 'https://sso.linagora.com/t', userinfo_endpoint: 'https://sso.linagora.com/u' },
    matrix: { homeserver: 'https://matrix.linagora.com/', tom: 'https://tom.linagora.com/' },
    services: {
      mail: { url: 'https://jmap.linagora.com/jmap/session', source: 'discovered' },
      dav: { url: 'https://dav.linagora.com/', source: 'discovered' },
      space: { url: 'https://space.linagora.com', source: 'convention' },
      project: { url: 'https://projects.linagora.com', source: 'convention' },
    },
    cozy: { instance: 'https://jdoe.twake.linagora.com' },
  },
  drive: { clientId: 'client-1', apps: ['mail'] },
  chat: { hermes: { userId: '@jdoe:linagora.com', deviceId: 'DEVICE1' } },
};

export function sampleContext(paths: AppPaths, platform: NodeJS.Platform = process.platform): CatalogContext {
  return { config: sampleConfig, paths, nodePath: '/usr/bin/node', cliPath: '/opt/twake-ai/build/bin.js', platform, language: 'en', timezone: 'UTC' };
}
```

`tests/config.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { sampleConfig } from './helpers/sample-config.js';
import { tempPaths } from './helpers/tmp.js';

describe('config.json', () => {
  it('keeps what mcp-twake-ai wrote into each agent', async () => {
    const { paths } = await tempPaths();
    const agents = { cursor: { entries: { 'twake-mail': '0123456789abcdef' } } };
    await saveConfig(paths, { ...sampleConfig, agents });
    expect((await loadConfig(paths))?.agents).toEqual(agents);
  });
});
```

`tests/agents/config-file.test.ts` :

```ts
import { chmod, lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { backupFile, backupName, readText, restoreFile, writeFileAtomic } from '../../src/agents/config-file.js';
import { tempDir } from '../helpers/tmp.js';

const now = new Date('2026-11-11T05:34:05.123Z');
const windows = process.platform === 'win32';

describe('agent configuration files', () => {
  it('names a backup after the file and the UTC time, as Hermes does', () => {
    expect(backupName('/h/.hermes/config.yaml', now)).toBe('/h/.hermes/config.yaml.bak-20261111T053405Z');
  });

  it('copies the file before a change, without overwriting an earlier copy', async () => {
    const file = join(await tempDir(), 'mcp.json');
    expect(await backupFile(file, now)).toBeUndefined();
    await writeFile(file, '{"a":1}');
    const first = await backupFile(file, now);
    const second = await backupFile(file, now);
    expect(first).toBe(`${file}.bak-20261111T053405Z`);
    expect(second).toBe(`${file}.bak-20261111T053405Z-2`);
    expect(await readFile(second!, 'utf8')).toBe('{"a":1}');
  });

  it('replaces a file in one step, creating its folder, private when new', async () => {
    const dir = await tempDir();
    const file = join(dir, 'Code', 'User', 'mcp.json');
    expect(await readText(file)).toBeUndefined();
    await writeFileAtomic(file, '{}\n');
    expect(await readText(file)).toBe('{}\n');
    if (!windows) expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readdir(join(dir, 'Code', 'User'))).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.skipIf(windows)('keeps the permissions of an existing file', async () => {
    const file = join(await tempDir(), 'claude_desktop_config.json');
    await writeFile(file, '{}');
    await chmod(file, 0o644);
    await writeFileAtomic(file, '{"mcpServers":{}}');
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  });

  it.skipIf(windows)('writes through a symbolic link instead of replacing it (dotfiles)', async () => {
    const dir = await tempDir();
    await mkdir(join(dir, 'dotfiles'));
    await mkdir(join(dir, '.cursor'));
    const real = join(dir, 'dotfiles', 'mcp.json');
    const link = join(dir, '.cursor', 'mcp.json');
    await writeFile(real, '{}');
    await symlink(real, link);
    await writeFileAtomic(link, '{"mcpServers":{}}');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('{"mcpServers":{}}');
  });

  it('puts the copy back, or removes a file that did not exist', async () => {
    const file = join(await tempDir(), 'mcp.json');
    await writeFile(file, 'before');
    const backup = await backupFile(file, now);
    await writeFileAtomic(file, 'after');
    await restoreFile(file, backup);
    expect(await readText(file)).toBe('before');
    await restoreFile(file, undefined);
    expect(await readText(file)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/agents/config-file.test.ts tests/config.test.ts`
Expected: FAIL. `config-file.test.ts` cannot resolve `../../src/agents/config-file.js`, and `config.test.ts` gets `undefined` instead of the agents (zod drops the unknown key).

- [ ] **Step 3: Write the implementation**

`src/config.ts`, in `ConfigSchema` after `chat` :

```ts
  /** what mcp-twake-ai wrote into each agent: entry name → fingerprint (spec §10.1, it only touches its own entries) */
  agents: z.record(z.string(), z.object({ entries: z.record(z.string(), z.string()) })).optional(),
```

`src/agents/config-file.ts` :

```ts
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** An agent's configuration file, or undefined when there is none yet. */
export async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** The file a symbolic link points to (dotfiles kept in a repository): that file is replaced, never the link. */
async function target(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** `<file>.bak-<YYYYMMDDTHHMMSSZ>` in UTC, the name Hermes gives its own backups. */
export function backupName(path: string, now: Date): string {
  return `${path}.bak-${now.toISOString().replace(/\.\d+Z$/, 'Z').replace(/[-:]/g, '')}`;
}

/** Copies the file next to itself before its first change; undefined when there is no file yet. */
export async function backupFile(path: string, now: Date): Promise<string | undefined> {
  const source = await target(path);
  if ((await readText(source)) === undefined) return undefined;
  const name = backupName(path, now);
  for (let n = 1; ; n++) {
    const backup = n === 1 ? name : `${name}-${n}`;
    try {
      await copyFile(source, backup, constants.COPYFILE_EXCL);
      return backup;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

/** Replaces the file in one step (temporary file in its folder, then rename), keeping its permissions; a new file is private. */
export async function writeFileAtomic(path: string, text: string): Promise<void> {
  const file = await target(path);
  let mode = 0o600;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {
    await mkdir(dirname(file), { recursive: true });
  }
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'wx', mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Puts back the copy made by backupFile, or removes the file when there was none before. */
export async function restoreFile(path: string, backup: string | undefined): Promise<void> {
  if (backup === undefined) await rm(await target(path), { force: true });
  else await writeFileAtomic(path, await readFile(backup, 'utf8'));
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/agents/config-file.test.ts tests/config.test.ts`
Expected: PASS (7 tests ; 2 sautés sous Windows).

- [ ] **Step 5: Commit**

```bash
git add src/agents/config-file.ts src/config.ts tests/agents/config-file.test.ts tests/config.test.ts tests/helpers/sample-config.ts
git commit -m "feat: backups and atomic writes of agent configuration files"
```

---

### Task 2 : entrées voulues, empreintes et plan

**Files:**
- Create: `src/agents/types.ts`, `src/agents/entries.ts`
- Modify: `src/exporter.ts` (extraire `launcherEntry`)
- Test: `tests/agents/entries.test.ts`

**Interfaces:**
- Consumes: `ServerEntry` et `serverEntry` de `src/exporter.ts` ; `CatalogContext` ; `sampleContext` (tâche 1).
- Produces:
  - `types.ts` : `AGENT_IDS`, `AgentId`, `isAgentId(value)`, `Entry = Record<string, unknown>`, `Capabilities { elicitation: boolean; reload: string }`, `EntryChange { set: Record<string, Entry>; remove: string[] }`, `AgentAdapter { id; label; target; capabilities; entryName(service); shape(base: ServerEntry): Entry; detect(); read(); write(change): Promise<{ backup?: string }> }`.
  - `entries.ts` : `normalizeEntry(entry)`, `fingerprint(entry): string`, `wantedEntries(adapter, services, ctx, env): Record<string, Entry>`, `ActionKind`, `EntryAction { name; kind; entry? }`, `needsConsent(action)`, `planEntries(current, wanted, owned): EntryAction[]`, `resolvePlan(actions, owned, consent): { change: EntryChange; owned: Record<string, string>; skipped: EntryAction[] }`.
  - `exporter.ts` : `launcherEntry(service, agent, ctx, env = {}): ServerEntry`.

- [ ] **Step 1: Write the failing test**

`tests/agents/entries.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { fingerprint, needsConsent, planEntries, resolvePlan, wantedEntries } from '../../src/agents/entries.js';
import type { AgentAdapter } from '../../src/agents/types.js';
import { appPaths } from '../../src/paths.js';
import { sampleContext } from '../helpers/sample-config.js';

const ctx = sampleContext(appPaths({ platform: 'linux', env: { TWAKE_AI_HOME: '/t' }, home: '/home/j' }), 'linux');
const cursor: AgentAdapter = {
  id: 'cursor',
  label: 'Cursor',
  target: '/home/j/.cursor/mcp.json',
  capabilities: { elicitation: true, reload: '' },
  entryName: (service) => `twake-${service}`,
  shape: (base) => ({ type: 'stdio', command: base.command, args: base.args, ...(Object.keys(base.env).length ? { env: base.env } : {}) }),
  detect: async () => true,
  read: async () => ({}),
  write: async () => ({}),
};
const entry = (service: string) => ({ command: 'node', args: ['cli', 'run', service] });
const hand = { command: 'npx', args: ['my-server'] };
const kinds = (actions: { name: string; kind: string }[]) => actions.map((action) => [action.name, action.kind]);

describe('fingerprint', () => {
  it('ignores what agents add around an entry', () => {
    const mail = entry('mail');
    expect(fingerprint(mail)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint({ type: 'stdio', ...mail, env: {} })).toBe(fingerprint(mail));
    expect(fingerprint({ args: mail.args, command: mail.command })).toBe(fingerprint(mail));
    expect(fingerprint(entry('dav'))).not.toBe(fingerprint(mail));
    expect(fingerprint({ ...mail, type: 'http' })).not.toBe(fingerprint(mail));
  });
});

describe('wantedEntries', () => {
  it('starts each service through the launcher, in the shape of the agent', () => {
    expect(wantedEntries(cursor, ['mail', 'chat'], ctx, {})).toEqual({
      'twake-mail': { type: 'stdio', command: '/usr/bin/node', args: ['/opt/twake-ai/build/bin.js', 'run', 'mail', '--agent', 'cursor'] },
      'twake-chat': { type: 'stdio', command: '/usr/bin/node', args: ['/opt/twake-ai/build/bin.js', 'run', 'chat', '--agent', 'cursor'] },
    });
    expect(wantedEntries(cursor, ['mail'], ctx, { TWAKE_AI_HOME: '/accounts/work' })['twake-mail']).toMatchObject({ env: { TWAKE_AI_HOME: '/accounts/work' } });
  });
});

describe('planEntries', () => {
  it('adds, keeps, updates, removes and forgets the entries mcp-twake-ai owns, and nothing else', () => {
    const owned = { 'twake-mail': fingerprint(entry('mail')), 'twake-dav': fingerprint(entry('dav')), 'twake-space': fingerprint(entry('space')), 'twake-drive': fingerprint(entry('drive')) };
    const actions = planEntries(
      { 'twake-mail': entry('mail'), 'twake-dav': entry('dav'), 'twake-space': entry('space'), github: hand },
      { 'twake-mail': { ...entry('mail'), args: ['cli2', 'run', 'mail'] }, 'twake-dav': entry('dav'), 'twake-chat': entry('chat') },
      owned,
    );
    expect(kinds(actions)).toEqual([
      ['twake-chat', 'add'],
      ['twake-dav', 'keep'],
      ['twake-drive', 'forget'],
      ['twake-mail', 'update'],
      ['twake-space', 'remove'],
    ]);
    expect(actions.some(needsConsent)).toBe(false);
  });

  it('asks before touching an entry it did not write, or one changed by hand since', () => {
    const actions = planEntries(
      { 'twake-mail': hand, 'twake-dav': { ...entry('dav'), env: { DEBUG: '1' } }, 'twake-space': { ...entry('space'), args: ['edited'] } },
      { 'twake-mail': entry('mail'), 'twake-dav': entry('dav') },
      { 'twake-dav': fingerprint(entry('dav')), 'twake-space': fingerprint(entry('space')) },
    );
    expect(kinds(actions)).toEqual([
      ['twake-dav', 'replace-modified'],
      ['twake-mail', 'replace-foreign'],
      ['twake-space', 'remove-modified'],
    ]);
    expect(actions.every(needsConsent)).toBe(true);
  });

  it('adopts an identical entry it has no record of', () => {
    expect(kinds(planEntries({ 'twake-mail': { type: 'stdio', ...entry('mail'), env: {} } }, { 'twake-mail': entry('mail') }, {}))).toEqual([['twake-mail', 'keep']]);
  });
});

describe('resolvePlan', () => {
  const actions = planEntries(
    { 'twake-mail': hand, 'twake-dav': entry('dav'), 'twake-space': entry('space') },
    { 'twake-mail': entry('mail'), 'twake-dav': entry('dav'), 'twake-chat': entry('chat') },
    { 'twake-space': fingerprint(entry('space')) },
  );

  it('applies what needs no consent, records the fingerprints, and leaves the rest alone', () => {
    const resolved = resolvePlan(actions, { 'twake-space': fingerprint(entry('space')) }, () => false);
    expect(resolved.change).toEqual({ set: { 'twake-chat': entry('chat') }, remove: ['twake-space'] });
    expect(resolved.owned).toEqual({ 'twake-chat': fingerprint(entry('chat')), 'twake-dav': fingerprint(entry('dav')) });
    expect(kinds(resolved.skipped)).toEqual([['twake-mail', 'replace-foreign']]);
  });

  it('replaces an entry it did not write once given consent', () => {
    const resolved = resolvePlan(actions, {}, (action) => action.name === 'twake-mail');
    expect(resolved.change.set['twake-mail']).toEqual(entry('mail'));
    expect(resolved.owned['twake-mail']).toBe(fingerprint(entry('mail')));
    expect(resolved.skipped).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/agents/entries.test.ts`
Expected: FAIL, `../../src/agents/entries.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/exporter.ts`, before `serverEntry` :

```ts
/** What an agent starts for one service through the launcher: node, mcp-twake-ai's command, `run <service> --agent <id>`. */
export function launcherEntry(service: ServiceId, agent: string, ctx: CatalogContext, env: Record<string, string> = {}): ServerEntry {
  return { command: ctx.nodePath, args: [ctx.cliPath, 'run', service, '--agent', agent], env };
}
```

and, in `serverEntry`, replace `if (!raw) return { command: ctx.nodePath, args: [ctx.cliPath, 'run', service, '--agent', agent], env: extra };` with:

```ts
  if (!raw) return launcherEntry(service, agent, ctx, extra);
```

`src/agents/types.ts` :

```ts
import type { ServiceId } from '../broker.js';
import type { ServerEntry } from '../exporter.js';

export const AGENT_IDS = ['claude-code', 'hermes', 'claude-desktop', 'cursor', 'vscode'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/** One MCP server entry, in the agent's own format. */
export type Entry = Record<string, unknown>;

export interface Capabilities {
  /** the agent answers elicitation/create: writes are approved in a dialog; otherwise every write is refused (spec §10.2) */
  elicitation: boolean;
  /** what the user does for the agent to load the change */
  reload: string;
}

export interface EntryChange {
  set: Record<string, Entry>;
  remove: string[];
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  /** where the entries live, as the user would look for them */
  target: string;
  capabilities: Capabilities;
  entryName(service: ServiceId): string;
  /** the launcher entry of one service, in the shape this agent stores */
  shape(base: ServerEntry): Entry;
  /** the agent is installed on this computer */
  detect(): Promise<boolean>;
  /** every MCP server entry the agent has now */
  read(): Promise<Record<string, Entry>>;
  /** sets and removes entries; on failure the agent is put back as it was, and the error is thrown */
  write(change: EntryChange): Promise<{ backup?: string }>;
}
```

`src/agents/entries.ts` :

```ts
import { createHash } from 'node:crypto';
import type { ServiceId } from '../broker.js';
import type { CatalogContext } from '../catalog.js';
import { launcherEntry } from '../exporter.js';
import type { AgentAdapter, Entry, EntryChange } from './types.js';

/** What identifies an entry whatever the agent adds around it: `type: "stdio"` is the default, and an empty env is no env. */
export function normalizeEntry(entry: Entry): Entry {
  const { type, env, ...rest } = entry;
  const out: Entry = { ...rest };
  if (type !== undefined && type !== 'stdio') out.type = type;
  const empty = typeof env === 'object' && env !== null && Object.keys(env).length === 0;
  if (env !== undefined && !empty) out.env = env;
  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
  }
  return value;
}

/** A short digest of an entry, kept in config.json to recognise the entries mcp-twake-ai wrote. */
export function fingerprint(entry: Entry): string {
  return createHash('sha256').update(JSON.stringify(canonical(normalizeEntry(entry)))).digest('hex').slice(0, 16);
}

/** The entries one agent should have: each service through the launcher. */
export function wantedEntries(adapter: AgentAdapter, services: ServiceId[], ctx: CatalogContext, env: Record<string, string>): Record<string, Entry> {
  return Object.fromEntries(services.map((service) => [adapter.entryName(service), adapter.shape(launcherEntry(service, adapter.id, ctx, env))]));
}

export type ActionKind = 'add' | 'update' | 'keep' | 'remove' | 'forget' | 'replace-foreign' | 'replace-modified' | 'remove-modified';

export interface EntryAction {
  name: string;
  kind: ActionKind;
  /** the entry wanted, for add, update, keep and replace-* */
  entry?: Entry;
}

/** An entry mcp-twake-ai did not write, or one changed by hand since: only with an explicit yes (spec §10.1). */
export function needsConsent(action: EntryAction): boolean {
  return action.kind === 'replace-foreign' || action.kind === 'replace-modified' || action.kind === 'remove-modified';
}

/** What to do with each entry, from what the agent has, what is wanted, and what mcp-twake-ai wrote before (name → fingerprint). */
export function planEntries(current: Record<string, Entry>, wanted: Record<string, Entry>, owned: Record<string, string>): EntryAction[] {
  const actions: EntryAction[] = [];
  for (const [name, entry] of Object.entries(wanted)) {
    const now = current[name];
    if (now === undefined) actions.push({ name, kind: 'add', entry });
    else if (fingerprint(now) === fingerprint(entry)) actions.push({ name, kind: 'keep', entry });
    else if (owned[name] === undefined) actions.push({ name, kind: 'replace-foreign', entry });
    else if (fingerprint(now) !== owned[name]) actions.push({ name, kind: 'replace-modified', entry });
    else actions.push({ name, kind: 'update', entry });
  }
  for (const [name, print] of Object.entries(owned)) {
    if (name in wanted) continue;
    const now = current[name];
    if (now === undefined) actions.push({ name, kind: 'forget' });
    else actions.push({ name, kind: fingerprint(now) === print ? 'remove' : 'remove-modified' });
  }
  return actions.sort((a, b) => a.name.localeCompare(b.name));
}

/** The change to write and the entries owned afterwards; what needs consent and does not get it is left alone. */
export function resolvePlan(
  actions: EntryAction[],
  owned: Record<string, string>,
  consent: (action: EntryAction) => boolean,
): { change: EntryChange; owned: Record<string, string>; skipped: EntryAction[] } {
  const change: EntryChange = { set: {}, remove: [] };
  const next = { ...owned };
  const skipped: EntryAction[] = [];
  for (const action of actions) {
    if (needsConsent(action) && !consent(action)) {
      skipped.push(action);
      continue;
    }
    switch (action.kind) {
      case 'add':
      case 'update':
      case 'replace-foreign':
      case 'replace-modified':
        change.set[action.name] = action.entry!;
        next[action.name] = fingerprint(action.entry!);
        break;
      case 'keep':
        next[action.name] = fingerprint(action.entry!);
        break;
      case 'remove':
      case 'remove-modified':
        change.remove.push(action.name);
        delete next[action.name];
        break;
      case 'forget':
        delete next[action.name];
        break;
    }
  }
  return { change, owned: next, skipped };
}
```

- [ ] **Step 4: Run it to verify it passes, then the exporter tests**

Run: `npx vitest run tests/agents/entries.test.ts tests/exporter.test.ts`
Expected: PASS (7 tests in entries, the exporter tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/agents/types.ts src/agents/entries.ts src/exporter.ts tests/agents/entries.test.ts
git commit -m "feat: plan the entries of an agent from their fingerprints"
```

---

### Task 3 : Claude Desktop, Cursor et VS Code (fichiers JSON)

**Files:**
- Create: `src/agents/locations.ts`, `src/agents/json-config.ts`
- Modify: `package.json`, `package-lock.json` (`jsonc-parser`)
- Test: `tests/agents/locations.test.ts`, `tests/agents/json-config.test.ts`

**Interfaces:**
- Consumes: `readText`, `backupFile`, `writeFileAtomic`, `restoreFile` (tâche 1) ; `AgentAdapter`, `Entry` (tâche 2) ; `entryName` de `src/catalog.ts`.
- Produces: `Place { platform; env; home }`, `pathOf(place)`, `isDirectory(path)`, `claudeDesktopConfig(place)`, `cursorConfig(place)`, `vscodeConfig(place)` ; `claudeDesktopAgent(place, now)`, `cursorAgent(place, now)`, `vscodeAgent(place, now)`, chacun un `AgentAdapter`.

- [ ] **Step 1: Add the dependency**

Run: `npm install --save jsonc-parser@3.3.1`
Expected: `package.json` lists `"jsonc-parser": "^3.3.1"`.

- [ ] **Step 2: Write the failing tests**

`tests/agents/locations.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { claudeDesktopConfig, cursorConfig, vscodeConfig } from '../../src/agents/locations.js';

const mac = { platform: 'darwin' as const, env: {}, home: '/Users/al' };
const linux = { platform: 'linux' as const, env: { XDG_CONFIG_HOME: '/x/conf' }, home: '/home/al' };
const win = { platform: 'win32' as const, env: { APPDATA: 'C:\\Users\\Al Ice\\AppData\\Roaming' }, home: 'C:\\Users\\Al Ice' };

describe('agent configuration files, by OS', () => {
  it('finds Claude Desktop', () => {
    expect(claudeDesktopConfig(mac)).toBe('/Users/al/Library/Application Support/Claude/claude_desktop_config.json');
    expect(claudeDesktopConfig(linux)).toBe('/x/conf/Claude/claude_desktop_config.json');
    expect(claudeDesktopConfig(win)).toBe('C:\\Users\\Al Ice\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
  });

  it('finds Cursor in the home folder', () => {
    expect(cursorConfig(mac)).toBe('/Users/al/.cursor/mcp.json');
    expect(cursorConfig(win)).toBe('C:\\Users\\Al Ice\\.cursor\\mcp.json');
  });

  it('finds the user mcp.json of VS Code, VSCODE_APPDATA first', () => {
    expect(vscodeConfig(mac)).toBe('/Users/al/Library/Application Support/Code/User/mcp.json');
    expect(vscodeConfig({ ...linux, env: {} })).toBe('/home/al/.config/Code/User/mcp.json');
    expect(vscodeConfig(win)).toBe('C:\\Users\\Al Ice\\AppData\\Roaming\\Code\\User\\mcp.json');
    expect(vscodeConfig({ ...linux, env: { VSCODE_APPDATA: '/data' } })).toBe('/data/Code/User/mcp.json');
  });
});
```

`tests/agents/json-config.test.ts` :

```ts
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeDesktopAgent, cursorAgent, vscodeAgent } from '../../src/agents/json-config.js';
import { tempDir } from '../helpers/tmp.js';

const now = () => new Date('2026-11-11T05:34:05Z');
const windows = process.platform === 'win32';
const root = !windows && process.getuid?.() === 0;

async function place() {
  const home = await tempDir();
  return { platform: process.platform, env: { APPDATA: join(home, 'AppData', 'Roaming') }, home };
}

const mail = { type: 'stdio', command: '/usr/bin/node', args: ['/opt/cli.js', 'run', 'mail', '--agent', 'x'] };

const VSCODE = `{
  // my servers
  "servers": {
    "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
  },
  "inputs": [{ "type": "promptString", "id": "token", "password": true }]
}
`;

describe('VS Code', () => {
  it('keeps comments, trailing commas, inputs and the other servers', async () => {
    const vscode = vscodeAgent(await place(), now);
    expect(await vscode.detect()).toBe(false);
    await mkdir(dirname(vscode.target), { recursive: true });
    await writeFile(vscode.target, VSCODE);
    expect(await vscode.detect()).toBe(true);
    expect(Object.keys(await vscode.read())).toEqual(['github']);
    const { backup } = await vscode.write({ set: { 'twake-mail': mail }, remove: [] });
    const text = await readFile(vscode.target, 'utf8');
    expect(text).toContain('// my servers');
    expect(text).toContain('"password": true');
    expect(Object.keys(await vscode.read())).toEqual(['github', 'twake-mail']);
    expect((await vscode.read())['twake-mail']).toEqual(mail);
    expect(await readFile(backup!, 'utf8')).toBe(VSCODE);
  });
});

describe('Cursor', () => {
  it('creates mcp.json when there is none, then removes an entry', async () => {
    const p = await place();
    const cursor = cursorAgent(p, now);
    expect(cursor.target).toBe(join(p.home, '.cursor', 'mcp.json'));
    expect(await cursor.detect()).toBe(false);
    await mkdir(join(p.home, '.cursor'));
    expect(await cursor.detect()).toBe(true);
    expect(await cursor.read()).toEqual({});
    expect(await cursor.write({ set: { 'twake-mail': mail, 'twake-dav': mail }, remove: [] })).toEqual({ backup: undefined });
    expect(JSON.parse(await readFile(cursor.target, 'utf8'))).toEqual({ mcpServers: { 'twake-mail': mail, 'twake-dav': mail } });
    await cursor.write({ set: {}, remove: ['twake-dav'] });
    expect(Object.keys(await cursor.read())).toEqual(['twake-mail']);
  });
});

describe('Claude Desktop', () => {
  it('keeps its own settings and the servers configured by hand', async () => {
    const desktop = claudeDesktopAgent(await place(), now);
    await mkdir(dirname(desktop.target), { recursive: true });
    await writeFile(desktop.target, JSON.stringify({ globalShortcut: 'Alt+Space', mcpServers: { 'twake-drive': { command: 'my-drive' } } }, null, 2));
    expect(desktop.capabilities.elicitation).toBe(false);
    await desktop.write({ set: { 'twake-mail': { command: '/usr/bin/node', args: ['/opt/cli.js'] } }, remove: [] });
    const saved = JSON.parse(await readFile(desktop.target, 'utf8'));
    expect(saved.globalShortcut).toBe('Alt+Space');
    expect(Object.keys(saved.mcpServers)).toEqual(['twake-drive', 'twake-mail']);
  });
});

describe('a damaged file', () => {
  it('is refused, named, and left as it is', async () => {
    const cursor = cursorAgent(await place(), now);
    await mkdir(dirname(cursor.target), { recursive: true });
    await writeFile(cursor.target, '{"mcpServers": {');
    await expect(cursor.read()).rejects.toMatchObject({ code: 'damaged_file', message: expect.stringContaining(cursor.target) });
    await expect(cursor.write({ set: { 'twake-mail': mail }, remove: [] })).rejects.toMatchObject({ code: 'damaged_file' });
    expect(await readFile(cursor.target, 'utf8')).toBe('{"mcpServers": {');
    expect(await readdir(dirname(cursor.target))).toEqual(['mcp.json']);
  });

  it('is refused when its servers are not an object', async () => {
    const cursor = cursorAgent(await place(), now);
    await mkdir(dirname(cursor.target), { recursive: true });
    await writeFile(cursor.target, '{"mcpServers": []}');
    await expect(cursor.read()).rejects.toMatchObject({ code: 'damaged_file', message: expect.stringContaining('mcpServers') });
  });

  it.skipIf(windows || root)('stays as it was when it cannot be written', async () => {
    const cursor = cursorAgent(await place(), now);
    const dir = dirname(cursor.target);
    await mkdir(dir, { recursive: true });
    await writeFile(cursor.target, '{}');
    await chmod(dir, 0o500);
    try {
      await expect(cursor.write({ set: { 'twake-mail': mail }, remove: [] })).rejects.toThrow();
      expect(await readFile(cursor.target, 'utf8')).toBe('{}');
    } finally {
      await chmod(dir, 0o700);
    }
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run tests/agents/locations.test.ts tests/agents/json-config.test.ts`
Expected: FAIL, the modules cannot be resolved.

- [ ] **Step 4: Write the implementation**

`src/agents/locations.ts` :

```ts
import { stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

/** The computer an agent is looked for on: OS, environment and home folder (replaceable in tests). */
export interface Place {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

export const pathOf = (p: Place) => (p.platform === 'win32' ? win32 : posix);

/** The settings folder of a desktop application: Application Support, %APPDATA% or $XDG_CONFIG_HOME. */
function appConfigDir(p: Place, name: string): string {
  if (p.platform === 'darwin') return posix.join(p.home, 'Library', 'Application Support', name);
  if (p.platform === 'win32') return win32.join(p.env.APPDATA || win32.join(p.home, 'AppData', 'Roaming'), name);
  return posix.join(p.env.XDG_CONFIG_HOME || posix.join(p.home, '.config'), name);
}

export const claudeDesktopConfig = (p: Place) => pathOf(p).join(appConfigDir(p, 'Claude'), 'claude_desktop_config.json');

export const cursorConfig = (p: Place) => pathOf(p).join(p.home, '.cursor', 'mcp.json');

/** The default profile's mcp.json; VSCODE_APPDATA moves the whole user data folder. */
export function vscodeConfig(p: Place): string {
  const path = pathOf(p);
  const base = p.env.VSCODE_APPDATA ? path.join(p.env.VSCODE_APPDATA, 'Code') : appConfigDir(p, 'Code');
  return path.join(base, 'User', 'mcp.json');
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
```

`src/agents/json-config.ts` :

```ts
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { entryName } from '../catalog.js';
import { TwakeAiError } from '../errors.js';
import type { ServerEntry } from '../exporter.js';
import { backupFile, readText, restoreFile, writeFileAtomic } from './config-file.js';
import { claudeDesktopConfig, cursorConfig, isDirectory, pathOf, vscodeConfig, type Place } from './locations.js';
import type { AgentAdapter, AgentId, Capabilities, Entry } from './types.js';

interface JsonAgent {
  id: AgentId;
  label: string;
  file: string;
  /** the object that holds the servers */
  key: 'mcpServers' | 'servers';
  /** the folder whose presence means the agent is installed */
  home: string;
  capabilities: Capabilities;
  shape(base: ServerEntry): Entry;
}

const withEnv = (base: ServerEntry) => (Object.keys(base.env).length ? { env: base.env } : {});
const plain = (base: ServerEntry): Entry => ({ command: base.command, args: base.args, ...withEnv(base) });
const stdio = (base: ServerEntry): Entry => ({ type: 'stdio', ...plain(base) });

function damaged(file: string, why: string): TwakeAiError {
  return new TwakeAiError('damaged_file', `${file} ${why}: fix it, then run again. Nothing was changed.`);
}

/** The servers of a JSON (or JSONC) settings file; a file the agent itself could not read is refused. */
function servers(a: JsonAgent, text: string): Record<string, Entry> {
  if (text.trim() === '') return {};
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) throw damaged(a.file, `is not valid JSON (${printParseErrorCode(errors[0]!.error)} at character ${errors[0]!.offset})`);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw damaged(a.file, 'is not a JSON object');
  const found = (config as Record<string, unknown>)[a.key];
  if (found === undefined) return {};
  if (typeof found !== 'object' || found === null || Array.isArray(found)) throw damaged(a.file, `has "${a.key}" that is not an object`);
  return found as Record<string, Entry>;
}

/** An agent whose servers live in a JSON file: only the entries named change; comments, layout and other keys stay. */
function jsonAgent(a: JsonAgent, now: () => Date): AgentAdapter {
  const read = async () => servers(a, (await readText(a.file)) ?? '');
  return {
    id: a.id,
    label: a.label,
    target: a.file,
    capabilities: a.capabilities,
    entryName,
    shape: a.shape,
    detect: () => isDirectory(a.home),
    read,
    async write(change) {
      const text = (await readText(a.file)) ?? '';
      servers(a, text);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const formattingOptions = { insertSpaces: true, tabSize: 2, eol };
      let out = text.trim() === '' ? `{}${eol}` : text;
      for (const name of change.remove) out = applyEdits(out, modify(out, [a.key, name], undefined, { formattingOptions }));
      for (const [name, entry] of Object.entries(change.set)) out = applyEdits(out, modify(out, [a.key, name], entry, { formattingOptions }));
      const backup = await backupFile(a.file, now());
      try {
        await writeFileAtomic(a.file, out);
        servers(a, (await readText(a.file)) ?? '');
      } catch (error) {
        await restoreFile(a.file, backup).catch(() => undefined);
        throw error;
      }
      return { backup };
    },
  };
}

export function claudeDesktopAgent(place: Place, now: () => Date): AgentAdapter {
  const file = claudeDesktopConfig(place);
  return jsonAgent(
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      file,
      key: 'mcpServers',
      home: pathOf(place).dirname(file),
      // no source confirms elicitation in Claude Desktop (checked 2026-11-11): writes are refused there
      capabilities: { elicitation: false, reload: 'Quit Claude Desktop completely, then start it again.' },
      shape: plain,
    },
    now,
  );
}

export function cursorAgent(place: Place, now: () => Date): AgentAdapter {
  const file = cursorConfig(place);
  return jsonAgent(
    {
      id: 'cursor',
      label: 'Cursor',
      file,
      key: 'mcpServers',
      home: pathOf(place).dirname(file),
      capabilities: { elicitation: true, reload: 'If Cursor does not show the servers, quit it completely and start it again.' },
      shape: stdio,
    },
    now,
  );
}

export function vscodeAgent(place: Place, now: () => Date): AgentAdapter {
  const file = vscodeConfig(place);
  return jsonAgent(
    {
      id: 'vscode',
      label: 'VS Code',
      file,
      key: 'servers',
      home: pathOf(place).dirname(file),
      capabilities: { elicitation: true, reload: 'VS Code starts the servers at the next chat message (or from the MCP Servers view).' },
      shape: stdio,
    },
    now,
  );
}
```

- [ ] **Step 5: Run them to verify they pass**

Run: `npx vitest run tests/agents/locations.test.ts tests/agents/json-config.test.ts`
Expected: PASS (3 + 6 tests ; 1 sauté sous Windows ou en root).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/agents/locations.ts src/agents/json-config.ts tests/agents/locations.test.ts tests/agents/json-config.test.ts
git commit -m "feat: write the Twake.ai servers into Claude Desktop, Cursor and VS Code"
```

---

### Task 4 : Hermes (YAML qui garde ses commentaires)

**Files:**
- Create: `src/agents/hermes.ts`
- Modify: `src/agents/locations.ts` (`hermesHome`)
- Test: `tests/agents/hermes.test.ts`, `tests/agents/locations.test.ts`

**Interfaces:**
- Consumes: tâches 1 à 3 ; `hermesEntryName` de `src/catalog.ts`.
- Produces: `hermesHome(place): Promise<string>` ; `hermesAgent(home: string, now): AgentAdapter` ; `HERMES_TOOL_TIMEOUT_S = 420`, `HERMES_ELICITATION_TIMEOUT_S = 300`.

- [ ] **Step 1: Write the failing tests**

À la fin de `tests/agents/locations.test.ts` (ajouter `hermesHome` à l'import de `locations.js`, et les imports ci-dessous) :

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir } from '../helpers/tmp.js';

describe('the Hermes home', () => {
  it('is HERMES_HOME, else ~/.hermes, else %LOCALAPPDATA%\\hermes on Windows', async () => {
    expect(await hermesHome({ ...linux, env: { HERMES_HOME: '/srv/hermes' } })).toBe('/srv/hermes');
    expect(await hermesHome(mac)).toBe('/Users/al/.hermes');
    expect(await hermesHome({ ...win, env: { LOCALAPPDATA: 'C:\\Users\\Al Ice\\AppData\\Local' } })).toBe('C:\\Users\\Al Ice\\AppData\\Local\\hermes');
  });

  it('follows the active profile when its folder exists', async () => {
    const home = await tempDir();
    const p = { platform: 'linux' as const, env: {}, home };
    await mkdir(join(home, '.hermes', 'profiles', 'work'), { recursive: true });
    await writeFile(join(home, '.hermes', 'active_profile'), 'work\n');
    expect(await hermesHome(p)).toBe(join(home, '.hermes', 'profiles', 'work'));
    await writeFile(join(home, '.hermes', 'active_profile'), 'gone');
    expect(await hermesHome(p)).toBe(join(home, '.hermes'));
    await writeFile(join(home, '.hermes', 'active_profile'), '../../etc');
    expect(await hermesHome(p)).toBe(join(home, '.hermes'));
  });
});
```

`tests/agents/hermes.test.ts` :

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/agents/hermes.test.ts tests/agents/locations.test.ts`
Expected: FAIL, `hermes.js` cannot be resolved and `hermesHome` is not exported.

- [ ] **Step 3: Write the implementation**

`src/agents/locations.ts`, add `readFile` to the import from `node:fs/promises`, then:

```ts
/** Hermes' home: HERMES_HOME, else ~/.hermes (%LOCALAPPDATA%\hermes on Windows), or the active profile in it. */
export async function hermesHome(p: Place): Promise<string> {
  const set = p.env.HERMES_HOME?.trim();
  if (set) return set;
  const path = pathOf(p);
  const root = p.platform === 'win32' ? path.join(p.env.LOCALAPPDATA || path.join(p.home, 'AppData', 'Local'), 'hermes') : path.join(p.home, '.hermes');
  let active = '';
  try {
    active = (await readFile(path.join(root, 'active_profile'), 'utf8')).trim();
  } catch {
    // no profile chosen
  }
  if (/^[A-Za-z0-9_][\w.-]*$/.test(active) && active !== 'default') {
    const profile = path.join(root, 'profiles', active);
    if (await isDirectory(profile)) return profile;
  }
  return root;
}
```

`src/agents/hermes.ts` :

```ts
import { join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { hermesEntryName } from '../catalog.js';
import { TwakeAiError } from '../errors.js';
import { backupFile, readText, restoreFile, writeFileAtomic } from './config-file.js';
import type { AgentAdapter, Entry } from './types.js';

/** Hermes gives up on an approval after 300 s; the server waits 330 s (catalog); a tool call may take 420 s in all. */
export const HERMES_TOOL_TIMEOUT_S = 420;
export const HERMES_ELICITATION_TIMEOUT_S = 300;

/** Hermes reads its MCP servers from `mcp_servers` in config.yaml: edited as a YAML document, so comments and layout stay. */
export function hermesAgent(home: string, now: () => Date): AgentAdapter {
  const file = join(home, 'config.yaml');
  const load = async () => {
    const doc = parseDocument((await readText(file)) ?? '');
    const error = doc.errors[0];
    if (error) {
      const line = error.linePos?.[0]?.line;
      throw new TwakeAiError('damaged_file', `${file} is not valid YAML (${error.code}${line ? `, line ${line}` : ''}): fix it, then run again. Nothing was changed.`);
    }
    const servers = doc.get('mcp_servers');
    if (servers !== undefined && servers !== null && !isMap(servers)) {
      throw new TwakeAiError('damaged_file', `${file} has mcp_servers that is not a mapping: fix it, then run again. Nothing was changed.`);
    }
    return doc;
  };
  const read = async (): Promise<Record<string, Entry>> => {
    const servers = ((await load()).toJS() as { mcp_servers?: Record<string, Entry> } | null)?.mcp_servers;
    return servers ?? {};
  };
  return {
    id: 'hermes',
    label: 'Hermes',
    target: file,
    capabilities: { elicitation: true, reload: 'Run /reload-mcp in Hermes, or restart it.' },
    entryName: hermesEntryName,
    shape: (base) => ({
      command: base.command,
      args: base.args,
      ...(Object.keys(base.env).length ? { env: base.env } : {}),
      timeout: HERMES_TOOL_TIMEOUT_S,
      elicitation: { enabled: true, timeout: HERMES_ELICITATION_TIMEOUT_S },
    }),
    detect: async () => (await readText(file)) !== undefined,
    read,
    async write(change) {
      const doc = await load();
      if (!isMap(doc.get('mcp_servers'))) doc.set('mcp_servers', doc.createNode({}));
      for (const name of change.remove) doc.deleteIn(['mcp_servers', name]);
      for (const [name, entry] of Object.entries(change.set)) doc.setIn(['mcp_servers', name], doc.createNode(entry));
      const out = doc.toString({ flowCollectionPadding: false });
      const backup = await backupFile(file, now());
      try {
        await writeFileAtomic(file, out);
        await load();
      } catch (error) {
        await restoreFile(file, backup).catch(() => undefined);
        throw error;
      }
      return { backup };
    },
  };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run tests/agents/hermes.test.ts tests/agents/locations.test.ts`
Expected: PASS (4 + 5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/hermes.ts src/agents/locations.ts tests/agents/hermes.test.ts tests/agents/locations.test.ts
git commit -m "feat: write the Twake.ai servers into Hermes, comments kept"
```

---

### Task 5 : lancer un programme, et Claude Code par `claude mcp`

**Files:**
- Create: `src/run-file.ts`, `src/agents/claude-code.ts`, `tests/helpers/fake-claude.ts`
- Modify: `src/installer.ts` (`npmRunner` passe par `runFile`), `src/agents/locations.ts` (`claudeCodeState`)
- Test: `tests/run-file.test.ts`, `tests/agents/claude-code.test.ts`, `tests/agents/locations.test.ts`

**Interfaces:**
- Consumes: `commandLine` de `src/catalog.ts` ; `readText` (tâche 1) ; `Place`, `pathOf` (tâche 3) ; `AgentAdapter` (tâche 2).
- Produces: `runFile(file, args, options?: { platform?; env?; timeoutMs? }): Promise<{ stdout; stderr }>` (rejet avec `stderr` attaché) ; `FileRunner` ; `claudeCodeState(place)` ; `findExecutable(name, place): Promise<string | undefined>` ; `claudeCodeAgent(place, run?: FileRunner): AgentAdapter` ; `installFakeClaude(dir)`.

- [ ] **Step 1: Write the failing tests**

`tests/run-file.test.ts` :

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runFile } from '../src/run-file.js';
import { tempDir } from './helpers/tmp.js';

const PRINT_ARGS = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))';

describe('runFile', () => {
  it('passes arguments as they are, spaces and quotes included', async () => {
    const script = join(await tempDir(), 'print args.cjs');
    await writeFile(script, PRINT_ARGS);
    const { stdout } = await runFile(process.execPath, [script, 'a b', "o'brien"]);
    expect(JSON.parse(stdout)).toEqual(['a b', "o'brien"]);
  });

  it('keeps what the program wrote on stderr when it fails', async () => {
    const script = join(await tempDir(), 'fail.cjs');
    await writeFile(script, "process.stderr.write('boom\\n'); process.exit(3)");
    await expect(runFile(process.execPath, [script])).rejects.toMatchObject({ stderr: 'boom\n' });
  });

  it.runIf(process.platform === 'win32')('starts a .cmd through cmd.exe, with spaces in the paths', async () => {
    const dir = join(await tempDir(), 'bin dir');
    await mkdir(dir);
    const script = join(dir, 'print.cjs');
    await writeFile(script, PRINT_ARGS);
    const shim = join(dir, 'print.cmd');
    await writeFile(shim, `@"${process.execPath}" "${script}" %*\r\n`);
    const { stdout } = await runFile(shim, ['a b', 'c']);
    expect(JSON.parse(stdout)).toEqual(['a b', 'c']);
  });
});
```

`tests/helpers/fake-claude.ts` :

```ts
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `claude mcp add|add-json|remove --scope user` as Claude Code 2.1 behaves (checked 2026-11-11): the user scope is
 * `mcpServers` of $CLAUDE_CONFIG_DIR/.claude.json, add refuses an existing name, remove a missing one (exit 1).
 * FAKE_CLAUDE_FAIL_ON=<name> makes adding that name fail. Every call is logged to claude-calls.jsonl.
 */
const FAKE_CLAUDE = `const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.CLAUDE_CONFIG_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'claude-calls.jsonl'), JSON.stringify(args) + '\\n');
const state = path.join(dir, '.claude.json');
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };
let data = {};
try { data = JSON.parse(fs.readFileSync(state, 'utf8')); } catch {}
data.mcpServers = data.mcpServers || {};
const save = () => fs.writeFileSync(state, JSON.stringify(data, null, 2));
const scope = args.indexOf('--scope');
const rest = args.filter((_, i) => scope < 0 || (i !== scope && i !== scope + 1)).slice(2);
if (args[0] !== 'mcp') fail('unknown command ' + args[0]);
if (args[1] === 'remove') {
  if (!data.mcpServers[rest[0]]) fail('No MCP server named "' + rest[0] + '" in user scope');
  delete data.mcpServers[rest[0]];
  save();
} else if (args[1] === 'add') {
  const dash = rest.indexOf('--');
  const name = rest[0];
  const env = {};
  for (let i = 1; i < dash; i++) if (rest[i] === '-e') { const [key, ...value] = rest[++i].split('='); env[key] = value.join('='); }
  if (process.env.FAKE_CLAUDE_FAIL_ON === name) fail('Cannot add ' + name + ': disk full');
  if (data.mcpServers[name]) fail('MCP server ' + name + ' already exists in user config');
  data.mcpServers[name] = { type: 'stdio', command: rest[dash + 1], args: rest.slice(dash + 2), env };
  save();
} else if (args[1] === 'add-json') {
  if (data.mcpServers[rest[0]]) fail('MCP server ' + rest[0] + ' already exists in user config');
  data.mcpServers[rest[0]] = JSON.parse(rest[1]);
  save();
} else fail('unknown mcp command ' + args[1]);
`;

/** A fake `claude` in "<dir>/bin dir" (a space, like C:\\Program Files): a shell script, or claude.cmd on Windows. */
export async function installFakeClaude(dir: string): Promise<{ binDir: string; configDir: string; calls(): Promise<string[][]> }> {
  const binDir = join(dir, 'bin dir');
  const configDir = join(dir, 'claude config');
  await mkdir(binDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const script = join(binDir, 'fake-claude.cjs');
  await writeFile(script, FAKE_CLAUDE);
  if (process.platform === 'win32') {
    await writeFile(join(binDir, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    await writeFile(join(binDir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(join(binDir, 'claude'), 0o755);
  }
  const calls = async () =>
    (await readFile(join(configDir, 'claude-calls.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  return { binDir, configDir, calls };
}

/** The environment of this process with PATH replaced (whatever its case on Windows). */
export function withPath(path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== 'PATH') env[key] = value;
  return { ...env, PATH: path, ...extra };
}
```

`tests/agents/claude-code.test.ts` :

```ts
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
```

À la fin de `tests/agents/locations.test.ts` (ajouter `claudeCodeState` à l'import de `locations.js`) :

```ts
describe('the Claude Code state file', () => {
  it('is ~/.claude.json, or in CLAUDE_CONFIG_DIR', () => {
    expect(claudeCodeState(mac)).toBe('/Users/al/.claude.json');
    expect(claudeCodeState(win)).toBe('C:\\Users\\Al Ice\\.claude.json');
    expect(claudeCodeState({ ...linux, env: { CLAUDE_CONFIG_DIR: '/cfg' } })).toBe('/cfg/.claude.json');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/run-file.test.ts tests/agents/claude-code.test.ts tests/agents/locations.test.ts`
Expected: FAIL, `run-file.js` and `claude-code.js` cannot be resolved, `claudeCodeState` is not exported.

- [ ] **Step 3: Write the implementation**

`src/run-file.ts` :

```ts
import { exec, execFile, type ExecException } from 'node:child_process';
import { commandLine } from './catalog.js';

export interface RunOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export type FileRunner = (file: string, args: string[], options?: RunOptions) => Promise<RunResult>;

/**
 * Starts a program without a shell. A .cmd or .bat on Windows (npm.cmd, the npm shim of claude) only starts through
 * cmd.exe: it gets one command line, each argument in double quotes. A failure carries what the program wrote on stderr.
 */
export const runFile: FileRunner = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    const settings = { maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: options.timeoutMs ?? 0, ...(options.env ? { env: options.env } : {}) };
    const done = (error: ExecException | null, stdout: string, stderr: string) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    };
    if ((options.platform ?? process.platform) === 'win32' && /\.(cmd|bat)$/i.test(file)) exec(commandLine([file, ...args], 'win32'), settings, done);
    else execFile(file, args, settings, done);
  });
```

`src/installer.ts` : replace the `exec, execFile, type ExecException` import with `import { runFile } from './run-file.js';`, drop `commandLine` from the catalog import, and replace `npmRunner` with:

```ts
export const npmRunner: Runner = async (command, args) => {
  try {
    await runFile(command, args);
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new TwakeAiError('unavailable', `npm could not install the Twake.ai MCP servers: ${npmFailure(stderr) || (error as Error).message}`);
  }
};
```

`src/agents/locations.ts` :

```ts
/** Claude Code keeps its user-scope servers in .claude.json, in CLAUDE_CONFIG_DIR or the home folder. */
export const claudeCodeState = (p: Place) => pathOf(p).join(p.env.CLAUDE_CONFIG_DIR || p.home, '.claude.json');
```

`src/agents/claude-code.ts` :

```ts
import { stat } from 'node:fs/promises';
import { entryName } from '../catalog.js';
import { TwakeAiError } from '../errors.js';
import { runFile, type FileRunner } from '../run-file.js';
import { readText } from './config-file.js';
import { claudeCodeState, pathOf, type Place } from './locations.js';
import type { AgentAdapter, Entry } from './types.js';

/** A variable whatever its case: Windows has Path, POSIX PATH. */
const variable = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

/** The program `name` as the shell would find it in PATH (with PATHEXT on Windows). */
export async function findExecutable(name: string, place: Place): Promise<string | undefined> {
  const path = pathOf(place);
  const windows = place.platform === 'win32';
  const extensions = windows ? (variable(place.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (variable(place.env, 'PATH') ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension.toLowerCase());
      try {
        const info = await stat(candidate);
        if (info.isFile() && (windows || (info.mode & 0o111) !== 0)) return candidate;
      } catch {
        // not in this folder
      }
    }
  }
  return undefined;
}

const SCOPE = ['--scope', 'user'];

/** `claude mcp add … -- <command> <args>`: no JSON on the command line, which cmd.exe would mangle for claude.cmd. */
function addArgs(name: string, entry: Entry): string[] {
  const env = Object.entries((entry.env ?? {}) as Record<string, string>).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return ['mcp', 'add', ...SCOPE, name, ...env, '--', String(entry.command), ...((entry.args ?? []) as unknown[]).map(String)];
}

/** Claude Code, through its own `claude mcp` commands: its .claude.json is only ever read (spec §10.1). */
export function claudeCodeAgent(place: Place, run: FileRunner = runFile): AgentAdapter {
  const state = claudeCodeState(place);
  const read = async (): Promise<Record<string, Entry>> => {
    const text = await readText(state);
    if (text === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TwakeAiError('damaged_file', `${state} is not valid JSON: start Claude Code once to repair it, then run again. Nothing was changed.`);
    }
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as Record<string, Entry>) : {};
  };
  const claude = async (name: string, args: string[]) => {
    const file = await findExecutable('claude', place);
    if (!file) throw new TwakeAiError('unsupported', 'The claude command is not in PATH: install Claude Code, then run again.');
    try {
      await run(file, args, { platform: place.platform, env: place.env, timeoutMs: 60_000 });
    } catch (error) {
      if (error instanceof TwakeAiError) throw error;
      const detail = String((error as { stderr?: string }).stderr ?? '').trim().split('\n').at(-1) || (error as Error).message;
      throw new TwakeAiError('unavailable', `claude mcp ${args[1]} ${name} failed: ${detail}`);
    }
  };
  return {
    id: 'claude-code',
    label: 'Claude Code',
    target: `claude mcp, user scope (${state})`,
    capabilities: { elicitation: true, reload: 'Start a new Claude Code session to load them.' },
    entryName,
    shape: (base) => ({ type: 'stdio', command: base.command, args: base.args, ...(Object.keys(base.env).length ? { env: base.env } : {}) }),
    detect: async () => (await findExecutable('claude', place)) !== undefined,
    read,
    async write(change) {
      const before = await read();
      const touched = new Set<string>();
      try {
        for (const name of [...change.remove, ...Object.keys(change.set)]) {
          if (before[name] === undefined) continue;
          touched.add(name);
          await claude(name, ['mcp', 'remove', ...SCOPE, name]);
        }
        for (const [name, entry] of Object.entries(change.set)) {
          touched.add(name);
          await claude(name, addArgs(name, entry));
        }
      } catch (error) {
        // Claude Code keeps no copy to put back: the entries touched are re-added as they were
        for (const name of touched) {
          await claude(name, ['mcp', 'remove', ...SCOPE, name]).catch(() => undefined);
          const previous = before[name];
          if (previous === undefined) continue;
          const again = typeof previous.command === 'string' ? addArgs(name, previous) : ['mcp', 'add-json', ...SCOPE, name, JSON.stringify(previous)];
          await claude(name, again).catch(() => undefined);
        }
        throw error;
      }
      return {};
    },
  };
}
```

- [ ] **Step 4: Run them to verify they pass, then the installer tests**

Run: `npx vitest run tests/run-file.test.ts tests/agents/claude-code.test.ts tests/agents/locations.test.ts tests/installer.test.ts`
Expected: PASS (2 + 4 + 6 tests, the installer tests unchanged ; le test `.cmd` ne tourne que sous Windows).

- [ ] **Step 5: Commit**

```bash
git add src/run-file.ts src/installer.ts src/agents/claude-code.ts src/agents/locations.ts tests/run-file.test.ts tests/helpers/fake-claude.ts tests/agents/claude-code.test.ts tests/agents/locations.test.ts
git commit -m "feat: write the Twake.ai servers into Claude Code with claude mcp"
```

---

### Task 6 : registre des agents, application isolée, empreintes enregistrées

**Files:**
- Create: `src/agents/index.ts`
- Test: `tests/agents/index.test.ts`

**Interfaces:**
- Consumes: les adaptateurs (tâches 3 à 5), `planEntries`, `resolvePlan` (tâche 2), `withLock`, `loadConfig`, `saveConfig`.
- Produces: `AgentsDeps extends Place { now(): Date; run?: FileRunner }` ; `createAdapters(d): Promise<Record<AgentId, AgentAdapter>>` ; `detectAgents(adapters): Promise<AgentId[]>` ; `AgentResult { agent; status: 'unchanged' | 'written' | 'failed'; skipped; owned; backup?; error? }` ; `applyAgent(adapter, actions, owned, consent): Promise<AgentResult>` ; `recordOwned(paths, agent, owned): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`tests/agents/index.test.ts` :

```ts
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/agents/index.test.ts`
Expected: FAIL, `../../src/agents/index.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/agents/index.ts` :

```ts
import { loadConfig, saveConfig } from '../config.js';
import { TwakeAiError } from '../errors.js';
import { withLock } from '../lock.js';
import type { AppPaths } from '../paths.js';
import type { FileRunner } from '../run-file.js';
import { claudeCodeAgent } from './claude-code.js';
import { resolvePlan, type EntryAction } from './entries.js';
import { hermesAgent } from './hermes.js';
import { claudeDesktopAgent, cursorAgent, vscodeAgent } from './json-config.js';
import { hermesHome, type Place } from './locations.js';
import { AGENT_IDS, type AgentAdapter, type AgentId } from './types.js';

export interface AgentsDeps extends Place {
  now(): Date;
  /** runs `claude`, replaceable in tests */
  run?: FileRunner;
}

/** The five agents mcp-twake-ai configures itself (spec §10.1). */
export async function createAdapters(d: AgentsDeps): Promise<Record<AgentId, AgentAdapter>> {
  const place = { platform: d.platform, env: d.env, home: d.home };
  return {
    'claude-code': claudeCodeAgent(place, d.run),
    hermes: hermesAgent(await hermesHome(place), d.now),
    'claude-desktop': claudeDesktopAgent(place, d.now),
    cursor: cursorAgent(place, d.now),
    vscode: vscodeAgent(place, d.now),
  };
}

export async function detectAgents(adapters: Record<AgentId, AgentAdapter>): Promise<AgentId[]> {
  const found: AgentId[] = [];
  for (const id of AGENT_IDS) if (await adapters[id].detect()) found.push(id);
  return found;
}

export interface AgentResult {
  agent: AgentId;
  status: 'unchanged' | 'written' | 'failed';
  /** the entries left alone because they need an explicit yes */
  skipped: EntryAction[];
  /** the entries mcp-twake-ai owns afterwards (name → fingerprint) */
  owned: Record<string, string>;
  backup?: string;
  error?: string;
}

/** Applies one agent's plan. A failure leaves that agent as it was (its adapter restores it) and is reported, not thrown. */
export async function applyAgent(
  adapter: AgentAdapter,
  actions: EntryAction[],
  owned: Record<string, string>,
  consent: (action: EntryAction) => boolean,
): Promise<AgentResult> {
  const resolved = resolvePlan(actions, owned, consent);
  const base = { agent: adapter.id, skipped: resolved.skipped };
  if (Object.keys(resolved.change.set).length === 0 && resolved.change.remove.length === 0) return { ...base, status: 'unchanged', owned: resolved.owned };
  try {
    const { backup } = await adapter.write(resolved.change);
    return { ...base, status: 'written', owned: resolved.owned, ...(backup ? { backup } : {}) };
  } catch (error) {
    return { ...base, status: 'failed', owned, error: error instanceof TwakeAiError ? error.message : String((error as Error)?.message ?? error) };
  }
}

/** Notes in config.json the entries mcp-twake-ai now owns in one agent. */
export async function recordOwned(paths: AppPaths, agent: AgentId, owned: Record<string, string>): Promise<void> {
  await withLock(paths.locksDir, 'config', async () => {
    const config = await loadConfig(paths);
    if (!config) return;
    await saveConfig(paths, { ...config, agents: { ...config.agents, [agent]: { entries: owned } } });
  });
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/agents/index.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agents/index.ts tests/agents/index.test.ts
git commit -m "feat: apply agents one by one and remember the entries written"
```

---

### Task 7 : `mcp-twake-ai setup` non interactif

**Files:**
- Modify: `src/cli.ts` (`home` dans `CliDeps`, `setupCommand`, `catalogContext`, usage)
- Modify: `README.md`, `docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md` (10.1, 10.2), `docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: tâches 2 et 6 ; `connectService`, `ensureInstalled`, `defaultServices`, `serviceEnv` existants.
- Produces: `CliDeps.home: string` ; la commande `setup --agents <ids|detected> [--services <list>] [--yes] [--force] [--no-browser]` ; sortie 0 si tout va bien, 1 si un agent a échoué, 2 pour une erreur d'usage.

- [ ] **Step 1: Write the failing tests**

`tests/cli.test.ts` :
- dans `testDeps()`, remplacer `const { paths } = await tempPaths();` par `const { root, paths } = await tempPaths();` et ajouter `home: join(root, 'home'),` à l'objet retourné (avant `platform: 'darwin'`) ;
- ajouter aux imports : `mkdir, writeFile` depuis `node:fs/promises` (à côté de `readFile`), et `readText` depuis `../src/agents/config-file.js` ;
- dans `describe('main: Twake Drive and Twake Chat', …)`, après le dernier test, ajouter :

```ts
  /** Signed in with Twake Mail found, Cursor and VS Code installed (macOS paths: testDeps uses platform darwin). */
  async function readyForSetup() {
    const deps = await signedIn();
    const config = (await loadConfig(deps.paths))!;
    await saveConfig(deps.paths, {
      ...config,
      environment: { ...config.environment, services: { mail: { url: 'https://jmap.example.com/jmap/session', source: 'discovered' } } },
    });
    deps.runInstall = fakeNpm(deps.paths);
    const cursor = join(deps.home, '.cursor', 'mcp.json');
    const vscode = join(deps.home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json');
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

  it('reports a damaged agent file and still writes the others', async () => {
    const { deps, cursor, vscode } = await readyForSetup();
    await writeFile(vscode, '{"servers": {');
    const io = captureIo();
    expect(await main(['setup', '--agents', 'cursor,vscode', '--services', 'mail', '--yes'], io, deps)).toBe(1);
    expect(io.out).toContain(`VS Code: ${vscode} is not valid JSON`);
    expect(JSON.parse((await readText(cursor))!).mcpServers).toHaveProperty('twake-mail');
    expect(await readText(vscode)).toBe('{"servers": {');
  });
```

(`dirname` est ajouté à l'import de `node:path` du fichier de test.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/cli.test.ts -t "setup|agent|plan|Chat device|damaged agent"`
Expected: FAIL, `setup` is an unknown command (exit 2 and the usage text).

- [ ] **Step 3: Write the implementation**

`src/cli.ts` :

1. Imports :

```ts
import { homedir } from 'node:os';
import { needsConsent, planEntries, wantedEntries, type ActionKind, type EntryAction } from './agents/entries.js';
import { applyAgent, createAdapters, detectAgents, recordOwned } from './agents/index.js';
import { AGENT_IDS, isAgentId, type AgentAdapter, type AgentId } from './agents/types.js';
import { type CatalogContext } from './catalog.js';
```

(`CatalogContext` rejoint l'import existant de `./catalog.js`.)

2. `CliDeps` : ajouter `/** the user's home folder, where agents keep their settings */ home: string;` et, dans `defaultDeps()`, `home: homedir(),`.

3. `USAGE` : ajouter la ligne `  mcp-twake-ai setup --agents <ids|detected> [--services <list>] [--yes] [--force] [--no-browser]` en tête, et dans `main` le cas `case 'setup': return await setupCommand(args, io, deps);`.

4. Le contexte du catalogue, partagé par `export` et `setup` (et `exportCommand` utilise `catalogContext(config, d)` à la place de son `ctxFor`) :

```ts
function catalogContext(config: TwakeAiConfig, d: CliDeps): CatalogContext {
  return { config, paths: d.paths, nodePath: d.nodePath, cliPath: d.cliPath, platform: d.platform, language: detectLanguage(d.env), timezone: systemTimezone() };
}
```

5. La commande :

```ts
const PLAN_LINE: Record<ActionKind, [string, string]> = {
  add: ['+', 'add'],
  update: ['~', 'update'],
  keep: ['=', 'unchanged'],
  remove: ['-', 'remove'],
  forget: ['·', 'already gone'],
  'replace-foreign': ['!', 'replaces an entry configured outside mcp-twake-ai'],
  'replace-modified': ['!', 'replaces an entry changed by hand since mcp-twake-ai wrote it'],
  'remove-modified': ['!', 'removes an entry changed by hand since mcp-twake-ai wrote it'],
};

function printPlan(io: Io, adapter: AgentAdapter, actions: EntryAction[], force: boolean): void {
  io.stdout(`${adapter.label} (${adapter.target})\n`);
  for (const action of actions) {
    const [symbol, words] = PLAN_LINE[action.kind];
    io.stdout(`  ${symbol} ${action.name.padEnd(14)} ${words}${needsConsent(action) && !force ? ': add --force to do it' : ''}\n`);
  }
  if (!adapter.capabilities.elicitation) io.stdout(`  ${adapter.label} cannot show approval requests: reads work, and every write is refused.\n`);
}

/** setup --agents …: writes the Twake.ai servers into the agents (spec §8, non-interactive; §10). */
async function setupCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({
      args,
      options: { agents: { type: 'string' }, services: { type: 'string' }, yes: { type: 'boolean' }, force: { type: 'boolean' }, 'no-browser': { type: 'boolean' } },
      strict: true,
    }),
  );
  const adapters = await createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  const detected = await detectAgents(adapters);
  if (values.agents === undefined) {
    throw new TwakeAiError('usage', `setup needs --agents: ${AGENT_IDS.join(', ')}, or "detected" (found here: ${detected.join(', ') || 'none'}).\n\n${USAGE}`);
  }
  const names = values.agents === 'detected' ? detected : [...new Set(values.agents.split(',').map((name) => name.trim()))];
  for (const name of names) {
    if (!isAgentId(name)) throw new TwakeAiError('usage', `"${name}" is not an agent mcp-twake-ai configures (${AGENT_IDS.join(', ')}): for any other one, use export.\n\n${USAGE}`);
  }
  if (names.length === 0) throw new TwakeAiError('usage', `No agent was found on this computer: name them with --agents.\n\n${USAGE}`);
  const config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'Sign in first: run `mcp-twake-ai login --email <address>`.');
  const services = values.services === undefined ? defaultServices(config) : values.services.split(',').map((s) => s.trim());
  for (const service of services) {
    if (!isServiceId(service)) throw new TwakeAiError('usage', `"${service}" is not a Twake.ai service (${SERVICE_IDS.join(', ')}).\n\n${USAGE}`);
  }
  const chosen = services as ServiceId[];
  const ctx = catalogContext(config, d);
  // what needs no new connection is checked before anything changes
  for (const agent of names) for (const service of chosen) if (service !== 'drive' && service !== 'chat') serviceEnv(service, agent, ctx);
  const env = d.env.TWAKE_AI_HOME ? { TWAKE_AI_HOME: d.env.TWAKE_AI_HOME } : {};
  const force = values.force ?? false;
  let failed = false;
  const plans: { adapter: AgentAdapter; owned: Record<string, string>; actions: EntryAction[] }[] = [];
  for (const agent of names as AgentId[]) {
    const adapter = adapters[agent];
    if (!(await adapter.detect())) {
      io.stdout(`${adapter.label}: not found on this computer (${adapter.target}), left out.\n`);
      continue;
    }
    const owned = config.agents?.[agent]?.entries ?? {};
    try {
      const actions = planEntries(await adapter.read(), wantedEntries(adapter, chosen, ctx, env), owned);
      plans.push({ adapter, owned, actions });
      printPlan(io, adapter, actions, force);
    } catch (error) {
      if (!(error instanceof TwakeAiError)) throw error;
      failed = true;
      io.stdout(`${adapter.label}: ${error.message}\n`);
    }
  }
  const driveFirst = chosen.includes('drive') && !config.drive;
  const chatFor = chosen.includes('chat') ? plans.map((plan) => plan.adapter.id).filter((agent) => !config.chat?.[agent]) : [];
  if (driveFirst) io.stdout('Twake Drive is connected first, in the browser.\n');
  if (chatFor.length > 0) io.stdout(`Twake Chat gets a device for: ${chatFor.join(', ')}.\n`);
  if (!values.yes) {
    io.stdout('Nothing was changed: run the same command with --yes to apply it.\n');
    return failed ? 1 : 0;
  }
  if (plans.length === 0) return failed ? 1 : 0;
  if (driveFirst) await connectService({ drive: true, 'no-browser': values['no-browser'] }, io, d);
  for (const agent of chatFor) await connectService({ chat: true, agent, 'no-browser': values['no-browser'] }, io, d);
  await ensureInstalled(d.paths, chosen, { run: d.runInstall, print: (line) => io.stdout(`${line}\n`) });
  for (const { adapter, owned, actions } of plans) {
    const result = await applyAgent(adapter, actions, owned, () => force);
    if (result.status === 'failed') {
      failed = true;
      io.stdout(`${adapter.label}: not changed, ${result.error}\n`);
      continue;
    }
    await recordOwned(d.paths, adapter.id, result.owned);
    if (result.status === 'unchanged') io.stdout(`${adapter.label}: already up to date.\n`);
    else io.stdout(`${adapter.label}: done${result.backup ? ` (previous file kept as ${result.backup})` : ''}. ${adapter.capabilities.reload}\n`);
    if (result.skipped.length > 0) io.stdout(`  left as they are: ${result.skipped.map((action) => action.name).join(', ')} (add --force to change them)\n`);
  }
  return failed ? 1 : 0;
}
```

6. Documentation :
- `README.md` : une section « Configure your agents: `mcp-twake-ai setup` » avant « Any agent: `mcp-twake-ai export` ». Elle contient les trois exemples (`--agents detected`, `--agents claude-code,hermes --yes`, `--agents cursor --services mail,dav --yes`), le tableau agent / emplacement / approbation des écritures de la section Global Constraints, et les règles (seulement ses entrées, `--force`, copie `.bak-<date>`, agent remis en état sur échec, deuxième passage sans changement, services retirés). La ligne de statut mentionne `setup`.
- Spec 10.1 : la ligne Claude Code dit `claude mcp add --scope user <nom> -- <command> <args…>` (pas de JSON à travers `cmd.exe`) ; Hermes cite `%LOCALAPPDATA%\hermes` et le profil actif ; VS Code, le profil par défaut et `VSCODE_APPDATA`.
- Spec 10.2 : Cursor « gérée (depuis 1.5) » ; Claude Desktop « non confirmée au 2026-11-11 : traitée comme non gérée ».
- Feuille de route : le 3b livre aussi `setup` non interactif ; le plan 4 garde le parcours interactif, la bannière, la langue et `--email`.

- [ ] **Step 4: Run them to verify they pass, then the whole suite**

Run: `npx vitest run tests/cli.test.ts && npm test && npm run typecheck`
Expected: PASS ; toute la suite verte, typecheck propre.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts README.md docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md
git commit -m "feat: mcp-twake-ai setup writes the Twake.ai servers into the agents"
```

---

### Task 8 : de bout en bout, la CLI construite écrit des entrées qui démarrent leur serveur

**Files:**
- Create: `tests/e2e/setup.e2e.test.ts`
- Modify: `package.json` (script `test:e2e`)

**Interfaces:**
- Consumes: `build/bin.js` (construit par le test) ; `installFakeMcp` ; `installFakeClaude`, `withPath` (tâche 5) ; `sampleConfig` (tâche 1).
- Produces: un test qui tourne dans `npm test` sur les trois OS, plus un test du vrai Claude Code quand `MCP_TWAKE_AI_E2E=1` et que `claude` est installé.

- [ ] **Step 1: Write the test**

`tests/e2e/setup.e2e.test.ts` :

```ts
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
```

`package.json`, in `scripts` : `"test:e2e": "MCP_TWAKE_AI_E2E=1 vitest run tests/e2e"` (POSIX ; sous Windows la variable se fixe à la main).

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/e2e`
Expected: PASS (1 test ; le test du vrai Claude Code est sauté).

Run: `MCP_TWAKE_AI_E2E=1 npx vitest run tests/e2e`
Expected: PASS (2 tests), avec le vrai `claude` de cette machine dans un `CLAUDE_CONFIG_DIR` temporaire : `claude mcp get twake-mail` affiche `Status: ✔ Connected`.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/setup.e2e.test.ts package.json
git commit -m "test: setup end to end, from the built CLI to a server that answers"
```
