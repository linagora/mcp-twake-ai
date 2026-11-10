# twake-ai, plan 2 : Drive et Chat

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `twake-ai login --drive`, `twake-ai login --chat --agent <id>`, `twake-ai token drive` et `twake-ai token chat --agent <id>` : le broker sert aussi Twake Drive (OAuth cozy-stack) et Twake Chat (un device Matrix par agent).

**Architecture:** Deux nouveaux modules de protocole, sur le modèle de `oidc.ts` : `cozy.ts` (enregistrement du client, PKCE, échange, refresh, apps activées, sonde `allow_oauth_token`) et `matrix.ts` (fournisseur SSO, `m.login.token`, refresh, logout). Deux nouveaux parcours de connexion, `login-drive.ts` et `login-chat.ts`, qui passent par `obtainCallback` : retour loopback avec un navigateur, adresse collée sans navigateur. Le broker factorise son « cache, sinon renouvellement unique sous verrou » pour les trois autorisations. Les identifiants d'autorisation et les clés du coffre sont regroupés dans `grants.ts`.

**Tech Stack:** celle du plan 1 (Node ≥ 22.13, TypeScript 7, Vitest 5, zod 4, proper-lockfile, @napi-rs/keyring, open, tsx).

**Spec:** `docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md` (sections 6 étape 7, 7.1 cozy et Matrix, 7.2). Feuille de route : `docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md`.

## Global Constraints

- Toutes les contraintes du plan 1 restent valables (ESM, `.js` dans les imports, fichiers 0600, erreurs `TwakeAiError` sur une ligne, contrat de `token`, aucun réseau dans les tests, lignes d'attribution dans les commits).
- Scope cozy, repris du README de mcp-twake-drive : `io.cozy.files io.cozy.files.* io.cozy.notes io.cozy.permissions io.cozy.sharings:GET io.cozy.settings:GET io.cozy.contacts:GET`.
- Client cozy :
  - `client_name: "Twake AI"`, `software_id: "github.com/linagora/twake-ai"`, `client_kind: "desktop"` ;
  - redirections `http://127.0.0.1:8765/callback`, `:8766` et `:8767` ;
  - PKCE `S256` (pris en charge par cozy-stack, `docs/auth.md`).
- Device Matrix : `initial_device_display_name: "Twake AI · <agent>"`, et `refresh_token: true` dans `POST /login`.
- Identifiant d'agent : `^[a-z0-9][a-z0-9-]{0,31}$`, vérifié avant de toucher un fichier, une clé ou un verrou.
- Autorisations et verrous : `oidc`, `cozy`, `matrix-<agent>`.
- Clés du coffre :
  - `cozy.client_secret`, `cozy.registration_token`, `cozy.refresh_token` ;
  - `matrix.<agent>.access_token`, `matrix.<agent>.refresh_token`.
- `expires_at` annoncé par `token` : au plus 1 heure après maintenant. Un MCP redemande donc au moins toutes les heures, même pour un jeton cozy de 7 jours ou un jeton Matrix sans expiration.
- Sans navigateur, Drive et Chat passent par une **adresse collée** : on affiche l'URL à ouvrir ailleurs, puis on lit l'adresse de la page finale, qui ne se charge pas.
- `login/get_token` (MSC3882) n'est pas utilisé : `matrix.linagora.com` répond `404 M_UNRECOGNIZED` (vérifié le 2026-11-10), et le flux `m.login.token` n'annonce pas `get_login_token`.

## Review Focus

- **Adresse collée avec des espaces autour** (copier-coller depuis un téléphone) : acceptée. Une adresse d'une autre tentative est refusée avec un message clair. Test dans la tâche 1.
- **`login --drive` relancé après une autorisation abandonnée** : aucun nouveau client cozy n'est enregistré, pour ne pas multiplier les « appareils connectés » orphelins sur le compte. Test dans la tâche 5.
- **Reconnexion OIDC (`twake-ai login`) après avoir connecté Drive et Chat** : les deux connexions sont conservées. Test dans la tâche 4.
- **Synapse sans refresh tokens** : le jeton est servi quand même, comme jeton sans expiration, et annoncé pour 1 heure au plus. Test dans la tâche 4.
- **Identifiant d'agent invalide** (`Claude Code`, `../x`) : refusé avant toute lecture ou écriture. Tests dans les tâches 4 et 7.

---

### Task 1 : POST JSON et retour de connexion collé

**Files:**
- Modify: `src/http.ts` (ajout de `postJson`), `src/loopback.ts` (paramètre `param`, `parseCallbackUrl`, `obtainCallback`)
- Test: `tests/http.test.ts`, `tests/callback.test.ts`

**Interfaces:**
- Consumes : `requestJson`, `HttpOptions` (plan 1) ; `waitForCallback`, `LoopbackOptions`, `CallbackResult` (plan 1).
- Produces :
  - `postJson(url: string, body: unknown, options?: HttpOptions, headers?: Record<string,string>): Promise<unknown>` (ne suit pas les redirections)
  - `LoopbackOptions.param?: string` (`'code'` par défaut) ; `CallbackResult.code` porte la valeur de ce paramètre
  - `parseCallbackUrl(pasted: string, state: string, param?: string): string`
  - `type CallbackMode = 'browser' | 'paste'`
  - `interface CallbackRequest { mode: CallbackMode; ports: number[]; state: string; timeoutMs: number; param: string; what: string; url(redirectUri: string): string }`
  - `interface CallbackDeps { openUrl(url: string): Promise<void>; print(line: string): void; readLine(question: string): Promise<string> }`
  - `obtainCallback(request: CallbackRequest, deps: CallbackDeps): Promise<CallbackResult>`

- [ ] **Step 1 : écrire les tests qui échouent**

Ajouter à la fin de `tests/http.test.ts`, et `postJson` à l'import de `../src/http.js` :

```ts
describe('postJson', () => {
  it('sends JSON and does not follow redirects', async () => {
    let seen: RequestInit | undefined;
    const capture = (async (_url: string, init: RequestInit) => {
      seen = init;
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    expect(await postJson('https://x.example/a', { a: 1 }, { fetch: capture })).toEqual({ ok: true });
    expect(seen).toMatchObject({ method: 'POST', redirect: 'manual', body: '{"a":1}' });
    expect((seen?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
});
```

`tests/callback.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { obtainCallback, parseCallbackUrl, waitForCallback, type CallbackDeps } from '../src/loopback.js';

describe('parseCallbackUrl', () => {
  it('reads the credential of the pasted address, spaces around included', () => {
    expect(parseCallbackUrl('  http://127.0.0.1:8765/callback?state=S&code=abc \n', 'S')).toBe('abc');
    expect(parseCallbackUrl('http://127.0.0.1:8765/callback?state=S&loginToken=lt', 'S', 'loginToken')).toBe('lt');
  });

  it('refuses the address of another attempt, an error and what is not an address', () => {
    expect(() => parseCallbackUrl('http://127.0.0.1:8765/callback?state=OLD&code=abc', 'S')).toThrow(
      expect.objectContaining({ code: 'login_cancelled', message: expect.stringContaining('another sign-in attempt') }),
    );
    expect(() => parseCallbackUrl('http://127.0.0.1:8765/callback?state=S&error=access_denied', 'S')).toThrow(
      expect.objectContaining({ code: 'login_cancelled', message: expect.stringContaining('access_denied') }),
    );
    expect(() => parseCallbackUrl('code=abc', 'S')).toThrow(expect.objectContaining({ code: 'login_cancelled' }));
  });
});

describe('waitForCallback with another parameter', () => {
  it('returns the Matrix login token', async () => {
    const result = await waitForCallback({
      ports: [0],
      state: 'S',
      timeoutMs: 5_000,
      param: 'loginToken',
      onListening: async (redirectUri) => {
        await fetch(`${redirectUri}?state=S&loginToken=lt-1`);
      },
    });
    expect(result.code).toBe('lt-1');
  });
});

describe('obtainCallback', () => {
  function deps(answer: string): CallbackDeps & { lines: string[]; opened: string[] } {
    const lines: string[] = [];
    const opened: string[] = [];
    return {
      lines,
      opened,
      openUrl: async (url) => {
        opened.push(url);
        await fetch(new URL(url).searchParams.get('back') ?? '');
      },
      print: (line) => lines.push(line),
      readLine: async () => answer,
    };
  }

  it('opens the browser and waits on the loopback in browser mode', async () => {
    const d = deps('');
    const result = await obtainCallback(
      {
        mode: 'browser',
        ports: [0],
        state: 'S',
        timeoutMs: 5_000,
        param: 'code',
        what: 'Twake Drive',
        url: (redirectUri) => `https://drive.example/authorize?back=${encodeURIComponent(`${redirectUri}?state=S&code=c1`)}`,
      },
      d,
    );
    expect(result.code).toBe('c1');
    expect(d.opened).toHaveLength(1);
  });

  it('prints the address to open elsewhere and reads the pasted one in paste mode', async () => {
    const d = deps('http://127.0.0.1:8765/callback?state=S&code=c2');
    const result = await obtainCallback(
      {
        mode: 'paste',
        ports: [8765, 8766],
        state: 'S',
        timeoutMs: 5_000,
        param: 'code',
        what: 'Twake Drive',
        url: (redirectUri) => `https://drive.example/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`,
      },
      d,
    );
    expect(result).toEqual({ code: 'c2', redirectUri: 'http://127.0.0.1:8765/callback' });
    expect(d.lines.join('\n')).toContain('https://drive.example/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback');
    expect(d.opened).toEqual([]);
  });
});
```

- [ ] **Step 2 : lancer les tests pour les voir échouer**

Run : `npx vitest run tests/http.test.ts tests/callback.test.ts`
Expected : FAIL, `postJson`, `parseCallbackUrl` et `obtainCallback` ne sont pas exportés.

- [ ] **Step 3 : ajouter `postJson` à `src/http.ts`** (juste après `postForm`)

```ts
/** POST JSON without following redirects (Matrix and cozy-stack APIs). */
export function postJson(url: string, body: unknown, options?: HttpOptions, headers: Record<string, string> = {}): Promise<unknown> {
  return requestJson(
    url,
    { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) },
    options,
  );
}
```

- [ ] **Step 4 : généraliser `src/loopback.ts`**

Dans `LoopbackOptions`, ajouter après `timeoutMs: number;` :

```ts
  /** query parameter carrying the one-time credential: `code` (OAuth, default) or `loginToken` (Matrix SSO) */
  param?: string;
```

Dans le gestionnaire du serveur, remplacer `const code = url.searchParams.get('code');` par :

```ts
    const code = url.searchParams.get(options.param ?? 'code');
```

et `const reason = url.searchParams.get('error_description') ?? error ?? 'no authorization code';` par :

```ts
      const reason = url.searchParams.get('error_description') ?? error ?? `no ${options.param ?? 'code'} in the answer`;
```

Ajouter à la fin du fichier :

```ts
/** The credential of an address pasted by the user, after checking it belongs to this attempt. */
export function parseCallbackUrl(pasted: string, state: string, param = 'code'): string {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new TwakeAiError('login_cancelled', 'This is not the address of the page: run the command again and paste the whole address.');
  }
  if (url.searchParams.get('state') !== state) {
    throw new TwakeAiError('login_cancelled', 'This address belongs to another sign-in attempt: run the command again.');
  }
  const value = url.searchParams.get(param);
  const error = url.searchParams.get('error');
  if (error || !value) {
    throw new TwakeAiError('login_cancelled', `Sign-in was not completed: ${url.searchParams.get('error_description') ?? error ?? `no ${param} in the address`}.`);
  }
  return value;
}

export type CallbackMode = 'browser' | 'paste';

export interface CallbackRequest {
  mode: CallbackMode;
  ports: number[];
  state: string;
  timeoutMs: number;
  param: string;
  /** what is being connected, for the messages ("Twake Drive", "Twake Chat for hermes") */
  what: string;
  /** the address to open, built from the redirect URI */
  url(redirectUri: string): string;
}

export interface CallbackDeps {
  openUrl(url: string): Promise<void>;
  print(line: string): void;
  readLine(question: string): Promise<string>;
}

/** With a browser: loopback callback. Without: the user opens the address elsewhere and pastes the final one back. */
export async function obtainCallback(request: CallbackRequest, deps: CallbackDeps): Promise<CallbackResult> {
  if (request.mode === 'paste') {
    const redirectUri = `http://127.0.0.1:${request.ports[0]}/callback`;
    deps.print(`To connect ${request.what}, open this address on a phone or a computer:\n  ${request.url(redirectUri)}`);
    deps.print('After signing in, the browser ends on a page that cannot load: copy its address from the address bar.');
    const pasted = await deps.readLine('Address of that page: ');
    return { code: parseCallbackUrl(pasted, request.state, request.param), redirectUri };
  }
  return waitForCallback({
    ports: request.ports,
    state: request.state,
    timeoutMs: request.timeoutMs,
    param: request.param,
    onListening: async (redirectUri) => {
      const url = request.url(redirectUri);
      deps.print(`Opening your browser to connect ${request.what}. If it does not open, visit:\n  ${url}`);
      await deps.openUrl(url).catch(() => undefined);
    },
  });
}
```

- [ ] **Step 5 : lancer les tests**

Run : `npx vitest run tests/http.test.ts tests/callback.test.ts tests/loopback.test.ts`
Expected : tout PASS (les tests loopback du plan 1 inclus).

- [ ] **Step 6 : commit**

```bash
git add src/http.ts src/loopback.ts tests/http.test.ts tests/callback.test.ts
git commit -m "feat: JSON posts and sign-in callbacks pasted from another device"
```

---

### Task 2 : protocole cozy-stack

**Files:**
- Create: `src/cozy.ts`, `tests/helpers/fake-cozy.ts`
- Test: `tests/cozy.test.ts`

**Interfaces:**
- Consumes : `getJson`, `postForm`, `postJson`, `requestJson`, `parseAnswer`, `requireSecureUrl`, `HttpError`, `HttpOptions` (`src/http.ts`) ; `OidcHttp`, `TokenSet` (`src/oidc.ts`) ; `TwakeAiError`.
- Produces :
  - `COZY_SCOPE: string`, `COZY_SOFTWARE_ID = 'github.com/linagora/twake-ai'`
  - `interface CozyClient { clientId: string; clientSecret: string; registrationToken: string }`
  - `registerCozyClient(instance, redirectUris: string[], http?): Promise<CozyClient>`
  - `cozyAuthorizeUrl(instance, { clientId, redirectUri, state, challenge }): string`
  - `tokenExpiry(accessToken: string, expiresIn: number | null | undefined, now: number): number`
  - `exchangeCozyCode(instance, client, { code, verifier }, http?: OidcHttp): Promise<TokenSet>`
  - `refreshCozy(instance, client, refreshToken, http?: OidcHttp): Promise<TokenSet>` : `login_required` (« `twake-ai login --drive` ») sur un 4xx
  - `oidcExchangeEnabled(instance, http?): Promise<boolean>`
  - `exchangeOidcForCozy(instance, client, oidcToken, http?: OidcHttp): Promise<TokenSet>`
  - `deleteCozyClient(instance, client, http?): Promise<void>`
  - `fetchPlatformApps(instance, accessToken, http?): Promise<string[]>`
  - (test) `startFakeCozy(): Promise<FakeCozy>`

- [ ] **Step 1 : écrire le faux cozy-stack**

`tests/helpers/fake-cozy.ts` :

```ts
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A cozy-stack instance on 127.0.0.1 with the /auth, /oidc and /settings routes twake-ai uses. */
export interface FakeCozy {
  url: string;
  refreshCount: number;
  registrations: number;
  deleted: string[];
  apps: string[];
  /** allow_oauth_token: POST /oidc/access_token exchanges an IdP token */
  oidcExchange: boolean;
  /** IdP tokens received by /oidc/access_token */
  oidcTokens: string[];
  /** exp claim of the JWT access tokens it issues */
  tokenExp: number;
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

export async function startFakeCozy(): Promise<FakeCozy> {
  const clients = new Map<string, { secret: string; registration: string }>();
  const codes = new Map<string, { clientId: string; challenge: string }>();
  const refreshTokens = new Map<string, string>(); // refresh token → client id
  const accessTokens = new Set<string>();
  const id = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;

  const cozy: FakeCozy = {
    url: '',
    refreshCount: 0,
    registrations: 0,
    deleted: [],
    apps: ['mail', 'chat', 'space', 'project'],
    oidcExchange: false,
    oidcTokens: [],
    tokenExp: 4_000_000_000,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const issue = (clientId: string, withRefresh: boolean) => {
    const payload = Buffer.from(JSON.stringify({ exp: cozy.tokenExp, aud: 'access' })).toString('base64url');
    const access = `cozy-access.${payload}.${randomBytes(4).toString('hex')}`;
    accessTokens.add(access);
    const body: Record<string, unknown> = { access_token: access, token_type: 'bearer', scope: 'io.cozy.files' };
    if (withRefresh) {
      const refresh = id('cozy-refresh');
      refreshTokens.set(refresh, clientId);
      body.refresh_token = refresh;
    }
    return body;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', cozy.url);
    const raw = req.method === 'POST' ? await readBody(req) : '';
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');

    if (req.method === 'POST' && url.pathname === '/auth/register') {
      const body = JSON.parse(raw) as { redirect_uris?: string[] };
      const clientId = id('client');
      const entry = { secret: id('secret'), registration: id('registration') };
      clients.set(clientId, entry);
      cozy.registrations++;
      return json(201, {
        client_id: clientId,
        client_secret: entry.secret,
        registration_access_token: entry.registration,
        redirect_uris: body.redirect_uris,
        grant_types: ['authorization_code', 'refresh_token'],
      });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/auth/register/')) {
      const clientId = decodeURIComponent(url.pathname.slice('/auth/register/'.length));
      if (clients.get(clientId)?.registration !== bearer) return json(401, { error: 'unauthorized' });
      clients.delete(clientId);
      cozy.deleted.push(clientId);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/auth/authorize') {
      // the user is signed in through the IdP and accepts the permissions at once
      const clientId = url.searchParams.get('client_id') ?? '';
      if (!clients.has(clientId) || url.searchParams.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request' });
      const code = id('code');
      codes.set(code, { clientId, challenge: url.searchParams.get('code_challenge') ?? '' });
      const back = new URL(url.searchParams.get('redirect_uri') ?? '');
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      back.searchParams.set('code', code);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/auth/access_token') {
      const form = new URLSearchParams(raw);
      const clientId = form.get('client_id') ?? '';
      if (clients.get(clientId)?.secret !== form.get('client_secret')) return json(400, { error: 'invalid client' });
      if (form.get('grant_type') === 'authorization_code') {
        const entry = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const challenge = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!entry || entry.clientId !== clientId || entry.challenge !== challenge) return json(400, { error: 'invalid code' });
        return json(200, issue(clientId, true));
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (refreshTokens.get(form.get('refresh_token') ?? '') !== clientId) return json(400, { error: 'invalid refresh token' });
        cozy.refreshCount++;
        return json(200, issue(clientId, false)); // cozy-stack keeps the refresh token
      }
      return json(400, { error: 'unsupported grant type' });
    }
    if (req.method === 'POST' && url.pathname === '/oidc/access_token') {
      const body = JSON.parse(raw) as { client_id?: string; client_secret?: string; oidc_token?: string };
      if (!cozy.oidcExchange) return json(400, { error: 'this endpoint is not enabled' });
      if (clients.get(body.client_id ?? '')?.secret !== body.client_secret) return json(400, { error: 'the client must be registered' });
      cozy.oidcTokens.push(body.oidc_token ?? '');
      return json(200, issue(body.client_id ?? '', true));
    }
    if (req.method === 'GET' && url.pathname === '/settings/context') {
      if (!accessTokens.has(bearer)) return json(401, { error: 'unauthorized' });
      return json(200, { data: { type: 'io.cozy.settings', id: 'io.cozy.settings.context', attributes: { additional_platform_apps: cozy.apps } } });
    }
    return json(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cozy.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return cozy;
}
```

- [ ] **Step 2 : écrire le test qui échoue**

`tests/cozy.test.ts` :

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COZY_SCOPE,
  cozyAuthorizeUrl,
  deleteCozyClient,
  exchangeCozyCode,
  exchangeOidcForCozy,
  fetchPlatformApps,
  oidcExchangeEnabled,
  refreshCozy,
  registerCozyClient,
  tokenExpiry,
  type CozyClient,
} from '../src/cozy.js';
import { createPkce } from '../src/oidc.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';

let cozy: FakeCozy;
let client: CozyClient;

beforeEach(async () => {
  cozy = await startFakeCozy();
  client = await registerCozyClient(cozy.url, ['http://127.0.0.1:8765/callback']);
});
afterEach(() => cozy.close());

/** Plays the browser: cozy-stack redirects at once with the code. */
async function codeFor(url: string): Promise<string> {
  const response = await fetch(url, { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '').searchParams.get('code') ?? '';
}

async function signedIn(): Promise<{ accessToken: string; refreshToken: string }> {
  const pkce = createPkce();
  const code = await codeFor(cozyAuthorizeUrl(cozy.url, { clientId: client.clientId, redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: pkce.challenge }));
  const tokens = await exchangeCozyCode(cozy.url, client, { code, verifier: pkce.verifier });
  return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken ?? '' };
}

describe('registration and authorization', () => {
  it('registers a client and keeps its secret and registration token', () => {
    expect(client).toEqual({
      clientId: expect.stringMatching(/^client-/),
      clientSecret: expect.stringMatching(/^secret-/),
      registrationToken: expect.stringMatching(/^registration-/),
    });
  });

  it('builds the authorization URL with PKCE and the Drive scope', () => {
    const url = new URL(cozyAuthorizeUrl(cozy.url, { clientId: 'c', redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: 'ch' }));
    expect(url.pathname).toBe('/auth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'c',
      redirect_uri: 'http://127.0.0.1:8765/callback',
      scope: COZY_SCOPE,
      state: 's',
      code_challenge: 'ch',
      code_challenge_method: 'S256',
    });
  });

  it('exchanges the code for tokens that expire with the JWT', async () => {
    const pkce = createPkce();
    const code = await codeFor(cozyAuthorizeUrl(cozy.url, { clientId: client.clientId, redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: pkce.challenge }));
    const tokens = await exchangeCozyCode(cozy.url, client, { code, verifier: pkce.verifier }, { now: () => 1000 });
    expect(tokens).toEqual({ accessToken: expect.stringMatching(/^cozy-access/), refreshToken: expect.stringMatching(/^cozy-refresh/), expiresAt: 4_000_000_000 });
  });

  it('refuses a code whose verifier does not match', async () => {
    const code = await codeFor(cozyAuthorizeUrl(cozy.url, { clientId: client.clientId, redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: createPkce().challenge }));
    await expect(exchangeCozyCode(cozy.url, client, { code, verifier: createPkce().verifier })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an instance in plain http outside this computer', async () => {
    await expect(registerCozyClient('http://alice.twake.example.com', [])).rejects.toMatchObject({ code: 'insecure_endpoint' });
  });
});

describe('tokens', () => {
  it('keeps the refresh token, which cozy-stack does not rotate', async () => {
    const { refreshToken } = await signedIn();
    const tokens = await refreshCozy(cozy.url, client, refreshToken);
    expect(tokens.refreshToken).toBe(refreshToken);
    expect(cozy.refreshCount).toBe(1);
  });

  it('asks to connect Drive again when the refresh token is refused', async () => {
    await expect(refreshCozy(cozy.url, client, 'cozy-refresh-unknown')).rejects.toMatchObject({
      code: 'login_required',
      message: expect.stringContaining('twake-ai login --drive'),
    });
  });

  it('computes the expiry from expires_in, else the JWT exp claim, else 5 minutes', () => {
    const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
    expect(tokenExpiry('opaque', 3600, 1000)).toBe(4600);
    expect(tokenExpiry(jwt({ exp: 9000 }), undefined, 1000)).toBe(9000);
    expect(tokenExpiry(jwt({ exp: 500 }), undefined, 1000)).toBe(1300);
    expect(tokenExpiry('opaque', null, 1000)).toBe(1300);
  });
});

describe('IdP token exchange (allow_oauth_token)', () => {
  it('detects that the exchange is disabled, as on the LINAGORA SaaS', async () => {
    expect(await oidcExchangeEnabled(cozy.url)).toBe(false);
  });

  it('detects that it is enabled, and exchanges the IdP token', async () => {
    cozy.oidcExchange = true;
    expect(await oidcExchangeEnabled(cozy.url)).toBe(true);
    const tokens = await exchangeOidcForCozy(cozy.url, client, 'idp-access');
    expect(tokens.refreshToken).toMatch(/^cozy-refresh/);
    expect(cozy.oidcTokens).toEqual(['idp-access']);
  });
});

describe('context and unregistration', () => {
  it('reads the platform apps enabled for the organization', async () => {
    const { accessToken } = await signedIn();
    expect(await fetchPlatformApps(cozy.url, accessToken)).toEqual(['mail', 'chat', 'space', 'project']);
  });

  it('deletes the client with its registration token', async () => {
    await deleteCozyClient(cozy.url, client);
    expect(cozy.deleted).toEqual([client.clientId]);
  });
});
```

- [ ] **Step 3 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/cozy.test.ts`
Expected : FAIL, module `../src/cozy.js` introuvable.

- [ ] **Step 4 : écrire `src/cozy.ts`**

```ts
import { z } from 'zod';
import { TwakeAiError } from './errors.js';
import { getJson, HttpError, parseAnswer, postForm, postJson, requestJson, requireSecureUrl, type HttpOptions } from './http.js';
import type { OidcHttp, TokenSet } from './oidc.js';

/** The permissions mcp-twake-drive needs (its README). */
export const COZY_SCOPE =
  'io.cozy.files io.cozy.files.* io.cozy.notes io.cozy.permissions io.cozy.sharings:GET io.cozy.settings:GET io.cozy.contacts:GET';
export const COZY_SOFTWARE_ID = 'github.com/linagora/twake-ai';

export interface CozyClient {
  clientId: string;
  clientSecret: string;
  registrationToken: string;
}

const nowS = () => Math.floor(Date.now() / 1000);
const DEFAULT_TTL_S = 300;

const RegistrationSchema = z.object({
  client_id: z.string(),
  client_secret: z.string(),
  registration_access_token: z.string(),
});

/** Registers twake-ai on the Twake Drive instance: it shows up as "Twake AI" in the connected devices. */
export async function registerCozyClient(instance: string, redirectUris: string[], http: HttpOptions = {}): Promise<CozyClient> {
  const url = `${requireSecureUrl(instance, 'The Twake Drive instance')}/auth/register`;
  const body = { redirect_uris: redirectUris, client_name: 'Twake AI', software_id: COZY_SOFTWARE_ID, client_kind: 'desktop' };
  const answer = parseAnswer(RegistrationSchema, await postJson(url, body, http), url);
  return { clientId: answer.client_id, clientSecret: answer.client_secret, registrationToken: answer.registration_access_token };
}

export function cozyAuthorizeUrl(instance: string, p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const url = new URL(`${instance}/auth/authorize`);
  const params = {
    response_type: 'code',
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: COZY_SCOPE,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

const CozyTokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).nullish(),
});

/** cozy-stack rarely sends expires_in: its access tokens are JWTs that carry their own exp claim. */
export function tokenExpiry(accessToken: string, expiresIn: number | null | undefined, now: number): number {
  if (expiresIn) return now + expiresIn;
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp === 'number' && payload.exp > now) return payload.exp;
  } catch {
    // not a JWT
  }
  return now + DEFAULT_TTL_S;
}

function toTokens(raw: unknown, now: number, url: string): TokenSet {
  const t = parseAnswer(CozyTokenSchema, raw, url);
  return { accessToken: t.access_token, refreshToken: t.refresh_token ?? undefined, expiresAt: tokenExpiry(t.access_token, t.expires_in, now) };
}

export async function exchangeCozyCode(instance: string, client: CozyClient, p: { code: string; verifier: string }, http: OidcHttp = {}): Promise<TokenSet> {
  const url = `${instance}/auth/access_token`;
  const form = {
    grant_type: 'authorization_code',
    code: p.code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code_verifier: p.verifier,
  };
  return toTokens(await postForm(url, form, http), (http.now ?? nowS)(), url);
}

export async function refreshCozy(instance: string, client: CozyClient, refreshToken: string, http: OidcHttp = {}): Promise<TokenSet> {
  const url = `${instance}/auth/access_token`;
  let raw: unknown;
  try {
    raw = await postForm(url, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret }, http);
  } catch (error) {
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      throw new TwakeAiError('login_required', 'Your Twake Drive connection has expired or was revoked: run `twake-ai login --drive`.');
    }
    throw error;
  }
  const tokens = toTokens(raw, (http.now ?? nowS)(), url);
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

/** allow_oauth_token: when the instance accepts an IdP token, Drive connects without a browser. Probed with dummy values. */
export async function oidcExchangeEnabled(instance: string, http: HttpOptions = {}): Promise<boolean> {
  try {
    await postJson(`${instance}/oidc/access_token`, { client_id: 'probe', client_secret: 'probe', scope: COZY_SCOPE, oidc_token: 'probe' }, http);
    return true;
  } catch (error) {
    return error instanceof HttpError && !error.body.includes('this endpoint is not enabled');
  }
}

export async function exchangeOidcForCozy(instance: string, client: CozyClient, oidcToken: string, http: OidcHttp = {}): Promise<TokenSet> {
  const url = `${instance}/oidc/access_token`;
  const body = { client_id: client.clientId, client_secret: client.clientSecret, scope: COZY_SCOPE, oidc_token: oidcToken };
  return toTokens(await postJson(url, body, http), (http.now ?? nowS)(), url);
}

export async function deleteCozyClient(instance: string, client: CozyClient, http: HttpOptions = {}): Promise<void> {
  await requestJson(
    `${instance}/auth/register/${encodeURIComponent(client.clientId)}`,
    { method: 'DELETE', redirect: 'manual', headers: { authorization: `Bearer ${client.registrationToken}` } },
    http,
  );
}

const ContextSchema = z.object({
  data: z.object({ attributes: z.object({ additional_platform_apps: z.array(z.string()).optional() }) }),
});

/** The Twake.ai apps enabled for the organization (mail, chat, space, project…). */
export async function fetchPlatformApps(instance: string, accessToken: string, http: HttpOptions = {}): Promise<string[]> {
  const url = `${instance}/settings/context`;
  const answer = parseAnswer(ContextSchema, await getJson(url, http, { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.api+json' }), url);
  return answer.data.attributes.additional_platform_apps ?? [];
}
```

- [ ] **Step 5 : lancer le test**

Run : `npx vitest run tests/cozy.test.ts`
Expected : 12 tests PASS.

- [ ] **Step 6 : commit**

```bash
git add src/cozy.ts tests/helpers/fake-cozy.ts tests/cozy.test.ts
git commit -m "feat: cozy-stack OAuth client for Twake Drive"
```

---

### Task 3 : protocole Matrix

**Files:**
- Create: `src/matrix.ts`, `tests/helpers/fake-synapse.ts`
- Test: `tests/matrix.test.ts`

**Interfaces:**
- Consumes : `getJson`, `postJson`, `requestJson`, `parseAnswer`, `HttpError`, `HttpOptions` ; `OidcHttp` ; `TwakeAiError`.
- Produces :
  - `ssoProvider(homeserver, http?): Promise<string | undefined>` : `unsupported` sans `m.login.sso`
  - `ssoRedirectUrl(homeserver, idp: string | undefined, redirectUrl: string): string`
  - `interface MatrixSession { userId: string; deviceId: string; accessToken: string; refreshToken?: string; expiresAt?: number }`
  - `loginWithToken(homeserver, loginToken, deviceName, http?: OidcHttp): Promise<MatrixSession>`
  - `refreshMatrix(homeserver, refreshToken, agent, http?: OidcHttp): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }>` : `login_required` (« `twake-ai login --chat --agent <agent>` ») sur un 401 ou 403
  - `logoutMatrix(homeserver, accessToken, http?): Promise<void>`
  - (test) `startFakeSynapse(): Promise<FakeSynapse>`

- [ ] **Step 1 : écrire le faux Synapse**

`tests/helpers/fake-synapse.ts` :

```ts
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A Synapse homeserver on 127.0.0.1 with SSO login, login tokens, refresh and logout. */
export interface FakeSynapse {
  url: string;
  /** id of the SSO identity provider; undefined: a single unnamed provider */
  idpId: string | undefined;
  /** false: no m.login.sso flow at all */
  sso: boolean;
  /** false: /login answers without refresh token (refreshable tokens disabled) */
  refreshableTokens: boolean;
  deviceNames: Record<string, string>;
  loggedOut: string[];
  refreshCount: number;
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

export async function startFakeSynapse(): Promise<FakeSynapse> {
  const loginTokens = new Set<string>();
  const refreshTokens = new Map<string, string>(); // refresh token → device
  const accessTokens = new Map<string, string>(); // access token → device
  let devices = 0;
  const token = (prefix: string) => `${prefix}-${randomBytes(6).toString('hex')}`;

  const synapse: FakeSynapse = {
    url: '',
    idpId: 'oidc-twake',
    sso: true,
    refreshableTokens: true,
    deviceNames: {},
    loggedOut: [],
    refreshCount: 0,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const session = (device: string, withRefresh: boolean) => {
    const access = token('syt');
    accessTokens.set(access, device);
    const body: Record<string, unknown> = { access_token: access };
    if (withRefresh) {
      const refresh = token('syr');
      refreshTokens.set(refresh, device);
      body.refresh_token = refresh;
      body.expires_in_ms = 300_000;
    }
    return body;
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', synapse.url);
    const body = req.method === 'POST' ? (JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>) : {};
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');

    if (req.method === 'GET' && url.pathname === '/_matrix/client/v3/login') {
      const flows: unknown[] = [{ type: 'm.login.token' }, { type: 'm.login.password' }];
      if (synapse.sso) flows.unshift({ type: 'm.login.sso', ...(synapse.idpId ? { identity_providers: [{ id: synapse.idpId, name: 'Connect with Twake' }] } : {}) });
      return json(200, { flows });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/_matrix/client/v3/login/sso/redirect')) {
      // the user is signed in at the IdP and confirms at once
      const loginToken = token('loginToken');
      loginTokens.add(loginToken);
      const back = new URL(url.searchParams.get('redirectUrl') ?? '');
      back.searchParams.set('loginToken', loginToken);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/_matrix/client/v3/login') {
      if (body.type !== 'm.login.token' || !loginTokens.delete(String(body.token))) return json(403, { errcode: 'M_FORBIDDEN', error: 'Invalid login token' });
      const device = `DEVICE${++devices}`;
      synapse.deviceNames[device] = String(body.initial_device_display_name ?? '');
      return json(200, { user_id: '@alice:example.com', device_id: device, ...session(device, synapse.refreshableTokens && body.refresh_token === true) });
    }
    if (req.method === 'POST' && url.pathname === '/_matrix/client/v3/refresh') {
      const device = refreshTokens.get(String(body.refresh_token));
      if (!device) return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown refresh token', soft_logout: true });
      refreshTokens.delete(String(body.refresh_token));
      synapse.refreshCount++;
      return json(200, session(device, true));
    }
    if (req.method === 'POST' && url.pathname === '/_matrix/client/v3/logout') {
      const device = accessTokens.get(bearer);
      if (!device) return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token' });
      synapse.loggedOut.push(device);
      return json(200, {});
    }
    return json(404, { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  synapse.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return synapse;
}
```

- [ ] **Step 2 : écrire le test qui échoue**

`tests/matrix.test.ts` :

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginWithToken, logoutMatrix, refreshMatrix, ssoProvider, ssoRedirectUrl } from '../src/matrix.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';

let synapse: FakeSynapse;
beforeEach(async () => {
  synapse = await startFakeSynapse();
});
afterEach(() => synapse.close());

/** Plays the browser through the SSO redirect and returns the login token sent back. */
async function loginTokenFor(idp: string | undefined): Promise<string> {
  const response = await fetch(ssoRedirectUrl(synapse.url, idp, 'http://127.0.0.1:8765/callback?state=S'), { redirect: 'manual' });
  return new URL(response.headers.get('location') ?? '').searchParams.get('loginToken') ?? '';
}

describe('single sign-on', () => {
  it('finds the identity provider of the SSO flow', async () => {
    expect(await ssoProvider(synapse.url)).toBe('oidc-twake');
    synapse.idpId = undefined;
    expect(await ssoProvider(synapse.url)).toBeUndefined();
  });

  it('says so when the homeserver offers no single sign-on', async () => {
    synapse.sso = false;
    await expect(ssoProvider(synapse.url)).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('builds the redirect URL, with or without a named provider', () => {
    expect(ssoRedirectUrl('https://matrix.example.com/', 'oidc-twake', 'http://127.0.0.1:8765/callback?state=S')).toBe(
      'https://matrix.example.com/_matrix/client/v3/login/sso/redirect/oidc-twake?redirectUrl=http%3A%2F%2F127.0.0.1%3A8765%2Fcallback%3Fstate%3DS',
    );
    expect(ssoRedirectUrl('https://matrix.example.com', undefined, 'http://x/cb')).toBe(
      'https://matrix.example.com/_matrix/client/v3/login/sso/redirect?redirectUrl=http%3A%2F%2Fx%2Fcb',
    );
  });
});

describe('sessions', () => {
  it('logs a new device in with the login token, asking for a refresh token', async () => {
    const session = await loginWithToken(synapse.url, await loginTokenFor('oidc-twake'), 'Twake AI · hermes', { now: () => 1000 });
    expect(session).toEqual({
      userId: '@alice:example.com',
      deviceId: 'DEVICE1',
      accessToken: expect.stringMatching(/^syt-/),
      refreshToken: expect.stringMatching(/^syr-/),
      expiresAt: 1300,
    });
    expect(synapse.deviceNames).toEqual({ DEVICE1: 'Twake AI · hermes' });
  });

  it('gets a token without expiry when the homeserver gives no refresh token', async () => {
    synapse.refreshableTokens = false;
    const session = await loginWithToken(synapse.url, await loginTokenFor('oidc-twake'), 'Twake AI · hermes');
    expect(session.refreshToken).toBeUndefined();
    expect(session.expiresAt).toBeUndefined();
  });

  it('refreshes the access token and rotates the refresh token', async () => {
    const session = await loginWithToken(synapse.url, await loginTokenFor('oidc-twake'), 'Twake AI · hermes');
    const renewed = await refreshMatrix(synapse.url, session.refreshToken ?? '', 'hermes', { now: () => 2000 });
    expect(renewed).toEqual({ accessToken: expect.stringMatching(/^syt-/), refreshToken: expect.stringMatching(/^syr-/), expiresAt: 2300 });
    expect(renewed.refreshToken).not.toBe(session.refreshToken);
  });

  it('asks to reconnect the agent when the refresh token is refused', async () => {
    await expect(refreshMatrix(synapse.url, 'syr-unknown', 'hermes')).rejects.toMatchObject({
      code: 'login_required',
      message: expect.stringContaining('twake-ai login --chat --agent hermes'),
    });
  });

  it('logs a device out', async () => {
    const session = await loginWithToken(synapse.url, await loginTokenFor('oidc-twake'), 'Twake AI · hermes');
    await logoutMatrix(synapse.url, session.accessToken);
    expect(synapse.loggedOut).toEqual(['DEVICE1']);
  });
});
```

- [ ] **Step 3 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/matrix.test.ts`
Expected : FAIL, module `../src/matrix.js` introuvable.

- [ ] **Step 4 : écrire `src/matrix.ts`**

```ts
import { z } from 'zod';
import { TwakeAiError } from './errors.js';
import { getJson, HttpError, parseAnswer, postJson, requestJson, type HttpOptions } from './http.js';
import type { OidcHttp } from './oidc.js';

const nowS = () => Math.floor(Date.now() / 1000);
const base = (homeserver: string) => homeserver.replace(/\/+$/, '');

const FlowsSchema = z.object({
  flows: z.array(z.object({ type: z.string(), identity_providers: z.array(z.object({ id: z.string() })).optional() })),
});

/** The identity provider of the homeserver's single sign-on (Twake Chat: `oidc-twake`). */
export async function ssoProvider(homeserver: string, http: HttpOptions = {}): Promise<string | undefined> {
  const url = `${base(homeserver)}/_matrix/client/v3/login`;
  const sso = parseAnswer(FlowsSchema, await getJson(url, http), url).flows.find((flow) => flow.type === 'm.login.sso');
  if (!sso) throw new TwakeAiError('unsupported', `${homeserver} does not offer single sign-on: Twake Chat cannot be connected.`);
  return sso.identity_providers?.[0]?.id;
}

export function ssoRedirectUrl(homeserver: string, idp: string | undefined, redirectUrl: string): string {
  const path = idp ? `/_matrix/client/v3/login/sso/redirect/${encodeURIComponent(idp)}` : '/_matrix/client/v3/login/sso/redirect';
  const url = new URL(`${base(homeserver)}${path}`);
  url.searchParams.set('redirectUrl', redirectUrl);
  return url.toString();
}

export interface MatrixSession {
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken?: string;
  /** epoch seconds; undefined: the token does not expire */
  expiresAt?: number;
}

const LoginSchema = z.object({
  user_id: z.string(),
  device_id: z.string(),
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in_ms: z.number().nullish(),
});

/** Creates the agent's own device: the end-to-end encryption store of mcp-twake-chat is bound to it. */
export async function loginWithToken(homeserver: string, loginToken: string, deviceName: string, http: OidcHttp = {}): Promise<MatrixSession> {
  const url = `${base(homeserver)}/_matrix/client/v3/login`;
  const body = { type: 'm.login.token', token: loginToken, refresh_token: true, initial_device_display_name: deviceName };
  const answer = parseAnswer(LoginSchema, await postJson(url, body, http), url);
  const now = (http.now ?? nowS)();
  return {
    userId: answer.user_id,
    deviceId: answer.device_id,
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? undefined,
    expiresAt: answer.expires_in_ms ? now + Math.floor(answer.expires_in_ms / 1000) : undefined,
  };
}

const RefreshSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in_ms: z.number().nullish(),
});

export async function refreshMatrix(
  homeserver: string,
  refreshToken: string,
  agent: string,
  http: OidcHttp = {},
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  const url = `${base(homeserver)}/_matrix/client/v3/refresh`;
  let raw: unknown;
  try {
    raw = await postJson(url, { refresh_token: refreshToken }, http);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
      throw new TwakeAiError('login_required', `The Twake Chat session of ${agent} has expired: run \`twake-ai login --chat --agent ${agent}\`.`);
    }
    throw error;
  }
  const answer = parseAnswer(RefreshSchema, raw, url);
  const now = (http.now ?? nowS)();
  return {
    accessToken: answer.access_token,
    refreshToken: answer.refresh_token ?? undefined,
    expiresAt: answer.expires_in_ms ? now + Math.floor(answer.expires_in_ms / 1000) : undefined,
  };
}

export async function logoutMatrix(homeserver: string, accessToken: string, http: HttpOptions = {}): Promise<void> {
  await requestJson(
    `${base(homeserver)}/_matrix/client/v3/logout`,
    { method: 'POST', redirect: 'manual', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, body: '{}' },
    http,
  );
}
```

- [ ] **Step 5 : lancer le test**

Run : `npx vitest run tests/matrix.test.ts`
Expected : 8 tests PASS.

- [ ] **Step 6 : commit**

```bash
git add src/matrix.ts tests/helpers/fake-synapse.ts tests/matrix.test.ts
git commit -m "feat: Matrix single sign-on, device login, refresh and logout"
```

---

### Task 4 : autorisations Drive et Chat dans le broker

**Files:**
- Create: `src/grants.ts`
- Modify: `src/config.ts` (champs `drive` et `chat`), `src/login.ts` (constantes déplacées ; conservation de `drive` et `chat` à la reconnexion), `src/broker.ts` (remplacement complet)
- Test: `tests/grants.test.ts`, `tests/broker.test.ts` (complété), `tests/login.test.ts` (complété)

**Interfaces:**
- Consumes : `refreshCozy`, `CozyClient` (tâche 2) ; `refreshMatrix` (tâche 3) ; plan 1 : `withLock`, `readCachedToken`, `writeCachedToken`, `refreshTokens`, `loadConfig`, `saveConfig`.
- Produces :
  - `src/grants.ts` :
    - `OIDC_GRANT`, `OIDC_REFRESH_KEY`, `COZY_GRANT = 'cozy'`
    - `COZY_KEYS = { clientSecret: 'cozy.client_secret', registrationToken: 'cozy.registration_token', refreshToken: 'cozy.refresh_token' }`
    - `NEVER_EXPIRES = Number.MAX_SAFE_INTEGER`
    - `checkAgentId(agent: string): string`
    - `matrixGrant(agent): string`
    - `matrixKey(agent, kind: 'access_token' | 'refresh_token'): string`
  - `src/login.ts` réexporte `OIDC_GRANT` et `OIDC_REFRESH_KEY` (les imports du plan 1 restent valables)
  - `TwakeAiConfig.drive?: { clientId: string; apps: string[] }`, `TwakeAiConfig.chat?: Record<string, { userId: string; deviceId: string }>`
  - `TokenOutput` gagne `device_id?: string`, `user_id?: string`
  - `MAX_ADVERTISED_TTL_S = 3600`
  - `getToken(service: ServiceId, deps: BrokerDeps, agent?: string): Promise<TokenOutput>`

- [ ] **Step 1 : écrire les tests qui échouent**

`tests/grants.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { checkAgentId, matrixGrant, matrixKey } from '../src/grants.js';

describe('agent ids', () => {
  it('accepts lowercase ids with digits and dashes', () => {
    expect(checkAgentId('claude-code')).toBe('claude-code');
    expect(matrixGrant('hermes')).toBe('matrix-hermes');
    expect(matrixKey('vscode', 'refresh_token')).toBe('matrix.vscode.refresh_token');
  });

  it('refuses ids that could name another file or key', () => {
    for (const bad of ['Claude Code', '../x', 'a/b', '', '-x', 'x'.repeat(33)]) {
      expect(() => checkAgentId(bad)).toThrow(expect.objectContaining({ code: 'usage' }));
    }
  });
});
```

Ajouter à `tests/broker.test.ts` (imports compris) :

```ts
import { COZY_KEYS, matrixKey, NEVER_EXPIRES } from '../src/grants.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';
import { createPkce } from '../src/oidc.js';
import { cozyAuthorizeUrl, exchangeCozyCode, registerCozyClient } from '../src/cozy.js';
import { loginWithToken, ssoRedirectUrl } from '../src/matrix.js';
```

```ts
describe('getToken for Drive and Chat', () => {
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

  /** signedIn() plus a connected Twake Drive whose cached token is gone. */
  async function withDrive(): Promise<BrokerDeps> {
    const d = await signedIn();
    const client = await registerCozyClient(cozy.url, ['http://127.0.0.1:8765/callback']);
    const pkce = createPkce();
    const atCozy = await fetch(cozyAuthorizeUrl(cozy.url, { clientId: client.clientId, redirectUri: 'http://127.0.0.1:8765/callback', state: 's', challenge: pkce.challenge }), { redirect: 'manual' });
    const code = new URL(atCozy.headers.get('location') ?? '').searchParams.get('code') ?? '';
    const tokens = await exchangeCozyCode(cozy.url, client, { code, verifier: pkce.verifier });
    await d.vault.set(COZY_KEYS.clientSecret, client.clientSecret);
    await d.vault.set(COZY_KEYS.registrationToken, client.registrationToken);
    await d.vault.set(COZY_KEYS.refreshToken, tokens.refreshToken ?? '');
    const config = { ...d.config, environment: { ...d.config.environment, cozy: { instance: cozy.url } }, drive: { clientId: client.clientId, apps: [] } };
    await saveConfig(d.paths, config);
    return { ...d, config };
  }

  /** signedIn() plus a Chat device for hermes. */
  async function withChat(refreshable: boolean): Promise<BrokerDeps> {
    const d = await signedIn();
    synapse.refreshableTokens = refreshable;
    const atSynapse = await fetch(ssoRedirectUrl(synapse.url, 'oidc-twake', 'http://127.0.0.1:8765/callback?state=S'), { redirect: 'manual' });
    const loginToken = new URL(atSynapse.headers.get('location') ?? '').searchParams.get('loginToken') ?? '';
    const session = await loginWithToken(synapse.url, loginToken, 'Twake AI · hermes');
    await d.vault.set(matrixKey('hermes', 'access_token'), session.accessToken);
    if (session.refreshToken) await d.vault.set(matrixKey('hermes', 'refresh_token'), session.refreshToken);
    const config = {
      ...d.config,
      environment: { ...d.config.environment, matrix: { homeserver: synapse.url } },
      chat: { hermes: { userId: session.userId, deviceId: session.deviceId } },
    };
    await saveConfig(d.paths, config);
    return { ...d, config };
  }

  it('renews the Drive token once and announces it for one hour at most', async () => {
    const d = await withDrive();
    const token = await getToken('drive', d);
    expect(token).toEqual({ access_token: expect.stringMatching(/^cozy-access/), expires_at: NOW + 3600 });
    expect(await getToken('drive', d)).toEqual(token);
    expect(cozy.refreshCount).toBe(1);
  });

  it('asks to connect Drive when it is not', async () => {
    const d = await signedIn();
    await expect(getToken('drive', d)).rejects.toMatchObject({ code: 'login_required', message: expect.stringContaining('twake-ai login --drive') });
  });

  it('serves the Chat token of an agent with its device and user', async () => {
    const d = await withChat(true);
    const token = await getToken('chat', d, 'hermes');
    expect(token).toEqual({ access_token: expect.stringMatching(/^syt-/), expires_at: NOW + 300, device_id: 'DEVICE1', user_id: '@alice:example.com' });
    expect(synapse.refreshCount).toBe(1);
  });

  it('serves a Chat token without expiry, announced for one hour, when Synapse gives no refresh token', async () => {
    const d = await withChat(false);
    const token = await getToken('chat', d, 'hermes');
    expect(token).toMatchObject({ expires_at: NOW + 3600, device_id: 'DEVICE1' });
    expect(await readCachedToken(d.paths, 'matrix-hermes')).toEqual({ accessToken: token.access_token, expiresAt: NEVER_EXPIRES });
  });

  it('needs the agent for a Chat token, and a connected one', async () => {
    const d = await withChat(true);
    await expect(getToken('chat', d)).rejects.toMatchObject({ code: 'usage' });
    await expect(getToken('chat', d, 'cursor')).rejects.toMatchObject({ code: 'login_required', message: expect.stringContaining('--agent cursor') });
    await expect(getToken('chat', d, '../x')).rejects.toMatchObject({ code: 'usage' });
  });
});
```

Dans `tests/broker.test.ts`, supprimer le test `does not serve Drive and Chat tokens yet`, qui ne s'applique plus.

Ajouter à `tests/login.test.ts` :

```ts
import { saveConfig } from '../src/config.js';
```

```ts
describe('signing in again', () => {
  it('keeps the Drive and Chat connections', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    await saveConfig(d.paths, { ...first, drive: { clientId: 'client-1', apps: ['mail'] }, chat: { hermes: { userId: '@alice:example.com', deviceId: 'D1' } } });
    const again = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    expect(again.drive).toEqual({ clientId: 'client-1', apps: ['mail'] });
    expect(again.chat).toEqual({ hermes: { userId: '@alice:example.com', deviceId: 'D1' } });
  });

  it('drops them when signing in to another domain', async () => {
    const d = await deps();
    const first = await loginOidc({ email: 'alice@example.com', environment, client, mode: 'browser', ports: [0] }, d);
    await saveConfig(d.paths, { ...first, drive: { clientId: 'client-1', apps: [] } });
    const other = await loginOidc({ email: 'alice@other.example', environment: { ...environment, domain: 'other.example' }, client, mode: 'browser', ports: [0] }, d);
    expect(other.drive).toBeUndefined();
  });
});
```

- [ ] **Step 2 : lancer les tests pour les voir échouer**

Run : `npx vitest run tests/grants.test.ts tests/broker.test.ts tests/login.test.ts`
Expected : FAIL. `../src/grants.js` est introuvable, `getToken('drive')` lève `unsupported`, et `drive` est absent après la reconnexion.

- [ ] **Step 3 : écrire `src/grants.ts`**

```ts
import { TwakeAiError } from './errors.js';

/** Grants (one lock and one cached token each) and their vault keys. */
export const OIDC_GRANT = 'oidc';
export const OIDC_REFRESH_KEY = 'oidc.refresh_token';

export const COZY_GRANT = 'cozy';
export const COZY_KEYS = {
  clientSecret: 'cozy.client_secret',
  registrationToken: 'cozy.registration_token',
  refreshToken: 'cozy.refresh_token',
} as const;

/** A Matrix access token issued without a refresh token does not expire. */
export const NEVER_EXPIRES = Number.MAX_SAFE_INTEGER;

const AGENT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Agent ids name vault keys, lock files and store directories: nothing that could reach another one. */
export function checkAgentId(agent: string): string {
  if (!AGENT_ID.test(agent)) {
    throw new TwakeAiError('usage', `"${agent}" is not a valid agent id: use lowercase letters, digits and dashes (claude-code, hermes…).`);
  }
  return agent;
}

export const matrixGrant = (agent: string) => `matrix-${checkAgentId(agent)}`;

export const matrixKey = (agent: string, kind: 'access_token' | 'refresh_token') => `matrix.${checkAgentId(agent)}.${kind}`;
```

- [ ] **Step 4 : compléter `src/config.ts`**

Dans `ConfigSchema`, ajouter après `environment: TwakeEnvironmentSchema,` :

```ts
  /** Twake Drive: the OAuth client registered on the instance (secrets in the vault) and the apps of the organization */
  drive: z.object({ clientId: z.string(), apps: z.array(z.string()) }).optional(),
  /** Twake Chat: one Matrix device per agent */
  chat: z.record(z.string(), z.object({ userId: z.string(), deviceId: z.string() })).optional(),
```

- [ ] **Step 5 : modifier `src/login.ts`**

Remplacer les deux lignes

```ts
export const OIDC_GRANT = 'oidc';
export const OIDC_REFRESH_KEY = 'oidc.refresh_token';
```

par

```ts
export { OIDC_GRANT, OIDC_REFRESH_KEY };
```

Ajouter `import { OIDC_GRANT, OIDC_REFRESH_KEY } from './grants.js';` aux imports, et remplacer `import { saveConfig, type TwakeAiConfig } from './config.js';` par `import { loadConfig, saveConfig, type TwakeAiConfig } from './config.js';`.

Dans `loginOidc`, remplacer le bloc `const config: TwakeAiConfig = { … };` par :

```ts
  // signing in again must not drop Drive and Chat, unless this is another domain
  const previous = await loadConfig(deps.paths).catch(() => undefined);
  const kept = previous && previous.environment.domain === request.environment.domain ? { drive: previous.drive, chat: previous.chat } : {};
  const config: TwakeAiConfig = {
    version: 1,
    email: request.email.trim(),
    vault: deps.vault.kind === 'keyring' ? 'keyring' : 'file',
    oidc: { clientId: request.client.clientId, scope: request.client.scope },
    environment: completeFromUserinfo(request.environment, userinfo, request.email),
    ...kept,
  };
```

- [ ] **Step 6 : réécrire `src/broker.ts`**

```ts
import type { TwakeAiConfig } from './config.js';
import { refreshCozy } from './cozy.js';
import { TwakeAiError } from './errors.js';
import { COZY_GRANT, COZY_KEYS, matrixGrant, matrixKey, NEVER_EXPIRES, OIDC_GRANT, OIDC_REFRESH_KEY } from './grants.js';
import { withLock } from './lock.js';
import { refreshMatrix } from './matrix.js';
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

/** An MCP server asks again at least every hour, so a long-lived token that was revoked is noticed. */
export const MAX_ADVERTISED_TTL_S = 3600;

/** What `twake-ai token` prints: the format every Twake.ai MCP server reads from *_TOKEN_COMMAND. */
export interface TokenOutput {
  access_token: string;
  expires_at: number;
  /** Twake Chat only: the device the encryption store is bound to */
  device_id?: string;
  user_id?: string;
}

export interface BrokerDeps {
  paths: AppPaths;
  config: TwakeAiConfig;
  vault: Vault;
  http: OidcHttp;
  /** epoch seconds */
  now(): number;
}

export async function getToken(service: ServiceId, deps: BrokerDeps, agent?: string): Promise<TokenOutput> {
  if (service === 'drive') return advertise(await cozyAccessToken(deps), deps);
  if (service === 'chat') {
    if (agent === undefined) throw new TwakeAiError('usage', 'A Twake Chat token belongs to an agent: run `twake-ai token chat --agent <id>`.');
    const grant = matrixGrant(agent);
    const device = deps.config.chat?.[agent];
    if (!device) throw new TwakeAiError('login_required', `Twake Chat is not connected for ${agent}: run \`twake-ai login --chat --agent ${agent}\`.`);
    return { ...advertise(await matrixAccessToken(agent, grant, deps), deps), device_id: device.deviceId, user_id: device.userId };
  }
  return advertise(await oidcAccessToken(deps), deps);
}

function advertise(token: CachedToken, d: BrokerDeps): TokenOutput {
  return { access_token: token.accessToken, expires_at: Math.min(token.expiresAt, d.now() + MAX_ADVERTISED_TTL_S) };
}

/** The cached token of a grant, or one renewal shared by every process waiting on the grant's lock. */
async function cachedOrRenewed(d: BrokerDeps, grant: string, renew: () => Promise<CachedToken>): Promise<CachedToken> {
  const fresh = (token: CachedToken | undefined): token is CachedToken => token !== undefined && token.expiresAt - EXPIRY_MARGIN_S > d.now();
  const cached = await readCachedToken(d.paths, grant);
  if (fresh(cached)) return cached;
  return withLock(d.paths.locksDir, grant, async () => {
    // another process may have renewed while we waited for the lock
    const again = await readCachedToken(d.paths, grant);
    if (fresh(again)) return again;
    const token = await renew();
    await writeCachedToken(d.paths, grant, token);
    return token;
  });
}

/** Mail, calendar, Space and Project share one access token: the twake-ai-agents client carries their four audiences. */
function oidcAccessToken(d: BrokerDeps): Promise<CachedToken> {
  return cachedOrRenewed(d, OIDC_GRANT, async () => {
    const refreshToken = await d.vault.get(OIDC_REFRESH_KEY);
    if (!refreshToken) throw new TwakeAiError('login_required', 'No Twake session on this computer: run `twake-ai login`.');
    const tokens = await refreshTokens(d.config.environment.oidc, d.config.oidc, refreshToken, { ...d.http, now: d.now });
    // the new refresh token first: once the IdP has rotated it, the old one is spent
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) await d.vault.set(OIDC_REFRESH_KEY, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  });
}

function cozyAccessToken(d: BrokerDeps): Promise<CachedToken> {
  const instance = d.config.environment.cozy.instance;
  const drive = d.config.drive;
  const notConnected = new TwakeAiError('login_required', 'Twake Drive is not connected on this computer: run `twake-ai login --drive`.');
  if (!instance || !drive) return Promise.reject(notConnected);
  return cachedOrRenewed(d, COZY_GRANT, async () => {
    const [clientSecret, registrationToken, refreshToken] = await Promise.all([
      d.vault.get(COZY_KEYS.clientSecret),
      d.vault.get(COZY_KEYS.registrationToken),
      d.vault.get(COZY_KEYS.refreshToken),
    ]);
    if (!clientSecret || !refreshToken) throw notConnected;
    const client = { clientId: drive.clientId, clientSecret, registrationToken: registrationToken ?? '' };
    const tokens = await refreshCozy(instance, client, refreshToken, { ...d.http, now: d.now });
    if (tokens.refreshToken && tokens.refreshToken !== refreshToken) await d.vault.set(COZY_KEYS.refreshToken, tokens.refreshToken);
    return { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
  });
}

function matrixAccessToken(agent: string, grant: string, d: BrokerDeps): Promise<CachedToken> {
  return cachedOrRenewed(d, grant, async () => {
    const refreshToken = await d.vault.get(matrixKey(agent, 'refresh_token'));
    if (refreshToken) {
      const renewed = await refreshMatrix(d.config.environment.matrix.homeserver, refreshToken, agent, { ...d.http, now: d.now });
      if (renewed.refreshToken && renewed.refreshToken !== refreshToken) await d.vault.set(matrixKey(agent, 'refresh_token'), renewed.refreshToken);
      return { accessToken: renewed.accessToken, expiresAt: renewed.expiresAt ?? NEVER_EXPIRES };
    }
    const accessToken = await d.vault.get(matrixKey(agent, 'access_token'));
    if (!accessToken) throw new TwakeAiError('login_required', `Twake Chat is not connected for ${agent}: run \`twake-ai login --chat --agent ${agent}\`.`);
    return { accessToken, expiresAt: NEVER_EXPIRES };
  });
}
```

- [ ] **Step 7 : lancer les tests**

Run : `npm test && npx tsc --noEmit`
Expected : toute la suite PASS, dont `grants.test.ts` (2), les 5 nouveaux tests du broker et les 2 nouveaux tests de reconnexion ; `tsc` sans erreur.

- [ ] **Step 8 : commit**

```bash
git add src/grants.ts src/config.ts src/login.ts src/broker.ts tests/grants.test.ts tests/broker.test.ts tests/login.test.ts
git commit -m "feat: Drive and Chat grants in the token broker"
```

---

### Task 5 : connexion de Twake Drive

**Files:**
- Create: `src/login-drive.ts`
- Test: `tests/login-drive.test.ts`

**Interfaces:**
- Consumes :
  - tâche 1 : `obtainCallback`, `CallbackDeps`, `CallbackMode`
  - tâche 2 : `registerCozyClient`, `cozyAuthorizeUrl`, `exchangeCozyCode`, `oidcExchangeEnabled`, `exchangeOidcForCozy`, `fetchPlatformApps`, `CozyClient`
  - tâche 4 : `COZY_GRANT`, `COZY_KEYS`
  - plan 1 : `createPkce`, `randomState`, `withLock`, `writeCachedToken`, `saveConfig`, `LOOPBACK_PORTS`, `requireSecureUrl`
- Produces :
  - `interface DriveLoginDeps extends CallbackDeps { paths: AppPaths; vault: Vault; http: OidcHttp; oidcToken(): Promise<string> }`
  - `loginDrive(config: TwakeAiConfig, mode: CallbackMode, deps: DriveLoginDeps, ports?: number[]): Promise<TwakeAiConfig>`

- [ ] **Step 1 : écrire le test qui échoue**

`tests/login-drive.test.ts` :

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type TwakeAiConfig } from '../src/config.js';
import { COZY_KEYS } from '../src/grants.js';
import { loginDrive, type DriveLoginDeps } from '../src/login-drive.js';
import { readCachedToken } from '../src/token-cache.js';
import { MemoryVault } from '../src/vault.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';
import { tempPaths } from './helpers/tmp.js';

let cozy: FakeCozy;
beforeEach(async () => {
  cozy = await startFakeCozy();
});
afterEach(() => cozy.close());

async function setup(): Promise<{ config: TwakeAiConfig; deps: DriveLoginDeps & { lines: string[] } }> {
  const { paths } = await tempPaths();
  const config: TwakeAiConfig = {
    version: 1,
    email: 'alice@example.com',
    vault: 'file',
    oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
    environment: {
      domain: 'example.com',
      oidc: { issuer: 'https://sso.example.com', authorization_endpoint: 'https://sso.example.com/a', token_endpoint: 'https://sso.example.com/t', userinfo_endpoint: 'https://sso.example.com/u' },
      matrix: { homeserver: 'https://matrix.example.com/' },
      services: {},
      cozy: { instance: cozy.url },
    },
  };
  await saveConfig(paths, config);
  const lines: string[] = [];
  return {
    config,
    deps: {
      paths,
      vault: new MemoryVault(),
      http: {},
      lines,
      print: (line) => lines.push(line),
      // the browser: cozy-stack redirects at once to the loopback
      openUrl: async (url) => {
        const atCozy = await fetch(url, { redirect: 'manual' });
        await fetch(atCozy.headers.get('location') ?? '');
      },
      readLine: async () => '',
      oidcToken: async () => 'idp-access',
    },
  };
}

describe('loginDrive', () => {
  it('registers a client, signs in through the browser and records the apps of the organization', async () => {
    const { config, deps } = await setup();
    const updated = await loginDrive(config, 'browser', deps, [0]);
    expect(updated.drive).toEqual({ clientId: expect.stringMatching(/^client-/), apps: ['mail', 'chat', 'space', 'project'] });
    expect(await loadConfig(deps.paths)).toEqual(updated);
    expect(await deps.vault.get(COZY_KEYS.clientSecret)).toMatch(/^secret-/);
    expect(await deps.vault.get(COZY_KEYS.registrationToken)).toMatch(/^registration-/);
    expect(await deps.vault.get(COZY_KEYS.refreshToken)).toMatch(/^cozy-refresh/);
    expect(await readCachedToken(deps.paths, 'cozy')).toEqual({ accessToken: expect.stringMatching(/^cozy-access/), expiresAt: 4_000_000_000 });
  });

  it('signs in from another device with the pasted address', async () => {
    const { config, deps } = await setup();
    deps.readLine = async () => {
      const url = /(http:\/\/127\.0\.0\.1:\d+\/auth\/authorize\S+)/.exec(deps.lines.join('\n'))?.[1] ?? '';
      const atCozy = await fetch(url, { redirect: 'manual' });
      return atCozy.headers.get('location') ?? '';
    };
    const updated = await loginDrive(config, 'paste', deps, [8765]);
    expect(updated.drive?.clientId).toMatch(/^client-/);
  });

  it('does not register another client when the first authorization was abandoned', async () => {
    const { config, deps } = await setup();
    deps.openUrl = async () => undefined;
    await expect(loginDrive(config, 'browser', deps, [0], { timeoutMs: 200 })).rejects.toMatchObject({ code: 'login_cancelled' });
    const afterAbandon = (await loadConfig(deps.paths))!;
    deps.openUrl = async (url) => {
      const atCozy = await fetch(url, { redirect: 'manual' });
      await fetch(atCozy.headers.get('location') ?? '');
    };
    await loginDrive(afterAbandon, 'browser', deps, [0]);
    expect(cozy.registrations).toBe(1);
  }, 15_000);

  it('exchanges the IdP token without any browser when the instance allows it', async () => {
    cozy.oidcExchange = true;
    const { config, deps } = await setup();
    deps.openUrl = async () => {
      throw new Error('no browser expected');
    };
    const updated = await loginDrive(config, 'paste', deps, [8765]);
    expect(updated.drive?.apps).toEqual(['mail', 'chat', 'space', 'project']);
    expect(cozy.oidcTokens).toEqual(['idp-access']);
    expect(deps.lines).toEqual([]);
  });

  it('says so when the identity provider gave no Drive instance', async () => {
    const { config, deps } = await setup();
    const withoutInstance = { ...config, environment: { ...config.environment, cozy: {} } };
    await expect(loginDrive(withoutInstance, 'browser', deps, [0])).rejects.toMatchObject({ code: 'unsupported' });
  });
});
```

Le test « abandoned » passe `{ timeoutMs: 200 }` à `loginDrive` (option de l'étape 3), pour ne pas attendre les 5 minutes du loopback.

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/login-drive.test.ts`
Expected : FAIL, module `../src/login-drive.js` introuvable.

- [ ] **Step 3 : écrire `src/login-drive.ts`**

```ts
import { saveConfig, type TwakeAiConfig } from './config.js';
import {
  cozyAuthorizeUrl,
  exchangeCozyCode,
  exchangeOidcForCozy,
  fetchPlatformApps,
  oidcExchangeEnabled,
  registerCozyClient,
  type CozyClient,
} from './cozy.js';
import { TwakeAiError } from './errors.js';
import { COZY_GRANT, COZY_KEYS } from './grants.js';
import { requireSecureUrl } from './http.js';
import { withLock } from './lock.js';
import { LOOPBACK_PORTS, obtainCallback, type CallbackDeps, type CallbackMode } from './loopback.js';
import { createPkce, randomState, type OidcHttp, type TokenSet } from './oidc.js';
import type { AppPaths } from './paths.js';
import { writeCachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export interface DriveLoginDeps extends CallbackDeps {
  paths: AppPaths;
  vault: Vault;
  http: OidcHttp;
  /** a current IdP access token, for instances that accept it (allow_oauth_token) */
  oidcToken(): Promise<string>;
}

/** Connects Twake Drive: an OAuth client on the instance, then its tokens (IdP token exchange, or browser sign-in). */
export async function loginDrive(
  config: TwakeAiConfig,
  mode: CallbackMode,
  deps: DriveLoginDeps,
  ports: number[] = LOOPBACK_PORTS,
  options: { timeoutMs?: number } = {},
): Promise<TwakeAiConfig> {
  const instance = config.environment.cozy.instance;
  if (!instance) {
    throw new TwakeAiError('unsupported', 'Your identity provider did not say which Twake Drive instance is yours (workplaceFqdn): Twake Drive cannot be connected.');
  }
  requireSecureUrl(instance, 'The Twake Drive instance');
  const { client, config: registered } = await ensureClient(config, instance, ports, deps);
  const tokens = (await oidcExchangeEnabled(instance, deps.http))
    ? await exchangeOidcForCozy(instance, client, await deps.oidcToken(), deps.http)
    : await authorize(instance, client, mode, ports, options.timeoutMs ?? 5 * 60_000, deps);
  const refreshToken = tokens.refreshToken;
  if (!refreshToken) throw new TwakeAiError('unsupported', `${instance} gave no refresh token: Twake Drive cannot stay connected.`);
  await withLock(deps.paths.locksDir, COZY_GRANT, async () => {
    await deps.vault.set(COZY_KEYS.refreshToken, refreshToken);
    await writeCachedToken(deps.paths, COZY_GRANT, { accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
  });
  const apps = await fetchPlatformApps(instance, tokens.accessToken, deps.http);
  const updated: TwakeAiConfig = { ...registered, drive: { clientId: client.clientId, apps } };
  await saveConfig(deps.paths, updated);
  return updated;
}

/** Reuses the registered client; registers one, and records it at once, so a later attempt does not register another. */
async function ensureClient(
  config: TwakeAiConfig,
  instance: string,
  ports: number[],
  deps: DriveLoginDeps,
): Promise<{ client: CozyClient; config: TwakeAiConfig }> {
  const [clientSecret, registrationToken] = await Promise.all([deps.vault.get(COZY_KEYS.clientSecret), deps.vault.get(COZY_KEYS.registrationToken)]);
  if (config.drive && clientSecret && registrationToken) {
    return { client: { clientId: config.drive.clientId, clientSecret, registrationToken }, config };
  }
  const client = await registerCozyClient(instance, ports.map((port) => `http://127.0.0.1:${port}/callback`), deps.http);
  await deps.vault.set(COZY_KEYS.clientSecret, client.clientSecret);
  await deps.vault.set(COZY_KEYS.registrationToken, client.registrationToken);
  const registered: TwakeAiConfig = { ...config, drive: { clientId: client.clientId, apps: config.drive?.apps ?? [] } };
  await saveConfig(deps.paths, registered);
  return { client, config: registered };
}

async function authorize(
  instance: string,
  client: CozyClient,
  mode: CallbackMode,
  ports: number[],
  timeoutMs: number,
  deps: DriveLoginDeps,
): Promise<TokenSet> {
  const pkce = createPkce();
  const state = randomState();
  const { code } = await obtainCallback(
    {
      mode,
      ports,
      state,
      timeoutMs,
      param: 'code',
      what: 'Twake Drive',
      url: (redirectUri) => cozyAuthorizeUrl(instance, { clientId: client.clientId, redirectUri, state, challenge: pkce.challenge }),
    },
    deps,
  );
  return exchangeCozyCode(instance, client, { code, verifier: pkce.verifier }, deps.http);
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/login-drive.test.ts`
Expected : 5 tests PASS.

- [ ] **Step 5 : commit**

```bash
git add src/login-drive.ts tests/login-drive.test.ts
git commit -m "feat: connect Twake Drive (cozy OAuth client, browser or pasted address, IdP token exchange)"
```

---

### Task 6 : connexion de Twake Chat pour un agent

**Files:**
- Create: `src/login-chat.ts`
- Test: `tests/login-chat.test.ts`

**Interfaces:**
- Consumes : tâche 1 (`obtainCallback`, `CallbackDeps`, `CallbackMode`) ; tâche 3 (`ssoProvider`, `ssoRedirectUrl`, `loginWithToken`, `logoutMatrix`) ; tâche 4 (`checkAgentId`, `matrixGrant`, `matrixKey`, `NEVER_EXPIRES`) ; plan 1 (`randomState`, `withLock`, `readCachedToken`, `writeCachedToken`, `saveConfig`, `LOOPBACK_PORTS`).
- Produces :
  - `interface ChatLoginDeps extends CallbackDeps { paths: AppPaths; vault: Vault; http: OidcHttp }`
  - `loginChat(config: TwakeAiConfig, agent: string, mode: CallbackMode, deps: ChatLoginDeps, ports?: number[]): Promise<TwakeAiConfig>`

- [ ] **Step 1 : écrire le test qui échoue**

`tests/login-chat.test.ts` :

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, saveConfig, type TwakeAiConfig } from '../src/config.js';
import { matrixKey, NEVER_EXPIRES } from '../src/grants.js';
import { loginChat, type ChatLoginDeps } from '../src/login-chat.js';
import { readCachedToken } from '../src/token-cache.js';
import { MemoryVault } from '../src/vault.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';
import { tempPaths } from './helpers/tmp.js';

let synapse: FakeSynapse;
beforeEach(async () => {
  synapse = await startFakeSynapse();
});
afterEach(() => synapse.close());

async function setup(): Promise<{ config: TwakeAiConfig; deps: ChatLoginDeps & { lines: string[] } }> {
  const { paths } = await tempPaths();
  const config: TwakeAiConfig = {
    version: 1,
    email: 'alice@example.com',
    vault: 'file',
    oidc: { clientId: 'twake-ai-agents', scope: 'openid' },
    environment: {
      domain: 'example.com',
      oidc: { issuer: 'https://sso.example.com', authorization_endpoint: 'https://sso.example.com/a', token_endpoint: 'https://sso.example.com/t', userinfo_endpoint: 'https://sso.example.com/u' },
      matrix: { homeserver: synapse.url },
      services: {},
      cozy: {},
    },
  };
  await saveConfig(paths, config);
  const lines: string[] = [];
  return {
    config,
    deps: {
      paths,
      vault: new MemoryVault(),
      http: { now: () => 1000 },
      lines,
      print: (line) => lines.push(line),
      openUrl: async (url) => {
        const atSynapse = await fetch(url, { redirect: 'manual' });
        await fetch(atSynapse.headers.get('location') ?? '');
      },
      readLine: async () => '',
    },
  };
}

describe('loginChat', () => {
  it('creates a device for the agent through the browser and records it', async () => {
    const { config, deps } = await setup();
    const updated = await loginChat(config, 'hermes', 'browser', deps, [0]);
    expect(updated.chat).toEqual({ hermes: { userId: '@alice:example.com', deviceId: 'DEVICE1' } });
    expect(await loadConfig(deps.paths)).toEqual(updated);
    expect(synapse.deviceNames).toEqual({ DEVICE1: 'Twake AI · hermes' });
    expect(await deps.vault.get(matrixKey('hermes', 'refresh_token'))).toMatch(/^syr-/);
    expect(await readCachedToken(deps.paths, 'matrix-hermes')).toEqual({ accessToken: expect.stringMatching(/^syt-/), expiresAt: 1300 });
  });

  it('creates it from another device with the pasted address', async () => {
    const { config, deps } = await setup();
    deps.readLine = async () => {
      const url = /(http:\/\/127\.0\.0\.1:\d+\/_matrix\S+)/.exec(deps.lines.join('\n'))?.[1] ?? '';
      const atSynapse = await fetch(url, { redirect: 'manual' });
      return atSynapse.headers.get('location') ?? '';
    };
    const updated = await loginChat(config, 'claude-code', 'paste', deps, [8765]);
    expect(updated.chat?.['claude-code']?.deviceId).toBe('DEVICE1');
  });

  it('keeps a token without expiry when Synapse gives no refresh token', async () => {
    synapse.refreshableTokens = false;
    const { config, deps } = await setup();
    await loginChat(config, 'hermes', 'browser', deps, [0]);
    expect(await deps.vault.get(matrixKey('hermes', 'refresh_token'))).toBeUndefined();
    expect((await readCachedToken(deps.paths, 'matrix-hermes'))?.expiresAt).toBe(NEVER_EXPIRES);
  });

  it('gives each agent its own device, and logs the previous device of an agent out', async () => {
    const { config, deps } = await setup();
    const withHermes = await loginChat(config, 'hermes', 'browser', deps, [0]);
    const withBoth = await loginChat(withHermes, 'claude-code', 'browser', deps, [0]);
    expect(withBoth.chat).toEqual({
      hermes: { userId: '@alice:example.com', deviceId: 'DEVICE1' },
      'claude-code': { userId: '@alice:example.com', deviceId: 'DEVICE2' },
    });
    const again = await loginChat(withBoth, 'hermes', 'browser', deps, [0]);
    expect(again.chat?.hermes?.deviceId).toBe('DEVICE3');
    expect(synapse.loggedOut).toEqual(['DEVICE1']);
  });

  it('refuses an invalid agent id before anything else', async () => {
    const { config, deps } = await setup();
    await expect(loginChat(config, 'Claude Code', 'browser', deps, [0])).rejects.toMatchObject({ code: 'usage' });
    expect(synapse.deviceNames).toEqual({});
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/login-chat.test.ts`
Expected : FAIL, module `../src/login-chat.js` introuvable.

- [ ] **Step 3 : écrire `src/login-chat.ts`**

```ts
import { saveConfig, type TwakeAiConfig } from './config.js';
import { checkAgentId, matrixGrant, matrixKey, NEVER_EXPIRES } from './grants.js';
import { withLock } from './lock.js';
import { LOOPBACK_PORTS, obtainCallback, type CallbackDeps, type CallbackMode } from './loopback.js';
import { loginWithToken, logoutMatrix, ssoProvider, ssoRedirectUrl } from './matrix.js';
import { randomState, type OidcHttp } from './oidc.js';
import type { AppPaths } from './paths.js';
import { readCachedToken, writeCachedToken } from './token-cache.js';
import type { Vault } from './vault.js';

export interface ChatLoginDeps extends CallbackDeps {
  paths: AppPaths;
  vault: Vault;
  http: OidcHttp;
}

/** Gives the agent its own Matrix device through single sign-on, and logs the agent's previous device out. */
export async function loginChat(
  config: TwakeAiConfig,
  agent: string,
  mode: CallbackMode,
  deps: ChatLoginDeps,
  ports: number[] = LOOPBACK_PORTS,
): Promise<TwakeAiConfig> {
  const grant = matrixGrant(checkAgentId(agent));
  const homeserver = config.environment.matrix.homeserver;
  const idp = await ssoProvider(homeserver, deps.http);
  const state = randomState();
  const { code: loginToken } = await obtainCallback(
    {
      mode,
      ports,
      state,
      timeoutMs: 5 * 60_000,
      param: 'loginToken',
      what: `Twake Chat for ${agent}`,
      url: (redirectUri) => ssoRedirectUrl(homeserver, idp, `${redirectUri}?state=${encodeURIComponent(state)}`),
    },
    deps,
  );
  const session = await loginWithToken(homeserver, loginToken, `Twake AI · ${agent}`, deps.http);
  const previous = config.chat?.[agent];
  await withLock(deps.paths.locksDir, grant, async () => {
    const previousToken = previous ? ((await readCachedToken(deps.paths, grant))?.accessToken ?? (await deps.vault.get(matrixKey(agent, 'access_token')))) : undefined;
    await deps.vault.set(matrixKey(agent, 'access_token'), session.accessToken);
    if (session.refreshToken) await deps.vault.set(matrixKey(agent, 'refresh_token'), session.refreshToken);
    else await deps.vault.delete(matrixKey(agent, 'refresh_token'));
    await writeCachedToken(deps.paths, grant, { accessToken: session.accessToken, expiresAt: session.expiresAt ?? NEVER_EXPIRES });
    // best effort: an old device left behind only clutters the session list
    if (previousToken && previous?.deviceId !== session.deviceId) await logoutMatrix(homeserver, previousToken, deps.http).catch(() => undefined);
  });
  const updated: TwakeAiConfig = { ...config, chat: { ...config.chat, [agent]: { userId: session.userId, deviceId: session.deviceId } } };
  await saveConfig(deps.paths, updated);
  return updated;
}
```

- [ ] **Step 4 : lancer le test**

Run : `npx vitest run tests/login-chat.test.ts`
Expected : 5 tests PASS.

- [ ] **Step 5 : commit**

```bash
git add src/login-chat.ts tests/login-chat.test.ts
git commit -m "feat: connect Twake Chat with one Matrix device per agent"
```

---

### Task 7 : commandes `login --drive`, `login --chat`, `token drive|chat`, et README

**Files:**
- Modify: `src/cli.ts`, `tests/cli.test.ts`, `README.md`

**Interfaces:**
- Consumes : `loginDrive` (tâche 5), `loginChat` (tâche 6), `getToken(service, deps, agent?)` (tâche 4), `checkAgentId` (tâche 4).
- Produces : `CliDeps.readLine(question: string): Promise<string>`. Usage :
  - `twake-ai login --drive [--no-browser]`
  - `twake-ai login --chat --agent <id> [--no-browser]`
  - `twake-ai token chat --agent <id>`

- [ ] **Step 1 : écrire les tests qui échouent**

Dans `tests/cli.test.ts` :

1. Dans `testDeps()`, remplacer la ligne `if (url.startsWith(idp.url)) return fetch(input, init);` par :

```ts
      if (url.startsWith('http://127.0.0.1:')) return fetch(input, init);
```

et ajouter `readLine: async () => '',` juste après `loopbackPorts: [0],`.

2. Ajouter aux imports :

```ts
import { loadConfig, saveConfig } from '../src/config.js';
import { startFakeCozy, type FakeCozy } from './helpers/fake-cozy.js';
import { startFakeSynapse, type FakeSynapse } from './helpers/fake-synapse.js';
```

3. Ajouter à la fin du fichier :

```ts
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
    expect(io.err).toContain('twake-ai login --email');
  });

  it('needs an agent for Chat, a valid one, and one service at a time', async () => {
    const deps = await signedIn();
    for (const argv of [['login', '--chat'], ['token', 'chat'], ['token', 'chat', '--agent', '../x'], ['login', '--drive', '--chat', '--agent', 'hermes']]) {
      const io = captureIo();
      expect(await main(argv, io, deps)).toBe(2);
      expect(io.out).toBe('');
    }
  });

  it('asks to connect Drive before serving its tokens', async () => {
    const deps = await signedIn();
    const io = captureIo();
    expect(await main(['token', 'drive'], io, deps)).toBe(1);
    expect(io.err).toContain('twake-ai login --drive');
  });
});
```

- [ ] **Step 2 : lancer le test pour le voir échouer**

Run : `npx vitest run tests/cli.test.ts`
Expected : FAIL, `--drive`, `--chat` et `--agent` sont refusés comme options inconnues (code 2), et `readLine` n'existe pas encore.

- [ ] **Step 3 : modifier `src/cli.ts`**

1. Imports, ajouter :

```ts
import { createInterface } from 'node:readline/promises';
import { checkAgentId } from './grants.js';
import { loginChat } from './login-chat.js';
import { loginDrive } from './login-drive.js';
import { LOOPBACK_PORTS } from './loopback.js';
```

(`openVault` et `chooseLoginMode` sont déjà importés depuis le plan 1.)

2. Dans `interface CliDeps`, ajouter après `sleep(ms: number): Promise<void>;` :

```ts
  /** reads one line typed by the user (the address pasted back when there is no browser) */
  readLine(question: string): Promise<string>;
```

et dans `defaultDeps()`, après `sleep: …,` :

```ts
    readLine: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
```

3. Remplacer la constante `USAGE` par :

```ts
const USAGE = `usage:
  twake-ai login [--email <address>] [--no-browser] [--client-id <id>] [--scope <scopes>]
  twake-ai login --drive [--no-browser]
  twake-ai login --chat --agent <id> [--no-browser]
  twake-ai token <${SERVICE_IDS.join('|')}> [--agent <id>]
  twake-ai --version
`;
```

4. Dans `loginCommand`, ajouter aux `options` de `parseArgs` :

```ts
        drive: { type: 'boolean' },
        chat: { type: 'boolean' },
        agent: { type: 'string' },
```

puis, juste après l'appel à `parseArgs` :

```ts
  if (values.drive || values.chat) return connectService(values, io, d);
```

5. Ajouter après `loginCommand` :

```ts
/** login --drive / login --chat --agent <id>: connects one service on top of the Twake session. */
async function connectService(
  values: { drive?: boolean; chat?: boolean; agent?: string; 'no-browser'?: boolean },
  io: Io,
  d: CliDeps,
): Promise<number> {
  if (values.drive && values.chat) throw new TwakeAiError('usage', `Connect one service at a time.\n\n${USAGE}`);
  if (values.chat && values.agent === undefined) throw new TwakeAiError('usage', `Twake Chat is connected for one agent: add --agent <id>.\n\n${USAGE}`);
  if (values.agent !== undefined) checkAgentId(values.agent);
  const config = await loadConfig(d.paths);
  if (!config) throw new TwakeAiError('login_required', 'Sign in first: run `twake-ai login --email <address>`.');
  const vault = await openVault(config.vault, d.paths);
  const http = { fetch: d.fetch, now: d.now, sleep: d.sleep };
  const mode = chooseLoginMode({ noBrowser: values['no-browser'] ?? false, env: d.env, platform: d.platform }) === 'browser' ? 'browser' : 'paste';
  const common = { paths: d.paths, vault, http, openUrl: d.openUrl, print: (line: string) => io.stdout(`${line}\n`), readLine: d.readLine };
  const ports = d.loopbackPorts ?? LOOPBACK_PORTS;
  if (values.drive) {
    const oidcToken = async () => (await getToken('mail', { paths: d.paths, config, vault, http: { fetch: d.fetch }, now: d.now })).access_token;
    const updated = await loginDrive(config, mode, { ...common, oidcToken }, ports);
    io.stdout(`Twake Drive connected: ${updated.environment.cozy.instance}\n`);
    return 0;
  }
  const agent = values.agent ?? '';
  const updated = await loginChat(config, agent, mode, common, ports);
  const device = updated.chat?.[agent];
  io.stdout(`Twake Chat connected for ${agent} as ${device?.userId} (device ${device?.deviceId}).\n`);
  return 0;
}
```

6. Dans `tokenCommand`, remplacer

```ts
  const { positionals } = usageErrors(() => parseArgs({ args, options: {}, allowPositionals: true, strict: true }));
```

par

```ts
  const { positionals, values } = usageErrors(() =>
    parseArgs({ args, options: { agent: { type: 'string' } }, allowPositionals: true, strict: true }),
  );
  if (values.agent !== undefined) checkAgentId(values.agent);
```

et l'appel `getToken(service, { … })` par `getToken(service, { … }, values.agent)` (même objet de dépendances, avec `values.agent` en troisième argument).

- [ ] **Step 4 : lancer tous les tests, la vérification de types et la compilation**

Run : `npm test && npm run typecheck && npm run build`
Expected : toute la suite PASS, `tsc` sans erreur, build OK.

- [ ] **Step 5 : compléter `README.md`**

Remplacer le paragraphe qui commence par `> **Status: early.**` par :

```markdown
> **Status: early.** This version serves Twake Mail, Twake Calendar and contacts, Twake Space, Twake Project, Twake Drive and Twake Chat. The agent configuration (`twake-ai setup`) and the export for other agents come next.
```

Ajouter, juste avant `## Files` :

````markdown
## Twake Drive and Twake Chat

```bash
twake-ai login --drive                 # registers "Twake AI" on your Twake Drive and connects it
twake-ai login --chat --agent hermes   # gives that agent its own Twake Chat device
```

- **Twake Drive** has its own sign-in (cozy-stack OAuth). Your Twake session is already open, so the browser only asks you to accept the permissions. `twake-ai token drive` then serves Drive tokens.
- **Twake Chat** encrypts messages end to end, and the encryption keys belong to a device. Each agent therefore gets its own device, "Twake AI · <agent>", listed in your Twake Chat sessions. `twake-ai token chat --agent hermes` prints the token together with its `device_id` and `user_id`, as mcp-twake-chat expects. Signing in again for the same agent replaces its device and logs the old one out.
- **Over SSH or without a display:** `twake-ai` prints the address to open on a phone or another computer. At the end, the browser shows a page that cannot load: paste its address back into the terminal.
````

- [ ] **Step 6 : commit**

```bash
git add src/cli.ts tests/cli.test.ts README.md
git commit -m "feat: twake-ai login --drive / --chat and Drive and Chat tokens"
```

---

## Vérification de fin de plan

- [ ] `npm test && npm run typecheck && npm run build` : tout passe.
- [ ] `node build/bin.js token chat` : code 2 et usage. `node build/bin.js token drive` sans configuration : code 1, stdout vide.
- [ ] Sur le SaaS LINAGORA, une fois le client `twake-ai-agents` créé (ou avec `--client-id`) : `login`, `login --drive`, `login --chat --agent test`, puis `token drive` et `token chat --agent test`. Le device « Twake AI · test » apparaît dans les sessions Twake Chat, et le client « Twake AI » dans les appareils connectés de Twake Drive.
