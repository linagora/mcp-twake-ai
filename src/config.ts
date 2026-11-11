import { z } from 'zod';
import { TwakeEnvironmentSchema } from './discovery.js';
import { TwakeAiError } from './errors.js';
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
  /** Twake Drive: the OAuth client registered on the instance (secrets in the vault) and the apps of the organization */
  drive: z.object({ clientId: z.string(), apps: z.array(z.string()) }).optional(),
  /** Twake Chat: one Matrix device per agent */
  chat: z.record(z.string(), z.object({ userId: z.string(), deviceId: z.string() })).optional(),
  /** what mcp-twake-ai wrote into each agent: entry name → fingerprint (spec §10.1, it only touches its own entries) */
  agents: z.record(z.string(), z.object({ entries: z.record(z.string(), z.string()) })).optional(),
});
export type TwakeAiConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(paths: AppPaths): Promise<TwakeAiConfig | undefined> {
  const damaged = new TwakeAiError('damaged_file', `${paths.configFile} is damaged: delete it, then run \`mcp-twake-ai login --email <address>\`.`);
  let raw: unknown;
  try {
    raw = await readPrivateJson(paths.configFile);
  } catch (error) {
    if (error instanceof SyntaxError) throw damaged;
    throw error;
  }
  if (raw === undefined) return undefined;
  const config = ConfigSchema.safeParse(raw);
  if (!config.success) throw damaged;
  return config.data;
}

export async function saveConfig(paths: AppPaths, config: TwakeAiConfig): Promise<void> {
  await writePrivateFile(paths.configFile, `${JSON.stringify(ConfigSchema.parse(config), null, 2)}\n`);
}
