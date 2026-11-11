# mcp-twake-ai, plan 5 : finitions

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** corriger les dix points mineurs des relectures des plans 3b, 4a et 4b qui touchent un utilisateur : fichiers d'agents avec un BOM ou derrière un lien cassé, codes de sortie et messages trompeurs, `uninstall` qui supprime trop, poignée de main fragile, trous du masquage du journal, formulations du parcours, outillage, utilisateurs de `npx`.

**Architecture:** des retouches locales, chacune avec son test, sans nouveau module.

**Tech Stack:** inchangée.

**Spec:** `docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md` (sections 7.3, 8, 10, 12). Les points viennent des relectures finales des plans 3b, 4a et 4b (listes « minor (deferred) »).

## Global Constraints

- Toutes celles des plans précédents.
- Un message dit quoi faire ; il ne recommande pas une option que le contexte ne connaît pas (`--force` dans le parcours guidé).
- Un code de sortie 0 veut dire : tout ce qui a été demandé est fait.

## Review Focus

- **`setup --yes` dont une entrée a été laissée faute de `--force`** : sortie 1, le message dit laquelle. Test dans la tâche 3.
- **`uninstall` avec `XDG_CACHE_HOME` = `XDG_DATA_HOME`** : les stores Chat restent. Test dans la tâche 5.
- **Une ligne `null` sur la sortie d'un serveur** : `status` ne plante pas. Test dans la tâche 6.

---

### Task 1 : fichiers JSON d'agent avec un BOM UTF-8

**Files:** Modify `src/agents/json-config.ts` ; Test `tests/agents/json-config.test.ts`

- [ ] **Step 1: Write the failing test** (dans `describe('Cursor', …)`)

```ts
  it('reads and keeps a UTF-8 byte order mark, as editors on Windows write it', async () => {
    const p = await place();
    const cursor = cursorAgent(p, now);
    await mkdir(dirname(cursor.target), { recursive: true });
    await writeFile(cursor.target, '\uFEFF{ "mcpServers": { "other": { "command": "x" } } }\n');
    expect(Object.keys(await cursor.read())).toEqual(['other']);
    await cursor.write({ set: { 'twake-mail': mail }, remove: [] });
    const text = await readFile(cursor.target, 'utf8');
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(Object.keys(await cursor.read())).toEqual(['other', 'twake-mail']);
  });
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run tests/agents/json-config.test.ts -t "byte order mark"` → FAIL (`InvalidSymbol at character 0`).

- [ ] **Step 3: Implementation** — dans `servers()`, travailler sur `text.replace(/^\uFEFF/, '')` ; dans `write`, retirer le BOM avant les modifications (`const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''`) et le remettre devant le texte écrit (`writeFileAtomic(a.file, bom + out)`).

- [ ] **Step 4: Run it to verify it passes**, then commit `fix: agent JSON files with a byte order mark are read and kept`.

### Task 2 : écriture atomique — lien cassé et fichier temporaire

**Files:** Modify `src/agents/config-file.ts` ; Test `tests/agents/config-file.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
  it.skipIf(windows)('writes the file a broken link points to, keeping the link', async () => {
    const dir = await tempDir();
    const link = join(dir, 'mcp.json');
    const real = join(dir, 'dotfiles', 'mcp.json');
    await symlink(real, link);
    await writeFileAtomic(link, '{}');
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toBe('{}');
  });

  it.skipIf(windows || root)('leaves no temporary file behind when writing fails', async () => {
    const dir = await tempDir();
    const file = join(dir, 'mcp.json');
    await writeFile(file, '{}');
    await chmod(file, 0o400);
    const write = writeFileAtomic(file, 'x'.repeat(10));
    // a read-only file can still be replaced by rename; make the write itself fail instead
    await expect(writeFileAtomic(join(dir, 'missing-dir', 'sub', '\0bad'), 'x')).rejects.toThrow();
    await write;
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
```

(`root` = `process.getuid?.() === 0` ; `lstat`, `readdir` ajoutés aux imports.)

- [ ] **Step 2: Run them to verify they fail** — le lien cassé est remplacé par un fichier ordinaire (`isSymbolicLink()` faux).

- [ ] **Step 3: Implementation** — `target(path)` : si `realpath` échoue et que `lstat(path)` est un lien, résoudre `readlink` (relatif au dossier du lien) et créer son dossier. Dans `writeFileAtomic`, envelopper `writeFile`/`sync`/`chmod` d'un `try … catch { await rm(tmp, { force: true }); throw }`.

- [ ] **Step 4: Run them to verify they pass**, then commit `fix: atomic writes follow a broken link and clean their temporary file on failure`.

### Task 3 : codes de sortie et messages de `setup`

**Files:** Modify `src/cli.ts` ; Test `tests/cli.test.ts`

- [ ] **Step 1: Write the failing tests** (dans `describe('main: Twake Drive and Twake Chat', …)`)

```ts
  it('exits with 1 when an entry was left alone for lack of --force, naming it', async () => {
    const { deps, cursor } = await readyForSetup();
    await writeFile(cursor, JSON.stringify({ mcpServers: { 'twake-mail': { command: 'my-mail' } } }));
    const io = captureIo();
    expect(await main(['setup', '--agents', 'cursor', '--services', 'mail', '--yes'], io, deps)).toBe(1);
    expect(io.out).toContain('left as they are: twake-mail');
  });

  it('exits with 1 when an agent named is not installed, and says why for Claude Code', async () => {
    const { deps } = await readyForSetup();
    const io = captureIo();
    expect(await main(['setup', '--agents', 'claude-code,cursor', '--services', 'mail', '--yes'], io, deps)).toBe(1);
    expect(io.out).toContain('Claude Code: the claude command is not in PATH, left out.');
  });

  it('does not suggest --yes when no agent can be set up', async () => {
    const { deps } = await readyForSetup();
    const io = captureIo();
    expect(await main(['setup', '--agents', 'claude-desktop', '--services', 'mail'], io, deps)).toBe(1);
    expect(io.out).not.toContain('--yes');
  });
```

Le test existant « leaves an entry configured by hand unless --force » attend désormais 1 au premier passage.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implementation** dans `runSetup` :
  - un agent non trouvé met `failed = true` ; pour Claude Code le message est `Claude Code: the claude command is not in PATH, left out.` ;
  - une entrée sautée (`result.skipped`) met `failed = true` ;
  - sans `apply`, la ligne « Nothing was changed: run … --yes » n'est écrite que si au moins un agent a un plan.

- [ ] **Step 4: Run them, then the whole suite**, then commit `fix: setup exits with 1 when something asked for was not done`.

### Task 4 : `logout` sans point de révocation

**Files:** Modify `src/oidc.ts`, `src/logout.ts` ; Test `tests/logout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('does not claim a revocation the identity provider cannot do', async () => {
    const { paths, vault, config } = await signedIn();
    const { revocation_endpoint: _none, ...oidc } = config.environment.oidc;
    const result = await logout({ paths, config: { ...config, environment: { ...config.environment, oidc } }, vault, http: {} });
    expect(result.done).not.toContain('Twake session revoked');
    expect(result.failed[0]).toMatch(/^Twake session: .*no revocation/);
    expect(await vault.get(OIDC_REFRESH_KEY)).toBeUndefined();
  });
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implementation** — `revokeToken` lève `TwakeAiError('unsupported', '<issuer> offers no revocation: the session ends when it expires, or from your account page.')` quand `revocation_endpoint` manque. Le parcours guidé, qui l'appelle avec `.catch`, n'en est pas affecté.

- [ ] **Step 4: Run it, then commit** `fix: logout says when the identity provider cannot revoke`.

### Task 5 : `uninstall` ne supprime que ce qui est à lui, et rend compte de la déconnexion

**Files:** Modify `src/uninstall.ts`, `src/cli.ts` ; Test `tests/cli.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
  it('keeps the Chat stores and other files when the cache and data folders are one', async () => {
    const { deps } = await readyForSetup();
    const shared = join(deps.home, 'shared');
    deps.paths = { ...deps.paths, cacheDir: shared, tokensDir: join(shared, 'tokens'), dataDir: shared };
    await mkdir(join(shared, 'chat', 'cursor'), { recursive: true });
    await writeFile(join(shared, 'someone-else.txt'), 'keep');
    expect(await main(['uninstall', '--yes'], captureIo(), deps)).toBe(0);
    expect(await readText(join(shared, 'someone-else.txt'))).toBe('keep');
    expect(await stat(join(shared, 'chat', 'cursor')).then(() => true, () => false)).toBe(true);
  });

  it('shows what uninstall revoked, and exits with 1 when a revocation failed', async () => {
    const { deps } = await readyForSetup();
    idp.close();
    const io = captureIo();
    expect(await main(['uninstall', '--yes'], io, deps)).toBe(1);
    expect(io.out).toMatch(/✗ Twake session: /);
  });
```

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implementation** — `removeFiles` supprime `tokensDir` au lieu de `cacheDir`, puis retire `cacheDir` et `stateDir` seulement s'ils sont vides (`rmdir`, erreurs ignorées). `uninstallCommand` affiche les lignes ✓ de `logout` et sort avec 1 si une révocation a échoué (les fichiers sont supprimés quand même).

- [ ] **Step 4: Run them, then the whole suite**, then commit `fix: uninstall removes only its own files and reports the sign-out`.

### Task 6 : poignée de main robuste

**Files:** Modify `src/status.ts` ; Test `tests/status.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('ignores lines that are not answers: null, and requests from the server', async () => {
    const odd = await script(`const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = JSON.parse(line);
  const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
  if (m.method === 'initialize') { process.stdout.write('null\\n'); send({ jsonrpc: '2.0', id: 1, method: 'roots/list' }); send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: {}, serverInfo: { name: 'odd', version: '1' } } }); }
  if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'a' }] } });
});`);
    expect(await handshake({ command: process.execPath, args: [odd] }, process.env)).toEqual({ ok: true, detail: '1 tools' });
  });
```

- [ ] **Step 2: Run it to verify it fails** (TypeError on `null`, or the request taken for the answer).

- [ ] **Step 3: Implementation** — ignorer une ligne qui n'est pas un objet ; ignorer un message qui a une `method` (requête ou notification du serveur) ; ne lire `id` que sur une réponse (`result` ou `error`).

- [ ] **Step 4: Run it, then commit** `fix: the status handshake ignores what is not an answer`.

### Task 7 : masquage du journal

**Files:** Modify `src/journal.ts` ; Test `tests/journal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('also hides camelCase names, escaped JSON and Matrix tokens, and leaves error codes readable', () => {
    expect(mask('{"refreshToken":"r-1","accessToken":"a-1"}')).toBe('{"refreshToken":"***","accessToken":"***"}');
    expect(mask('body {\\"refresh_token\\":\\"r-2\\"}')).toBe('body {\\"refresh_token\\":\\"***\\"}');
    expect(mask('token syt_YWxpY2U_abcdef_123 and syr_YWxpY2U_xyz_456')).toBe('token *** and ***');
    expect(mask('{"code":"M_UNKNOWN_TOKEN"}')).toBe('{"code":"M_UNKNOWN_TOKEN"}');
  });
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implementation** — dans `SECRET`, accepter `refreshToken|accessToken|idToken|clientSecret` et des guillemets précédés d'un antislash (`\\\\?["']`) ; une règle `\bsy[tr]_[\w-]+` → `***` ; pour `code`, ne pas masquer une valeur faite de majuscules et de `_` (un code d'erreur).

- [ ] **Step 4: Run it, then commit** `fix: the journal masks camelCase, escaped and Matrix tokens`.

### Task 8 : formulations du parcours guidé

**Files:** Modify `src/wizard.ts`, `src/i18n.ts`, `src/cli.ts` ; Test `tests/wizard.test.ts`, `tests/cli.test.ts`

- [ ] **Step 1: Write the failing tests**
  - wizard : un conflit `{ …, removal: true }` pose « {agent}: remove {name}, which was changed by hand since mcp-twake-ai wrote it? » ;
  - CLI (vrai kit) : avec une entrée Cursor configurée à la main, le texte du plan montré par le parcours ne contient pas `--force`.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implementation** — `WizardKit.plan` rend `removal: action.kind === 'remove-modified'` ; clé `removeEntry` en/fr ; `printPlan` et les lignes « left as they are … (add --force …) » n'écrivent pas l'indice `--force` quand `request.quiet`.

- [ ] **Step 4: Run them, then commit** `fix: the guided setup asks about removals as removals, without command-line hints`.

### Task 9 : outillage — `@clack/prompts` figé, `test:e2e` partout

**Files:** Modify `package.json`, `package-lock.json` ; Create `scripts/e2e.mjs`

- [ ] **Step 1:** `npm install --save-exact @clack/prompts@1.8.1` (la 1.9.0 est trop récente) ; vérifier `"@clack/prompts": "1.8.1"`.
- [ ] **Step 2:** `scripts/e2e.mjs` lance `vitest run tests/e2e` avec `MCP_TWAKE_AI_E2E=1` dans l'environnement du processus enfant (`spawnSync(process.execPath, [vitest, 'run', 'tests/e2e'], { env, stdio: 'inherit' })`), ce qui marche sous Windows ; `"test:e2e": "node scripts/e2e.mjs"`.
- [ ] **Step 3:** `npm run test:e2e` → PASS (le test du vrai Claude Code tourne ici). Commit `chore: pin clack exactly, and a test:e2e script that runs on Windows`.

### Task 10 : utilisateurs de `npx`, et PATH Windows

**Files:** Modify `src/cli.ts`, `src/self-install.ts` ; Test `tests/self-install.test.ts`, `tests/cli.test.ts`

- [ ] **Step 1: Write the failing tests**
  - `writeShortcut` sous Windows reconnaît le dossier dans le PATH quelle que soit la casse (`C:\\USERS\\X\\APPDATA\\LOCAL\\TWAKE-AI\\BIN`) ;
  - après `uninstall --yes` lancé depuis le cache de `npx`, le message ne conseille pas `npm uninstall -g` (il dit que rien d'autre n'est à retirer).

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implementation** — comparaison `toLowerCase()` des chemins sous Windows ; message final de `uninstall` selon `isNpxCache(d.cliPath)`.

- [ ] **Step 4: Run them, then the whole suite and typecheck**, then commit `fix: npx users get the right uninstall advice; PATH compared without case on Windows`.
