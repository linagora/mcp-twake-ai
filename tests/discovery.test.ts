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
    expect(await discover('jdoe@linagora.com', deps(linagoraRoutes, linagoraSrv))).toEqual(linagoraEnvironment);
  });

  it('accepts an address typed with spaces and capitals', async () => {
    expect((await discover('  JDoe@Linagora.COM ', deps(linagoraRoutes, linagoraSrv))).domain).toBe('linagora.com');
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
    await expect(discover('jdoe@linagora.com', deps({}))).rejects.toMatchObject({ code: 'network' });
  });

  it('leaves out what it cannot find, and falls back to the JMAP well-known URL', async () => {
    const routes: Routes = {
      ...linagoraRoutes,
      'https://jmap.linagora.com/.well-known/jmap': () => new Response('{}', { status: 401 }),
    };
    delete routes['https://space.linagora.com/'];
    const env = await discover('jdoe@linagora.com', deps(routes, { '_jmap._tcp.linagora.com': linagoraSrv['_jmap._tcp.linagora.com']! }));
    expect(env.services).toEqual({
      mail: { url: 'https://jmap.linagora.com/.well-known/jmap', source: 'discovered' },
      project: { url: 'https://projects.linagora.com', source: 'convention' },
    });
  });

  it('keeps a non-standard SRV port and prefers the lowest priority', async () => {
    const env = await discover(
      'jdoe@linagora.com',
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
    const env = completeFromUserinfo(linagoraEnvironment, { workplaceFqdn: 'jdoe.twake.linagora.com' }, 'jdoe@linagora.com');
    expect(env.cozy).toEqual({ pattern: 'https://{username}.twake.linagora.com', instance: 'https://jdoe.twake.linagora.com' });
  });

  it('falls back to the instance pattern with the local part of the address', () => {
    expect(completeFromUserinfo(linagoraEnvironment, {}, 'JDoe@linagora.com').cozy.instance).toBe('https://jdoe.twake.linagora.com');
  });
});

describe('discover: endpoint safety and fallbacks', () => {
  const matrixClient = fixture('matrix-client.json') as Record<string, unknown>;
  const withWellKnown = (body: unknown): Routes => ({ ...linagoraRoutes, 'https://linagora.com/.well-known/matrix/client': () => Response.json(body) });

  it('refuses an identity provider announced in plain http', async () => {
    const routes = withWellKnown({ ...matrixClient, 'm.authentication': { issuer: 'http://sso.linagora.com/' } });
    await expect(discover('jdoe@linagora.com', deps(routes, linagoraSrv))).rejects.toMatchObject({ code: 'insecure_endpoint' });
  });

  it('refuses a homeserver announced in plain http', async () => {
    const routes = withWellKnown({ ...matrixClient, 'm.homeserver': { base_url: 'http://matrix.linagora.com/' } });
    await expect(discover('jdoe@linagora.com', deps(routes, linagoraSrv))).rejects.toMatchObject({ code: 'insecure_endpoint' });
  });

  it('ignores a JMAP redirect to plain http and uses /jmap/session', async () => {
    const routes: Routes = {
      ...linagoraRoutes,
      'https://jmap.linagora.com/.well-known/jmap': () => new Response(null, { status: 302, headers: { location: 'http://jmap.linagora.com/jmap/session' } }),
    };
    expect((await discover('jdoe@linagora.com', deps(routes, linagoraSrv))).services.mail).toEqual({
      url: 'https://jmap.linagora.com/jmap/session',
      source: 'discovered',
    });
  });

  it('falls back to /jmap/session when the JMAP well-known URL does not exist', async () => {
    const routes: Routes = { ...linagoraRoutes, 'https://jmap.linagora.com/.well-known/jmap': () => new Response('Not found', { status: 404 }) };
    expect((await discover('jdoe@linagora.com', deps(routes, linagoraSrv))).services.mail).toEqual({
      url: 'https://jmap.linagora.com/jmap/session',
      source: 'discovered',
    });
  });

  it('says the domain is unavailable, not foreign, when its discovery answers 503', async () => {
    const routes: Routes = { 'https://linagora.com/.well-known/matrix/client': () => new Response('down', { status: 503 }) };
    await expect(discover('jdoe@linagora.com', deps(routes))).rejects.toMatchObject({ code: 'unavailable' });
  });
});

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

describe('discover: host names', () => {
  it('ignores SRV targets that are not plain host names, whatever they end with', async () => {
    const env = await discover(
      'jdoe@linagora.com',
      deps(linagoraRoutes, {
        '_jmap._tcp.linagora.com': [{ name: 'attacker.example/.linagora.com', port: 443, priority: 0, weight: 1 }],
        '_caldavs._tcp.linagora.com': [{ name: 'attacker.example#.linagora.com', port: 443, priority: 0, weight: 1 }],
      }),
    );
    expect(env.services.mail).toBeUndefined();
    expect(env.services.dav).toBeUndefined();
  });

  it('refuses an email domain that is not a plain host name', () => {
    for (const bad of ['<jdoe@linagora.com>', 'jdoe@attacker.example/x', 'jdoe@linagora.com#x', 'jdoe@linagora..com']) {
      expect(() => emailDomain(bad)).toThrow(expect.objectContaining({ code: 'usage' }));
    }
  });
});
