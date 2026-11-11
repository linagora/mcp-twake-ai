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
