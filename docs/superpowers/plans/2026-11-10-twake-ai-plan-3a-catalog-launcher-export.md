# twake-ai, plan 3a : catalogue, installation, lanceur et export

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `twake-ai run <service> --agent <id>` lance un MCP Twake.ai installé en version figée, avec l'environnement construit par twake-ai. `twake-ai export --agent <id>` installe ces MCP et génère les fichiers de configuration pour n'importe quel agent.

**Architecture:**
- **`catalog.ts`** décrit les six MCP sous forme de données (paquet, version, préfixe de variables) et construit leur environnement : URL, `*_TOKEN_COMMAND` entre apostrophes POSIX, langue, fuseau, réglages Hermes, store Chat propre à l'agent et au device.
- **`installer.ts`** installe les paquets manquants dans `<dataDir>/prefix` avec npm, et retrouve leur point d'entrée.
- **`launcher.ts`** démarre le MCP avec `stdio: 'inherit'`, ce qui fait passer l'élicitation sans relais. Il transmet les signaux et propage le code de sortie.
- **`exporter.ts`** produit les fichiers d'export.
- **Découverte :** une cible SRV hors du domaine de l'email est désormais ignorée, puisque les réponses DNS ne sont pas authentifiées.

**Tech Stack:** celle des plans 1 et 2, plus `yaml` 2 et `smol-toml` 1.

**Spec:** `docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md`, sections 5.3 (préfixe), 9 (lanceur) et 11 (export). Feuille de route : `docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md` (le plan 3 y est découpé en 3a et 3b).

## Global Constraints

- **Contraintes reprises :** toutes celles des plans 1 et 2.
- **Versions figées :**

  | Paquet | Version |
  |---|---|
  | `mcp-twake-mail` | 4.1.0 |
  | `mcp-twake-dav` | 4.2.0 |
  | `mcp-twake-drive` | 0.4.0 |
  | `mcp-twake-chat` | 0.6.0 |
  | `mcp-twake-space` | 0.2.1 |
  | `mcp-twake-project` | 0.2.1 |

  Point d'entrée de chaque paquet : son champ `bin`.
- **Installation :** `npm install --prefix <dataDir>/prefix --no-audit --no-fund --save-exact --allow-scripts=sqlite3 <paquets@versions>`. Le script d'installation de `sqlite3`, dont dépend mcp-twake-chat, est bloqué par défaut sous npm 11.
- **Commande de jeton :** `*_TOKEN_COMMAND` = `'<node>' '<cli>' 'token' '<service>'`, plus `'--agent' '<id>'` pour Chat. Chaque élément est entre apostrophes POSIX, puisque les six MCP passent par `/bin/sh -c`.
- **Noms d'entrées :** `twake-<service>` ; pour Hermes, `twake_<service>`.
- **Hermes :** `timeout: 420`, `elicitation: { enabled: true, timeout: 300 }`, `<PRÉFIXE>_APPROVAL_TIMEOUT_MS=330000`.
- **Préfixes d'approbation :** `JMAP`, `DAV`, `TWAKE_DRIVE`, `MATRIX`, `TWAKE_SPACE`, `TWAKE_PROJECT`.
- **Store Chat :** `<dataDir>/chat/<agent>/<deviceId>`. Un nouveau device a ainsi un nouveau store, puisque le store E2EE est lié au device.
- **Priorité de l'environnement :** les variables déjà présentes dans l'environnement de l'agent l'emportent sur celles que twake-ai construit (spec section 9).
- **`twake-ai run` n'écrit jamais sur stdout :** c'est le canal MCP. Ses erreurs vont sur stderr.
- **Langue :** `TWAKE_AI_LANGUAGE`, sinon `LC_ALL`, `LC_MESSAGES` ou `LANG` : `fr…` donne `fr`, tout le reste `en`.
- **Fuseau :** celui du système (`Intl`), sinon `UTC`.
- **SRV :** une cible n'est retenue que si elle est le domaine de l'email ou l'un de ses sous-domaines.

## Review Focus

- **Chemin de Node ou de la CLI avec une espace ou une apostrophe** (`/opt/my node/bin/node`, `/home/o'brien/…`) : `/bin/sh -c` doit retrouver exactement les arguments. Test dans la tâche 2.
- **Variable déjà fixée dans l'environnement de l'agent** (`USER_LANGUAGE=fr`) : elle l'emporte sur celle de twake-ai. Test dans la tâche 4.
- **MCP qui sort avec un code non nul ou qui est tué** : `twake-ai run` sort avec le même code, et l'agent voit l'échec. Test dans la tâche 4.
- **Export avec Chat pour un agent sans device** : le device est créé au moment de l'export. Le broker ne pourrait pas ouvrir de navigateur plus tard, quand le MCP lui demandera un jeton. Test dans la tâche 5.
- **Cible SRV d'un autre domaine** (`jmap.attacker.example`, `linagora.com.evil.example`) : ignorée. Test dans la tâche 1.

---

### Task 1 : cibles SRV limitées au domaine de l'email

**Files:**
- Modify: `src/discovery.ts` (fonction `srvBase`)
- Test: `tests/discovery.test.ts`

**Interfaces:**
- Consumes : `discover`, `SrvRecord` (plan 1).
- Produces : comportement uniquement. Une cible SRV hors de `<domaine>` et de ses sous-domaines est traitée comme absente.

- [ ] **Step 1 : écrire le test qui échoue** (à la fin de `tests/discovery.test.ts`)

```ts
describe('discover: SRV targets', () => {
  it('ignores SRV targets outside the email domain, because DNS answers are not authenticated', async () => {
    const env = await discover(
      'jdoe@linagora.com',
      deps(linagoraRoutes, {
        '_jmap._tcp.linagora.com': [{ name: 'jmap.attacker.example.', port: 443, priority: 0, weight: 1 }],
        '_caldavs._tcp.linagora.com': [{ name: 'linagora.com.evil.example', port: 443, priority: 0, weight: 1 }],
      }),
    );
    expect(env.services.mail).toBeUndefined();
    expect(env.services.dav).toBeUndefined();
  });

  it('keeps the domain itself and its subdomains', async () => {
    const env = await discover(
      'jdoe@linagora.com',
      deps({ ...linagoraRoutes, 'https://linagora.com/.well-known/jmap': () => new Response('{}', { status: 401 }) }, {
        '_jmap._tcp.linagora.com': [{ name: 'linagora.com.', port: 443, priority: 0, weight: 1 }],
        '_caldavs._tcp.linagora.com': [{ name: 'DAV.Linagora.com.', port: 443, priority: 0, weight: 1 }],
      }),
    );
    expect(env.services.mail?.url).toBe('https://linagora.com/.well-known/jmap');
    expect(env.services.dav?.url).toBe('https://dav.linagora.com/');
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/discovery.test.ts`
Expected : FAIL. Le premier test trouve `mail` et `dav` chez l'attaquant ; le second garde `DAV.Linagora.com` avec ses majuscules.

- [ ] **Step 3 : modifier `srvBase` dans `src/discovery.ts`**

Remplacer :

```ts
  const best = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
  if (!best) return undefined;
  const host = best.name.replace(/\.$/, '');
```

par :

```ts
  // DNS answers are not authenticated: only targets inside the email's domain may later receive the user's tokens
  const inDomain = (record: SrvRecord) => {
    const host = record.name.replace(/\.$/, '').toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  };
  const best = records.filter(inDomain).sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
  if (!best) return undefined;
  const host = best.name.replace(/\.$/, '').toLowerCase();
```

- [ ] **Step 4 : lancer les tests**

Run : `npx vitest run tests/discovery.test.ts`
Expected : tout PASS (les tests des plans 1 et 2 compris).

- [ ] **Step 5 : commit**

```bash
git add src/discovery.ts tests/discovery.test.ts
git commit -m "fix: only trust SRV targets inside the email's domain"
```

---

### Task 2 : catalogue des MCP et leur environnement

**Files:**
- Create: `src/catalog.ts`
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes : `ServiceId` (`src/broker.ts`), `TwakeAiConfig`, `AppPaths`, `TwakeAiError`, `checkAgentId` (`src/grants.ts`).
- Produces :
  - `interface McpPackage { name: string; version: string; approval: string }`
  - `CATALOG: Record<ServiceId, McpPackage>`
  - `HERMES_APPROVAL_TIMEOUT_MS = '330000'`
  - `entryName(service): string` (`twake-mail`), `hermesEntryName(service): string` (`twake_mail`)
  - `interface CatalogContext { config: TwakeAiConfig; paths: AppPaths; nodePath: string; cliPath: string; language: 'en' | 'fr'; timezone: string }`
  - `shellQuote(value: string): string`
  - `tokenCommand(service, agent: string | undefined, ctx): string`
  - `serviceEnv(service, agent: string, ctx): Record<string, string>`
  - `detectLanguage(env: NodeJS.ProcessEnv): 'en' | 'fr'`, `systemTimezone(): string`

- [ ] **Step 1 : écrire le test qui échoue**

`tests/catalog.test.ts` :

```ts
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG, detectLanguage, entryName, hermesEntryName, serviceEnv, shellQuote, tokenCommand, type CatalogContext } from '../src/catalog.js';
import type { TwakeAiConfig } from '../src/config.js';
import { appPaths } from '../src/paths.js';

const config: TwakeAiConfig = {
  version: 1,
  email: 'JDoe@linagora.com',
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

const ctx: CatalogContext = {
  config,
  paths: appPaths({ platform: 'linux', env: { TWAKE_AI_HOME: '/t' }, home: '/home/j' }),
  nodePath: '/usr/bin/node',
  cliPath: '/opt/twake-ai/build/bin.js',
  language: 'fr',
  timezone: 'Europe/Paris',
};

const cmd = (service: string, agent?: string) => `'/usr/bin/node' '/opt/twake-ai/build/bin.js' 'token' '${service}'${agent ? ` '--agent' '${agent}'` : ''}`;

describe('catalog', () => {
  it('pins the six MCP servers', () => {
    expect(Object.fromEntries(Object.entries(CATALOG).map(([service, pkg]) => [service, `${pkg.name}@${pkg.version}`]))).toEqual({
      mail: 'mcp-twake-mail@4.1.0',
      dav: 'mcp-twake-dav@4.2.0',
      drive: 'mcp-twake-drive@0.4.0',
      chat: 'mcp-twake-chat@0.6.0',
      space: 'mcp-twake-space@0.2.1',
      project: 'mcp-twake-project@0.2.1',
    });
    expect(entryName('mail')).toBe('twake-mail');
    expect(hermesEntryName('project')).toBe('twake_project');
  });
});

describe('tokenCommand', () => {
  it('quotes every argument for /bin/sh -c', () => {
    expect(tokenCommand('chat', 'hermes', ctx)).toBe(cmd('chat', 'hermes'));
    expect(shellQuote("o'brien")).toBe(`'o'\\''brien'`);
  });

  it.skipIf(process.platform === 'win32')('survives spaces and quotes in paths through /bin/sh -c', () => {
    const odd = { ...ctx, nodePath: '/opt/my node/bin/node', cliPath: "/home/o'brien/cli.js" };
    const printed = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${tokenCommand('mail', undefined, odd)}`], { encoding: 'utf8' });
    expect(printed.split('\n').slice(0, 4)).toEqual(['/opt/my node/bin/node', "/home/o'brien/cli.js", 'token', 'mail']);
  });
});

describe('serviceEnv', () => {
  it('builds the environment of each service', () => {
    const common = { USER_LANGUAGE: 'fr', USER_TIMEZONE: 'Europe/Paris' };
    expect(serviceEnv('mail', 'claude-code', ctx)).toEqual({
      JMAP_SESSION_URL: 'https://jmap.linagora.com/jmap/session',
      JMAP_AUTH_METHOD: 'command',
      JMAP_TOKEN_COMMAND: cmd('mail'),
      ...common,
    });
    expect(serviceEnv('dav', 'claude-code', ctx)).toEqual({
      DAV_URL: 'https://dav.linagora.com/',
      DAV_AUTH_METHOD: 'command',
      DAV_TOKEN_COMMAND: cmd('dav'),
      DAV_ORGANIZER_EMAIL: 'jdoe@linagora.com',
      ...common,
    });
    expect(serviceEnv('drive', 'claude-code', ctx)).toEqual({ TWAKE_DRIVE_URL: 'https://jdoe.twake.linagora.com', TWAKE_DRIVE_TOKEN_COMMAND: cmd('drive'), ...common });
    expect(serviceEnv('space', 'claude-code', ctx)).toEqual({
      TWAKE_SPACE_URL: 'https://space.linagora.com',
      TWAKE_SPACE_TOKEN_COMMAND: cmd('space'),
      TWAKE_SPACE_OIDC_ISSUER: 'https://sso.linagora.com',
      ...common,
    });
    expect(serviceEnv('project', 'claude-code', ctx)).toEqual({
      TWAKE_PROJECT_URL: 'https://projects.linagora.com',
      TWAKE_PROJECT_TOKEN_COMMAND: cmd('project'),
      TWAKE_PROJECT_OIDC_ISSUER: 'https://sso.linagora.com',
      ...common,
    });
  });

  it("gives Chat the agent's device, its own store and the ToM recovery", () => {
    expect(serviceEnv('chat', 'hermes', ctx)).toMatchObject({
      MATRIX_USER_ID: '@jdoe:linagora.com',
      MATRIX_TOKEN_COMMAND: cmd('chat', 'hermes'),
      MATRIX_HOMESERVER_URL: 'https://matrix.linagora.com/',
      TOM_URL: 'https://tom.linagora.com/',
      MATRIX_E2EE_RECOVERY: 'tom',
      MATRIX_STORE_DIR: join('/t/data', 'chat', 'hermes', 'DEVICE1'),
    });
  });

  it('lets the approval wait a little longer than Hermes', () => {
    expect(serviceEnv('mail', 'hermes', ctx).JMAP_APPROVAL_TIMEOUT_MS).toBe('330000');
    expect(serviceEnv('chat', 'hermes', ctx).MATRIX_APPROVAL_TIMEOUT_MS).toBe('330000');
    expect(serviceEnv('mail', 'claude-code', ctx).JMAP_APPROVAL_TIMEOUT_MS).toBeUndefined();
  });

  it('says what is missing', () => {
    const bare = { ...ctx, config: { ...config, drive: undefined, chat: undefined, environment: { ...config.environment, services: {} } } };
    expect(() => serviceEnv('mail', 'claude-code', bare)).toThrow(expect.objectContaining({ code: 'unsupported' }));
    expect(() => serviceEnv('drive', 'claude-code', bare)).toThrow(expect.objectContaining({ code: 'login_required', message: expect.stringContaining('login --drive') }));
    expect(() => serviceEnv('chat', 'cursor', ctx)).toThrow(expect.objectContaining({ code: 'login_required', message: expect.stringContaining('--agent cursor') }));
    expect(() => serviceEnv('mail', 'Claude Code', ctx)).toThrow(expect.objectContaining({ code: 'usage' }));
  });
});

describe('detectLanguage', () => {
  it('reads TWAKE_AI_LANGUAGE, then the locale', () => {
    expect(detectLanguage({ TWAKE_AI_LANGUAGE: 'en', LANG: 'fr_FR.UTF-8' })).toBe('en');
    expect(detectLanguage({ LANG: 'fr_FR.UTF-8' })).toBe('fr');
    expect(detectLanguage({ LC_ALL: 'de_DE.UTF-8', LANG: 'fr_FR' })).toBe('en');
    expect(detectLanguage({})).toBe('en');
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/catalog.test.ts`
Expected : FAIL, module `../src/catalog.js` introuvable.

- [ ] **Step 3 : écrire `src/catalog.ts`**

```ts
import { join } from 'node:path';
import type { ServiceId } from './broker.js';
import type { TwakeAiConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { checkAgentId } from './grants.js';
import type { AppPaths } from './paths.js';

export interface McpPackage {
  name: string;
  version: string;
  /** prefix of its *_APPROVAL and *_APPROVAL_TIMEOUT_MS variables */
  approval: string;
}

/** The six Twake.ai MCP servers, pinned: an agent never starts a version nobody tested with twake-ai. */
export const CATALOG: Record<ServiceId, McpPackage> = {
  mail: { name: 'mcp-twake-mail', version: '4.1.0', approval: 'JMAP' },
  dav: { name: 'mcp-twake-dav', version: '4.2.0', approval: 'DAV' },
  drive: { name: 'mcp-twake-drive', version: '0.4.0', approval: 'TWAKE_DRIVE' },
  chat: { name: 'mcp-twake-chat', version: '0.6.0', approval: 'MATRIX' },
  space: { name: 'mcp-twake-space', version: '0.2.1', approval: 'TWAKE_SPACE' },
  project: { name: 'mcp-twake-project', version: '0.2.1', approval: 'TWAKE_PROJECT' },
};

/** Hermes waits 300 s for an answer: the server waits a little longer, so that Hermes, not the server, gives up first. */
export const HERMES_APPROVAL_TIMEOUT_MS = '330000';

export const entryName = (service: ServiceId) => `twake-${service}`;
export const hermesEntryName = (service: ServiceId) => `twake_${service}`;

export interface CatalogContext {
  config: TwakeAiConfig;
  paths: AppPaths;
  /** absolute paths of node and of twake-ai's command (build/bin.js) */
  nodePath: string;
  cliPath: string;
  language: 'en' | 'fr';
  timezone: string;
}

/** POSIX single quotes: the Twake.ai MCP servers run *_TOKEN_COMMAND through /bin/sh -c. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function tokenCommand(service: ServiceId, agent: string | undefined, ctx: CatalogContext): string {
  return [ctx.nodePath, ctx.cliPath, 'token', service, ...(agent ? ['--agent', agent] : [])].map(shellQuote).join(' ');
}

export function detectLanguage(env: NodeJS.ProcessEnv): 'en' | 'fr' {
  const tag = env.TWAKE_AI_LANGUAGE || env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return tag.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** The environment of one MCP server for one agent: URLs, token command, language, time zone, agent-specific settings. */
export function serviceEnv(service: ServiceId, agent: string, ctx: CatalogContext): Record<string, string> {
  checkAgentId(agent);
  const { config } = ctx;
  const env = config.environment;
  const common: Record<string, string> = { USER_LANGUAGE: ctx.language, USER_TIMEZONE: ctx.timezone };
  if (agent === 'hermes') common[`${CATALOG[service].approval}_APPROVAL_TIMEOUT_MS`] = HERMES_APPROVAL_TIMEOUT_MS;
  const notFound = (what: string) => new TwakeAiError('unsupported', `No ${what} was found for ${env.domain}: it cannot be configured.`);
  switch (service) {
    case 'mail': {
      const url = env.services.mail?.url;
      if (!url) throw notFound('Twake Mail (JMAP) server');
      return { JMAP_SESSION_URL: url, JMAP_AUTH_METHOD: 'command', JMAP_TOKEN_COMMAND: tokenCommand('mail', undefined, ctx), ...common };
    }
    case 'dav': {
      const url = env.services.dav?.url;
      if (!url) throw notFound('Twake Calendar (CalDAV) server');
      return {
        DAV_URL: url,
        DAV_AUTH_METHOD: 'command',
        DAV_TOKEN_COMMAND: tokenCommand('dav', undefined, ctx),
        // required with an SSO token: the server cannot tell the user's address from it
        DAV_ORGANIZER_EMAIL: config.email.trim().toLowerCase(),
        ...common,
      };
    }
    case 'drive': {
      const instance = env.cozy.instance;
      if (!instance || !config.drive) throw new TwakeAiError('login_required', 'Twake Drive is not connected: run `twake-ai login --drive`.');
      return { TWAKE_DRIVE_URL: instance, TWAKE_DRIVE_TOKEN_COMMAND: tokenCommand('drive', undefined, ctx), ...common };
    }
    case 'chat': {
      const device = config.chat?.[agent];
      if (!device) throw new TwakeAiError('login_required', `Twake Chat is not connected for ${agent}: run \`twake-ai login --chat --agent ${agent}\`.`);
      return {
        MATRIX_USER_ID: device.userId,
        MATRIX_TOKEN_COMMAND: tokenCommand('chat', agent, ctx),
        MATRIX_HOMESERVER_URL: env.matrix.homeserver,
        ...(env.matrix.tom ? { TOM_URL: env.matrix.tom } : {}),
        MATRIX_E2EE_RECOVERY: 'tom',
        // the end-to-end encryption store belongs to one device: a new device gets a new store
        MATRIX_STORE_DIR: join(ctx.paths.dataDir, 'chat', agent, device.deviceId),
        ...common,
      };
    }
    case 'space': {
      const url = env.services.space?.url;
      if (!url) throw notFound('Twake Space server');
      return { TWAKE_SPACE_URL: url, TWAKE_SPACE_TOKEN_COMMAND: tokenCommand('space', undefined, ctx), TWAKE_SPACE_OIDC_ISSUER: env.oidc.issuer, ...common };
    }
    case 'project': {
      const url = env.services.project?.url;
      if (!url) throw notFound('Twake Project server');
      return { TWAKE_PROJECT_URL: url, TWAKE_PROJECT_TOKEN_COMMAND: tokenCommand('project', undefined, ctx), TWAKE_PROJECT_OIDC_ISSUER: env.oidc.issuer, ...common };
    }
  }
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/catalog.test.ts && npx tsc --noEmit`
Expected : 8 tests PASS (7 sous Windows), `tsc` sans erreur.

- [ ] **Step 5 : commit**

```bash
git add src/catalog.ts tests/catalog.test.ts
git commit -m "feat: catalog of the six MCP servers and their environment"
```

---

### Task 3 : installation dans le préfixe privé

**Files:**
- Create: `src/installer.ts`, `tests/helpers/fake-mcp.ts`
- Test: `tests/installer.test.ts`

**Interfaces:**
- Consumes : `CATALOG` (tâche 2), `ServiceId`, `AppPaths`, `TwakeAiError`.
- Produces :
  - `type Runner = (command: string, args: string[]) => Promise<void>`
  - `prefixDir(paths): string`
  - `installedVersion(paths, packageName): Promise<string | undefined>`
  - `entryPoint(paths, service): Promise<string>` : `unsupported` si le paquet n'est pas installé
  - `ensureInstalled(paths, services: ServiceId[], deps: { run?: Runner; print(line: string): void }): Promise<string[]>` (renvoie ce qui a été installé)
  - (test) `installFakeMcp(paths, service, script?: string): Promise<void>`, `fakeNpm(paths): Runner & { calls: string[][] }`

- [ ] **Step 1 : écrire le faux MCP et le test qui échoue**

`tests/helpers/fake-mcp.ts` :

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CATALOG } from '../../src/catalog.js';
import type { ServiceId } from '../../src/broker.js';
import { prefixDir, type Runner } from '../../src/installer.js';
import type { AppPaths } from '../../src/paths.js';

/**
 * A stdio MCP server speaking newline-delimited JSON-RPC: it answers initialize, asks the client
 * for approval (elicitation/create) on tools/call and then reports the environment it was given;
 * method "quit" exits with params.code.
 */
export const FAKE_MCP = `import { createInterface } from 'node:readline';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
let pending;
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } });
  }
  if (message.method === 'tools/call') {
    pending = message.id;
    return send({ jsonrpc: '2.0', id: 'approval-1', method: 'elicitation/create', params: { message: 'Do it?', requestedSchema: { type: 'object', properties: {} } } });
  }
  if (message.id === 'approval-1') {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(JMAP|DAV|TWAKE|MATRIX|TOM|USER)_/.test(key)));
    return send({ jsonrpc: '2.0', id: pending, result: { content: [{ type: 'text', text: JSON.stringify({ action: message.result.action, env }) }] } });
  }
  if (message.method === 'quit') process.exit(message.params.code);
});
rl.on('close', () => process.exit(0));
`;

/** Puts a package that looks like the pinned MCP server of `service` in the private prefix. */
export async function installFakeMcp(paths: AppPaths, service: ServiceId, script = FAKE_MCP, version = CATALOG[service].version): Promise<void> {
  const pkg = CATALOG[service];
  const dir = join(prefixDir(paths), 'node_modules', pkg.name);
  await mkdir(join(dir, 'build'), { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: pkg.name, version, type: 'module', bin: { [pkg.name]: 'build/index.js' } }));
  await writeFile(join(dir, 'build', 'index.js'), script);
}

/** An npm that records its arguments and "installs" fake packages. */
export function fakeNpm(paths: AppPaths): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (_command: string, args: string[]) => {
    calls.push(args);
    for (const spec of args.filter((arg) => arg.startsWith('mcp-twake-'))) {
      const service = (Object.keys(CATALOG) as ServiceId[]).find((s) => spec.startsWith(`${CATALOG[s].name}@`));
      if (service) await installFakeMcp(paths, service, FAKE_MCP, spec.split('@')[1]);
    }
  }) as Runner & { calls: string[][] };
  run.calls = calls;
  return run;
}
```

`tests/installer.test.ts` :

```ts
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureInstalled, entryPoint, installedVersion, prefixDir } from '../src/installer.js';
import { fakeNpm, installFakeMcp } from './helpers/fake-mcp.js';
import { tempPaths } from './helpers/tmp.js';

describe('ensureInstalled', () => {
  it('installs the missing servers at their pinned versions, allowing the sqlite3 build of mcp-twake-chat', async () => {
    const { paths } = await tempPaths();
    const npm = fakeNpm(paths);
    const lines: string[] = [];
    expect(await ensureInstalled(paths, ['mail', 'chat', 'mail'], { run: npm, print: (line) => lines.push(line) })).toEqual([
      'mcp-twake-mail@4.1.0',
      'mcp-twake-chat@0.6.0',
    ]);
    expect(npm.calls).toEqual([
      ['install', '--prefix', prefixDir(paths), '--no-audit', '--no-fund', '--save-exact', '--allow-scripts=sqlite3', 'mcp-twake-mail@4.1.0', 'mcp-twake-chat@0.6.0'],
    ]);
    expect(lines.join('\n')).toContain('mcp-twake-chat@0.6.0');
    expect(await installedVersion(paths, 'mcp-twake-chat')).toBe('0.6.0');
  });

  it('does nothing when everything is installed, and replaces another version', async () => {
    const { paths } = await tempPaths();
    await installFakeMcp(paths, 'mail');
    await installFakeMcp(paths, 'dav', undefined, '4.0.0');
    const npm = fakeNpm(paths);
    expect(await ensureInstalled(paths, ['mail', 'dav'], { run: npm, print: () => undefined })).toEqual(['mcp-twake-dav@4.2.0']);
    expect(await ensureInstalled(paths, ['mail', 'dav'], { run: npm, print: () => undefined })).toEqual([]);
    expect(npm.calls).toHaveLength(1);
  });
});

describe('entryPoint', () => {
  it("resolves the package's command", async () => {
    const { paths } = await tempPaths();
    await installFakeMcp(paths, 'project');
    expect(await entryPoint(paths, 'project')).toBe(join(prefixDir(paths), 'node_modules', 'mcp-twake-project', 'build', 'index.js'));
  });

  it('says how to install a missing server', async () => {
    const { paths } = await tempPaths();
    await expect(entryPoint(paths, 'space')).rejects.toMatchObject({ code: 'unsupported', message: expect.stringContaining('mcp-twake-space') });
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/installer.test.ts`
Expected : FAIL, module `../src/installer.js` introuvable.

- [ ] **Step 3 : écrire `src/installer.ts`**

```ts
import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServiceId } from './broker.js';
import { CATALOG } from './catalog.js';
import { TwakeAiError } from './errors.js';
import type { AppPaths } from './paths.js';

export type Runner = (command: string, args: string[]) => Promise<void>;

/** The private prefix the pinned MCP servers are installed into: agents start them from there, never through npx. */
export function prefixDir(paths: AppPaths): string {
  return join(paths.dataDir, 'prefix');
}

const packageDir = (paths: AppPaths, name: string) => join(prefixDir(paths), 'node_modules', name);

export async function installedVersion(paths: AppPaths, name: string): Promise<string | undefined> {
  try {
    return (JSON.parse(await readFile(join(packageDir(paths, name), 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/** The JS file that starts an installed MCP server: its package's bin. */
export async function entryPoint(paths: AppPaths, service: ServiceId): Promise<string> {
  const pkg = CATALOG[service];
  let manifest: { bin?: string | Record<string, string> };
  try {
    manifest = JSON.parse(await readFile(join(packageDir(paths, pkg.name), 'package.json'), 'utf8')) as typeof manifest;
  } catch {
    throw new TwakeAiError('unsupported', `${pkg.name} is not installed for twake-ai: run \`twake-ai export --agent <id>\`.`);
  }
  const bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin?.[pkg.name] ?? Object.values(manifest.bin ?? {})[0]);
  if (!bin) throw new TwakeAiError('bad_response', `${pkg.name} declares no command to start.`);
  return join(packageDir(paths, pkg.name), bin);
}

const npmRunner: Runner = (command, args) =>
  new Promise((resolve, reject) => {
    // npm is npm.cmd on Windows, which Node only starts through a shell
    execFile(command, args, { shell: process.platform === 'win32', maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail = String(stderr).trim().split('\n').at(-1) || error.message;
      reject(new TwakeAiError('unavailable', `npm could not install the Twake.ai MCP servers: ${detail}`));
    });
  });

/** Installs the pinned servers that are missing or at another version, and says what it installed. */
export async function ensureInstalled(paths: AppPaths, services: ServiceId[], deps: { run?: Runner; print(line: string): void }): Promise<string[]> {
  const missing: string[] = [];
  for (const service of [...new Set(services)]) {
    const pkg = CATALOG[service];
    if ((await installedVersion(paths, pkg.name)) !== pkg.version) missing.push(`${pkg.name}@${pkg.version}`);
  }
  if (missing.length === 0) return [];
  const prefix = prefixDir(paths);
  await mkdir(prefix, { recursive: true });
  deps.print(`Installing ${missing.join(', ')}…`);
  const windows = process.platform === 'win32';
  await (deps.run ?? npmRunner)(windows ? 'npm.cmd' : 'npm', [
    'install',
    '--prefix',
    windows ? `"${prefix}"` : prefix,
    '--no-audit',
    '--no-fund',
    '--save-exact',
    // npm 11 blocks install scripts; mcp-twake-chat needs the one of sqlite3 (its native module)
    '--allow-scripts=sqlite3',
    ...missing,
  ]);
  return missing;
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/installer.test.ts && npx tsc --noEmit`
Expected : 4 tests PASS, `tsc` sans erreur.

- [ ] **Step 5 : commit**

```bash
git add src/installer.ts tests/helpers/fake-mcp.ts tests/installer.test.ts
git commit -m "feat: install the pinned MCP servers into the private prefix"
```

---

### Task 4 : lanceur `twake-ai run`

**Files:**
- Create: `src/launcher.ts`
- Modify: `src/cli.ts` (commande `run`, dépendances `nodePath` et `cliPath`)
- Test: `tests/launcher.test.ts`, `tests/cli.test.ts` (`testDeps` complété)

**Interfaces:**
- Consumes : `serviceEnv`, `CatalogContext`, `detectLanguage`, `systemTimezone`, `CATALOG` (tâche 2) ; `entryPoint` (tâche 3) ; `loadConfig`, `checkAgentId`, `isServiceId`.
- Produces :
  - `interface LaunchDeps { paths: AppPaths; env: NodeJS.ProcessEnv; nodePath: string; cliPath: string; language: 'en' | 'fr'; timezone: string }`
  - `runService(service: ServiceId, agent: string, deps: LaunchDeps): Promise<number>` (le code de sortie du MCP)
  - `CliDeps.nodePath: string`, `CliDeps.cliPath: string`
  - commande `twake-ai run <service> --agent <id>`

- [ ] **Step 1 : écrire le test qui échoue**

`tests/launcher.test.ts` :

```ts
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { saveConfig, type TwakeAiConfig } from '../src/config.js';
import { installFakeMcp } from './helpers/fake-mcp.js';
import { tempPaths } from './helpers/tmp.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const running: ChildProcessWithoutNullStreams[] = [];
afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL');
});

const config: TwakeAiConfig = {
  version: 1,
  email: 'jdoe@linagora.com',
  vault: 'file',
  oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
  environment: {
    domain: 'linagora.com',
    oidc: { issuer: 'https://sso.linagora.com', authorization_endpoint: 'https://sso.linagora.com/a', token_endpoint: 'https://sso.linagora.com/t', userinfo_endpoint: 'https://sso.linagora.com/u' },
    matrix: { homeserver: 'https://matrix.linagora.com/' },
    services: { mail: { url: 'https://jmap.linagora.com/jmap/session', source: 'discovered' } },
    cozy: {},
  },
};

/** `twake-ai run …` as an agent starts it, with a JSON-RPC client on its stdio. */
async function launch(args: string[], env: Record<string, string> = {}) {
  const { root, paths } = await tempPaths();
  await saveConfig(paths, config);
  await installFakeMcp(paths, 'mail');
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'run', ...args], {
    cwd: repoRoot,
    env: { ...process.env, TWAKE_AI_HOME: root, LANG: 'en_US.UTF-8', ...env },
  });
  running.push(child);
  const lines: unknown[] = [];
  const waiting: ((message: unknown) => void)[] = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as unknown;
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else lines.push(message);
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    send: (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`),
    next: () => new Promise<any>((resolve) => (lines.length ? resolve(lines.shift()) : waiting.push(resolve))),
    close: () => child.stdin.end(),
    exited,
    stderr: () => stderr,
  };
}

describe('twake-ai run', () => {
  it('starts the server with its environment and lets the approval request go both ways', { timeout: 30_000 }, async () => {
    const mcp = await launch(['mail', '--agent', 'claude-code']);
    mcp.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: { name: 'test', version: '1' } } });
    expect((await mcp.next()).result.serverInfo.name).toBe('fake');
    mcp.send({ id: 2, method: 'tools/call', params: { name: 'send_email', arguments: {} } });
    const approval = await mcp.next();
    expect(approval).toMatchObject({ id: 'approval-1', method: 'elicitation/create' });
    mcp.send({ id: 'approval-1', result: { action: 'accept', content: {} } });
    const result = JSON.parse((await mcp.next()).result.content[0].text) as { action: string; env: Record<string, string> };
    expect(result.action).toBe('accept');
    expect(result.env).toMatchObject({
      JMAP_SESSION_URL: 'https://jmap.linagora.com/jmap/session',
      JMAP_AUTH_METHOD: 'command',
      JMAP_TOKEN_COMMAND: expect.stringContaining("'token' 'mail'"),
      USER_LANGUAGE: 'en',
    });
    mcp.close();
    expect(await mcp.exited).toBe(0);
    expect(mcp.stderr()).toBe('');
  });

  it("keeps what the agent's environment already sets", { timeout: 30_000 }, async () => {
    const mcp = await launch(['mail', '--agent', 'claude-code'], { USER_LANGUAGE: 'fr', JMAP_SESSION_URL: 'https://jmap.example.org/session' });
    mcp.send({ id: 1, method: 'tools/call', params: { name: 'x', arguments: {} } });
    await mcp.next();
    mcp.send({ id: 'approval-1', result: { action: 'decline' } });
    const { env } = JSON.parse((await mcp.next()).result.content[0].text) as { env: Record<string, string> };
    expect(env.USER_LANGUAGE).toBe('fr');
    expect(env.JMAP_SESSION_URL).toBe('https://jmap.example.org/session');
    mcp.close();
    await mcp.exited;
  });

  it('exits with the code of the server', { timeout: 30_000 }, async () => {
    const mcp = await launch(['mail', '--agent', 'claude-code']);
    mcp.send({ method: 'quit', params: { code: 3 } });
    expect(await mcp.exited).toBe(3);
  });

  it('says on stderr, never on stdout, what is missing', { timeout: 30_000 }, async () => {
    const mcp = await launch(['space', '--agent', 'claude-code']);
    expect(await mcp.exited).toBe(1);
    expect(mcp.stderr()).toMatch(/^twake-ai: No Twake Space server was found/);
  });
});
```

Dans `tests/cli.test.ts`, ajouter à l'objet renvoyé par `testDeps()`, après `readLine: async () => '',` :

```ts
    nodePath: '/usr/bin/node',
    cliPath: '/opt/twake-ai/build/bin.js',
```

et à la fin du fichier :

```ts
describe('main: run', () => {
  it('needs a service and an agent', async () => {
    for (const argv of [['run'], ['run', 'mail'], ['run', 'calendar', '--agent', 'hermes'], ['run', 'mail', '--agent', '../x']]) {
      const io = captureIo();
      expect(await main(argv, io, await testDeps())).toBe(2);
      expect(io.out).toBe('');
    }
  });
});
```

- [ ] **Step 2 : lancer les tests pour les voir échouer**

Run : `npx vitest run tests/launcher.test.ts tests/cli.test.ts`
Expected : FAIL. `run` est une commande inconnue (usage, code 2) et le faux MCP ne démarre jamais.

- [ ] **Step 3 : écrire `src/launcher.ts`**

```ts
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import type { ServiceId } from './broker.js';
import { CATALOG, serviceEnv } from './catalog.js';
import { loadConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { checkAgentId } from './grants.js';
import { entryPoint } from './installer.js';
import type { AppPaths } from './paths.js';

export interface LaunchDeps {
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  nodePath: string;
  cliPath: string;
  language: 'en' | 'fr';
  timezone: string;
}

/**
 * Starts one MCP server for one agent. Its stdio is the agent's (inherited, so approval requests go both ways untouched);
 * signals are passed on, and its exit code becomes ours. Nothing is ever written to stdout here: that is the MCP channel.
 */
export async function runService(service: ServiceId, agent: string, deps: LaunchDeps): Promise<number> {
  checkAgentId(agent);
  const config = await loadConfig(deps.paths);
  if (!config) throw new TwakeAiError('login_required', 'twake-ai is not set up on this computer: run `twake-ai login --email <address>`.');
  const built = serviceEnv(service, agent, { config, paths: deps.paths, nodePath: deps.nodePath, cliPath: deps.cliPath, language: deps.language, timezone: deps.timezone });
  // what the agent's environment already sets wins (spec §9)
  const env = { ...built, ...deps.env };
  const entry = await entryPoint(deps.paths, service);
  return new Promise((resolve, reject) => {
    const child = spawn(deps.nodePath, [entry], { stdio: 'inherit', env });
    const forwarded = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => [signal, () => child.kill(signal)] as const);
    for (const [signal, handler] of forwarded) process.on(signal, handler);
    const cleanup = () => {
      for (const [signal, handler] of forwarded) process.off(signal, handler);
    };
    child.once('error', (error) => {
      cleanup();
      reject(new TwakeAiError('unavailable', `Cannot start ${CATALOG[service].name}: ${error.message}`));
    });
    child.once('exit', (code, signal) => {
      cleanup();
      resolve(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
  });
}
```

- [ ] **Step 4 : brancher `run` dans `src/cli.ts`**

1. Imports, ajouter :

```ts
import { fileURLToPath } from 'node:url';
import { detectLanguage, systemTimezone } from './catalog.js';
import { runService } from './launcher.js';
```

2. Dans `interface CliDeps`, ajouter :

```ts
  /** absolute paths of node and of twake-ai's command, written into agent configurations and token commands */
  nodePath: string;
  cliPath: string;
```

et dans `defaultDeps()` :

```ts
    nodePath: process.execPath,
    cliPath: fileURLToPath(new URL('./bin.js', import.meta.url)),
```

3. Dans `USAGE`, ajouter la ligne `  twake-ai run <${SERVICE_IDS.join('|')}> --agent <id>` juste avant `  twake-ai --version`.

4. Dans le `switch (command)` de `main`, ajouter avant `default:` :

```ts
      case 'run':
        return await runCommand(args, deps);
```

5. Ajouter après `tokenCommand` :

```ts
/** run <service> --agent <id>: what agent configurations start. stdout belongs to the MCP server. */
async function runCommand(args: string[], d: CliDeps): Promise<number> {
  const { positionals, values } = usageErrors(() =>
    parseArgs({ args, options: { agent: { type: 'string' } }, allowPositionals: true, strict: true }),
  );
  const [service, ...extra] = positionals;
  if (!service || !isServiceId(service) || extra.length > 0 || values.agent === undefined) throw new TwakeAiError('usage', USAGE);
  checkAgentId(values.agent);
  return runService(service, values.agent, {
    paths: d.paths,
    env: d.env,
    nodePath: d.nodePath,
    cliPath: d.cliPath,
    language: detectLanguage(d.env),
    timezone: systemTimezone(),
  });
}
```

- [ ] **Step 5 : lancer les tests**

Run : `npm test && npx tsc --noEmit`
Expected : toute la suite PASS (4 tests lanceur, 1 test CLI de plus), `tsc` sans erreur.

- [ ] **Step 6 : commit**

```bash
git add src/launcher.ts src/cli.ts tests/launcher.test.ts tests/cli.test.ts
git commit -m "feat: twake-ai run starts an MCP server with its environment"
```

---

### Task 5 : `twake-ai export`

**Files:**
- Create: `src/exporter.ts`
- Modify: `src/cli.ts` (commande `export`, dépendance `runInstall`), `README.md`, `package.json` (dépendances `yaml`, `smol-toml`)
- Test: `tests/exporter.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes : tâches 2 à 4 ; `loginChat` (plan 2) ; `shellQuote`.
- Produces :
  - `interface ServerEntry { command: string; args: string[]; env: Record<string, string> }`
  - `interface ExportOptions { agent: string; services: ServiceId[]; raw: boolean }`
  - `serverEntry(service, agent, raw, ctx): Promise<ServerEntry>`
  - `exportFiles(options, ctx): Promise<Record<string, string>>`
  - `writeExport(dir: string, files: Record<string, string>): Promise<void>`
  - `defaultServices(config): ServiceId[]`
  - `CliDeps.runInstall?: Runner`
  - commande `twake-ai export --agent <id> [--services a,b] [--raw] [--out <dir>] [--no-browser]`

- [ ] **Step 1 : installer les bibliothèques**

Run : `npm install yaml@^2.9.1 smol-toml@^1.9.1`
Expected : `package.json` les liste dans `dependencies`.

- [ ] **Step 2 : écrire les tests qui échouent**

`tests/exporter.test.ts` :

```ts
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { CatalogContext } from '../src/catalog.js';
import type { TwakeAiConfig } from '../src/config.js';
import { defaultServices, exportFiles, writeExport } from '../src/exporter.js';
import { prefixDir } from '../src/installer.js';
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
    expect(files['mail.env']).toContain(`JMAP_SESSION_URL="https://jmap.linagora.com/jmap/session"`);
    expect(files['chat.env']).toContain(`MATRIX_TOKEN_COMMAND="'/usr/bin/node' '/opt/twake-ai/build/bin.js' 'token' 'chat' '--agent' 'zed'"`);
    expect(files['README.md']).toContain('mcpServers.json');
  });

  it('gives the servers and their full environment with --raw', async () => {
    const ctx = await context();
    const files = await exportFiles({ agent: 'zed', services: ['project'], raw: true }, ctx);
    const entry = JSON.parse(files['mcpServers.json']!).mcpServers['twake-project'];
    expect(entry.args).toEqual([join(prefixDir(ctx.paths), 'node_modules', 'mcp-twake-project', 'build', 'index.js')]);
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
```

Dans `tests/cli.test.ts`, ajouter `import { fakeNpm } from './helpers/fake-mcp.js';` et, dans le `describe('main: Twake Drive and Twake Chat', …)`, avant le dernier `});` du bloc :

```ts
  it('exports for an agent, creating its Chat device and installing the servers first', async () => {
    const deps = await signedIn();
    const npm = fakeNpm(deps.paths);
    deps.runInstall = npm;
    const out = join(deps.paths.dataDir, '..', 'export');
    const io = captureIo();
    expect(await main(['export', '--agent', 'zed', '--services', 'chat', '--out', out], io, deps)).toBe(0);
    expect(io.out).toContain('Twake Chat connected for zed');
    expect(npm.calls[0]).toContain('mcp-twake-chat@0.6.0');
    const servers = JSON.parse(await readFile(join(out, 'mcpServers.json'), 'utf8')).mcpServers;
    expect(servers['twake-chat'].args).toEqual(['/opt/twake-ai/build/bin.js', 'run', 'chat', '--agent', 'zed']);
    expect(io.out).toContain(out);
  });

  it('refuses an unknown service in --services', async () => {
    const io = captureIo();
    expect(await main(['export', '--agent', 'zed', '--services', 'mail,calendar'], io, await signedIn())).toBe(2);
  });
```

et `import { readFile } from 'node:fs/promises';` ainsi que `import { join } from 'node:path';` aux imports s'ils n'y sont pas.

- [ ] **Step 3 : lancer les tests pour les voir échouer**

Run : `npx vitest run tests/exporter.test.ts tests/cli.test.ts`
Expected : FAIL, module `../src/exporter.js` introuvable, et `export` est une commande inconnue.

- [ ] **Step 4 : écrire `src/exporter.ts`**

````ts
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify as stringifyToml } from 'smol-toml';
import { stringify as stringifyYaml } from 'yaml';
import type { ServiceId } from './broker.js';
import { CATALOG, entryName, HERMES_APPROVAL_TIMEOUT_MS, hermesEntryName, serviceEnv, shellQuote, type CatalogContext } from './catalog.js';
import type { TwakeAiConfig } from './config.js';
import { entryPoint } from './installer.js';

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ExportOptions {
  agent: string;
  services: ServiceId[];
  /** the MCP servers themselves with their full environment, instead of `twake-ai run` */
  raw: boolean;
}

/** What an agent starts for one service. The environment is built in both cases, so a missing connection fails here. */
export async function serverEntry(service: ServiceId, agent: string, raw: boolean, ctx: CatalogContext): Promise<ServerEntry> {
  const env = serviceEnv(service, agent, ctx);
  if (!raw) return { command: ctx.nodePath, args: [ctx.cliPath, 'run', service, '--agent', agent], env: {} };
  return { command: ctx.nodePath, args: [await entryPoint(ctx.paths, service)], env };
}

/** The services worth exporting: those found for the domain, Drive once connected, and Chat (its device is created on export). */
export function defaultServices(config: TwakeAiConfig): ServiceId[] {
  const found = config.environment.services;
  return (['mail', 'dav', 'drive', 'chat', 'space', 'project'] as const).filter((service) => {
    if (service === 'drive') return config.drive !== undefined;
    if (service === 'chat') return true;
    return found[service] !== undefined;
  });
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const withEnv = (entry: ServerEntry, env: Record<string, string> = entry.env) => ({
  command: entry.command,
  args: entry.args,
  ...(Object.keys(env).length ? { env } : {}),
});
const envFile = (env: Record<string, string>) =>
  Object.entries(env)
    .map(([key, value]) => `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)
    .join('\n') + '\n';

/** Every file of the export, by name. Nothing secret: tokens only ever come from `twake-ai token`. */
export async function exportFiles(options: ExportOptions, ctx: CatalogContext): Promise<Record<string, string>> {
  const entries = new Map<ServiceId, ServerEntry>();
  for (const service of options.services) entries.set(service, await serverEntry(service, options.agent, options.raw, ctx));
  const byName = <T>(name: (service: ServiceId) => string, shape: (entry: ServerEntry, service: ServiceId) => T) =>
    Object.fromEntries([...entries].map(([service, entry]) => [name(service), shape(entry, service)]));
  const files: Record<string, string> = {
    'mcpServers.json': json({ mcpServers: byName(entryName, (entry) => withEnv(entry)) }),
    'vscode-mcp.json': json({ servers: byName(entryName, (entry) => ({ type: 'stdio', ...withEnv(entry) })) }),
    'hermes.yaml': stringifyYaml({
      mcp_servers: byName(hermesEntryName, (entry, service) => ({
        ...withEnv(entry, { ...entry.env, [`${CATALOG[service].approval}_APPROVAL_TIMEOUT_MS`]: HERMES_APPROVAL_TIMEOUT_MS }),
        timeout: 420,
        elicitation: { enabled: true, timeout: 300 },
      })),
    }),
    'codex.toml': stringifyToml({ mcp_servers: byName(entryName, (entry) => withEnv(entry)) }),
    'claude-code.sh': [
      '#!/bin/sh',
      '# Adds the Twake.ai MCP servers to Claude Code (user scope). Generated by twake-ai export.',
      'set -e',
      ...[...entries].map(([service, entry]) => `claude mcp add-json --scope user ${entryName(service)} ${shellQuote(JSON.stringify({ type: 'stdio', ...withEnv(entry) }))}`),
      '',
    ].join('\n'),
    'commands.txt': [...entries]
      .map(([service, entry]) => `# ${entryName(service)} (environment: ${service}.env)\n${[entry.command, ...entry.args].map(shellQuote).join(' ')}\n`)
      .join('\n'),
    'README.md': readme(options),
  };
  for (const service of options.services) files[`${service}.env`] = envFile(serviceEnv(service, options.agent, ctx));
  return files;
}

export async function writeExport(dir: string, files: Record<string, string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
    if (name.endsWith('.sh')) await chmod(join(dir, name), 0o755);
  }
}

function readme(options: ExportOptions): string {
  return `# Twake.ai MCP servers for "${options.agent}"

Generated by \`twake-ai export\`. ${options.raw ? 'Each entry starts an MCP server with its full environment.' : 'Each entry starts `twake-ai run <service> --agent ' + options.agent + '`, which builds the environment itself.'} No file holds a secret: the servers get their tokens from \`twake-ai token\`.

| File | For |
|---|---|
| \`mcpServers.json\` | Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI…: merge into their \`mcpServers\` |
| \`vscode-mcp.json\` | VS Code: merge into the \`servers\` of your user \`mcp.json\` |
| \`hermes.yaml\` | Hermes Agent: merge into \`mcp_servers\` of \`~/.hermes/config.yaml\` |
| \`codex.toml\` | Codex CLI: append to \`~/.codex/config.toml\` |
| \`claude-code.sh\` | Claude Code: run it once |
| \`<service>.env\`, \`commands.txt\` | anything else: the command, its arguments and its environment |

- **Approvals:** every write is approved by you first, through MCP elicitation. In an agent without elicitation, reads work and writes are refused. Set \`<PREFIX>_APPROVAL=client\` only if the agent itself asks you to confirm every write tool.
- **Hermes:** keep \`timeout: 420\` and \`elicitation.timeout: 300\`; the servers wait 330 s for your answer.
- **Twake Chat:** this export uses the device of "${options.agent}". Use another \`--agent\` for every other agent: one encryption device cannot run in two agents at once.
- **Paths:** the commands use absolute paths, because some agents do not see your \`PATH\`. Export again after moving Node.js.
- **Windows:** the Twake.ai MCP servers run their token command through \`/bin/sh\` for now, so these entries work on Linux and macOS only.
`;
}
````

- [ ] **Step 5 : brancher `export` dans `src/cli.ts`**

1. Imports, ajouter :

```ts
import { defaultServices, exportFiles, writeExport } from './exporter.js';
import { ensureInstalled, type Runner } from './installer.js';
import { resolve as resolvePath } from 'node:path';
```

2. Dans `interface CliDeps`, ajouter `runInstall?: Runner;` (npm, remplaçable en test).

3. Dans `USAGE`, ajouter avant `  twake-ai --version` :

```
  twake-ai export --agent <id> [--services <list>] [--raw] [--out <dir>] [--no-browser]
```

4. Dans le `switch (command)` de `main`, ajouter avant `default:` :

```ts
      case 'export':
        return await exportCommand(args, io, deps);
```

5. Ajouter après `runCommand` :

```ts
/** export --agent <id>: the configuration files for any agent, after installing the servers they start. */
async function exportCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({
      args,
      options: { agent: { type: 'string' }, services: { type: 'string' }, raw: { type: 'boolean' }, out: { type: 'string' }, 'no-browser': { type: 'boolean' } },
      strict: true,
    }),
  );
  if (values.agent === undefined) throw new TwakeAiError('usage', `export needs --agent <id>: the agent these files are for.\n\n${USAGE}`);
  const agent = checkAgentId(values.agent);
  let config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'Sign in first: run `twake-ai login --email <address>`.');
  const services = values.services === undefined ? defaultServices(config) : values.services.split(',').map((s) => s.trim());
  for (const service of services) {
    if (!isServiceId(service)) throw new TwakeAiError('usage', `"${service}" is not a Twake.ai service (${SERVICE_IDS.join(', ')}).\n\n${USAGE}`);
  }
  const chosen = services as ServiceId[];
  if (chosen.includes('chat') && !config.chat?.[agent]) {
    // later, the token command runs inside the MCP server and cannot open a browser: the device is created now
    await connectService({ chat: true, agent, 'no-browser': values['no-browser'] }, io, d);
    config = (await loadConfig(d.paths)) ?? config;
  }
  const ctx = { config, paths: d.paths, nodePath: d.nodePath, cliPath: d.cliPath, language: detectLanguage(d.env), timezone: systemTimezone() };
  await ensureInstalled(d.paths, chosen, { run: d.runInstall, print: (line) => io.stdout(`${line}\n`) });
  const files = await exportFiles({ agent, services: chosen, raw: values.raw ?? false }, ctx);
  const out = resolvePath(values.out ?? 'twake-ai-export');
  await writeExport(out, files);
  io.stdout(`Wrote ${Object.keys(files).length} files to ${out}: see its README.md.\n`);
  return 0;
}
```

Ajouter `type ServiceId` à l'import depuis `./broker.js` s'il n'y est pas.

- [ ] **Step 6 : lancer tous les tests, la vérification de types et la compilation**

Run : `npm test && npm run typecheck && npm run build`
Expected : toute la suite PASS, `tsc` sans erreur, build OK.

- [ ] **Step 7 : compléter `README.md`** (avant `## Files`)

````markdown
## Any agent: `twake-ai export`

```bash
twake-ai export --agent zed                         # every service found and connected
twake-ai export --agent cursor --services mail,chat --out ./cursor-config
twake-ai export --agent zed --raw                   # the servers and their full environment
```

`export` installs the pinned Twake.ai MCP servers into twake-ai's private folder, creates the agent's Twake Chat device if needed, and writes `mcpServers.json` (Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI…), `vscode-mcp.json`, `hermes.yaml`, `codex.toml`, `claude-code.sh` and one `<service>.env` per service, with a README saying where each goes. By default the entries start `twake-ai run <service> --agent <id>`, which builds the server's environment (URLs, token command, language, time zone); variables already set in the agent's environment win. No file holds a secret.
````

- [ ] **Step 8 : commit**

```bash
git add package.json package-lock.json src/exporter.ts src/cli.ts tests/exporter.test.ts tests/cli.test.ts README.md
git commit -m "feat: twake-ai export writes the configuration files for any agent"
```

---

## Vérification de fin de plan

- [ ] `npm test && npm run typecheck && npm run build` : tout passe.
- [ ] Sur Linux, avec une vraie connexion et le réseau : `node build/bin.js export --agent test --services project --out /tmp/x`, puis `npx @modelcontextprotocol/inspector node build/bin.js run project --agent test`. L'inspecteur liste les 47 outils de mcp-twake-project.
