# twake-ai, plan 1 : socle et broker OIDC

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Livrer un paquet `twake-ai` dont les commandes `twake-ai login` et `twake-ai token <mail|dav|space|project>` remplacent le `my-token-broker` des README des MCP Twake.ai.

**Architecture:** Le paquet est une CLI Node en TypeScript, avec un module par fichier plat dans `src/`, comme les six MCP. `login` découvre les services à partir de l'email (`.well-known/matrix/client`, OIDC, SRV), connecte l'utilisateur à l'IdP (PKCE en loopback, ou device flow) et range le refresh token dans le coffre de l'OS, avec un fichier 0600 en repli. `token` sert le jeton d'accès en cache, ou le renouvelle sous un verrou inter-processus.

**Tech Stack:** Node ≥ 22.13, TypeScript 7 (`module: Node16`), Vitest 5, zod 4, proper-lockfile 4, @napi-rs/keyring 2, open 11, tsx 4 (tests multi-processus).

**Spec:** `docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md`. La feuille de route des quatre plans est dans `docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md`.

## Global Constraints

- Node `>=22.13` (`engines.node`), ESM (`"type": "module"`), imports relatifs suffixés `.js`.
- TypeScript compile `src/` vers `build/` ; les tests sont dans `tests/*.test.ts` et ne sont pas compilés par `tsc`.
- Licence `AGPL-3.0-only`.
- Style des six MCP : 2 espaces, apostrophes simples, points-virgules, messages et identifiants en anglais. La traduction des messages viendra au plan 4.
- Toute erreur destinée à l'utilisateur est une `TwakeAiError(code, message)`. La CLI écrit `twake-ai: <message>` sur stderr.
- Codes de sortie : `0` succès, `2` usage, `1` toute autre erreur.
- Contrat de `twake-ai token` : en cas de succès, stdout contient exactement `{"access_token":"…","expires_at":<epoch s>}` suivi d'un saut de ligne. En cas d'échec, rien sur stdout.
- Fichiers privés : mode `0600`, répertoires `0700`, écriture atomique (fichier temporaire puis renommage).
- Client OIDC par défaut : `twake-ai-agents`, à surcharger avec `--client-id` ou `TWAKE_AI_OIDC_CLIENT_ID`.
- Scope par défaut : `openid email profile offline_access workplaceFqdn`.
- Ports loopback : `8765`, `8766`, `8767`, redirection `http://127.0.0.1:<port>/callback`.
- Délai de connexion en loopback : 5 minutes.
- Marge d'expiration : 60 s.
- Verrou : 10 s d'attente au plus, péremption au bout de 30 s.
- Clé du coffre pour le refresh OIDC : `oidc.refresh_token`.
- Service du trousseau : `twake-ai`.
- Cache des jetons : `<cacheDir>/tokens/<autorisation>.json`.
- `TWAKE_AI_HOME` regroupe `config/`, `cache/`, `data/` et `state/` sous un seul répertoire.
- `TWAKE_AI_VAULT=file` force le coffre fichier.
- Aucun accès réseau dans les tests : seulement des faux serveurs sur `127.0.0.1`, ou un `fetch` injecté.
- Chaque message de commit se termine par les lignes d'attribution en vigueur pour la session.

## Review Focus

- **Email saisi avec des espaces ou des majuscules** (`  Alice@LINAGORA.com `) : le domaine doit être trouvé (`linagora.com`), et pas refusé. Test dans la tâche 7.
- **IdP qui ne fait pas tourner les refresh tokens, ou qui ne donne pas `expires_in`** : on garde l'ancien refresh token, et la durée de vie vaut 300 s. Test dans la tâche 6.
- **Jeton en cache qui expire dans moins de 60 s** : il doit être renouvelé, et pas servi au MCP qui échouerait juste après. Test dans la tâche 10.
- **Fichier de cache corrompu** (JSON tronqué après une coupure) : `token` renouvelle au lieu de planter. Test dans la tâche 10.
- **Retour loopback avec un `state` qui n'est pas le bon** (vieil onglet, tentative CSRF) : réponse 400, et la connexion continue d'attendre le bon retour. Test dans la tâche 8.

---

### Task 1 : squelette du paquet et `--version`

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `LICENSE`, `src/cli.ts`, `src/bin.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Produces : `interface Io { stdout(text: string): void; stderr(text: string): void }`, `const processIo: Io`, `main(argv: string[], io: Io): Promise<number>`. La tâche 11 ajoutera un troisième paramètre `deps`.

- [ ] **Step 1 : écrire `package.json`, `tsconfig.json`, `.gitignore`**

`package.json` :

```json
{
  "name": "twake-ai",
  "version": "0.1.0",
  "description": "Install, configure and authenticate the Twake.ai MCP servers in your AI agents",
  "type": "module",
  "bin": {
    "twake-ai": "build/bin.js"
  },
  "files": [
    "build",
    "README.md",
    "LICENSE"
  ],
  "engines": {
    "node": ">=22.13"
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/linagora/twake-ai.git"
  },
  "license": "AGPL-3.0-only"
}
```

`tsconfig.json` (même base que les six MCP) :

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "sourceMap": true,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "build", "tests"]
}
```

`.gitignore` :

```
node_modules/
build/
coverage/
```

- [ ] **Step 2 : installer les dépendances et la licence**

Run :

```bash
npm install zod@^4.6.7 proper-lockfile@^4.1.2 @napi-rs/keyring@^2.1.2 open@^11.0.4
npm install -D typescript@^7.0.2 vitest@^5.1.0 @types/node@^26.6.6 @types/proper-lockfile@^4.1.4 tsx@^4.23.15
curl -fsSL https://www.gnu.org/licenses/agpl-3.0.txt -o LICENSE
```

Expected : `package.json` contient maintenant `dependencies` et `devDependencies`, `package-lock.json` existe, et `LICENSE` commence par `GNU AFFERO GENERAL PUBLIC LICENSE`.

- [ ] **Step 3 : écrire le test qui échoue**

`tests/cli.test.ts` :

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli.js';

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

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

describe('main', () => {
  it('prints the package version', async () => {
    const io = captureIo();
    expect(await main(['--version'], io)).toBe(0);
    expect(io.out).toBe(`${version}\n`);
  });

  it('prints the usage on stderr and exits 2 for an unknown command', async () => {
    const io = captureIo();
    expect(await main(['frobnicate'], io)).toBe(2);
    expect(io.err).toMatch(/usage:/);
    expect(io.out).toBe('');
  });
});
```

- [ ] **Step 4 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/cli.test.ts`
Expected : FAIL, `Cannot find module '../src/cli.js'` ou équivalent.

- [ ] **Step 5 : écrire `src/cli.ts` et `src/bin.ts`**

`src/cli.ts` :

```ts
import { readFileSync } from 'node:fs';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processIo: Io = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

const USAGE = `usage:
  twake-ai --version
`;

export async function main(argv: string[], io: Io): Promise<number> {
  const [command] = argv;
  if (command === '--version' || command === '-v') {
    io.stdout(`${packageVersion()}\n`);
    return 0;
  }
  io.stderr(USAGE);
  return 2;
}
```

`src/bin.ts` :

```ts
#!/usr/bin/env node
import { main, processIo } from './cli.js';

process.exitCode = await main(process.argv.slice(2), processIo);
```

- [ ] **Step 6 : lancer les tests et la compilation**

Run : `npx vitest run tests/cli.test.ts && npm run build && node build/bin.js --version`
Expected : 2 tests PASS, puis `0.1.0`.

- [ ] **Step 7 : commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore LICENSE src/cli.ts src/bin.ts tests/cli.test.ts
git commit -m "feat: scaffold the twake-ai package with --version"
```

---

### Task 2 : erreurs et répertoires de l'application

**Files:**
- Create: `src/errors.ts`, `src/paths.ts`, `tests/helpers/tmp.ts`
- Test: `tests/paths.test.ts`

**Interfaces:**
- Produces :
  - `type ErrorCode = 'usage' | 'not_twake_domain' | 'network' | 'bad_response' | 'login_required' | 'login_cancelled' | 'ports_busy' | 'lock_timeout' | 'insecure_file' | 'unsupported'`
  - `class TwakeAiError extends Error { readonly code: ErrorCode }`
  - `interface PlatformInfo { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; home: string }`
  - `interface AppPaths { configDir; cacheDir; dataDir; stateDir; configFile; vaultFile; tokensDir; locksDir: string }`
  - `appPaths(p?: PlatformInfo): AppPaths`
  - (test) `tempDir(): Promise<string>`, `tempPaths(): Promise<{ root: string; paths: AppPaths }>`

- [ ] **Step 1 : écrire le test qui échoue**

`tests/paths.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { appPaths } from '../src/paths.js';

describe('appPaths', () => {
  it('follows the XDG defaults on Linux and macOS', () => {
    const p = appPaths({ platform: 'linux', env: {}, home: '/home/alice' });
    expect(p.configFile).toBe('/home/alice/.config/twake-ai/config.json');
    expect(p.vaultFile).toBe('/home/alice/.config/twake-ai/secrets.json');
    expect(p.tokensDir).toBe('/home/alice/.cache/twake-ai/tokens');
    expect(p.dataDir).toBe('/home/alice/.local/share/twake-ai');
    expect(p.locksDir).toBe('/home/alice/.local/state/twake-ai/locks');
    expect(appPaths({ platform: 'darwin', env: {}, home: '/Users/alice' }).configDir).toBe('/Users/alice/.config/twake-ai');
  });

  it('honours the XDG variables', () => {
    const p = appPaths({ platform: 'linux', env: { XDG_CONFIG_HOME: '/x/conf', XDG_CACHE_HOME: '/x/cache' }, home: '/home/alice' });
    expect(p.configFile).toBe('/x/conf/twake-ai/config.json');
    expect(p.tokensDir).toBe('/x/cache/twake-ai/tokens');
  });

  it('uses APPDATA and LOCALAPPDATA on Windows, spaces included', () => {
    const p = appPaths({
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\Al Ice\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Al Ice\\AppData\\Local' },
      home: 'C:\\Users\\Al Ice',
    });
    expect(p.configFile).toBe('C:\\Users\\Al Ice\\AppData\\Roaming\\twake-ai\\config.json');
    expect(p.dataDir).toBe('C:\\Users\\Al Ice\\AppData\\Local\\twake-ai');
    expect(p.tokensDir).toBe('C:\\Users\\Al Ice\\AppData\\Local\\twake-ai\\cache\\tokens');
  });

  it('groups everything under TWAKE_AI_HOME', () => {
    const p = appPaths({ platform: 'linux', env: { TWAKE_AI_HOME: '/tmp/t' }, home: '/home/alice' });
    expect(p.configFile).toBe('/tmp/t/config/config.json');
    expect(p.tokensDir).toBe('/tmp/t/cache/tokens');
    expect(p.locksDir).toBe('/tmp/t/state/locks');
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/paths.test.ts`
Expected : FAIL, module `../src/paths.js` introuvable.

- [ ] **Step 3 : écrire `src/errors.ts`, `src/paths.ts` et `tests/helpers/tmp.ts`**

`src/errors.ts` :

```ts
export type ErrorCode =
  | 'usage'
  | 'not_twake_domain'
  | 'network'
  | 'bad_response'
  | 'login_required'
  | 'login_cancelled'
  | 'ports_busy'
  | 'lock_timeout'
  | 'insecure_file'
  | 'unsupported';

/** An error whose message is written for the user: the CLI prints it as is. */
export class TwakeAiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TwakeAiError';
  }
}
```

`src/paths.ts` :

```ts
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export interface PlatformInfo {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

export interface AppPaths {
  configDir: string;
  cacheDir: string;
  dataDir: string;
  stateDir: string;
  configFile: string;
  vaultFile: string;
  tokensDir: string;
  locksDir: string;
}

export function currentPlatform(): PlatformInfo {
  return { platform: process.platform, env: process.env, home: homedir() };
}

/** Where twake-ai keeps its files. TWAKE_AI_HOME groups them all under one directory (tests, several accounts). */
export function appPaths(p: PlatformInfo = currentPlatform()): AppPaths {
  const path = p.platform === 'win32' ? win32 : posix;
  let configDir: string;
  let cacheDir: string;
  let dataDir: string;
  let stateDir: string;
  const root = p.env.TWAKE_AI_HOME;
  if (root) {
    configDir = path.join(root, 'config');
    cacheDir = path.join(root, 'cache');
    dataDir = path.join(root, 'data');
    stateDir = path.join(root, 'state');
  } else if (p.platform === 'win32') {
    const roaming = p.env.APPDATA || path.join(p.home, 'AppData', 'Roaming');
    const local = p.env.LOCALAPPDATA || path.join(p.home, 'AppData', 'Local');
    configDir = path.join(roaming, 'twake-ai');
    dataDir = path.join(local, 'twake-ai');
    cacheDir = path.join(local, 'twake-ai', 'cache');
    stateDir = path.join(local, 'twake-ai', 'state');
  } else {
    configDir = path.join(p.env.XDG_CONFIG_HOME || path.join(p.home, '.config'), 'twake-ai');
    cacheDir = path.join(p.env.XDG_CACHE_HOME || path.join(p.home, '.cache'), 'twake-ai');
    dataDir = path.join(p.env.XDG_DATA_HOME || path.join(p.home, '.local', 'share'), 'twake-ai');
    stateDir = path.join(p.env.XDG_STATE_HOME || path.join(p.home, '.local', 'state'), 'twake-ai');
  }
  return {
    configDir,
    cacheDir,
    dataDir,
    stateDir,
    configFile: path.join(configDir, 'config.json'),
    vaultFile: path.join(configDir, 'secrets.json'),
    tokensDir: path.join(cacheDir, 'tokens'),
    locksDir: path.join(stateDir, 'locks'),
  };
}
```

`tests/helpers/tmp.ts` :

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { appPaths, type AppPaths } from '../../src/paths.js';

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'twake-ai-test-'));
  created.push(dir);
  return dir;
}

export async function tempPaths(): Promise<{ root: string; paths: AppPaths }> {
  const root = await tempDir();
  return { root, paths: appPaths({ platform: process.platform, env: { TWAKE_AI_HOME: root }, home: root }) };
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/paths.test.ts`
Expected : 4 tests PASS.

- [ ] **Step 5 : commit**

```bash
git add src/errors.ts src/paths.ts tests/helpers/tmp.ts tests/paths.test.ts
git commit -m "feat: user-facing errors and per-platform app directories"
```

---

### Task 3 : fichiers privés

**Files:**
- Create: `src/files.ts`
- Test: `tests/files.test.ts`

**Interfaces:**
- Consumes : `TwakeAiError` (tâche 2), `tempDir()` (tâche 2).
- Produces :
  - `writePrivateFile(path: string, data: string): Promise<void>`
  - `assertPrivateFile(path: string, platform?: NodeJS.Platform): Promise<void>`
  - `readPrivateJson(path: string): Promise<unknown>` (renvoie `undefined` si le fichier n'existe pas ; laisse passer `SyntaxError` pour un JSON invalide)

- [ ] **Step 1 : écrire le test qui échoue**

`tests/files.test.ts` :

```ts
import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPrivateJson, writePrivateFile } from '../src/files.js';
import { tempDir } from './helpers/tmp.js';

describe('writePrivateFile', () => {
  it('creates the missing directories and writes the file with mode 0600', async () => {
    const file = join(await tempDir(), 'a', 'b', 'secret.json');
    await writePrivateFile(file, '{"x":1}');
    expect(await readFile(file, 'utf8')).toBe('{"x":1}');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('replaces an existing file and leaves no temporary file behind', async () => {
    const dir = await tempDir();
    const file = join(dir, 'secret.json');
    await writePrivateFile(file, 'one');
    await writePrivateFile(file, 'two');
    expect(await readFile(file, 'utf8')).toBe('two');
    expect(await readdir(dir)).toEqual(['secret.json']);
  });
});

describe('readPrivateJson', () => {
  it('returns undefined when the file does not exist', async () => {
    expect(await readPrivateJson(join(await tempDir(), 'missing.json'))).toBeUndefined();
  });

  it('parses a private file', async () => {
    const file = join(await tempDir(), 'ok.json');
    await writePrivateFile(file, '{"a":"b"}');
    expect(await readPrivateJson(file)).toEqual({ a: 'b' });
  });

  it.skipIf(process.platform === 'win32')('refuses a file that other users can read', async () => {
    const file = join(await tempDir(), 'open.json');
    await writeFile(file, '{}');
    await chmod(file, 0o644);
    await expect(readPrivateJson(file)).rejects.toMatchObject({ code: 'insecure_file', message: expect.stringMatching(/chmod 600/) });
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/files.test.ts`
Expected : FAIL, module `../src/files.js` introuvable.

- [ ] **Step 3 : écrire `src/files.ts`**

```ts
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { TwakeAiError } from './errors.js';

/** Writes `data` to `path` atomically (temporary file, then rename), readable by the owner only. */
export async function writePrivateFile(path: string, data: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Refuses a file that other users can read or write. POSIX only: Windows protects files with ACLs. */
export async function assertPrivateFile(path: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return;
  const { mode } = await stat(path);
  if ((mode & 0o077) !== 0) {
    throw new TwakeAiError('insecure_file', `${path} must not be readable by other users: run chmod 600 "${path}"`);
  }
}

/** Reads a private JSON file; `undefined` when it does not exist. */
export async function readPrivateJson(path: string): Promise<unknown> {
  try {
    await assertPrivateFile(path);
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/files.test.ts`
Expected : 5 tests PASS (4 sous Windows).

- [ ] **Step 5 : commit**

```bash
git add src/files.ts tests/files.test.ts
git commit -m "feat: atomic private files (0600) and their permission check"
```

---

### Task 4 : verrou inter-processus

**Files:**
- Create: `src/lock.ts`
- Test: `tests/lock.test.ts`

**Interfaces:**
- Consumes : `TwakeAiError`, `tempPaths()` (tâche 2).
- Produces : `withLock<T>(locksDir: string, name: string, fn: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T>`. Lève `TwakeAiError('lock_timeout')` si le verrou reste pris au-delà de `timeoutMs` (10 000 par défaut).

- [ ] **Step 1 : écrire le test qui échoue**

`tests/lock.test.ts` :

```ts
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { withLock } from '../src/lock.js';
import { tempPaths } from './helpers/tmp.js';

describe('withLock', () => {
  it('runs the callers one at a time', async () => {
    const { paths } = await tempPaths();
    const events: string[] = [];
    const job = (id: string) =>
      withLock(paths.locksDir, 'oidc', async () => {
        events.push(`start ${id}`);
        await sleep(50);
        events.push(`end ${id}`);
      });
    await Promise.all([job('a'), job('b')]);
    expect(events).toHaveLength(4);
    expect(events[1]).toBe(events[0]!.replace('start', 'end'));
    expect(events[3]).toBe(events[2]!.replace('start', 'end'));
  });

  it('returns the value of the callback', async () => {
    const { paths } = await tempPaths();
    expect(await withLock(paths.locksDir, 'oidc', async () => 42)).toBe(42);
  });

  it('fails with lock_timeout while another holder keeps the lock', async () => {
    const { paths } = await tempPaths();
    let releaseOuter!: () => void;
    let acquired!: () => void;
    const isAcquired = new Promise<void>((resolve) => (acquired = resolve));
    const outer = withLock(paths.locksDir, 'oidc', () => new Promise<void>((resolve) => {
      releaseOuter = resolve;
      acquired();
    }));
    await isAcquired;
    await expect(withLock(paths.locksDir, 'oidc', async () => 1, { timeoutMs: 300 })).rejects.toMatchObject({ code: 'lock_timeout' });
    releaseOuter();
    await outer;
  });

  it('releases the lock when the callback throws', async () => {
    const { paths } = await tempPaths();
    await expect(withLock(paths.locksDir, 'oidc', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await withLock(paths.locksDir, 'oidc', async () => 'free', { timeoutMs: 300 })).toBe('free');
  });

  it('does not block between different names', async () => {
    const { paths } = await tempPaths();
    const result = await withLock(paths.locksDir, 'oidc', () => withLock(paths.locksDir, 'vault-file', async () => 'nested', { timeoutMs: 300 }));
    expect(result).toBe('nested');
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/lock.test.ts`
Expected : FAIL, module `../src/lock.js` introuvable.

- [ ] **Step 3 : écrire `src/lock.ts`**

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { TwakeAiError } from './errors.js';

/**
 * Runs `fn` while holding a lock shared by every twake-ai process of this user.
 * Token refreshes run under it: two processes must never spend the same refresh token.
 */
export async function withLock<T>(
  locksDir: string,
  name: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  await mkdir(locksDir, { recursive: true, mode: 0o700 });
  const target = join(locksDir, name);
  await writeFile(target, '', { flag: 'a', mode: 0o600 });
  let release: () => Promise<void>;
  try {
    release = await lock(target, {
      stale: 30_000,
      retries: { retries: Math.max(1, Math.ceil(timeoutMs / 100)), factor: 1, minTimeout: 100, maxTimeout: 100 },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOCKED') {
      throw new TwakeAiError(
        'lock_timeout',
        `Another twake-ai process has held the "${name}" lock for more than ${Math.round(timeoutMs / 1000)} s: try again, or delete ${target}.lock if no twake-ai process is running.`,
      );
    }
    throw error;
  }
  try {
    return await fn();
  } finally {
    await release();
  }
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/lock.test.ts`
Expected : 5 tests PASS.

- [ ] **Step 5 : commit**

```bash
git add src/lock.ts tests/lock.test.ts
git commit -m "feat: cross-process lock with a bounded wait"
```

---

### Task 5 : coffre de secrets

**Files:**
- Create: `src/vault.ts`
- Test: `tests/vault.test.ts`

**Interfaces:**
- Consumes : `readPrivateJson`, `writePrivateFile` (tâche 3), `withLock` (tâche 4), `AppPaths` (tâche 2).
- Produces :
  - `type VaultKind = 'keyring' | 'file'`
  - `interface Vault { readonly kind: VaultKind | 'memory'; get(key): Promise<string | undefined>; set(key, value): Promise<void>; delete(key): Promise<void> }`
  - `class MemoryVault`, `class FileVault(paths: AppPaths)`, `class KeyringVault(entry: KeyringEntryFactory)`
  - `interface KeyringEntry { getPassword(): string | null; setPassword(p: string): void; deletePassword(): boolean }`
  - `type KeyringEntryFactory = (service: string, account: string) => KeyringEntry`
  - `const KEYRING_SERVICE = 'twake-ai'`
  - `chooseVault(paths, env?, load?): Promise<Vault>` : sonde le trousseau, utilisé une seule fois, au login
  - `openVault(kind: VaultKind, paths, load?): Promise<Vault>` : sans sonde, utilisé par `token`

- [ ] **Step 1 : écrire le test qui échoue**

`tests/vault.test.ts` :

```ts
import { stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { chooseVault, FileVault, KeyringVault, openVault, type KeyringEntry, type KeyringEntryFactory } from '../src/vault.js';
import { tempPaths } from './helpers/tmp.js';

function fakeKeyring(): { factory: KeyringEntryFactory; store: Map<string, string> } {
  const store = new Map<string, string>();
  const factory: KeyringEntryFactory = (service, account): KeyringEntry => {
    const key = `${service}/${account}`;
    return {
      getPassword: () => store.get(key) ?? null,
      setPassword: (password) => {
        store.set(key, password);
      },
      deletePassword: () => store.delete(key),
    };
  };
  return { factory, store };
}

describe('FileVault', () => {
  it('stores, reads and deletes secrets in a 0600 file', async () => {
    const { paths } = await tempPaths();
    const vault = new FileVault(paths);
    expect(await vault.get('oidc.refresh_token')).toBeUndefined();
    await vault.set('oidc.refresh_token', 'r1');
    await vault.set('other', 'x');
    expect(await vault.get('oidc.refresh_token')).toBe('r1');
    await vault.delete('oidc.refresh_token');
    expect(await vault.get('oidc.refresh_token')).toBeUndefined();
    expect(await vault.get('other')).toBe('x');
    if (process.platform !== 'win32') expect((await stat(paths.vaultFile)).mode & 0o777).toBe(0o600);
  });

  it('keeps every key when two writes race', async () => {
    const { paths } = await tempPaths();
    const vault = new FileVault(paths);
    await Promise.all(['a', 'b', 'c', 'd'].map((key) => vault.set(key, key)));
    expect(await Promise.all(['a', 'b', 'c', 'd'].map((key) => vault.get(key)))).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('KeyringVault', () => {
  it('stores secrets under the twake-ai service', async () => {
    const { factory, store } = fakeKeyring();
    const vault = new KeyringVault(factory);
    await vault.set('oidc.refresh_token', 'r1');
    expect(store.get('twake-ai/oidc.refresh_token')).toBe('r1');
    expect(await vault.get('oidc.refresh_token')).toBe('r1');
    await vault.delete('oidc.refresh_token');
    await vault.delete('oidc.refresh_token');
    expect(await vault.get('oidc.refresh_token')).toBeUndefined();
  });
});

describe('chooseVault', () => {
  it('uses the keyring when it works, and removes its probe', async () => {
    const { paths } = await tempPaths();
    const { factory, store } = fakeKeyring();
    const vault = await chooseVault(paths, {}, async () => factory);
    expect(vault.kind).toBe('keyring');
    expect(store.size).toBe(0);
  });

  it('falls back to the file when the keyring cannot load (no session bus, unsupported OS)', async () => {
    const { paths } = await tempPaths();
    const vault = await chooseVault(paths, {}, async () => {
      throw new Error('Platform secure storage failure');
    });
    expect(vault.kind).toBe('file');
  });

  it('falls back to the file when the keyring does not keep what it is given', async () => {
    const { paths } = await tempPaths();
    const forgetful: KeyringEntryFactory = () => ({ getPassword: () => null, setPassword: () => undefined, deletePassword: () => false });
    expect((await chooseVault(paths, {}, async () => forgetful)).kind).toBe('file');
  });

  it('obeys TWAKE_AI_VAULT=file', async () => {
    const { paths } = await tempPaths();
    const { factory } = fakeKeyring();
    expect((await chooseVault(paths, { TWAKE_AI_VAULT: 'file' }, async () => factory)).kind).toBe('file');
  });
});

describe('openVault', () => {
  it('opens the kind recorded in the configuration', async () => {
    const { paths } = await tempPaths();
    const { factory } = fakeKeyring();
    expect((await openVault('file', paths)).kind).toBe('file');
    expect((await openVault('keyring', paths, async () => factory)).kind).toBe('keyring');
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/vault.test.ts`
Expected : FAIL, module `../src/vault.js` introuvable.

- [ ] **Step 3 : écrire `src/vault.ts`**

```ts
import { readPrivateJson, writePrivateFile } from './files.js';
import { withLock } from './lock.js';
import type { AppPaths } from './paths.js';

export type VaultKind = 'keyring' | 'file';

export interface Vault {
  readonly kind: VaultKind | 'memory';
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const KEYRING_SERVICE = 'twake-ai';

export class MemoryVault implements Vault {
  readonly kind = 'memory' as const;
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

/** Fallback when the OS has no usable keychain (Linux server without a session bus…): one 0600 JSON file. */
export class FileVault implements Vault {
  readonly kind = 'file' as const;

  constructor(private readonly paths: AppPaths) {}

  async get(key: string): Promise<string | undefined> {
    return (await this.read())[key];
  }

  async set(key: string, value: string): Promise<void> {
    await this.update((values) => {
      values[key] = value;
    });
  }

  async delete(key: string): Promise<void> {
    await this.update((values) => {
      delete values[key];
    });
  }

  private async read(): Promise<Record<string, string>> {
    return ((await readPrivateJson(this.paths.vaultFile)) ?? {}) as Record<string, string>;
  }

  private async update(change: (values: Record<string, string>) => void): Promise<void> {
    await withLock(this.paths.locksDir, 'vault-file', async () => {
      const values = await this.read();
      change(values);
      await writePrivateFile(this.paths.vaultFile, `${JSON.stringify(values, null, 2)}\n`);
    });
  }
}

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export type KeyringEntryFactory = (service: string, account: string) => KeyringEntry;

/** macOS Keychain, Windows Credential Manager, Secret Service on Linux. */
export class KeyringVault implements Vault {
  readonly kind = 'keyring' as const;

  constructor(private readonly entry: KeyringEntryFactory) {}

  async get(key: string): Promise<string | undefined> {
    return this.entry(KEYRING_SERVICE, key).getPassword() ?? undefined;
  }

  async set(key: string, value: string): Promise<void> {
    this.entry(KEYRING_SERVICE, key).setPassword(value);
  }

  async delete(key: string): Promise<void> {
    try {
      this.entry(KEYRING_SERVICE, key).deletePassword();
    } catch {
      // nothing stored under this key: already deleted
    }
  }
}

async function loadKeyring(): Promise<KeyringEntryFactory> {
  const { Entry } = await import('@napi-rs/keyring');
  return (service, account) => new Entry(service, account);
}

/** Picks the vault once, at login: the OS keychain when it works, else the 0600 file. TWAKE_AI_VAULT=file forces the file. */
export async function chooseVault(
  paths: AppPaths,
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<KeyringEntryFactory> = loadKeyring,
): Promise<Vault> {
  if (env.TWAKE_AI_VAULT === 'file') return new FileVault(paths);
  try {
    const vault = new KeyringVault(await load());
    await vault.set('probe', 'ok');
    const works = (await vault.get('probe')) === 'ok';
    await vault.delete('probe');
    if (works) return vault;
  } catch {
    // no usable keychain here: fall back to the file
  }
  return new FileVault(paths);
}

/** Opens the vault recorded in the configuration, without probing (the token command runs often). */
export async function openVault(kind: VaultKind, paths: AppPaths, load: () => Promise<KeyringEntryFactory> = loadKeyring): Promise<Vault> {
  return kind === 'keyring' ? new KeyringVault(await load()) : new FileVault(paths);
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/vault.test.ts`
Expected : 8 tests PASS.

- [ ] **Step 5 : commit**

```bash
git add src/vault.ts tests/vault.test.ts
git commit -m "feat: secret vault in the OS keychain with a 0600 file fallback"
```

---

### Task 6 : HTTP et protocole OIDC

**Files:**
- Create: `src/http.ts`, `src/oidc.ts`, `tests/helpers/fake-idp.ts`
- Test: `tests/http.test.ts`, `tests/oidc.test.ts`

**Interfaces:**
- Consumes : `TwakeAiError` (tâche 2).
- Produces (`src/http.ts`) :
  - `interface HttpOptions { fetch?: typeof fetch; timeoutMs?: number }`
  - `class HttpError extends Error { status: number; url: string; body: string; get oauthError(): string | undefined }`
  - `send(url, init: RequestInit, options?): Promise<Response>`
  - `requestJson(url, init, options?): Promise<unknown>`
  - `getJson(url, options?, headers?): Promise<unknown>`
  - `postForm(url, form: Record<string,string>, options?): Promise<unknown>`
- Produces (`src/oidc.ts`) :
  - `OidcMetadataSchema` (zod), `type OidcMetadata = { issuer; authorization_endpoint; token_endpoint; userinfo_endpoint; revocation_endpoint?; device_authorization_endpoint? }`
  - `fetchOidcMetadata(issuer: string, http?: HttpOptions): Promise<OidcMetadata>`
  - `interface OidcClient { clientId: string; scope: string }`
  - `interface TokenSet { accessToken: string; refreshToken?: string; expiresAt: number /* epoch s */ }`
  - `type OidcHttp = HttpOptions & { now?: () => number; sleep?: (ms: number) => Promise<void> }`
  - `createPkce(): { verifier: string; challenge: string }`, `randomState(): string`
  - `authorizeUrl(meta, client, { redirectUri, state, challenge, loginHint? }): string`
  - `exchangeCode(meta, client, { code, redirectUri, verifier }, http?): Promise<TokenSet>`
  - `refreshTokens(meta, client, refreshToken: string, http?): Promise<TokenSet>` : `TwakeAiError('login_required')` sur `invalid_grant` ou 401
  - `revokeToken(meta, client, token: string, http?): Promise<void>`
  - `fetchUserinfo(meta, accessToken: string, http?): Promise<Record<string, unknown>>`
  - `type DeviceAuthorization = { device_code; user_code; verification_uri; verification_uri_complete?; expires_in: number; interval?: number }`
  - `startDeviceAuthorization(meta, client, http?): Promise<DeviceAuthorization>`
  - `pollDeviceToken(meta, client, device, http?): Promise<TokenSet>`
  - (test) `startFakeIdp(): Promise<FakeIdp>`

- [ ] **Step 1 : écrire le faux IdP**

`tests/helpers/fake-idp.ts` :

```ts
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An OIDC provider on 127.0.0.1 with the endpoints twake-ai uses, and knobs to misbehave. */
export interface FakeIdp {
  url: string;
  refreshCount: number;
  revoked: string[];
  /** device flow: polls answered `authorization_pending` before the user "approves" */
  devicePendingPolls: number;
  deviceSlowDownFirst: boolean;
  deviceDenied: boolean;
  /** false: refresh responses carry no new refresh token (non-rotating IdP) */
  rotateRefreshTokens: boolean;
  /** false: no refresh token at all (client without offline_access) */
  offlineAccess: boolean;
  /** undefined: responses carry no expires_in */
  expiresIn: number | undefined;
  userinfo: Record<string, unknown>;
  issueRefreshToken(): string;
  close(): Promise<void>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export async function startFakeIdp(): Promise<FakeIdp> {
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const accessTokens = new Set<string>();
  let devicePolls = 0;
  const token = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;

  const idp: FakeIdp = {
    url: '',
    refreshCount: 0,
    revoked: [],
    devicePendingPolls: 1,
    deviceSlowDownFirst: false,
    deviceDenied: false,
    rotateRefreshTokens: true,
    offlineAccess: true,
    expiresIn: 300,
    userinfo: { sub: 'alice', email: 'alice@example.com', workplaceFqdn: 'alice.twake.example.com' },
    issueRefreshToken() {
      const refresh = token('refresh');
      refreshTokens.add(refresh);
      return refresh;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const issue = (withRefresh: boolean) => {
    const access = token('access');
    accessTokens.add(access);
    const body: Record<string, unknown> = { access_token: access, token_type: 'Bearer' };
    if (idp.expiresIn !== undefined) body.expires_in = idp.expiresIn;
    if (withRefresh && idp.offlineAccess) body.refresh_token = idp.issueRefreshToken();
    return body;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', idp.url);
    const form = req.method === 'POST' ? new URLSearchParams(await readBody(req)) : new URLSearchParams();
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    switch (url.pathname) {
      case '/.well-known/openid-configuration':
        return json(200, {
          issuer: idp.url,
          authorization_endpoint: `${idp.url}/authorize`,
          token_endpoint: `${idp.url}/token`,
          userinfo_endpoint: `${idp.url}/userinfo`,
          revocation_endpoint: `${idp.url}/revoke`,
          device_authorization_endpoint: `${idp.url}/device`,
        });
      case '/authorize': {
        // the user is already signed in at the IdP: straight back with a code
        const code = token('code');
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirectUri });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      case '/device':
        devicePolls = 0;
        return json(200, {
          device_code: 'device-1',
          user_code: 'ABCD-EFGH',
          verification_uri: `${idp.url}/activate`,
          verification_uri_complete: `${idp.url}/activate?user_code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      case '/token': {
        const grant = form.get('grant_type');
        if (grant === 'authorization_code') {
          const code = form.get('code') ?? '';
          const entry = codes.get(code);
          codes.delete(code);
          const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
          if (!entry || entry.challenge !== challenge || entry.redirectUri !== form.get('redirect_uri')) return json(400, { error: 'invalid_grant' });
          return json(200, issue(true));
        }
        if (grant === 'refresh_token') {
          const presented = form.get('refresh_token') ?? '';
          if (!refreshTokens.has(presented)) return json(400, { error: 'invalid_grant' });
          idp.refreshCount++;
          if (idp.rotateRefreshTokens) refreshTokens.delete(presented);
          return json(200, issue(idp.rotateRefreshTokens));
        }
        if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
          devicePolls++;
          if (idp.deviceDenied) return json(400, { error: 'access_denied' });
          if (idp.deviceSlowDownFirst && devicePolls === 1) return json(400, { error: 'slow_down' });
          if (devicePolls <= idp.devicePendingPolls + (idp.deviceSlowDownFirst ? 1 : 0)) return json(400, { error: 'authorization_pending' });
          return json(200, issue(true));
        }
        return json(400, { error: 'unsupported_grant_type' });
      }
      case '/userinfo': {
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (!accessTokens.has(bearer)) return json(401, { error: 'invalid_token' });
        return json(200, idp.userinfo);
      }
      case '/revoke': {
        const revoked = form.get('token') ?? '';
        idp.revoked.push(revoked);
        refreshTokens.delete(revoked);
        return json(200, {});
      }
      default:
        return json(404, { error: 'not_found' });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  idp.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return idp;
}
```

- [ ] **Step 2 : écrire les tests qui échouent**

`tests/http.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { getJson, HttpError } from '../src/http.js';

const fetchReturning = (response: () => Response) => (async () => response()) as unknown as typeof fetch;

describe('HttpError', () => {
  it('exposes the OAuth error code of the body', () => {
    expect(new HttpError(400, 'https://x/token', '{"error":"invalid_grant"}').oauthError).toBe('invalid_grant');
    expect(new HttpError(500, 'https://x/token', '<html>').oauthError).toBeUndefined();
  });
});

describe('getJson', () => {
  it('parses a JSON answer', async () => {
    expect(await getJson('https://x.example/a', { fetch: fetchReturning(() => Response.json({ ok: true })) })).toEqual({ ok: true });
  });

  it('throws HttpError with the body on an HTTP error', async () => {
    const error = await getJson('https://x.example/a', { fetch: fetchReturning(() => new Response('{"error":"nope"}', { status: 403 })) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 403, oauthError: 'nope' });
  });

  it('turns a network failure into a network error naming the host', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(getJson('https://sso.example.com/x', { fetch: failing })).rejects.toMatchObject({
      code: 'network',
      message: expect.stringContaining('sso.example.com'),
    });
  });

  it('refuses an answer that is not JSON', async () => {
    await expect(getJson('https://x.example/a', { fetch: fetchReturning(() => new Response('<html>')) })).rejects.toMatchObject({ code: 'bad_response' });
  });
});
```

`tests/oidc.test.ts` :

```ts
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  fetchOidcMetadata,
  fetchUserinfo,
  pollDeviceToken,
  refreshTokens,
  revokeToken,
  startDeviceAuthorization,
  type OidcClient,
  type OidcMetadata,
} from '../src/oidc.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';

const client: OidcClient = { clientId: 'twake-ai-agents', scope: 'openid email offline_access' };
let idp: FakeIdp;
let meta: OidcMetadata;

beforeEach(async () => {
  idp = await startFakeIdp();
  meta = await fetchOidcMetadata(idp.url);
});
afterEach(() => idp.close());

/** Plays the browser: follows the authorization URL and returns the code sent back. */
async function codeFor(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

function virtualClock(start = 1_000_000) {
  const clock = { t: start, now: () => clock.t, sleep: async (ms: number) => void (clock.t += ms / 1000) };
  return clock;
}

describe('PKCE and authorization URL', () => {
  it('derives the S256 challenge from the verifier', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toHaveLength(43);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('builds the authorization URL with PKCE, state and login hint', () => {
    const url = new URL(authorizeUrl(meta, client, { redirectUri: 'http://127.0.0.1:8765/callback', state: 's1', challenge: 'c1', loginHint: 'alice@example.com' }));
    expect(url.origin + url.pathname).toBe(`${idp.url}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'twake-ai-agents',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      scope: 'openid email offline_access',
      state: 's1',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
      login_hint: 'alice@example.com',
    });
  });
});

describe('code exchange', () => {
  it('exchanges the code for tokens that expire expires_in seconds from now', async () => {
    const pkce = createPkce();
    const redirectUri = 'http://127.0.0.1:1/callback';
    const code = await codeFor(authorizeUrl(meta, client, { redirectUri, state: 's', challenge: pkce.challenge }));
    const tokens = await exchangeCode(meta, client, { code, redirectUri, verifier: pkce.verifier }, { now: () => 1000 });
    expect(tokens.accessToken).toMatch(/^access-/);
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    expect(tokens.expiresAt).toBe(1300);
  });

  it('fails when the verifier does not match the challenge', async () => {
    const redirectUri = 'http://127.0.0.1:1/callback';
    const code = await codeFor(authorizeUrl(meta, client, { redirectUri, state: 's', challenge: createPkce().challenge }));
    await expect(exchangeCode(meta, client, { code, redirectUri, verifier: createPkce().verifier })).rejects.toMatchObject({ oauthError: 'invalid_grant' });
  });
});

describe('refresh', () => {
  it('returns the rotated refresh token', async () => {
    const old = idp.issueRefreshToken();
    const tokens = await refreshTokens(meta, client, old, { now: () => 2000 });
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    expect(tokens.refreshToken).not.toBe(old);
    expect(tokens.expiresAt).toBe(2300);
  });

  it('keeps the old refresh token when the IdP does not rotate, and assumes 300 s without expires_in', async () => {
    idp.rotateRefreshTokens = false;
    idp.expiresIn = undefined;
    const old = idp.issueRefreshToken();
    const tokens = await refreshTokens(meta, client, old, { now: () => 2000 });
    expect(tokens.refreshToken).toBe(old);
    expect(tokens.expiresAt).toBe(2300);
  });

  it('asks to sign in again when the refresh token is no longer valid', async () => {
    await expect(refreshTokens(meta, client, 'refresh-unknown')).rejects.toMatchObject({
      code: 'login_required',
      message: expect.stringContaining('twake-ai login'),
    });
  });
});

describe('userinfo and revocation', () => {
  it('reads the userinfo with the access token', async () => {
    const tokens = await refreshTokens(meta, client, idp.issueRefreshToken());
    expect(await fetchUserinfo(meta, tokens.accessToken)).toMatchObject({ workplaceFqdn: 'alice.twake.example.com' });
  });

  it('revokes a refresh token, and does nothing without a revocation endpoint', async () => {
    const refresh = idp.issueRefreshToken();
    await revokeToken(meta, client, refresh);
    expect(idp.revoked).toEqual([refresh]);
    await revokeToken({ ...meta, revocation_endpoint: undefined }, client, 'other');
    expect(idp.revoked).toEqual([refresh]);
  });
});

describe('device flow', () => {
  it('polls until the user approves, slowing down when asked', async () => {
    idp.deviceSlowDownFirst = true;
    const clock = virtualClock();
    const device = await startDeviceAuthorization(meta, client);
    expect(device.user_code).toBe('ABCD-EFGH');
    const tokens = await pollDeviceToken(meta, client, device, clock);
    expect(tokens.refreshToken).toMatch(/^refresh-/);
    // 5 s, slow_down (+5), 10 s pending, 10 s approved
    expect(clock.t - 1_000_000).toBe(25);
  });

  it('stops when the user refuses', async () => {
    idp.deviceDenied = true;
    const device = await startDeviceAuthorization(meta, client);
    await expect(pollDeviceToken(meta, client, device, virtualClock())).rejects.toMatchObject({ code: 'login_cancelled' });
  });

  it('stops when the code expires', async () => {
    idp.devicePendingPolls = 1_000;
    const device = await startDeviceAuthorization(meta, client);
    await expect(pollDeviceToken(meta, client, device, virtualClock())).rejects.toMatchObject({
      code: 'login_cancelled',
      message: expect.stringContaining('expired'),
    });
  });

  it('says so when the IdP offers no device flow', async () => {
    await expect(startDeviceAuthorization({ ...meta, device_authorization_endpoint: undefined }, client)).rejects.toMatchObject({ code: 'unsupported' });
  });
});
```

- [ ] **Step 3 : lancer les tests pour les voir échouer**

Run : `npx vitest run tests/http.test.ts tests/oidc.test.ts`
Expected : FAIL, modules `../src/http.js` et `../src/oidc.js` introuvables.

- [ ] **Step 4 : écrire `src/http.ts`**

```ts
import { TwakeAiError } from './errors.js';

export interface HttpOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}`);
    this.name = 'HttpError';
  }

  /** The OAuth `error` code of the body (RFC 6749 §5.2), if any. */
  get oauthError(): string | undefined {
    try {
      const parsed = JSON.parse(this.body) as { error?: unknown };
      return typeof parsed.error === 'string' ? parsed.error : undefined;
    } catch {
      return undefined;
    }
  }
}

/** fetch with a timeout; a network failure becomes a `network` error that names the host. */
export async function send(url: string, init: RequestInit, options: HttpOptions = {}): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  } catch (error) {
    throw new TwakeAiError('network', `Cannot reach ${new URL(url).host}: ${(error as Error).message}`);
  }
}

export async function requestJson(url: string, init: RequestInit, options: HttpOptions = {}): Promise<unknown> {
  const headers = { accept: 'application/json', ...(init.headers as Record<string, string> | undefined) };
  const response = await send(url, { ...init, headers }, options);
  const body = await response.text();
  if (!response.ok) throw new HttpError(response.status, url, body);
  if (!body) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new TwakeAiError('bad_response', `${url} did not answer JSON`);
  }
}

export function getJson(url: string, options?: HttpOptions, headers: Record<string, string> = {}): Promise<unknown> {
  return requestJson(url, { method: 'GET', headers }, options);
}

export function postForm(url: string, form: Record<string, string>, options?: HttpOptions): Promise<unknown> {
  return requestJson(
    url,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() },
    options,
  );
}
```

- [ ] **Step 5 : écrire `src/oidc.ts`**

```ts
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { TwakeAiError } from './errors.js';
import { getJson, HttpError, postForm, type HttpOptions } from './http.js';

export const OidcMetadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  userinfo_endpoint: z.string(),
  revocation_endpoint: z.string().optional(),
  device_authorization_endpoint: z.string().optional(),
});
export type OidcMetadata = z.infer<typeof OidcMetadataSchema>;

export interface OidcClient {
  clientId: string;
  scope: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** epoch seconds */
  expiresAt: number;
}

export type OidcHttp = HttpOptions & {
  /** epoch seconds */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** Lifetime assumed when the IdP does not give expires_in (it is optional in RFC 6749). */
const DEFAULT_TTL_S = 300;

const nowS = () => Math.floor(Date.now() / 1000);

export async function fetchOidcMetadata(issuer: string, http?: HttpOptions): Promise<OidcMetadata> {
  return OidcMetadataSchema.parse(await getJson(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, http));
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function randomState(): string {
  return randomBytes(16).toString('base64url');
}

export function authorizeUrl(
  meta: OidcMetadata,
  client: OidcClient,
  p: { redirectUri: string; state: string; challenge: string; loginHint?: string },
): string {
  const url = new URL(meta.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.clientId,
    redirect_uri: p.redirectUri,
    scope: client.scope,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  }).toString();
  return url.toString();
}

const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

function toTokenSet(raw: unknown, now: number): TokenSet {
  const t = TokenResponseSchema.parse(raw);
  return { accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: now + (t.expires_in ?? DEFAULT_TTL_S) };
}

export async function exchangeCode(
  meta: OidcMetadata,
  client: OidcClient,
  p: { code: string; redirectUri: string; verifier: string },
  http: OidcHttp = {},
): Promise<TokenSet> {
  const raw = await postForm(
    meta.token_endpoint,
    { grant_type: 'authorization_code', client_id: client.clientId, code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier },
    http,
  );
  return toTokenSet(raw, (http.now ?? nowS)());
}

/** Renews the access token. Keeps the old refresh token when the IdP does not rotate it. */
export async function refreshTokens(meta: OidcMetadata, client: OidcClient, refreshToken: string, http: OidcHttp = {}): Promise<TokenSet> {
  let raw: unknown;
  try {
    raw = await postForm(meta.token_endpoint, { grant_type: 'refresh_token', client_id: client.clientId, refresh_token: refreshToken }, http);
  } catch (error) {
    if (error instanceof HttpError && (error.oauthError === 'invalid_grant' || error.status === 401)) {
      throw new TwakeAiError('login_required', 'Your Twake session has expired: run `twake-ai login`.');
    }
    throw error;
  }
  const tokens = toTokenSet(raw, (http.now ?? nowS)());
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

export async function revokeToken(meta: OidcMetadata, client: OidcClient, token: string, http: HttpOptions = {}): Promise<void> {
  if (!meta.revocation_endpoint) return;
  await postForm(meta.revocation_endpoint, { client_id: client.clientId, token, token_type_hint: 'refresh_token' }, http);
}

export async function fetchUserinfo(meta: OidcMetadata, accessToken: string, http: HttpOptions = {}): Promise<Record<string, unknown>> {
  return (await getJson(meta.userinfo_endpoint, http, { authorization: `Bearer ${accessToken}` })) as Record<string, unknown>;
}

const DeviceAuthorizationSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number().optional(),
});
export type DeviceAuthorization = z.infer<typeof DeviceAuthorizationSchema>;

export async function startDeviceAuthorization(meta: OidcMetadata, client: OidcClient, http: HttpOptions = {}): Promise<DeviceAuthorization> {
  if (!meta.device_authorization_endpoint) {
    throw new TwakeAiError('unsupported', `${meta.issuer} does not offer sign-in from another device: run twake-ai login on a computer with a browser.`);
  }
  return DeviceAuthorizationSchema.parse(await postForm(meta.device_authorization_endpoint, { client_id: client.clientId, scope: client.scope }, http));
}

/** Waits for the user to approve the device code (RFC 8628 §3.4–3.5). */
export async function pollDeviceToken(meta: OidcMetadata, client: OidcClient, device: DeviceAuthorization, http: OidcHttp = {}): Promise<TokenSet> {
  const now = http.now ?? nowS;
  const sleep = http.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const expired = new TwakeAiError('login_cancelled', 'The sign-in code has expired: run twake-ai login again.');
  const deadline = now() + device.expires_in;
  let interval = device.interval ?? 5;
  while (now() < deadline) {
    await sleep(interval * 1000);
    try {
      const raw = await postForm(
        meta.token_endpoint,
        { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: client.clientId },
        http,
      );
      return toTokenSet(raw, now());
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      if (error.oauthError === 'authorization_pending') continue;
      if (error.oauthError === 'slow_down') {
        interval += 5;
        continue;
      }
      if (error.oauthError === 'access_denied') throw new TwakeAiError('login_cancelled', 'Sign-in was refused on the other device.');
      if (error.oauthError === 'expired_token') throw expired;
      throw error;
    }
  }
  throw expired;
}
```

- [ ] **Step 6 : lancer les tests**

Run : `npx vitest run tests/http.test.ts tests/oidc.test.ts`
Expected : 5 tests PASS dans `http.test.ts`, 13 dans `oidc.test.ts`.

- [ ] **Step 7 : commit**

```bash
git add src/http.ts src/oidc.ts tests/helpers/fake-idp.ts tests/http.test.ts tests/oidc.test.ts
git commit -m "feat: OIDC client (PKCE, refresh, device flow, revocation) over a small HTTP layer"
```

---

### Task 7 : découverte à partir de l'email

**Files:**
- Create: `src/discovery.ts`, `tests/fixtures/linagora/matrix-client.json`, `tests/fixtures/linagora/openid-configuration.json`
- Test: `tests/discovery.test.ts`

**Interfaces:**
- Consumes : `getJson`, `send`, `HttpError`, `HttpOptions` (tâche 6) ; `fetchOidcMetadata`, `OidcMetadataSchema` (tâche 6) ; `TwakeAiError` (tâche 2).
- Produces :
  - `interface SrvRecord { name: string; port: number; priority: number; weight: number }`
  - `interface DiscoveryDeps extends HttpOptions { resolveSrv(hostname: string): Promise<SrvRecord[]> }`
  - `type Endpoint = { url: string; source: 'discovered' | 'convention' | 'manual' }`
  - `TwakeEnvironmentSchema` (zod)
  - `type TwakeEnvironment = { domain; oidc: OidcMetadata; matrix: { homeserver; tom? }; services: { mail?; dav?; space?; project?: Endpoint }; cozy: { pattern?; instance?: string } }`
  - `emailDomain(email: string): string`
  - `discover(email: string, deps: DiscoveryDeps): Promise<TwakeEnvironment>`
  - `completeFromUserinfo(env, userinfo: Record<string, unknown>, email: string): TwakeEnvironment`

- [ ] **Step 1 : enregistrer les fixtures (relevées sur linagora.com le 2026-11-10)**

`tests/fixtures/linagora/matrix-client.json` :

```json
{
  "m.homeserver": { "base_url": "https://matrix.linagora.com/" },
  "m.identity_server": { "base_url": "https://tom.linagora.com/" },
  "t.server": { "base_url": "https://tom.linagora.com/", "server_name": "linagora.com" },
  "m.federated_identity_services": { "base_urls": ["https://fed.stg.lin-saas.com/"] },
  "app.twake.chat": {
    "assistants": { "base_url": "https://matrix-rtc.linagora.com" },
    "common_settings": {
      "application_name": "settings",
      "application_url": "https://{username}-settings.twake.linagora.com/",
      "enabled": true
    },
    "enable_invitations": false,
    "matrix_profile_updates_allowed": false,
    "support_contact": "@support:twake.app"
  },
  "m.authentication": { "issuer": "https://sso.linagora.com/" }
}
```

`tests/fixtures/linagora/openid-configuration.json` :

```json
{
  "issuer": "https://sso.linagora.com",
  "authorization_endpoint": "https://sso.linagora.com/oauth2/authorize",
  "token_endpoint": "https://sso.linagora.com/oauth2/token",
  "userinfo_endpoint": "https://sso.linagora.com/oauth2/userinfo",
  "revocation_endpoint": "https://sso.linagora.com/oauth2/revoke",
  "introspection_endpoint": "https://sso.linagora.com/oauth2/introspect",
  "end_session_endpoint": "https://sso.linagora.com/oauth2/logout",
  "device_authorization_endpoint": "https://sso.linagora.com/oauth2/device",
  "grant_types_supported": ["authorization_code", "password", "client_credentials", "refresh_token"],
  "code_challenge_methods_supported": ["plain", "S256"],
  "scopes_supported": ["openid", "profile", "email", "address", "phone", "workplaceFqdn"],
  "claims_supported": ["sub", "iss", "auth_time", "acr", "sid", "workplaceFqdn"],
  "token_endpoint_auth_methods_supported": ["client_secret_post", "client_secret_basic"]
}
```

- [ ] **Step 2 : écrire le test qui échoue**

`tests/discovery.test.ts` :

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { completeFromUserinfo, discover, emailDomain, type DiscoveryDeps, type SrvRecord, type TwakeEnvironment } from '../src/discovery.js';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/linagora/${name}`, import.meta.url), 'utf8')) as unknown;

type Routes = Record<string, () => Response>;

function deps(routes: Routes, srv: Record<string, SrvRecord[]> = {}): DiscoveryDeps {
  return {
    fetch: (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const route = routes[url];
      if (!route) throw new TypeError(`fetch failed (no route for ${url})`);
      return route();
    }) as typeof fetch,
    resolveSrv: async (name) => {
      const records = srv[name];
      if (!records) throw Object.assign(new Error(`queryResolveSrv ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
      return records;
    },
  };
}

const linagoraRoutes: Routes = {
  'https://linagora.com/.well-known/matrix/client': () => Response.json(fixture('matrix-client.json')),
  'https://sso.linagora.com/.well-known/openid-configuration': () => Response.json(fixture('openid-configuration.json')),
  'https://jmap.linagora.com/.well-known/jmap': () => new Response(null, { status: 302, headers: { location: 'https://jmap.linagora.com/jmap/session' } }),
  'https://space.linagora.com/': () => new Response('<html>', { status: 200 }),
  'https://projects.linagora.com/': () => new Response('<html>', { status: 200 }),
};

const linagoraSrv: Record<string, SrvRecord[]> = {
  '_jmap._tcp.linagora.com': [{ name: 'jmap.linagora.com', port: 443, priority: 0, weight: 1 }],
  '_caldavs._tcp.linagora.com': [{ name: 'dav.linagora.com', port: 443, priority: 0, weight: 1 }],
};

const linagoraEnvironment: TwakeEnvironment = {
  domain: 'linagora.com',
  oidc: {
    issuer: 'https://sso.linagora.com',
    authorization_endpoint: 'https://sso.linagora.com/oauth2/authorize',
    token_endpoint: 'https://sso.linagora.com/oauth2/token',
    userinfo_endpoint: 'https://sso.linagora.com/oauth2/userinfo',
    revocation_endpoint: 'https://sso.linagora.com/oauth2/revoke',
    device_authorization_endpoint: 'https://sso.linagora.com/oauth2/device',
  },
  matrix: { homeserver: 'https://matrix.linagora.com/', tom: 'https://tom.linagora.com/' },
  services: {
    mail: { url: 'https://jmap.linagora.com/jmap/session', source: 'discovered' },
    dav: { url: 'https://dav.linagora.com/', source: 'discovered' },
    space: { url: 'https://space.linagora.com', source: 'convention' },
    project: { url: 'https://projects.linagora.com', source: 'convention' },
  },
  cozy: { pattern: 'https://{username}.twake.linagora.com' },
};

describe('emailDomain', () => {
  it('trims the address and lowercases the domain', () => {
    expect(emailDomain('  Alice@LINAGORA.com ')).toBe('linagora.com');
  });

  it('refuses what is not an email address', () => {
    for (const bad of ['alice', '@linagora.com', 'alice@', 'al ice@linagora.com']) {
      expect(() => emailDomain(bad)).toThrow(expect.objectContaining({ code: 'usage' }));
    }
  });
});

describe('discover', () => {
  it('finds every Twake.ai service of the LINAGORA SaaS from the email address', async () => {
    expect(await discover('mmaudet@linagora.com', deps(linagoraRoutes, linagoraSrv))).toEqual(linagoraEnvironment);
  });

  it('accepts an address typed with spaces and capitals', async () => {
    expect((await discover('  MMaudet@Linagora.COM ', deps(linagoraRoutes, linagoraSrv))).domain).toBe('linagora.com');
  });

  it('says the domain is not a Twake.ai domain when it has no Matrix client discovery', async () => {
    const routes = { 'https://example.org/.well-known/matrix/client': () => new Response('Not found', { status: 404 }) };
    await expect(discover('bob@example.org', deps(routes))).rejects.toMatchObject({ code: 'not_twake_domain' });
  });

  it('says the domain is not a Twake.ai domain when the discovery URL answers a web page', async () => {
    const routes = { 'https://example.org/.well-known/matrix/client': () => new Response('<html>', { status: 200 }) };
    await expect(discover('bob@example.org', deps(routes))).rejects.toMatchObject({ code: 'not_twake_domain' });
  });

  it('says so when the Matrix discovery names no identity provider', async () => {
    const routes = { 'https://example.org/.well-known/matrix/client': () => Response.json({ 'm.homeserver': { base_url: 'https://m.example.org/' } }) };
    await expect(discover('bob@example.org', deps(routes))).rejects.toMatchObject({ code: 'not_twake_domain' });
  });

  it('reports a network failure as such, not as a foreign domain', async () => {
    await expect(discover('mmaudet@linagora.com', deps({}))).rejects.toMatchObject({ code: 'network' });
  });

  it('leaves out what it cannot find, and falls back to the JMAP well-known URL', async () => {
    const routes: Routes = {
      ...linagoraRoutes,
      'https://jmap.linagora.com/.well-known/jmap': () => new Response('{}', { status: 401 }),
    };
    delete routes['https://space.linagora.com/'];
    const env = await discover('mmaudet@linagora.com', deps(routes, { '_jmap._tcp.linagora.com': linagoraSrv['_jmap._tcp.linagora.com']! }));
    expect(env.services).toEqual({
      mail: { url: 'https://jmap.linagora.com/.well-known/jmap', source: 'discovered' },
      project: { url: 'https://projects.linagora.com', source: 'convention' },
    });
  });

  it('keeps a non-standard SRV port and prefers the lowest priority', async () => {
    const env = await discover(
      'mmaudet@linagora.com',
      deps(linagoraRoutes, {
        '_caldavs._tcp.linagora.com': [
          { name: 'backup.linagora.com.', port: 443, priority: 10, weight: 1 },
          { name: 'dav.linagora.com.', port: 8443, priority: 0, weight: 1 },
        ],
      }),
    );
    expect(env.services.dav).toEqual({ url: 'https://dav.linagora.com:8443/', source: 'discovered' });
  });
});

describe('completeFromUserinfo', () => {
  it('takes the Twake Drive instance from workplaceFqdn', () => {
    const env = completeFromUserinfo(linagoraEnvironment, { workplaceFqdn: 'mmaudet.twake.linagora.com' }, 'mmaudet@linagora.com');
    expect(env.cozy).toEqual({ pattern: 'https://{username}.twake.linagora.com', instance: 'https://mmaudet.twake.linagora.com' });
  });

  it('falls back to the instance pattern with the local part of the address', () => {
    expect(completeFromUserinfo(linagoraEnvironment, {}, 'MMaudet@linagora.com').cozy.instance).toBe('https://mmaudet.twake.linagora.com');
  });
});
```

- [ ] **Step 3 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/discovery.test.ts`
Expected : FAIL, module `../src/discovery.js` introuvable.

- [ ] **Step 4 : écrire `src/discovery.ts`**

```ts
import { z } from 'zod';
import { TwakeAiError } from './errors.js';
import { getJson, HttpError, send, type HttpOptions } from './http.js';
import { fetchOidcMetadata, OidcMetadataSchema } from './oidc.js';

export interface SrvRecord {
  name: string;
  port: number;
  priority: number;
  weight: number;
}

export interface DiscoveryDeps extends HttpOptions {
  resolveSrv(hostname: string): Promise<SrvRecord[]>;
}

const EndpointSchema = z.object({ url: z.string(), source: z.enum(['discovered', 'convention', 'manual']) });
export type Endpoint = z.infer<typeof EndpointSchema>;

export const TwakeEnvironmentSchema = z.object({
  domain: z.string(),
  oidc: OidcMetadataSchema,
  matrix: z.object({ homeserver: z.string(), tom: z.string().optional() }),
  services: z.object({
    mail: EndpointSchema.optional(),
    dav: EndpointSchema.optional(),
    space: EndpointSchema.optional(),
    project: EndpointSchema.optional(),
  }),
  cozy: z.object({ pattern: z.string().optional(), instance: z.string().optional() }),
});
export type TwakeEnvironment = z.infer<typeof TwakeEnvironmentSchema>;

const MatrixClientWellKnownSchema = z.object({
  'm.homeserver': z.object({ base_url: z.string() }),
  'm.authentication': z.object({ issuer: z.string() }).optional(),
  't.server': z.object({ base_url: z.string() }).optional(),
  'app.twake.chat': z.object({ common_settings: z.object({ application_url: z.string() }).optional() }).optional(),
});

export function emailDomain(email: string): string {
  const trimmed = email.trim();
  const at = trimmed.lastIndexOf('@');
  if (at < 1 || at === trimmed.length - 1 || /\s/.test(trimmed)) {
    throw new TwakeAiError('usage', `"${email}" is not an email address.`);
  }
  return trimmed.slice(at + 1).toLowerCase();
}

const notTwake = (domain: string) =>
  new TwakeAiError(
    'not_twake_domain',
    `${domain} does not look like a Twake.ai domain (no Matrix client discovery at https://${domain}/.well-known/matrix/client).`,
  );

/** Everything twake-ai can learn from the email address alone, before signing in. */
export async function discover(email: string, deps: DiscoveryDeps): Promise<TwakeEnvironment> {
  const domain = emailDomain(email);
  let wellKnown: z.infer<typeof MatrixClientWellKnownSchema>;
  try {
    wellKnown = MatrixClientWellKnownSchema.parse(await getJson(`https://${domain}/.well-known/matrix/client`, deps));
  } catch (error) {
    // offline is not the same as foreign: only an answer that is not a Twake.ai discovery means foreign
    if (error instanceof TwakeAiError && error.code === 'network') throw error;
    if (error instanceof HttpError || error instanceof z.ZodError || error instanceof TwakeAiError) throw notTwake(domain);
    throw error;
  }
  const issuer = wellKnown['m.authentication']?.issuer;
  if (!issuer) throw notTwake(domain);
  const [oidc, mail, dav, space, project] = await Promise.all([
    fetchOidcMetadata(issuer, deps),
    discoverJmap(domain, deps),
    discoverDav(domain, deps),
    probeConvention(`https://space.${domain}`, deps),
    probeConvention(`https://projects.${domain}`, deps),
  ]);
  return {
    domain,
    oidc,
    matrix: { homeserver: wellKnown['m.homeserver'].base_url, tom: wellKnown['t.server']?.base_url },
    services: { mail, dav, space, project },
    cozy: { pattern: cozyPattern(wellKnown['app.twake.chat']?.common_settings?.application_url) },
  };
}

/** After sign-in: the exact Twake Drive (cozy) instance, from the workplaceFqdn claim or the instance pattern. */
export function completeFromUserinfo(env: TwakeEnvironment, userinfo: Record<string, unknown>, email: string): TwakeEnvironment {
  const fqdn = typeof userinfo.workplaceFqdn === 'string' ? userinfo.workplaceFqdn.trim() : '';
  const trimmed = email.trim();
  const localPart = trimmed.slice(0, trimmed.lastIndexOf('@')).toLowerCase();
  const instance = fqdn
    ? `https://${fqdn.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
    : env.cozy.pattern?.replace('{username}', localPart);
  return { ...env, cozy: { ...env.cozy, instance } };
}

/** `https://{username}-settings.twake.linagora.com/` → `https://{username}.twake.linagora.com` */
function cozyPattern(settingsUrl: string | undefined): string | undefined {
  const match = settingsUrl ? /^(https:\/\/)\{username\}-settings\.([^/]+)\/?$/.exec(settingsUrl) : null;
  return match ? `${match[1]}{username}.${match[2]}` : undefined;
}

async function srvBase(service: string, domain: string, deps: DiscoveryDeps): Promise<string | undefined> {
  let records: SrvRecord[];
  try {
    records = await deps.resolveSrv(`${service}.${domain}`);
  } catch {
    return undefined;
  }
  const best = [...records].sort((a, b) => a.priority - b.priority || b.weight - a.weight)[0];
  if (!best) return undefined;
  const host = best.name.replace(/\.$/, '');
  return best.port === 443 ? `https://${host}` : `https://${host}:${best.port}`;
}

async function discoverJmap(domain: string, deps: DiscoveryDeps): Promise<Endpoint | undefined> {
  const base = await srvBase('_jmap._tcp', domain, deps);
  if (!base) return undefined;
  const wellKnown = `${base}/.well-known/jmap`;
  try {
    const response = await send(wellKnown, { method: 'GET', redirect: 'manual' }, deps);
    void response.body?.cancel();
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      return { url: new URL(location, wellKnown).toString(), source: 'discovered' };
    }
  } catch {
    // the well-known URL is a valid JMAP session URL too
  }
  return { url: wellKnown, source: 'discovered' };
}

async function discoverDav(domain: string, deps: DiscoveryDeps): Promise<Endpoint | undefined> {
  const base = await srvBase('_caldavs._tcp', domain, deps);
  return base ? { url: `${base}/`, source: 'discovered' } : undefined;
}

/** Space and Project have no discovery yet: try `https://<service>.<domain>/`. */
async function probeConvention(url: string, deps: DiscoveryDeps): Promise<Endpoint | undefined> {
  try {
    const response = await send(`${url}/`, { method: 'GET', redirect: 'manual' }, { ...deps, timeoutMs: 8_000 });
    void response.body?.cancel();
    return response.status < 400 ? { url, source: 'convention' } : undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5 : lancer le test**

Run : `npx vitest run tests/discovery.test.ts`
Expected : 11 tests PASS.

- [ ] **Step 6 : commit**

```bash
git add src/discovery.ts tests/discovery.test.ts tests/fixtures/linagora
git commit -m "feat: discover Twake.ai services from the email address"
```

---

### Task 8 : retour loopback de la connexion

**Files:**
- Create: `src/loopback.ts`
- Test: `tests/loopback.test.ts`

**Interfaces:**
- Consumes : `TwakeAiError` (tâche 2).
- Produces :
  - `const LOOPBACK_PORTS = [8765, 8766, 8767]`
  - `interface LoopbackOptions { ports: number[]; state: string; timeoutMs: number; onListening(redirectUri: string): Promise<void> | void }`
  - `interface CallbackResult { code: string; redirectUri: string }`
  - `waitForCallback(options: LoopbackOptions): Promise<CallbackResult>`. Le port `0` signifie « un port libre quelconque » (tests).

- [ ] **Step 1 : écrire le test qui échoue**

`tests/loopback.test.ts` :

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForCallback } from '../src/loopback.js';

const blockers: Server[] = [];
afterEach(() => {
  for (const server of blockers.splice(0)) server.close();
});

async function occupiedPort(): Promise<number> {
  const server = createServer();
  blockers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

describe('waitForCallback', () => {
  it('returns the code sent back to the redirect URI', async () => {
    let page = '';
    const result = await waitForCallback({
      ports: [0],
      state: 'S1',
      timeoutMs: 5_000,
      onListening: async (redirectUri) => {
        const response = await fetch(`${redirectUri}?code=abc&state=S1`);
        page = await response.text();
      },
    });
    expect(result.code).toBe('abc');
    expect(result.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(page).toContain('signed in');
  });

  it('ignores a callback with another state and keeps waiting for the right one', async () => {
    const statuses: number[] = [];
    const result = await waitForCallback({
      ports: [0],
      state: 'GOOD',
      timeoutMs: 5_000,
      onListening: async (redirectUri) => {
        statuses.push((await fetch(`${redirectUri}?code=stale&state=OLD`)).status);
        statuses.push((await fetch(`${redirectUri}?code=fresh&state=GOOD`)).status);
      },
    });
    expect(statuses).toEqual([400, 200]);
    expect(result.code).toBe('fresh');
  });

  it('fails with login_cancelled when the IdP sends an error back', async () => {
    await expect(
      waitForCallback({
        ports: [0],
        state: 'S',
        timeoutMs: 5_000,
        onListening: async (redirectUri) => {
          await fetch(`${redirectUri}?error=access_denied&error_description=User%20refused&state=S`);
        },
      }),
    ).rejects.toMatchObject({ code: 'login_cancelled', message: expect.stringContaining('User refused') });
  });

  it('gives up after the timeout', async () => {
    await expect(waitForCallback({ ports: [0], state: 'S', timeoutMs: 100, onListening: () => undefined })).rejects.toMatchObject({
      code: 'login_cancelled',
    });
  });

  it('moves to the next port when one is taken', async () => {
    const busy = await occupiedPort();
    const result = await waitForCallback({
      ports: [busy, 0],
      state: 'S',
      timeoutMs: 5_000,
      onListening: async (redirectUri) => {
        await fetch(`${redirectUri}?code=c&state=S`);
      },
    });
    expect(result.redirectUri).not.toContain(`:${busy}/`);
  });

  it('fails with ports_busy when every port is taken', async () => {
    const busy = await occupiedPort();
    await expect(waitForCallback({ ports: [busy], state: 'S', timeoutMs: 1_000, onListening: () => undefined })).rejects.toMatchObject({
      code: 'ports_busy',
      message: expect.stringContaining(String(busy)),
    });
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/loopback.test.ts`
Expected : FAIL, module `../src/loopback.js` introuvable.

- [ ] **Step 3 : écrire `src/loopback.ts`**

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TwakeAiError } from './errors.js';

/** Registered at the IdP for the twake-ai-agents client: LemonLDAP may not ignore the loopback port (RFC 8252 §7.3). */
export const LOOPBACK_PORTS = [8765, 8766, 8767];

export interface LoopbackOptions {
  ports: number[];
  state: string;
  timeoutMs: number;
  /** Called once the server listens, with the redirect URI to put in the authorization request. */
  onListening(redirectUri: string): Promise<void> | void;
}

export interface CallbackResult {
  code: string;
  redirectUri: string;
}

const page = (title: string) =>
  `<!doctype html><meta charset="utf-8"><title>Twake.ai</title><body style="font-family:system-ui;margin:3rem"><h1>${title}</h1><p>You can close this tab and go back to the terminal.</p>`;

/** Serves http://127.0.0.1:<port>/callback until the IdP sends the user back with a code. */
export async function waitForCallback(options: LoopbackOptions): Promise<CallbackResult> {
  let settle!: { resolve: (result: CallbackResult) => void; reject: (error: Error) => void };
  const result = new Promise<CallbackResult>((resolve, reject) => (settle = { resolve, reject }));
  result.catch(() => undefined); // rejected before anyone awaits it: not an unhandled rejection
  let redirectUri = '';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const html = (status: number, title: string) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page(title));
    };
    if (url.pathname !== '/callback') {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.searchParams.get('state') !== options.state) {
      html(400, 'This sign-in link is not the current one');
      return;
    }
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error || !code) {
      html(400, 'Sign-in was not completed');
      const reason = url.searchParams.get('error_description') ?? error ?? 'no authorization code';
      settle.reject(new TwakeAiError('login_cancelled', `Sign-in was not completed: ${reason}.`));
      return;
    }
    html(200, 'You are signed in to Twake.ai');
    settle.resolve({ code, redirectUri });
  });

  const port = await listenOnFirstFreePort(server, options.ports);
  redirectUri = `http://127.0.0.1:${port}/callback`;
  const timer = setTimeout(() => {
    const minutes = Math.max(1, Math.round(options.timeoutMs / 60_000));
    settle.reject(new TwakeAiError('login_cancelled', `No sign-in within ${minutes} minute(s): run twake-ai login again.`));
  }, options.timeoutMs);
  try {
    await options.onListening(redirectUri);
    return await result;
  } finally {
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections();
  }
}

async function listenOnFirstFreePort(server: Server, ports: number[]): Promise<number> {
  for (const port of ports) {
    const listening = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (listening) return (server.address() as AddressInfo).port;
  }
  throw new TwakeAiError(
    'ports_busy',
    `Ports ${ports.join(', ')} are all in use on 127.0.0.1: free one of them, or run twake-ai login --no-browser.`,
  );
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/loopback.test.ts`
Expected : 6 tests PASS.

- [ ] **Step 5 : commit**

```bash
git add src/loopback.ts tests/loopback.test.ts
git commit -m "feat: loopback callback server for the browser sign-in"
```

---

### Task 9 : configuration et connexion OIDC

**Files:**
- Create: `src/config.ts`, `src/token-cache.ts`, `src/login.ts`
- Test: `tests/login.test.ts`

**Interfaces:**
- Consumes :
  - tâche 7 : `TwakeEnvironmentSchema`, `TwakeEnvironment`, `completeFromUserinfo`
  - tâche 3 : `readPrivateJson`, `writePrivateFile`
  - tâche 4 : `withLock`
  - tâche 8 : `waitForCallback`, `LOOPBACK_PORTS`
  - tâche 6 : `authorizeUrl`, `createPkce`, `randomState`, `exchangeCode`, `fetchUserinfo`, `startDeviceAuthorization`, `pollDeviceToken`, `fetchOidcMetadata`, `OidcClient`, `OidcHttp`, `TokenSet`
  - tâche 5 : `Vault`, `MemoryVault`
- Produces :
  - `src/config.ts` :
    - `DEFAULT_CLIENT_ID = 'twake-ai-agents'`, `DEFAULT_SCOPE = 'openid email profile offline_access workplaceFqdn'`
    - `ConfigSchema`
    - `type TwakeAiConfig = { version: 1; email: string; vault: 'keyring' | 'file'; oidc: { clientId: string; scope: string }; environment: TwakeEnvironment }`
    - `loadConfig(paths): Promise<TwakeAiConfig | undefined>`, `saveConfig(paths, config): Promise<void>`
  - `src/token-cache.ts` :
    - `interface CachedToken { accessToken: string; expiresAt: number }`
    - `readCachedToken(paths, grant: string): Promise<CachedToken | undefined>` (un JSON corrompu donne `undefined`)
    - `writeCachedToken(paths, grant, token): Promise<void>`
  - `src/login.ts` :
    - `OIDC_GRANT = 'oidc'`, `OIDC_REFRESH_KEY = 'oidc.refresh_token'`
    - `type LoginMode = 'browser' | 'device'`
    - `chooseLoginMode({ noBrowser, env, platform }): LoginMode`
    - `interface LoginRequest { email; environment; client: OidcClient; mode: LoginMode; ports?: number[]; timeoutMs?: number }`
    - `interface LoginDeps { paths; vault; http: OidcHttp; openUrl(url: string): Promise<void>; print(line: string): void }`
    - `loginOidc(request, deps): Promise<TwakeAiConfig>`

- [ ] **Step 1 : écrire le test qui échoue**

`tests/login.test.ts` :

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { TwakeEnvironment } from '../src/discovery.js';
import { chooseLoginMode, loginOidc, OIDC_REFRESH_KEY, type LoginDeps } from '../src/login.js';
import { fetchOidcMetadata } from '../src/oidc.js';
import { readCachedToken } from '../src/token-cache.js';
import { MemoryVault } from '../src/vault.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';
import { tempPaths } from './helpers/tmp.js';

let idp: FakeIdp;
let environment: TwakeEnvironment;

beforeEach(async () => {
  idp = await startFakeIdp();
  environment = {
    domain: 'example.com',
    oidc: await fetchOidcMetadata(idp.url),
    matrix: { homeserver: 'https://matrix.example.com/' },
    services: {},
    cozy: { pattern: 'https://{username}.twake.example.com' },
  };
});
afterEach(() => idp.close());

const client = { clientId: 'twake-ai-agents', scope: 'openid email offline_access workplaceFqdn' };

/** Plays the browser: the IdP redirects at once to the loopback callback. */
async function browser(url: string): Promise<void> {
  const atIdp = await fetch(url, { redirect: 'manual' });
  await fetch(atIdp.headers.get('location') ?? '');
}

async function deps(overrides: Partial<LoginDeps> = {}): Promise<LoginDeps & { lines: string[] }> {
  const { paths } = await tempPaths();
  const lines: string[] = [];
  let t = 1_000_000;
  return {
    paths,
    vault: new MemoryVault(),
    http: { now: () => t, sleep: async (ms) => void (t += ms / 1000) },
    openUrl: browser,
    print: (line) => lines.push(line),
    lines,
    ...overrides,
  };
}

describe('loginOidc', () => {
  it('signs in through the browser, keeps the refresh token and saves the completed configuration', async () => {
    const d = await deps();
    const config = await loginOidc({ email: ' alice@example.com ', environment, client, mode: 'browser', ports: [0] }, d);
    expect(config).toMatchObject({
      version: 1,
      email: 'alice@example.com',
      oidc: client,
      environment: { cozy: { instance: 'https://alice.twake.example.com' } },
    });
    expect(await loadConfig(d.paths)).toEqual(config);
    expect(await d.vault.get(OIDC_REFRESH_KEY)).toMatch(/^refresh-/);
    expect(await readCachedToken(d.paths, 'oidc')).toEqual({ accessToken: expect.stringMatching(/^access-/), expiresAt: 1_000_300 });
    expect(d.lines.join('\n')).toContain(`${idp.url}/authorize?`);
  });

  it('still prints the URL to open when the browser cannot be opened', async () => {
    const d = await deps({
      openUrl: async () => {
        throw new Error('no browser');
      },
    });
    const login = loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0], timeoutMs: 2_000 }, d);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const url = /(http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+)/.exec(d.lines.join('\n'))?.[1];
    expect(url).toBeDefined();
    await browser(url!);
    await expect(login).resolves.toMatchObject({ email: 'alice@example.com' });
  });

  it('signs in from another device and shows the code to enter', async () => {
    const d = await deps();
    const config = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'device' }, d);
    expect(config.environment.cozy.instance).toBe('https://alice.twake.example.com');
    expect(d.lines.join('\n')).toContain('ABCD-EFGH');
    expect(await d.vault.get(OIDC_REFRESH_KEY)).toMatch(/^refresh-/);
  });

  it('refuses a sign-in that gives no refresh token, and saves nothing', async () => {
    idp.offlineAccess = false;
    const d = await deps();
    await expect(loginOidc({ email: 'alice@example.com', environment, client, mode: 'device' }, d)).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('offline_access'),
    });
    expect(await loadConfig(d.paths)).toBeUndefined();
  });
});

describe('chooseLoginMode', () => {
  it('uses the browser on a desktop', () => {
    expect(chooseLoginMode({ noBrowser: false, env: {}, platform: 'darwin' })).toBe('browser');
    expect(chooseLoginMode({ noBrowser: false, env: {}, platform: 'win32' })).toBe('browser');
    expect(chooseLoginMode({ noBrowser: false, env: { WAYLAND_DISPLAY: 'wayland-0' }, platform: 'linux' })).toBe('browser');
  });

  it('signs in from another device over SSH, without a display, or when asked', () => {
    expect(chooseLoginMode({ noBrowser: false, env: { SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22', DISPLAY: ':0' }, platform: 'linux' })).toBe('device');
    expect(chooseLoginMode({ noBrowser: false, env: {}, platform: 'linux' })).toBe('device');
    expect(chooseLoginMode({ noBrowser: true, env: {}, platform: 'darwin' })).toBe('device');
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/login.test.ts`
Expected : FAIL, modules `../src/config.js`, `../src/login.js` et `../src/token-cache.js` introuvables.

- [ ] **Step 3 : écrire `src/config.ts`**

```ts
import { z } from 'zod';
import { TwakeEnvironmentSchema } from './discovery.js';
import { readPrivateJson, writePrivateFile } from './files.js';
import type { AppPaths } from './paths.js';

export const DEFAULT_CLIENT_ID = 'twake-ai-agents';
export const DEFAULT_SCOPE = 'openid email profile offline_access workplaceFqdn';

/** config.json: nothing secret, the secrets live in the vault. */
export const ConfigSchema = z.object({
  version: z.literal(1),
  email: z.string(),
  vault: z.enum(['keyring', 'file']),
  oidc: z.object({ clientId: z.string(), scope: z.string() }),
  environment: TwakeEnvironmentSchema,
});
export type TwakeAiConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(paths: AppPaths): Promise<TwakeAiConfig | undefined> {
  const raw = await readPrivateJson(paths.configFile);
  return raw === undefined ? undefined : ConfigSchema.parse(raw);
}

export async function saveConfig(paths: AppPaths, config: TwakeAiConfig): Promise<void> {
  await writePrivateFile(paths.configFile, `${JSON.stringify(ConfigSchema.parse(config), null, 2)}\n`);
}
```

- [ ] **Step 4 : écrire `src/token-cache.ts`**

```ts
import { join } from 'node:path';
import { readPrivateJson, writePrivateFile } from './files.js';
import type { AppPaths } from './paths.js';

export interface CachedToken {
  accessToken: string;
  /** epoch seconds */
  expiresAt: number;
}

const file = (paths: AppPaths, grant: string) => join(paths.tokensDir, `${grant}.json`);

/** The cached access token of a grant; `undefined` when missing or unreadable (the caller then refreshes). */
export async function readCachedToken(paths: AppPaths, grant: string): Promise<CachedToken | undefined> {
  let raw: unknown;
  try {
    raw = await readPrivateJson(file(paths, grant));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const token = raw as Partial<CachedToken> | undefined;
  return typeof token?.accessToken === 'string' && typeof token.expiresAt === 'number'
    ? { accessToken: token.accessToken, expiresAt: token.expiresAt }
    : undefined;
}

export async function writeCachedToken(paths: AppPaths, grant: string, token: CachedToken): Promise<void> {
  await writePrivateFile(file(paths, grant), JSON.stringify(token));
}
```

- [ ] **Step 5 : écrire `src/login.ts`**

```ts
import { saveConfig, type TwakeAiConfig } from './config.js';
import { completeFromUserinfo, type TwakeEnvironment } from './discovery.js';
import { TwakeAiError } from './errors.js';
import { withLock } from './lock.js';
import { LOOPBACK_PORTS, waitForCallback } from './loopback.js';
import {
  authorizeUrl,
  createPkce,
  exchangeCode,
  fetchUserinfo,
  pollDeviceToken,
  randomState,
  startDeviceAuthorization,
  type OidcClient,
  type OidcHttp,
  type TokenSet,
} from './oidc.js';
import type { AppPaths } from './paths.js';
import { writeCachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export const OIDC_GRANT = 'oidc';
export const OIDC_REFRESH_KEY = 'oidc.refresh_token';

export type LoginMode = 'browser' | 'device';

/** Browser sign-in when a browser can open here; otherwise sign-in from another device (RFC 8628). */
export function chooseLoginMode(o: { noBrowser: boolean; env: NodeJS.ProcessEnv; platform: NodeJS.Platform }): LoginMode {
  if (o.noBrowser || o.env.SSH_CONNECTION || o.env.SSH_TTY) return 'device';
  if (o.platform === 'linux' && !o.env.DISPLAY && !o.env.WAYLAND_DISPLAY) return 'device';
  return 'browser';
}

export interface LoginRequest {
  email: string;
  environment: TwakeEnvironment;
  client: OidcClient;
  mode: LoginMode;
  ports?: number[];
  timeoutMs?: number;
}

export interface LoginDeps {
  paths: AppPaths;
  vault: Vault;
  http: OidcHttp;
  openUrl(url: string): Promise<void>;
  print(line: string): void;
}

/** Signs in once at the IdP, keeps the refresh token in the vault and saves the completed configuration. */
export async function loginOidc(request: LoginRequest, deps: LoginDeps): Promise<TwakeAiConfig> {
  const meta = request.environment.oidc;
  const tokens = request.mode === 'browser' ? await browserLogin(request, deps) : await deviceLogin(request, deps);
  const refreshToken = tokens.refreshToken;
  if (!refreshToken) {
    throw new TwakeAiError(
      'unsupported',
      `${meta.issuer} gave no refresh token: the client "${request.client.clientId}" needs the offline_access scope.`,
    );
  }
  const userinfo = await fetchUserinfo(meta, tokens.accessToken, deps.http);
  await withLock(deps.paths.locksDir, OIDC_GRANT, async () => {
    await deps.vault.set(OIDC_REFRESH_KEY, refreshToken);
    await writeCachedToken(deps.paths, OIDC_GRANT, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
  });
  const config: TwakeAiConfig = {
    version: 1,
    email: request.email.trim(),
    vault: deps.vault.kind === 'keyring' ? 'keyring' : 'file',
    oidc: { clientId: request.client.clientId, scope: request.client.scope },
    environment: completeFromUserinfo(request.environment, userinfo, request.email),
  };
  await saveConfig(deps.paths, config);
  return config;
}

async function browserLogin(request: LoginRequest, deps: LoginDeps): Promise<TokenSet> {
  const pkce = createPkce();
  const state = randomState();
  const { code, redirectUri } = await waitForCallback({
    ports: request.ports ?? LOOPBACK_PORTS,
    state,
    timeoutMs: request.timeoutMs ?? 5 * 60_000,
    onListening: async (redirectUri) => {
      const url = authorizeUrl(request.environment.oidc, request.client, {
        redirectUri,
        state,
        challenge: pkce.challenge,
        loginHint: request.email.trim(),
      });
      deps.print(`Opening your browser to sign in. If it does not open, visit:\n  ${url}`);
      await deps.openUrl(url).catch(() => undefined);
    },
  });
  return exchangeCode(request.environment.oidc, request.client, { code, redirectUri, verifier: pkce.verifier }, deps.http);
}

async function deviceLogin(request: LoginRequest, deps: LoginDeps): Promise<TokenSet> {
  const device = await startDeviceAuthorization(request.environment.oidc, request.client, deps.http);
  deps.print(`To sign in, open ${device.verification_uri} on a phone or a computer and enter the code ${device.user_code}`);
  if (device.verification_uri_complete) deps.print(`(or open ${device.verification_uri_complete} directly)`);
  return pollDeviceToken(request.environment.oidc, request.client, device, deps.http);
}
```

- [ ] **Step 6 : lancer le test**

Run : `npx vitest run tests/login.test.ts`
Expected : 6 tests PASS.

- [ ] **Step 7 : commit**

```bash
git add src/config.ts src/token-cache.ts src/login.ts tests/login.test.ts
git commit -m "feat: OIDC sign-in (browser or other device) saving the configuration and the grant"
```

---

### Task 10 : broker de jetons

**Files:**
- Create: `src/broker.ts`, `tests/helpers/token-worker.ts`
- Test: `tests/broker.test.ts`

**Interfaces:**
- Consumes :
  - tâche 9 : `TwakeAiConfig`, `saveConfig`, `OIDC_GRANT`, `OIDC_REFRESH_KEY`, `readCachedToken`, `writeCachedToken`, `CachedToken`
  - tâche 4 : `withLock`
  - tâche 6 : `refreshTokens`, `OidcHttp`
  - tâche 5 : `Vault`, `FileVault`, `openVault`
- Produces :
  - `SERVICE_IDS = ['mail', 'dav', 'drive', 'chat', 'space', 'project'] as const`, `type ServiceId`, `isServiceId(value: string): value is ServiceId`
  - `EXPIRY_MARGIN_S = 60`
  - `interface TokenOutput { access_token: string; expires_at: number }`
  - `interface BrokerDeps { paths; config: TwakeAiConfig; vault: Vault; http: OidcHttp; now(): number }`
  - `getToken(service: ServiceId, deps: BrokerDeps): Promise<TokenOutput>` : `drive` et `chat` lèvent `TwakeAiError('unsupported')` jusqu'au plan 2

- [ ] **Step 1 : écrire le processus de test et le test qui échoue**

`tests/helpers/token-worker.ts` :

```ts
// One twake-ai process asking for a token, as an MCP server would: used by the concurrency test.
import { getToken } from '../../src/broker.js';
import { loadConfig } from '../../src/config.js';
import { appPaths } from '../../src/paths.js';
import { openVault } from '../../src/vault.js';

const paths = appPaths();
const config = await loadConfig(paths);
if (!config) throw new Error('no configuration');
const token = await getToken('mail', {
  paths,
  config,
  vault: await openVault(config.vault, paths),
  http: {},
  now: () => Math.floor(Date.now() / 1000),
});
process.stdout.write(JSON.stringify(token));
```

`tests/broker.test.ts` :

```ts
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getToken, type BrokerDeps } from '../src/broker.js';
import { saveConfig, type TwakeAiConfig } from '../src/config.js';
import { OIDC_REFRESH_KEY } from '../src/login.js';
import { fetchOidcMetadata } from '../src/oidc.js';
import { readCachedToken, writeCachedToken } from '../src/token-cache.js';
import { FileVault } from '../src/vault.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';
import { tempPaths } from './helpers/tmp.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const NOW = 2_000_000;

let idp: FakeIdp;
beforeEach(async () => {
  idp = await startFakeIdp();
});
afterEach(() => idp.close());

/** A machine where `twake-ai login` has run: configuration saved, refresh token in a file vault, no cached token. */
async function signedIn(): Promise<BrokerDeps & { root: string }> {
  const { root, paths } = await tempPaths();
  const config: TwakeAiConfig = {
    version: 1,
    email: 'alice@example.com',
    vault: 'file',
    oidc: { clientId: 'twake-ai-agents', scope: 'openid offline_access' },
    environment: {
      domain: 'example.com',
      oidc: await fetchOidcMetadata(idp.url),
      matrix: { homeserver: 'https://matrix.example.com/' },
      services: {},
      cozy: {},
    },
  };
  await saveConfig(paths, config);
  const vault = new FileVault(paths);
  await vault.set(OIDC_REFRESH_KEY, idp.issueRefreshToken());
  return { root, paths, config, vault, http: {}, now: () => NOW };
}

describe('getToken', () => {
  it('serves the cached token without contacting the IdP', async () => {
    const d = await signedIn();
    await writeCachedToken(d.paths, 'oidc', { accessToken: 'cached', expiresAt: NOW + 600 });
    expect(await getToken('project', d)).toEqual({ access_token: 'cached', expires_at: NOW + 600 });
    expect(idp.refreshCount).toBe(0);
  });

  it('refreshes when nothing is cached, keeps the rotated refresh token and caches the access token', async () => {
    const d = await signedIn();
    const before = await d.vault.get(OIDC_REFRESH_KEY);
    const token = await getToken('mail', d);
    expect(token).toEqual({ access_token: expect.stringMatching(/^access-/), expires_at: NOW + 300 });
    expect(idp.refreshCount).toBe(1);
    expect(await d.vault.get(OIDC_REFRESH_KEY)).not.toBe(before);
    expect(await readCachedToken(d.paths, 'oidc')).toEqual({ accessToken: token.access_token, expiresAt: NOW + 300 });
    expect(await getToken('dav', d)).toEqual(token);
    expect(idp.refreshCount).toBe(1);
  });

  it('refreshes a cached token that expires within 60 s', async () => {
    const d = await signedIn();
    await writeCachedToken(d.paths, 'oidc', { accessToken: 'almost-expired', expiresAt: NOW + 59 });
    expect((await getToken('space', d)).access_token).not.toBe('almost-expired');
    expect(idp.refreshCount).toBe(1);
  });

  it('refreshes instead of failing when the cache file is corrupted', async () => {
    const d = await signedIn();
    await writeCachedToken(d.paths, 'oidc', { accessToken: 'x', expiresAt: NOW + 600 });
    await writeFile(join(d.paths.tokensDir, 'oidc.json'), '{"accessToken":"x","expi');
    expect((await getToken('mail', d)).access_token).toMatch(/^access-/);
  });

  it('asks to sign in when the vault holds no refresh token', async () => {
    const d = await signedIn();
    await d.vault.delete(OIDC_REFRESH_KEY);
    await expect(getToken('mail', d)).rejects.toMatchObject({ code: 'login_required', message: expect.stringContaining('twake-ai login') });
  });

  it('asks to sign in when the IdP no longer accepts the refresh token', async () => {
    const d = await signedIn();
    await d.vault.set(OIDC_REFRESH_KEY, 'refresh-revoked');
    await expect(getToken('mail', d)).rejects.toMatchObject({ code: 'login_required' });
  });

  it('does not serve Drive and Chat tokens yet', async () => {
    const d = await signedIn();
    await expect(getToken('drive', d)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(getToken('chat', d)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('refreshes once when eight processes ask at the same moment', { timeout: 60_000 }, async () => {
    const d = await signedIn();
    const worker = join(repoRoot, 'tests', 'helpers', 'token-worker.ts');
    const outputs = await Promise.all(
      Array.from({ length: 8 }, () =>
        run(process.execPath, ['--import', 'tsx', worker], { cwd: repoRoot, env: { ...process.env, TWAKE_AI_HOME: d.root } }),
      ),
    );
    const tokens = outputs.map(({ stdout }) => (JSON.parse(stdout) as { access_token: string }).access_token);
    expect(new Set(tokens).size).toBe(1);
    expect(idp.refreshCount).toBe(1);
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/broker.test.ts`
Expected : FAIL, module `../src/broker.js` introuvable.

- [ ] **Step 3 : écrire `src/broker.ts`**

```ts
import type { TwakeAiConfig } from './config.js';
import { TwakeAiError } from './errors.js';
import { withLock } from './lock.js';
import { OIDC_GRANT, OIDC_REFRESH_KEY } from './login.js';
import { refreshTokens, type OidcHttp } from './oidc.js';
import type { AppPaths } from './paths.js';
import { readCachedToken, writeCachedToken, type CachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export const SERVICE_IDS = ['mail', 'dav', 'drive', 'chat', 'space', 'project'] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export function isServiceId(value: string): value is ServiceId {
  return (SERVICE_IDS as readonly string[]).includes(value);
}

/** A token handed to an MCP server stays valid at least this long. */
export const EXPIRY_MARGIN_S = 60;

/** What `twake-ai token` prints: the format every Twake.ai MCP server reads from *_TOKEN_COMMAND. */
export interface TokenOutput {
  access_token: string;
  expires_at: number;
}

export interface BrokerDeps {
  paths: AppPaths;
  config: TwakeAiConfig;
  vault: Vault;
  http: OidcHttp;
  /** epoch seconds */
  now(): number;
}

export async function getToken(service: ServiceId, deps: BrokerDeps): Promise<TokenOutput> {
  if (service === 'drive' || service === 'chat') {
    throw new TwakeAiError('unsupported', `This version of twake-ai does not serve ${service} tokens yet.`);
  }
  const token = await oidcAccessToken(deps);
  return { access_token: token.accessToken, expires_at: token.expiresAt };
}

/** Mail, calendar, Space and Project share one access token: the twake-ai-agents client carries their four audiences. */
async function oidcAccessToken(d: BrokerDeps): Promise<CachedToken> {
  const fresh = (token: CachedToken | undefined): token is CachedToken => token !== undefined && token.expiresAt - EXPIRY_MARGIN_S > d.now();
  const cached = await readCachedToken(d.paths, OIDC_GRANT);
  if (fresh(cached)) return cached;
  return withLock(d.paths.locksDir, OIDC_GRANT, async () => {
    // another process may have refreshed while we waited for the lock
    const again = await readCachedToken(d.paths, OIDC_GRANT);
    if (fresh(again)) return again;
    const refreshToken = await d.vault.get(OIDC_REFRESH_KEY);
    if (!refreshToken) throw new TwakeAiError('login_required', 'No Twake session on this computer: run `twake-ai login`.');
    const tokens = await refreshTokens(d.config.environment.oidc, d.config.oidc, refreshToken, { ...d.http, now: d.now });
    // the new refresh token first: once the IdP has rotated it, the old one is spent
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) await d.vault.set(OIDC_REFRESH_KEY, tokens.refreshToken);
    const token = { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
    await writeCachedToken(d.paths, OIDC_GRANT, token);
    return token;
  });
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/broker.test.ts`
Expected : 8 tests PASS. Le test de concurrence prend quelques secondes : les 8 processus démarrent avec tsx.

- [ ] **Step 5 : commit**

```bash
git add src/broker.ts tests/helpers/token-worker.ts tests/broker.test.ts
git commit -m "feat: token broker with a double-checked refresh under the lock"
```

---

### Task 11 : commandes `login` et `token`, et README

**Files:**
- Modify: `src/cli.ts` (remplacement complet)
- Create: `README.md`
- Test: `tests/cli.test.ts` (complété)

**Interfaces:**
- Consumes : toutes les tâches précédentes.
- Produces :
  - `interface CliDeps { paths; env; platform; fetch; resolveSrv; openUrl(url): Promise<void>; chooseVault(paths): Promise<Vault>; now(): number; sleep(ms): Promise<void>; loopbackPorts?: number[] }`
  - `defaultDeps(): CliDeps`
  - `main(argv: string[], io: Io, deps?: CliDeps): Promise<number>`

- [ ] **Step 1 : compléter le test qui échoue**

Remplacer `tests/cli.test.ts` par :

```ts
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliDeps, type Io } from '../src/cli.js';
import { chooseVault } from '../src/vault.js';
import { startFakeIdp, type FakeIdp } from './helpers/fake-idp.js';
import { tempPaths } from './helpers/tmp.js';

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
  const { paths } = await tempPaths();
  const clock = { t: 3_000_000 };
  const discovery = { 'm.homeserver': { base_url: 'https://matrix.example.com/' }, 'm.authentication': { issuer: idp.url } };
  return {
    clock,
    paths,
    env: {},
    platform: 'darwin',
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url === 'https://example.com/.well-known/matrix/client') return Response.json(discovery);
      if (url.startsWith(idp.url)) return fetch(input, init);
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

  it('asks to sign in first when twake-ai is not set up, with nothing on stdout', async () => {
    const io = captureIo();
    expect(await main(['token', 'mail'], io, await testDeps())).toBe(1);
    expect(io.err).toMatch(/^twake-ai: .*twake-ai login/);
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

describe('the twake-ai process', () => {
  it('exits 1 with the message on stderr and an empty stdout when not set up', { timeout: 30_000 }, async () => {
    const { root } = await tempPaths();
    const result = await run(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'token', 'mail'], {
      cwd: repoRoot,
      env: { ...process.env, TWAKE_AI_HOME: root },
    }).catch((error: { code: number; stdout: string; stderr: string }) => error);
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect((result as { stderr: string }).stderr).toContain('twake-ai login');
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/cli.test.ts`
Expected : FAIL. `main` ignore `login` et `token`, et `CliDeps` n'est pas exporté.

- [ ] **Step 3 : réécrire `src/cli.ts`**

```ts
import { resolveSrv } from 'node:dns/promises';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { getToken, isServiceId, SERVICE_IDS } from './broker.js';
import { DEFAULT_CLIENT_ID, DEFAULT_SCOPE, loadConfig } from './config.js';
import { discover, type DiscoveryDeps } from './discovery.js';
import { TwakeAiError } from './errors.js';
import { chooseLoginMode, loginOidc } from './login.js';
import { appPaths, type AppPaths } from './paths.js';
import { chooseVault, openVault, type Vault } from './vault.js';

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processIo: Io = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

export interface CliDeps {
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  fetch: typeof fetch;
  resolveSrv: DiscoveryDeps['resolveSrv'];
  openUrl(url: string): Promise<void>;
  chooseVault(paths: AppPaths): Promise<Vault>;
  /** epoch seconds */
  now(): number;
  sleep(ms: number): Promise<void>;
  loopbackPorts?: number[];
}

export function defaultDeps(): CliDeps {
  return {
    paths: appPaths(),
    env: process.env,
    platform: process.platform,
    fetch: globalThis.fetch,
    resolveSrv,
    openUrl: async (url) => {
      const { default: open } = await import('open');
      await open(url);
    },
    chooseVault: (paths) => chooseVault(paths),
    now: () => Math.floor(Date.now() / 1000),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return pkg.version;
}

const USAGE = `usage:
  twake-ai login [--email <address>] [--no-browser] [--client-id <id>] [--scope <scopes>]
  twake-ai token <${SERVICE_IDS.join('|')}>
  twake-ai --version
`;

function usageErrors<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    throw new TwakeAiError('usage', `${(error as Error).message}\n\n${USAGE}`);
  }
}

export async function main(argv: string[], io: Io, deps: CliDeps = defaultDeps()): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case '--version':
      case '-v':
        io.stdout(`${packageVersion()}\n`);
        return 0;
      case 'login':
        return await loginCommand(args, io, deps);
      case 'token':
        return await tokenCommand(args, io, deps);
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (error) {
    if (error instanceof TwakeAiError) {
      io.stderr(`twake-ai: ${error.message}\n`);
      return error.code === 'usage' ? 2 : 1;
    }
    io.stderr(`twake-ai: unexpected error: ${(error as Error).message}\n`);
    return 1;
  }
}

async function loginCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({
      args,
      options: {
        email: { type: 'string' },
        'no-browser': { type: 'boolean' },
        'client-id': { type: 'string' },
        scope: { type: 'string' },
      },
      strict: true,
    }),
  );
  const email = values.email ?? (await loadConfig(d.paths))?.email;
  if (!email) throw new TwakeAiError('usage', `--email is required the first time.\n\n${USAGE}`);
  io.stdout(`Looking up the Twake.ai services of ${email.trim()}…\n`);
  const environment = await discover(email, { fetch: d.fetch, resolveSrv: d.resolveSrv });
  for (const [service, endpoint] of Object.entries(environment.services)) {
    io.stdout(`  ${endpoint.source === 'convention' ? '~' : '✓'} ${service.padEnd(8)} ${endpoint.url}\n`);
  }
  const config = await loginOidc(
    {
      email,
      environment,
      client: {
        clientId: values['client-id'] ?? d.env.TWAKE_AI_OIDC_CLIENT_ID ?? DEFAULT_CLIENT_ID,
        scope: values.scope ?? DEFAULT_SCOPE,
      },
      mode: chooseLoginMode({ noBrowser: values['no-browser'] ?? false, env: d.env, platform: d.platform }),
      ports: d.loopbackPorts,
    },
    {
      paths: d.paths,
      vault: await d.chooseVault(d.paths),
      http: { fetch: d.fetch, now: d.now, sleep: d.sleep },
      openUrl: d.openUrl,
      print: (line) => io.stdout(`${line}\n`),
    },
  );
  const drive = config.environment.cozy.instance;
  io.stdout(`Signed in as ${config.email}.${drive ? ` Twake Drive: ${drive}` : ''}\n`);
  return 0;
}

async function tokenCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { positionals } = usageErrors(() => parseArgs({ args, options: {}, allowPositionals: true, strict: true }));
  const [service, ...extra] = positionals;
  if (!service || !isServiceId(service) || extra.length > 0) throw new TwakeAiError('usage', USAGE);
  const config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'twake-ai is not set up on this computer: run `twake-ai login --email <address>`.');
  const token = await getToken(service, {
    paths: d.paths,
    config,
    vault: await openVault(config.vault, d.paths),
    http: { fetch: d.fetch },
    now: d.now,
  });
  io.stdout(`${JSON.stringify(token)}\n`);
  return 0;
}
```

- [ ] **Step 4 : lancer tous les tests, la vérification de types et la compilation**

Run : `npm test && npm run typecheck && npm run build`
Expected : toutes les suites PASS (cli, paths, files, lock, vault, http, oidc, discovery, loopback, login, broker), `tsc` sans erreur, et `build/bin.js` présent.

- [ ] **Step 5 : écrire `README.md`**

````markdown
# twake-ai

**Connect the Twake.ai MCP servers to your AI agent with one sign-in.**

`twake-ai` is the token broker the six [Twake.ai MCP servers](https://github.com/linagora/mcp-twake-project#part-of-twakeai) refer to as `my-token-broker`. It signs you in once at your Twake.ai identity provider, keeps the refresh token in your operating system's keychain (macOS Keychain, Windows Credential Manager, Secret Service), and prints a fresh access token whenever an MCP server asks for one.

> **Status: early.** This version serves Twake Mail, Twake Calendar and contacts, Twake Space and Twake Project. Twake Drive and Twake Chat, the agent configuration (`twake-ai setup`) and the export for other agents come next.

## Requirements

- **Node.js** >= 22.13
- An account on the Twake.ai SaaS
- The OIDC client `twake-ai-agents` on your identity provider (public client, PKCE, `offline_access`, loopback redirect URIs `http://127.0.0.1:8765/callback` to `:8767`, device flow, and the audiences of the Twake.ai backends). Another client can be used with `--client-id` or `TWAKE_AI_OIDC_CLIENT_ID`.

## Sign in

```bash
npx twake-ai login --email jane.doe@example.com
```

`twake-ai` finds your Twake.ai services from your address, opens your browser to sign in, and stores the session. Over SSH or without a display it shows a code to enter from another device instead (`--no-browser` forces it).

## Use it from an MCP server

Every Twake.ai MCP server takes a command that prints a token:

```bash
claude mcp add twake-project --scope user \
  -e TWAKE_PROJECT_URL=https://projects.example.com \
  -e "TWAKE_PROJECT_TOKEN_COMMAND=twake-ai token project" \
  -e TWAKE_PROJECT_OIDC_ISSUER=https://sso.example.com/ \
  -- npx -y mcp-twake-project
```

`twake-ai token <mail|dav|space|project>` prints `{"access_token": "...", "expires_at": <epoch s>}`. It serves the cached token while it is valid for more than 60 seconds, and otherwise renews it under a lock shared by every process, so several servers in several agents never spend the same refresh token twice. When the session has expired it exits with an error that says to run `twake-ai login`.

## Files

| What | Where (Linux, macOS) |
|---|---|
| Configuration (no secret) | `~/.config/twake-ai/config.json` |
| Refresh token | the OS keychain, service `twake-ai`; otherwise `~/.config/twake-ai/secrets.json` (`0600`) |
| Cached access tokens | `~/.cache/twake-ai/tokens/` (`0600`) |

On Windows: `%APPDATA%\twake-ai` and `%LOCALAPPDATA%\twake-ai`. `TWAKE_AI_HOME` groups everything under one directory.

## Development

```bash
npm install
npm test          # Vitest, against fake servers on 127.0.0.1
npm run typecheck
npm run build     # then: node build/bin.js
```

## License

Licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

Copyright © 2026 [LINAGORA](https://linagora.com)
````

- [ ] **Step 6 : commit**

```bash
git add src/cli.ts tests/cli.test.ts README.md
git commit -m "feat: twake-ai login and twake-ai token commands"
```

---

## Vérification de fin de plan

- [ ] `npm test && npm run typecheck && npm run build` : tout passe.
- [ ] `node build/bin.js token mail` dans un `TWAKE_AI_HOME` vide : code 1, stdout vide, stderr qui dit de lancer `twake-ai login`.
- [ ] Si le client `twake-ai-agents` (ou un client de test) existe : `node build/bin.js login --email <adresse>` puis `node build/bin.js token project` sur le SaaS LINAGORA, et l'appel de userinfo avec ce jeton répond 200.
