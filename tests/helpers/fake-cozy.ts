import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** A cozy-stack instance on 127.0.0.1 with the /auth, /oidc and /settings routes mcp-twake-ai uses. */
export interface FakeCozy {
  url: string;
  refreshCount: number;
  registrations: number;
  deleted: string[];
  apps: string[];
  /** allow_oauth_token: POST /oidc/access_token exchanges an IdP token */
  oidcExchange: boolean;
  /** /oidc/access_token does not exist (404) */
  oidcMissing: boolean;
  /** the exchange itself fails for a registered client */
  oidcExchangeFails: boolean;
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
    oidcMissing: false,
    oidcExchangeFails: false,
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
    if (req.method === 'GET' && url.pathname.startsWith('/auth/register/')) {
      const clientId = decodeURIComponent(url.pathname.slice('/auth/register/'.length));
      const entry = clients.get(clientId);
      if (!entry) return json(404, { error: 'not found' });
      if (entry.registration !== bearer) return json(401, { error: 'unauthorized' });
      return json(200, { client_id: clientId, client_name: 'Twake AI' });
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
      if (cozy.oidcMissing) return json(404, { error: 'not found' });
      if (!cozy.oidcExchange) return json(400, { error: 'this endpoint is not enabled' });
      // cozy-stack validates the IdP token first (userinfo), then looks the client up
      if (!(body.oidc_token ?? '').startsWith('idp-')) return json(400, { error: 'invalid token' });
      if (clients.get(body.client_id ?? '')?.secret !== body.client_secret) return json(400, { error: 'the client must be registered' });
      if (cozy.oidcExchangeFails) return json(400, { error: 'invalid token' });
      cozy.oidcTokens.push(body.oidc_token ?? '');
      return json(200, issue(body.client_id ?? '', true));
    }
    if (req.method === 'GET' && url.pathname === '/settings/instance') {
      if (!accessTokens.has(bearer)) return json(401, { error: 'unauthorized' });
      return json(200, { data: { type: 'io.cozy.settings', id: 'io.cozy.settings.instance', attributes: { locale: 'fr', public_name: 'Alice' } } });
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
