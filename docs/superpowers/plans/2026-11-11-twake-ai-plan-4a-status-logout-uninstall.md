# mcp-twake-ai, plan 4a : `status`, `logout`, `uninstall` et journal

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** trois commandes d'exploitation.
- `mcp-twake-ai status` dit, pour chaque agent et chaque service, si l'entrée est en place, si l'autorisation fonctionne et si le serveur MCP démarre vraiment (poignée de main `initialize` puis `tools/list`).
- `mcp-twake-ai logout` révoque toutes les autorisations.
- `mcp-twake-ai uninstall` retire tout ce que l'outil a installé.

Un journal `twake-ai.log`, avec les secrets masqués, garde la trace des commandes.

**Architecture:**
- **`src/describe.ts`** : `describeError`, qui sort de `cli.ts`, puisque `status` et `logout` en ont besoin.
- **`src/journal.ts`** : ajout d'une ligne masquée dans `<stateDir>/twake-ai.log`, avec rotation à 1 Mo.
- **`src/status.ts`** : les vérifications.
  - Appels légers : `userinfo` (OIDC), `/settings/instance` (cozy), `/account/whoami` (Matrix).
  - Poignée de main MCP sur la commande même qu'un agent lance.
  - Lecture des entrées d'un agent par rapport aux empreintes.
- **`src/logout.ts`** : révocation OIDC, suppression du client cozy, déconnexion de chaque device Matrix, puis effacement du coffre et du cache. Chaque étape est tentée même si la précédente échoue.
- **`src/uninstall.ts`** : retrait des entrées possédées dans chaque agent, `logout`, suppression du préfixe, des fichiers et, sur demande, des stores Chat.
- **CLI :** `status [--agents <ids>] [--no-start]`, `status --env <service> [--agent <id>]`, `logout`, `uninstall [--yes] [--force] [--delete-chat-stores]`.

**Tech Stack:** celle du plan 3b. Aucune nouvelle dépendance.

**Spec:** `docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md`, sections 7.3 (`logout`), 12.1 à 12.4 (erreurs, `status`, `uninstall`, journal) et 13.2 (de bout en bout). Plan précédent : `docs/superpowers/plans/2026-11-11-twake-ai-plan-3b-agent-adapters.md`.

## Global Constraints

- **Contraintes reprises :** toutes celles des plans 1 à 3b.
- **`status` :**
  - Il ne modifie rien.
  - Il sort avec le code 0 si tout est vert, 1 sinon.
  - Une poignée de main dure au plus 30 s, et le serveur est arrêté juste après.
  - `--no-start` saute les poignées de main.
- **`status --env <service> [--agent <id>]`** affiche l'environnement que `run` construirait, une variable par ligne. Il n'y a aucun secret à masquer : l'environnement ne contient que la commande de jeton.
- **`logout` :**
  - **Étapes**, dans cet ordre, chacune tentée même si une autre échoue :
    1. révocation du refresh token OIDC (`revocation_endpoint`) ;
    2. `DELETE /auth/register/:client_id` sur l'instance Drive ;
    3. `POST /_matrix/client/v3/logout` pour chaque device, après un refresh si le jeton a expiré ;
    4. effacement des clés du coffre et du cache de jetons.
  - **`config.json` ensuite :** il perd `drive` et `chat`, et garde l'email, l'environnement et `agents`, pour qu'un `login` suffise à repartir.
  - **Sortie :** code 1 si une révocation a échoué, et le message nomme ce qui n'a pas pu être révoqué.
- **`uninstall` :**
  - **Sans `--yes`, il n'affiche que le plan.**
  - **Avec `--yes` :**
    1. Il retire les entrées dont l'empreinte correspond. Les autres ne partent qu'avec `--force`.
    2. Il fait le `logout`.
    3. Il supprime `<dataDir>/prefix`, `config.json`, `secrets.json`, le cache et le journal.
  - **Stores Chat** (`<dataDir>/chat`) : supprimés seulement avec `--delete-chat-stores`, puisqu'ils contiennent l'index local des messages. Sinon le récapitulatif dit où ils restent.
- **Journal :**
  - Chaque commande y laisse une ligne, sauf `token` et `run` réussis, appelés en continu par les serveurs.
  - Il reçoit aussi chaque erreur.
  - Sont masqués : les JWT, `Bearer …`, et toute valeur de `access_token`, `refresh_token`, `id_token`, `client_secret`, `registration_access_token`, `code`, `code_verifier`, `device_code`, `loginToken`.
  - Le fichier est en `0600`. Au-delà de 1 Mo, il est renommé en `.1`.
  - Une erreur d'écriture du journal n'arrête jamais une commande.

## Review Focus

- **`logout` avec l'IdP injoignable :** la révocation échoue, mais le device Chat est quand même déconnecté et le coffre effacé ; le récapitulatif nomme l'échec. Test dans la tâche 4.
- **Serveur MCP qui sort tout de suite** (pas de session, `token` en erreur) : `status` affiche la dernière ligne de son stderr, et pas un délai dépassé. Test dans la tâche 2.
- **Entrée modifiée à la main au moment de `uninstall`** : elle reste en place sans `--force`, et le récapitulatif le dit. Test dans la tâche 5.
- **Journal qui reçoit un message contenant un jeton** (erreur HTTP qui recopie un `refresh_token`) : la valeur est masquée. Test dans la tâche 1.
- **`status` sur un agent qui n'est pas installé, ou sans entrée** : la ligne le dit, sans planter. Test dans la tâche 3.

---

### Task 1 : `describeError` partagé et journal masqué

**Files:**
- Create: `src/describe.ts`, `src/journal.ts`
- Modify: `src/cli.ts` (importe `describeError`, journalise chaque commande)
- Test: `tests/journal.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Produces: `describeError(error: unknown): string` ; `journalFile(paths): string`, `mask(text): string`, `journal(paths, line, now?): Promise<void>`, `MAX_JOURNAL_BYTES`.

- [ ] **Step 1: Write the failing tests**

`tests/journal.test.ts` :

```ts
import { readFile, stat, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { journal, journalFile, mask, MAX_JOURNAL_BYTES } from '../src/journal.js';
import { tempPaths } from './helpers/tmp.js';

describe('mask', () => {
  it('hides tokens, codes and secrets, and nothing else', () => {
    expect(mask('POST /token refresh_token=r-123&client_id=twake-ai-agents')).toBe('POST /token refresh_token=***&client_id=twake-ai-agents');
    expect(mask('{"access_token":"eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl","expires_in":300}')).toBe('{"access_token":"***","expires_in":300}');
    expect(mask('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer ***');
    expect(mask('callback ?code=xyz&state=s1')).toBe('callback ?code=***&state=s1');
    expect(mask('client_secret: s3cr3t, registration_access_token: rat')).toBe('client_secret: ***, registration_access_token: ***');
    expect(mask('login --email jdoe@linagora.com')).toBe('login --email jdoe@linagora.com');
  });
});

describe('journal', () => {
  it('appends a private, masked line per call', async () => {
    const { paths } = await tempPaths();
    await journal(paths, 'login: sso.linagora.com refused refresh_token=r-1\nsecond line', new Date('2026-11-11T05:00:00Z'));
    await journal(paths, 'status: ok', new Date('2026-11-11T05:00:01Z'));
    expect(await readFile(journalFile(paths), 'utf8')).toBe(
      '2026-11-11T05:00:00.000Z login: sso.linagora.com refused refresh_token=*** second line\n2026-11-11T05:00:01.000Z status: ok\n',
    );
    if (process.platform !== 'win32') expect((await stat(journalFile(paths))).mode & 0o777).toBe(0o600);
  });

  it('starts a new file past 1 MB, keeping the previous one as .1', async () => {
    const { paths } = await tempPaths();
    await journal(paths, 'first');
    await writeFile(journalFile(paths), 'x'.repeat(MAX_JOURNAL_BYTES + 1));
    await journal(paths, 'after rotation');
    expect((await readFile(journalFile(paths), 'utf8')).endsWith(' after rotation\n')).toBe(true);
    expect((await stat(`${journalFile(paths)}.1`)).size).toBe(MAX_JOURNAL_BYTES + 1);
  });
});
```

`tests/cli.test.ts`, in `describe('main: second sign-in and failures', …)` (add `journalFile` to the imports, from `../src/journal.js`):

```ts
  it('keeps a journal of commands and errors, without tokens', async () => {
    const deps = await testDeps();
    expect(await main(['login', '--email', 'alice@example.com'], captureIo(), deps)).toBe(0);
    expect(await main(['token', 'mail'], captureIo(), deps)).toBe(0);
    idp.tokenFailureStatus = 400;
    await main(['token', 'dav', '--agent', 'x'], captureIo(), deps);
    const text = await readFile(journalFile(deps.paths), 'utf8');
    expect(text).toContain('login --email alice@example.com → 0');
    expect(text).not.toContain('token mail');
    expect(text).toContain('token dav --agent x → 1');
    expect(text).not.toMatch(/access_token|eyJ/);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/journal.test.ts tests/cli.test.ts -t "mask|journal"`
Expected: FAIL, `../src/journal.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/describe.ts` (moved from `cli.ts`, unchanged):

```ts
import { TwakeAiError } from './errors.js';
import { hostOf, HttpError } from './http.js';

/** One line for the user (an MCP server shows only the last line of stderr). Usage errors keep the usage text. */
export function describeError(error: unknown): string {
  if (error instanceof TwakeAiError) return error.message;
  if (error instanceof HttpError) {
    return `${hostOf(error.url)} refused the request (HTTP ${error.status}${error.oauthError ? `, ${error.oauthError}` : ''}).`;
  }
  return `unexpected error: ${String((error as Error)?.message ?? error).split('\n')[0]}`;
}
```

`src/journal.ts` :

```ts
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppPaths } from './paths.js';

export const MAX_JOURNAL_BYTES = 1024 * 1024;

export const journalFile = (paths: AppPaths) => join(paths.stateDir, 'twake-ai.log');

const JWT = /\beyJ[\w-]*\.[\w-]+\.[\w-]+/g;
const BEARER = /\b(Bearer\s+)[\w.~+/=-]+/gi;
const SECRET = /\b(access_token|refresh_token|id_token|client_secret|registration_access_token|code_verifier|device_code|loginToken|code)(["']?\s*[:=]\s*["']?)([^\s"'&,}]+)/g;

/** Hides every token, code or secret a line may carry (spec §12.4). */
export function mask(text: string): string {
  return text.replace(SECRET, '$1$2***').replace(JWT, '***').replace(BEARER, '$1***');
}

/** Appends one masked line to twake-ai.log (private, rotated past 1 MB). The journal never stops a command. */
export async function journal(paths: AppPaths, line: string, now: Date = new Date()): Promise<void> {
  try {
    const file = journalFile(paths);
    await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
    try {
      if ((await stat(file)).size > MAX_JOURNAL_BYTES) await rename(file, `${file}.1`);
    } catch {
      // no journal yet
    }
    await appendFile(file, `${now.toISOString()} ${mask(line).replace(/\s*\n\s*/g, ' ')}\n`, { mode: 0o600 });
  } catch {
    // best effort
  }
}
```

`src/cli.ts` :
- supprimer la fonction `describeError` et l'importer : `import { describeError } from './describe.js';` (retirer `hostOf, HttpError` de l'import de `./http.js` s'ils ne servent plus) ; importer `journal` de `./journal.js` ;
- dans `main`, envelopper l'aiguillage pour journaliser :

```ts
export async function main(argv: string[], io: Io, deps: CliDeps = defaultDeps()): Promise<number> {
  const [command, ...args] = argv;
  let code: number;
  let failure: string | undefined;
  try {
    code = await dispatch(command, args, io, deps);
  } catch (error) {
    failure = describeError(error);
    io.stderr(`mcp-twake-ai: ${failure}\n`);
    code = error instanceof TwakeAiError && error.code === 'usage' ? 2 : 1;
  }
  // token and run are called all day long by the servers: only their failures are worth a line
  if (code !== 0 || (command !== 'token' && command !== 'run')) {
    await journal(deps.paths, `${[command, ...args].join(' ')} → ${code}${failure ? `: ${failure.split('\n')[0]}` : ''}`);
  }
  return code;
}

async function dispatch(command: string | undefined, args: string[], io: Io, deps: CliDeps): Promise<number> {
  switch (command) {
    // … the cases that were in main, unchanged …
  }
}
```

- [ ] **Step 4: Run them to verify they pass, then the whole suite**

Run: `npx vitest run tests/journal.test.ts tests/cli.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/describe.ts src/journal.ts src/cli.ts tests/journal.test.ts tests/cli.test.ts
git commit -m "feat: a journal of commands and errors, secrets masked"
```

---

### Task 2 : vérifications de `status`

**Files:**
- Create: `src/status.ts`
- Modify: `tests/helpers/fake-cozy.ts` (`GET /settings/instance`), `tests/helpers/fake-synapse.ts` (`GET /_matrix/client/v3/account/whoami`)
- Test: `tests/status.test.ts`

**Interfaces:**
- Consumes: `getToken`, `BrokerDeps` (broker) ; `fetchUserinfo` (oidc) ; `requestJson` (http) ; `describeError` (tâche 1) ; `fingerprint` (plan 3b) ; `AgentAdapter`.
- Produces: `Check { ok: boolean; detail: string }` ; `checkSession(d: BrokerDeps): Promise<Check>` ; `checkDrive(d): Promise<Check>` ; `checkChat(d, agent): Promise<Check>` ; `handshake(entry: { command: string; args: string[]; env?: Record<string, string> }, env, timeoutMs = 30_000): Promise<Check>` ; `EntryState { name; service; state: 'ok' | 'missing' | 'modified' | 'foreign' | 'no-node'; entry? }` ; `entryStates(adapter, owned): Promise<EntryState[]>` ; `serviceOfEntry(name): ServiceId | undefined`.

- [ ] **Step 1: Write the failing test**

Fakes : in `tests/helpers/fake-cozy.ts`, before the `/settings/context` route:

```ts
    if (req.method === 'GET' && url.pathname === '/settings/instance') {
      if (!accessTokens.has(bearer)) return json(401, { error: 'unauthorized' });
      return json(200, { data: { type: 'io.cozy.settings', id: 'io.cozy.settings.instance', attributes: { locale: 'fr', public_name: 'Alice' } } });
    }
```

in `tests/helpers/fake-synapse.ts`, before the `logout` route:

```ts
    if (req.method === 'GET' && url.pathname === '/_matrix/client/v3/account/whoami') {
      const device = accessTokens.get(bearer);
      if (!device || expired.has(bearer)) return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token', soft_logout: true });
      return json(200, { user_id: '@alice:example.com', device_id: device });
    }
```

`tests/status.test.ts` :

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorAgent } from '../src/agents/json-config.js';
import { fingerprint } from '../src/agents/entries.js';
import { entryStates, handshake, serviceOfEntry } from '../src/status.js';
import { tempDir } from './helpers/tmp.js';

const HELLO = `const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  const send = (x) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...x }) + '\\n');
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'hello', version: '1' } } });
  if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'a' }, { name: 'b' }] } });
});`;

async function script(text: string): Promise<string> {
  const file = join(await tempDir(), 'server.cjs');
  await writeFile(file, text);
  return file;
}

describe('handshake', () => {
  it('starts the server, lists its tools, and stops it', async () => {
    expect(await handshake({ command: process.execPath, args: [await script(HELLO)] }, process.env)).toEqual({ ok: true, detail: '2 tools' });
  });

  it('reports the last line of stderr when the server stops at once', async () => {
    const dying = await script("process.stderr.write('starting\\ntoken command failed: No Twake session on this computer\\n'); process.exit(1);");
    expect(await handshake({ command: process.execPath, args: [dying] }, process.env)).toEqual({ ok: false, detail: 'token command failed: No Twake session on this computer' });
  });

  it('gives up on a server that never answers', async () => {
    const mute = await script('setInterval(() => {}, 1000);');
    expect(await handshake({ command: process.execPath, args: [mute] }, process.env, 300)).toEqual({ ok: false, detail: 'no answer within 0.3 s' });
  });

  it('reports a command that cannot start', async () => {
    const check = await handshake({ command: join(await tempDir(), 'no-node'), args: [] }, process.env);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/ENOENT/);
  });
});

describe('entryStates', () => {
  it('compares each entry with what mcp-twake-ai wrote, and checks its node', async () => {
    const home = await tempDir();
    await mkdir(join(home, '.cursor'));
    const cursor = cursorAgent({ platform: process.platform, env: {}, home }, () => new Date());
    const mine = (service: string) => ({ type: 'stdio', command: process.execPath, args: ['/cli.js', 'run', service, '--agent', 'cursor'] });
    await writeFile(
      cursor.target,
      JSON.stringify({
        mcpServers: {
          'twake-mail': mine('mail'),
          'twake-dav': { ...mine('dav'), args: ['edited'] },
          'twake-drive': { command: join(home, 'gone', 'node'), args: [] },
          'twake-space': { command: 'my-space' },
        },
      }),
    );
    const owned = { 'twake-mail': fingerprint(mine('mail')), 'twake-dav': fingerprint(mine('dav')), 'twake-drive': fingerprint({ command: join(home, 'gone', 'node'), args: [] }), 'twake-chat': 'abc' };
    expect((await entryStates(cursor, owned)).map((e) => [e.name, e.service, e.state])).toEqual([
      ['twake-chat', 'chat', 'missing'],
      ['twake-dav', 'dav', 'modified'],
      ['twake-drive', 'drive', 'no-node'],
      ['twake-mail', 'mail', 'ok'],
      ['twake-space', 'space', 'foreign'],
    ]);
    expect(serviceOfEntry('twake_project')).toBe('project');
    expect(serviceOfEntry('github')).toBeUndefined();
  });
});
```

Les tests de `checkSession`, `checkDrive` et `checkChat` passent par la CLI, contre les faux serveurs (tâche 3).

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/status.test.ts`
Expected: FAIL, `../src/status.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/status.ts` :

```ts
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { fingerprint } from './agents/entries.js';
import type { AgentAdapter, Entry } from './agents/types.js';
import { getToken, isServiceId, type BrokerDeps, type ServiceId } from './broker.js';
import { describeError } from './describe.js';
import { requestJson } from './http.js';
import { fetchUserinfo } from './oidc.js';

export interface Check {
  ok: boolean;
  detail: string;
}

const failed = (error: unknown): Check => ({ ok: false, detail: describeError(error) });

/** The Twake session: a token, then userinfo (spec §12.2). */
export async function checkSession(d: BrokerDeps): Promise<Check> {
  try {
    const token = await getToken('mail', d);
    const info = await fetchUserinfo(d.config.environment.oidc, token.access_token, d.http);
    return { ok: true, detail: String(info.email ?? info.sub ?? d.config.email) };
  } catch (error) {
    return failed(error);
  }
}

/** Twake Drive: a token, then /settings/instance. */
export async function checkDrive(d: BrokerDeps): Promise<Check> {
  try {
    const token = await getToken('drive', d);
    const instance = d.config.environment.cozy.instance ?? '';
    await requestJson(`${instance.replace(/\/$/, '')}/settings/instance`, { headers: { authorization: `Bearer ${token.access_token}` } }, d.http);
    return { ok: true, detail: instance };
  } catch (error) {
    return failed(error);
  }
}

/** The Twake Chat device of one agent: a token, then /account/whoami. */
export async function checkChat(d: BrokerDeps, agent: string): Promise<Check> {
  try {
    const token = await getToken('chat', d, agent);
    const homeserver = d.config.environment.matrix.homeserver.replace(/\/$/, '');
    const who = z.object({ user_id: z.string() }).parse(await requestJson(`${homeserver}/_matrix/client/v3/account/whoami`, { headers: { authorization: `Bearer ${token.access_token}` } }, d.http));
    return { ok: true, detail: `${who.user_id} (device ${token.device_id})` };
  } catch (error) {
    return failed(error);
  }
}

/** Starts an agent's entry as the agent would, asks initialize then tools/list, and stops it (spec §12.2, point 4). */
export function handshake(entry: { command: string; args: string[]; env?: Record<string, string> }, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<Check> {
  return new Promise((resolve) => {
    const child = spawn(entry.command, entry.args, { env: { ...env, ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (check: Check) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(check);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: `no answer within ${timeoutMs / 1000} s` }), timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => finish({ ok: false, detail: error.message }));
    child.once('exit', (code) => finish({ ok: false, detail: stderr.trim().split('\n').at(-1) || `the server stopped (exit code ${code})` }));
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: { id?: unknown; error?: { message?: string }; result?: { tools?: unknown[] } };
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        return;
      }
      if (message.error) return finish({ ok: false, detail: message.error.message ?? 'error' });
      if (message.id === 1) {
        send({ method: 'notifications/initialized' });
        send({ id: 2, method: 'tools/list', params: {} });
      } else if (message.id === 2) {
        finish({ ok: true, detail: `${message.result?.tools?.length ?? 0} tools` });
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-twake-ai status', version: '1' } } });
  });
}

/** The service an entry name stands for: twake-mail, twake_mail → mail. */
export function serviceOfEntry(name: string): ServiceId | undefined {
  const service = /^twake[-_](\w+)$/.exec(name)?.[1];
  return service && isServiceId(service) ? service : undefined;
}

export interface EntryState {
  name: string;
  service: ServiceId;
  state: 'ok' | 'missing' | 'modified' | 'foreign' | 'no-node';
  entry?: Entry;
}

/** Each Twake.ai entry of an agent, against the fingerprints mcp-twake-ai noted and the node it starts. */
export async function entryStates(adapter: AgentAdapter, owned: Record<string, string>): Promise<EntryState[]> {
  const current = await adapter.read();
  const names = new Set([...Object.keys(owned), ...Object.keys(current).filter((name) => serviceOfEntry(name) !== undefined)]);
  const states: EntryState[] = [];
  for (const name of [...names].sort()) {
    const service = serviceOfEntry(name);
    if (!service) continue;
    const entry = current[name];
    if (entry === undefined) {
      states.push({ name, service, state: 'missing' });
      continue;
    }
    let state: EntryState['state'] = owned[name] === undefined ? 'foreign' : fingerprint(entry) === owned[name] ? 'ok' : 'modified';
    if (state === 'ok') {
      try {
        if (!(await stat(String(entry.command))).isFile()) state = 'no-node';
      } catch {
        state = 'no-node';
      }
    }
    states.push({ name, service, state, entry });
  }
  return states;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/status.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/status.ts tests/status.test.ts tests/helpers/fake-cozy.ts tests/helpers/fake-synapse.ts
git commit -m "feat: status checks, from the authorizations to an MCP handshake"
```

---

### Task 3 : la commande `status`

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: tâche 2 ; `createAdapters`, `AGENT_IDS`, `isAgentId` (plan 3b) ; `serviceEnv`, `catalogContext`.
- Produces: `status [--agents <ids>] [--no-start]` ; `status --env <service> [--agent <id>]`.

- [ ] **Step 1: Write the failing tests**

`tests/cli.test.ts`, at the end of `describe('main: Twake Drive and Twake Chat', …)` (it reuses `readyForSetup`):

```ts
  it('shows the health of the session, Drive, Chat and every entry', async () => {
    const { deps } = await readyForSetup();
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
    idp.tokenFailureStatus = 400;
    await saveConfig(deps.paths, { ...(await loadConfig(deps.paths))! });
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

  it('prints the environment run would build', async () => {
    const { deps } = await readyForSetup();
    const io = captureIo();
    expect(await main(['status', '--env', 'mail', '--agent', 'cursor'], io, deps)).toBe(0);
    expect(io.out).toContain('JMAP_SESSION_URL=https://jmap.example.com/jmap/session\n');
    expect(io.out).toContain("JMAP_TOKEN_COMMAND='/usr/bin/node' '/opt/twake-ai/build/bin.js' 'token' 'mail'\n");
  });
```

(`readyForSetup` signs in the fake IdP's user, alice@example.com. `deps.nodePath` becomes the real Node in the third test, so `entryStates` sees an existing node and the handshake runs.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/cli.test.ts -t "health|wrong|starts each|environment run"`
Expected: FAIL, `status` is an unknown command.

- [ ] **Step 3: Write the implementation**

`src/cli.ts` :
- imports : `checkChat, checkDrive, checkSession, entryStates, handshake, type Check` de `./status.js` ;
- `USAGE` : `  mcp-twake-ai status [--agents <ids>] [--no-start]` et `  mcp-twake-ai status --env <service> [--agent <id>]` ;
- `dispatch` : `case 'status': return await statusCommand(args, io, deps);`

```ts
const STATE_LINE: Record<EntryState['state'], [string, string]> = {
  ok: ['✓', 'in place'],
  missing: ['✗', 'missing: run setup again'],
  modified: ['!', 'changed by hand since mcp-twake-ai wrote it'],
  foreign: ['!', 'configured outside mcp-twake-ai'],
  'no-node': ['✗', 'its node is gone (updated with nvm?): run setup again'],
};

const mark = (check: Check) => (check.ok ? '✓' : '✗');

/** status: the session, Drive, each agent's entries and Chat device, and a handshake with each server (spec §12.2). */
async function statusCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({ args, options: { agents: { type: 'string' }, 'no-start': { type: 'boolean' }, env: { type: 'string' }, agent: { type: 'string' } }, strict: true }),
  );
  const config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'mcp-twake-ai is not set up on this computer: run `mcp-twake-ai login --email <address>`.');
  if (values.env !== undefined) {
    if (!isServiceId(values.env)) throw new TwakeAiError('usage', `"${values.env}" is not a Twake.ai service (${SERVICE_IDS.join(', ')}).\n\n${USAGE}`);
    const env = serviceEnv(values.env, checkAgentId(values.agent ?? 'agent'), catalogContext(config, d));
    for (const [key, value] of Object.entries(env)) io.stdout(`${key}=${value}\n`);
    return 0;
  }
  const vault = await openVault(config.vault, d.paths);
  const broker = { paths: d.paths, config, vault, http: { fetch: d.fetch, now: d.now, sleep: d.sleep }, now: d.now };
  let healthy = true;
  const report = (check: Check, label: string) => {
    healthy &&= check.ok;
    io.stdout(`${mark(check)} ${label}: ${check.detail}\n`);
  };
  report(await checkSession(broker), 'Twake session');
  if (config.drive) report(await checkDrive(broker), 'Twake Drive');
  const adapters = await createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  const wanted = values.agents === undefined ? (Object.keys(config.agents ?? {}).filter(isAgentId) as AgentId[]) : values.agents.split(',').map((name) => name.trim());
  for (const name of wanted) {
    if (!isAgentId(name)) throw new TwakeAiError('usage', `"${name}" is not an agent mcp-twake-ai configures (${AGENT_IDS.join(', ')}).\n\n${USAGE}`);
    const adapter = adapters[name];
    io.stdout(`${adapter.label} (${adapter.target})\n`);
    if (!(await adapter.detect())) {
      healthy = false;
      io.stdout('  ✗ not found on this computer\n');
      continue;
    }
    let states: EntryState[];
    try {
      states = await entryStates(adapter, config.agents?.[name]?.entries ?? {});
    } catch (error) {
      healthy = false;
      io.stdout(`  ✗ ${describeError(error)}\n`);
      continue;
    }
    if (states.length === 0) io.stdout('  no Twake.ai entry: run setup\n');
    for (const state of states) {
      let [symbol, words] = STATE_LINE[state.state];
      if (state.state === 'ok' && !values['no-start']) {
        const started = await handshake(state.entry as { command: string; args: string[]; env?: Record<string, string> }, d.env);
        [symbol, words] = started.ok ? ['✓', `starts, ${started.detail}`] : ['✗', started.detail];
      }
      healthy &&= symbol === '✓';
      io.stdout(`  ${symbol} ${state.name.padEnd(14)} ${words}\n`);
    }
    if (states.some((state) => state.service === 'chat')) {
      const chat = await checkChat(broker, name);
      healthy &&= chat.ok;
      io.stdout(`  ${mark(chat)} Twake Chat (${name}): ${chat.detail}\n`);
    }
  }
  return healthy ? 0 : 1;
}
```

(`EntryState` s'importe avec `type` depuis `./status.js`.)

- [ ] **Step 4: Run them to verify they pass, then the whole suite**

Run: `npx vitest run tests/cli.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "feat: mcp-twake-ai status, a health check of every agent and service"
```

---

### Task 4 : `logout`

**Files:**
- Create: `src/logout.ts`
- Modify: `src/matrix.ts` (`logoutDevice`), `src/login-chat.ts` (l'utilise), `src/cli.ts`
- Test: `tests/logout.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: `revokeToken` (oidc), `deleteCozyClient` (cozy), `logoutMatrix`, `refreshMatrix` (matrix), `OIDC_REFRESH_KEY`, `COZY_KEYS`, `matrixKey`, `saveConfig`, `describeError`.
- Produces: `logoutDevice(homeserver, agent, tokens: { accessToken?; refreshToken? }, http): Promise<void>` (lève si le device n'a pas pu être déconnecté) ; `logout(d: { paths; config; vault; http }): Promise<{ done: string[]; failed: string[] }>` ; commande `logout`.

- [ ] **Step 1: Write the failing tests**

`tests/logout.test.ts` :

```ts
import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { saveConfig, loadConfig, type TwakeAiConfig } from '../src/config.js';
import { COZY_KEYS, matrixKey, OIDC_REFRESH_KEY } from '../src/grants.js';
import { logout } from '../src/logout.js';
import { fetchOidcMetadata } from '../src/oidc.js';
import { writeCachedToken } from '../src/token-cache.js';
import { MemoryVault } from '../src/vault.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';
import { tempPaths } from './helpers/tmp.js';

let idp: FakeIdp;
let cozy: FakeCozy;
let synapse: FakeSynapse;
beforeEach(async () => {
  [idp, cozy, synapse] = await Promise.all([startFakeIdp(), startFakeCozy(), startFakeSynapse()]);
});
afterEach(async () => {
  idp.close();
  await cozy.close();
  await synapse.close();
});

/** Signed in, with Drive and a Chat device for hermes, as the fakes issued them. */
async function signedIn() {
  const { paths } = await tempPaths();
  const vault = new MemoryVault();
  const refresh = idp.issueRefreshToken();
  await vault.set(OIDC_REFRESH_KEY, refresh);
  const client = await cozy.registerClient();
  await vault.set(COZY_KEYS.clientSecret, client.clientSecret);
  await vault.set(COZY_KEYS.registrationToken, client.registrationToken);
  const device = await synapse.issueDevice('Twake AI · hermes');
  await vault.set(matrixKey('hermes', 'access_token'), device.accessToken);
  await vault.set(matrixKey('hermes', 'refresh_token'), device.refreshToken);
  const config: TwakeAiConfig = {
    version: 1,
    email: 'alice@example.com',
    vault: 'file',
    oidc: { clientId: 'twake-ai-agents', scope: 'openid offline_access' },
    environment: { domain: 'example.com', oidc: await fetchOidcMetadata(idp.url), matrix: { homeserver: synapse.url }, services: {}, cozy: { instance: cozy.url } },
    drive: { clientId: client.clientId, apps: [] },
    chat: { hermes: { userId: '@alice:example.com', deviceId: device.deviceId } },
    agents: { cursor: { entries: { 'twake-mail': '0123456789abcdef' } } },
  };
  await saveConfig(paths, config);
  await writeCachedToken(paths, 'oidc', { access_token: 'a', expires_at: Number.MAX_SAFE_INTEGER });
  return { paths, vault, config, refresh, device };
}

describe('logout', () => {
  it('revokes the session, removes the Drive client, signs the devices out, then forgets every secret', async () => {
    const { paths, vault, config, refresh, device } = await signedIn();
    const result = await logout({ paths, config, vault, http: {} });
    expect(result.failed).toEqual([]);
    expect(result.done).toEqual(['Twake session revoked', 'Twake Drive access removed', 'Twake Chat device of hermes signed out']);
    expect(idp.revoked).toEqual([refresh]);
    expect(cozy.deleted).toEqual([config.drive!.clientId]);
    expect(synapse.loggedOut).toEqual([device.deviceId]);
    expect(await vault.get(OIDC_REFRESH_KEY)).toBeUndefined();
    expect(await vault.get(matrixKey('hermes', 'refresh_token'))).toBeUndefined();
    expect(await readdir(paths.tokensDir).catch(() => [])).toEqual([]);
    const after = await loadConfig(paths);
    expect(after).toMatchObject({ email: 'alice@example.com', agents: config.agents });
    expect(after?.drive).toBeUndefined();
    expect(after?.chat).toBeUndefined();
  });

  it('goes on when a step fails, and says which one', async () => {
    const { paths, vault, config, device } = await signedIn();
    idp.close();
    const result = await logout({ paths, config, vault, http: { timeoutMs: 2000 } });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatch(/^Twake session: /);
    expect(synapse.loggedOut).toEqual([device.deviceId]);
    expect(await vault.get(OIDC_REFRESH_KEY)).toBeUndefined();
  });

  it('signs out a device whose access token has expired, after a refresh', async () => {
    const { paths, vault, config, device } = await signedIn();
    synapse.expireIssuedAccessTokens();
    expect((await logout({ paths, config, vault, http: {} })).failed).toEqual([]);
    expect(synapse.loggedOut).toEqual([device.deviceId]);
  });
});
```

Les faux serveurs gagnent deux aides de test : `FakeCozy.registerClient(): Promise<{ clientId; clientSecret; registrationToken }>`, qui enregistre un client comme le ferait `POST /auth/register`, et `FakeSynapse.issueDevice(name): Promise<{ deviceId; accessToken; refreshToken }>`, qui crée un device comme le ferait `m.login.token`. Chacune réutilise les tables internes du faux.

`tests/cli.test.ts`, at the end of `describe('main: Twake Drive and Twake Chat', …)`:

```ts
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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/logout.test.ts tests/cli.test.ts -t "logout|logs out"`
Expected: FAIL, `../src/logout.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/matrix.ts` :

```ts
/** Signs one device out, renewing its access token first if it has expired; throws when the device stays signed in. */
export async function logoutDevice(homeserver: string, agent: string, tokens: { accessToken?: string; refreshToken?: string }, http: OidcHttp = {}): Promise<void> {
  if (tokens.accessToken) {
    try {
      await logoutMatrix(homeserver, tokens.accessToken, http);
      return;
    } catch (error) {
      if (!tokens.refreshToken) throw error;
    }
  }
  if (!tokens.refreshToken) throw new TwakeAiError('login_required', `No Twake Chat session is kept for ${agent}.`);
  const renewed = await refreshMatrix(homeserver, tokens.refreshToken, agent, http);
  await logoutMatrix(homeserver, renewed.accessToken, http);
}
```

`src/login-chat.ts` : `logoutPreviousDevice` devient `await logoutDevice(homeserver, agent, old, http).catch(() => undefined);` (best effort, inchangé pour l'utilisateur).

`src/logout.ts` :

```ts
import { rm } from 'node:fs/promises';
import { saveConfig, type TwakeAiConfig } from './config.js';
import { deleteCozyClient } from './cozy.js';
import { describeError } from './describe.js';
import { COZY_KEYS, matrixKey, OIDC_REFRESH_KEY } from './grants.js';
import { logoutDevice } from './matrix.js';
import type { OidcHttp } from './oidc.js';
import { revokeToken } from './oidc.js';
import type { AppPaths } from './paths.js';
import type { Vault } from './vault.js';

export interface LogoutDeps {
  paths: AppPaths;
  config: TwakeAiConfig;
  vault: Vault;
  http: OidcHttp;
}

/**
 * Revokes the Twake session, removes the Drive client, signs every Chat device out, then forgets the secrets and the
 * cached tokens (spec §7.3). Every step is tried even when another one fails.
 */
export async function logout(d: LogoutDeps): Promise<{ done: string[]; failed: string[] }> {
  const { config, vault, http } = d;
  const done: string[] = [];
  const failed: string[] = [];
  const attempt = async (label: string, what: string, step: () => Promise<void>) => {
    try {
      await step();
      done.push(label);
    } catch (error) {
      failed.push(`${what}: ${describeError(error)}`);
    }
  };
  const refresh = await vault.get(OIDC_REFRESH_KEY);
  if (refresh) await attempt('Twake session revoked', 'Twake session', () => revokeToken(config.environment.oidc, config.oidc, refresh, http));
  const instance = config.environment.cozy.instance;
  if (config.drive && instance) {
    const client = { clientId: config.drive.clientId, clientSecret: (await vault.get(COZY_KEYS.clientSecret)) ?? '', registrationToken: (await vault.get(COZY_KEYS.registrationToken)) ?? '' };
    await attempt('Twake Drive access removed', 'Twake Drive', () => deleteCozyClient(instance, client, http));
  }
  const agents = Object.keys(config.chat ?? {});
  for (const agent of agents) {
    const tokens = { accessToken: await vault.get(matrixKey(agent, 'access_token')), refreshToken: await vault.get(matrixKey(agent, 'refresh_token')) };
    await attempt(`Twake Chat device of ${agent} signed out`, `Twake Chat (${agent})`, () => logoutDevice(config.environment.matrix.homeserver, agent, tokens, http));
  }
  for (const key of [OIDC_REFRESH_KEY, ...Object.values(COZY_KEYS), ...agents.flatMap((agent) => [matrixKey(agent, 'access_token'), matrixKey(agent, 'refresh_token')])]) {
    await vault.delete(key).catch(() => undefined);
  }
  await rm(d.paths.tokensDir, { recursive: true, force: true });
  const { drive: _drive, chat: _chat, ...rest } = config;
  await saveConfig(d.paths, rest);
  return { done, failed };
}
```

`src/cli.ts` : `USAGE` gagne `  mcp-twake-ai logout`, `dispatch` gagne `case 'logout': return await logoutCommand(io, deps);` et :

```ts
/** logout: revokes every authorization and forgets the secrets (spec §7.3). */
async function logoutCommand(io: Io, d: CliDeps): Promise<number> {
  const config = await loadConfig(d.paths);
  if (!config) {
    io.stdout('Nothing to sign out of: mcp-twake-ai is not set up on this computer.\n');
    return 0;
  }
  const vault = await openVault(config.vault, d.paths);
  const { done, failed } = await logout({ paths: d.paths, config, vault, http: { fetch: d.fetch, now: d.now, sleep: d.sleep } });
  for (const line of done) io.stdout(`✓ ${line}\n`);
  for (const line of failed) io.stdout(`✗ ${line}\n`);
  io.stdout(failed.length ? 'The secrets are forgotten here; what could not be revoked expires on its own, or can be removed from your Twake account.\n' : 'Signed out. Run mcp-twake-ai login to sign in again.\n');
  return failed.length ? 1 : 0;
}
```

- [ ] **Step 4: Run them to verify they pass, then the whole suite**

Run: `npx vitest run tests/logout.test.ts tests/cli.test.ts tests/login-chat.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/logout.ts src/matrix.ts src/login-chat.ts src/cli.ts tests/logout.test.ts tests/cli.test.ts tests/helpers/fake-cozy.ts tests/helpers/fake-synapse.ts
git commit -m "feat: mcp-twake-ai logout revokes every authorization"
```

---

### Task 5 : `uninstall`

**Files:**
- Create: `src/uninstall.ts`
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `planEntries`, `applyAgent` (plan 3b) ; `logout` (tâche 4) ; `prefixDir` (installer) ; `journalFile` (tâche 1).
- Produces: `uninstallPlan(config, adapters): Promise<{ agent: AgentAdapter; actions: EntryAction[] }[]>` ; `removeFiles(paths, deleteChatStores): Promise<string[]>` ; commande `uninstall [--yes] [--force] [--delete-chat-stores]`.

- [ ] **Step 1: Write the failing tests**

`tests/cli.test.ts`, at the end of `describe('main: Twake Drive and Twake Chat', …)`:

```ts
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
  });

  it('keeps an entry changed by hand unless --force, and the Chat stores unless asked', async () => {
    const { deps, cursor } = await readyForSetup();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail', '--yes'], captureIo(), deps)).toBe(0);
    const servers = JSON.parse((await readText(cursor))!);
    servers.mcpServers['twake-mail'].env = { DEBUG: '1' };
    await writeFile(cursor, JSON.stringify(servers));
    await mkdir(join(deps.paths.dataDir, 'chat', 'cursor'), { recursive: true });
    const io = captureIo();
    expect(await main(['uninstall', '--yes', '--delete-chat-stores'], io, deps)).toBe(0);
    expect(io.out).toContain('left as they are: twake-mail');
    expect(JSON.parse((await readText(cursor))!).mcpServers['twake-mail'].env).toEqual({ DEBUG: '1' });
    expect(await stat(join(deps.paths.dataDir, 'chat')).then(() => true, () => false)).toBe(false);
  });
```

(Ajouter `prefixDir` de `../src/installer.js` aux imports, et `stat` à l'import de `node:fs/promises`.)

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/cli.test.ts -t "uninstall"`
Expected: FAIL, `uninstall` is an unknown command.

- [ ] **Step 3: Write the implementation**

`src/uninstall.ts` :

```ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { planEntries, type EntryAction } from './agents/entries.js';
import { isAgentId, type AgentAdapter, type AgentId } from './agents/types.js';
import type { TwakeAiConfig } from './config.js';
import { prefixDir } from './installer.js';
import { journalFile } from './journal.js';
import type { AppPaths } from './paths.js';

/** For every agent mcp-twake-ai wrote into: removing its entries (wanted: none). */
export async function uninstallPlan(config: TwakeAiConfig, adapters: Record<AgentId, AgentAdapter>): Promise<{ adapter: AgentAdapter; owned: Record<string, string>; actions: EntryAction[] }[]> {
  const plans = [];
  for (const [agent, record] of Object.entries(config.agents ?? {})) {
    if (!isAgentId(agent) || Object.keys(record.entries).length === 0) continue;
    const adapter = adapters[agent];
    plans.push({ adapter, owned: record.entries, actions: planEntries(await adapter.read(), {}, record.entries) });
  }
  return plans;
}

/** Removes the private prefix, the configuration, the secrets file, the cache and the journal; the Chat stores on request. */
export async function removeFiles(paths: AppPaths, deleteChatStores: boolean): Promise<string[]> {
  const targets = [prefixDir(paths), paths.configFile, paths.vaultFile, paths.cacheDir, journalFile(paths), `${journalFile(paths)}.1`, paths.locksDir];
  if (deleteChatStores) targets.push(join(paths.dataDir, 'chat'));
  for (const target of targets) await rm(target, { recursive: true, force: true });
  return targets;
}
```

`src/cli.ts` : `USAGE` gagne `  mcp-twake-ai uninstall [--yes] [--force] [--delete-chat-stores]`, `dispatch` gagne `case 'uninstall': return await uninstallCommand(args, io, deps);` et :

```ts
/** uninstall: removes the entries written, signs out, deletes what mcp-twake-ai installed (spec §12.3). */
async function uninstallCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({ args, options: { yes: { type: 'boolean' }, force: { type: 'boolean' }, 'delete-chat-stores': { type: 'boolean' } }, strict: true }),
  );
  const config = await loadConfig(d.paths).catch(() => undefined);
  const adapters = await createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  const force = values.force ?? false;
  const plans = config ? await uninstallPlan(config, adapters) : [];
  for (const { adapter, actions } of plans) printPlan(io, adapter, actions, force);
  const chat = join(d.paths.dataDir, 'chat');
  io.stdout(`${config ? 'Sign out of Twake.ai, then remove' : 'Remove'} ${prefixDir(d.paths)}, the configuration, the cache and the journal.\n`);
  io.stdout(values['delete-chat-stores'] ? `Delete the Twake Chat stores in ${chat}.\n` : `Twake Chat stores kept in ${chat} (add --delete-chat-stores to delete them).\n`);
  if (!values.yes) {
    io.stdout('Nothing was changed: run the same command with --yes to do it.\n');
    return 0;
  }
  let failed = false;
  for (const { adapter, owned, actions } of plans) {
    const result = await applyAgent(adapter, actions, owned, () => force);
    if (result.status === 'failed') {
      failed = true;
      io.stdout(`${adapter.label}: not changed, ${result.error}\n`);
    } else {
      io.stdout(`${adapter.label}: ${result.status === 'written' ? 'entries removed' : 'nothing to remove'}.\n`);
      if (result.skipped.length > 0) io.stdout(`  left as they are: ${result.skipped.map((action) => action.name).join(', ')} (add --force to remove them)\n`);
    }
  }
  if (config) {
    const vault = await openVault(config.vault, d.paths);
    const { failed: notRevoked } = await logout({ paths: d.paths, config, vault, http: { fetch: d.fetch, now: d.now, sleep: d.sleep } });
    for (const line of notRevoked) io.stdout(`✗ ${line}\n`);
  }
  await removeFiles(d.paths, values['delete-chat-stores'] ?? false);
  io.stdout(`mcp-twake-ai is uninstalled.${values['delete-chat-stores'] ? '' : ` Twake Chat stores kept in ${chat}.`} Remove the command itself with: npm uninstall -g mcp-twake-ai\n`);
  return failed ? 1 : 0;
}
```

- [ ] **Step 4: Run them to verify they pass, then the whole suite**

Run: `npx vitest run tests/cli.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/uninstall.ts src/cli.ts tests/cli.test.ts
git commit -m "feat: mcp-twake-ai uninstall removes what it installed"
```

---

### Task 6 : de bout en bout, `setup` → `status` → `logout` → `uninstall`, et documentation

**Files:**
- Modify: `tests/e2e/setup.e2e.test.ts`
- Modify: `README.md`, `docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md`

**Interfaces:**
- Consumes: tout ce qui précède, par la CLI construite.

- [ ] **Step 1: Write the test**

`tests/e2e/setup.e2e.test.ts`, a new `it` in the `describe` (imports: `startFakeIdp` from `../helpers/fake-idp.js`, `openVault` from `../../src/vault.js`, `OIDC_REFRESH_KEY` from `../../src/grants.js`, `fetchOidcMetadata` from `../../src/oidc.js`):

```ts
  it('lives through status, logout and uninstall', { timeout: 90_000 }, async () => {
    const idp = await startFakeIdp();
    try {
      const { home, env } = await computer();
      const paths = appPaths({ platform: process.platform, env: { TWAKE_AI_HOME: env.TWAKE_AI_HOME }, home });
      const refresh = idp.issueRefreshToken();
      await saveConfig(paths, { ...sampleConfig, email: 'alice@example.com', drive: undefined, chat: undefined, environment: { ...sampleConfig.environment, oidc: await fetchOidcMetadata(idp.url) } });
      await (await openVault('file', paths)).set(OIDC_REFRESH_KEY, refresh);
      setup(env, '--agents', 'cursor', '--services', 'mail', '--yes');
      const run = (...args: string[]) => {
        try {
          return { code: 0, out: execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' }) };
        } catch (error) {
          return { code: (error as { status: number }).status, out: String((error as { stdout: string }).stdout) };
        }
      };
      const status = run('status');
      expect(status.out).toContain('✓ Twake session: alice@example.com');
      expect(status.out).toMatch(/✓ twake-mail\s+starts, 1 tools/);
      expect(status.code).toBe(0);
      expect(run('logout').out).toContain('✓ Twake session revoked');
      expect(idp.revoked).toEqual([refresh]);
      expect(run('uninstall', '--yes').code).toBe(0);
      expect(JSON.parse(await readFile(join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers).toEqual({});
      expect(run('status').out).toContain('mcp-twake-ai login --email');
    } finally {
      idp.close();
    }
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/e2e`
Expected: PASS (2 tests, 1 skipped).

- [ ] **Step 3: Documentation**

- `README.md` : une section « Check, sign out, uninstall » après « Configure your agents », avec `mcp-twake-ai status` (et `--no-start`, `--env mail --agent cursor`), `mcp-twake-ai logout`, `mcp-twake-ai uninstall [--yes] [--force] [--delete-chat-stores]`, chacun avec une phrase sur ce qu'il fait ; la table « Files » gagne la ligne du journal (`~/.local/state/twake-ai/twake-ai.log`, secrets masqués).
- Feuille de route : le plan 4 est découpé en 4a (`status`, `logout`, `uninstall`, journal, livré) et 4b (`setup` interactif, bannière, i18n, auto-installation par `npx` et raccourci, `scripts/live.mjs`).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/setup.e2e.test.ts README.md docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md
git commit -m "test: setup, status, logout and uninstall end to end"
```
