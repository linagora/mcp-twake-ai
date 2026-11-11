import { z } from 'zod';
import { TwakeAiError } from './errors.js';
import { getJson, HttpError, isSecureUrl, requireSecureUrl, send, type HttpOptions } from './http.js';
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
    if (error instanceof TwakeAiError && (error.code === 'network' || error.code === 'unavailable')) throw error;
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
  const homeserver = requireSecureUrl(wellKnown['m.homeserver'].base_url, `The Matrix homeserver of ${domain}`);
  const tom = wellKnown['t.server'] && requireSecureUrl(wellKnown['t.server'].base_url, `The ToM server of ${domain}`);
  return {
    domain,
    oidc,
    matrix: { homeserver, tom },
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
  const usual: Endpoint = { url: `${base}/jmap/session`, source: 'discovered' };
  try {
    const response = await send(wellKnown, { method: 'GET', redirect: 'manual' }, deps);
    void response.body?.cancel();
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const target = new URL(location, wellKnown).toString();
      return isSecureUrl(target) ? { url: target, source: 'discovered' } : usual;
    }
    // RFC 8620 §2.2: the well-known URL is itself a session URL when it answers (401 without credentials)
    if (response.status < 400 || response.status === 401) return { url: wellKnown, source: 'discovered' };
  } catch {
    // unreachable for now: keep the usual session URL
  }
  return usual;
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
