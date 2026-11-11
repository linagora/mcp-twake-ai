import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

/** An OIDC provider on 127.0.0.1 with the endpoints mcp-twake-ai uses, and knobs to misbehave. */
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
  /** merged into the discovery document (another issuer, an http endpoint…) */
  metadataOverrides: Record<string, unknown>;
  /** the token endpoint answers 307 to this URL */
  redirectTokenTo: string | undefined;
  /** requests received on /capture (where a followed redirect would land) */
  captured: number;
  /** the token endpoint answers this HTTP status (503…) */
  tokenFailureStatus: number | undefined;
  /** the token endpoint rejects the client (invalid_client) */
  rejectClient: boolean;
  expiresInAsString: boolean;
  omitAccessToken: boolean;
  deviceVerificationUri: string | undefined;
  /** client_id and scope of the last authorization or device request */
  lastClientId: string | undefined;
  lastScope: string | undefined;
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
    metadataOverrides: {},
    redirectTokenTo: undefined,
    captured: 0,
    tokenFailureStatus: undefined,
    rejectClient: false,
    expiresInAsString: false,
    omitAccessToken: false,
    deviceVerificationUri: undefined,
    lastClientId: undefined,
    lastScope: undefined,
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
    const body: Record<string, unknown> = { token_type: 'Bearer' };
    if (!idp.omitAccessToken) body.access_token = access;
    if (idp.expiresIn !== undefined) body.expires_in = idp.expiresInAsString ? String(idp.expiresIn) : idp.expiresIn;
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
          ...idp.metadataOverrides,
        });
      case '/authorize': {
        // the user is already signed in at the IdP: straight back with a code
        const code = token('code');
        idp.lastClientId = url.searchParams.get('client_id') ?? undefined;
        idp.lastScope = url.searchParams.get('scope') ?? undefined;
        const redirectUri = url.searchParams.get('redirect_uri') ?? '';
        codes.set(code, { challenge: url.searchParams.get('code_challenge') ?? '', redirectUri });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      case '/device': {
        devicePolls = 0;
        idp.lastClientId = form.get('client_id') ?? undefined;
        idp.lastScope = form.get('scope') ?? undefined;
        const verification = idp.deviceVerificationUri ?? `${idp.url}/activate`;
        return json(200, {
          device_code: 'device-1',
          user_code: 'ABCD-EFGH',
          verification_uri: verification,
          verification_uri_complete: `${verification}?user_code=ABCD-EFGH`,
          expires_in: 600,
          interval: 5,
        });
      }
      case '/capture':
        idp.captured++;
        return json(200, { access_token: 'stolen', expires_in: 300 });
      case '/token': {
        if (idp.redirectTokenTo) {
          res.writeHead(307, { location: idp.redirectTokenTo });
          return res.end();
        }
        if (idp.tokenFailureStatus) return json(idp.tokenFailureStatus, { error: 'temporarily_unavailable' });
        if (idp.rejectClient) return json(401, { error: 'invalid_client' });
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
