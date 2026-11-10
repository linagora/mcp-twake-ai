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
