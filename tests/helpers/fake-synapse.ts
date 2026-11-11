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
  /** device id it hands out instead of DEVICE<n> */
  deviceIdOverride: string | undefined;
  /** every access token issued so far expires (as refreshable Synapse tokens do after 5 minutes) */
  expireIssuedAccessTokens(): void;
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
  const expired = new Set<string>();
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
    deviceIdOverride: undefined,
    expireIssuedAccessTokens() {
      for (const access of accessTokens.keys()) expired.add(access);
    },
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
      const device = synapse.deviceIdOverride ?? `DEVICE${++devices}`;
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
    if (req.method === 'GET' && url.pathname === '/_matrix/client/v3/account/whoami') {
      const device = accessTokens.get(bearer);
      if (!device || expired.has(bearer)) return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token', soft_logout: true });
      return json(200, { user_id: '@alice:example.com', device_id: device });
    }
    if (req.method === 'POST' && url.pathname === '/_matrix/client/v3/logout') {
      const device = accessTokens.get(bearer);
      if (!device || expired.has(bearer)) return json(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'Unknown token', soft_logout: true });
      synapse.loggedOut.push(device);
      return json(200, {});
    }
    return json(404, { errcode: 'M_UNRECOGNIZED', error: 'Unrecognized request' });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  synapse.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return synapse;
}
