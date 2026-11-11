import type { CatalogContext } from '../../src/catalog.js';
import type { TwakeAiConfig } from '../../src/config.js';
import type { AppPaths } from '../../src/paths.js';

/** A signed-in account on linagora.com, with Mail, Calendar, Space and Project found, Drive and a Chat device for hermes. */
export const sampleConfig: TwakeAiConfig = {
  version: 1,
  email: 'jdoe@linagora.com',
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

export function sampleContext(paths: AppPaths, platform: NodeJS.Platform = process.platform): CatalogContext {
  return { config: sampleConfig, paths, nodePath: '/usr/bin/node', cliPath: '/opt/twake-ai/build/bin.js', platform, language: 'en', timezone: 'UTC' };
}
