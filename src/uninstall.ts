import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { planEntries, type EntryAction } from './agents/entries.js';
import { AGENT_IDS, isAgentId, type AgentAdapter, type AgentId } from './agents/types.js';
import { COZY_KEYS, matrixKey, OIDC_REFRESH_KEY } from './grants.js';
import { openVault } from './vault.js';
import type { TwakeAiConfig } from './config.js';
import { prefixDir } from './installer.js';
import { journalFile } from './journal.js';
import type { AppPaths } from './paths.js';

/** For every agent mcp-twake-ai wrote into: removing its entries (wanted: none). */
export async function uninstallPlan(config: TwakeAiConfig, adapters: Record<AgentId, AgentAdapter>): Promise<{ adapter: AgentAdapter; owned: Record<string, string>; actions: EntryAction[] }[]> {
  const plans = [];
  for (const [agent, record] of Object.entries(config.agents ?? {})) {
    if (!isAgentId(agent) || Object.keys(record.entries).length === 0) continue;
    const adapter = adapters[agent];
    plans.push({ adapter, owned: record.entries, actions: planEntries(await adapter.read(), {}, record.entries) });
  }
  return plans;
}

/**
 * Removes the private prefix, the configuration, the secrets file, the cache and the journal; the Chat stores on request.
 * keepConfig: entries left in agents stay recorded, so that uninstall --force can still remove them.
 */
export async function removeFiles(paths: AppPaths, deleteChatStores: boolean, keepConfig = false): Promise<string[]> {
  const targets = [prefixDir(paths), ...(keepConfig ? [] : [paths.configFile]), paths.vaultFile, paths.cacheDir, journalFile(paths), `${journalFile(paths)}.1`, paths.locksDir];
  if (deleteChatStores) targets.push(join(paths.dataDir, 'chat'));
  for (const target of targets) await rm(target, { recursive: true, force: true });
  return targets;
}

/** Without a readable configuration: deletes every secret mcp-twake-ai could have kept, in the keychain and in the file. */
export async function forgetSecrets(paths: AppPaths): Promise<void> {
  const keys = [OIDC_REFRESH_KEY, ...Object.values(COZY_KEYS), ...AGENT_IDS.flatMap((agent) => [matrixKey(agent, 'access_token'), matrixKey(agent, 'refresh_token')])];
  for (const kind of ['keyring', 'file'] as const) {
    try {
      const vault = await openVault(kind, paths);
      for (const key of keys) await vault.delete(key).catch(() => undefined);
    } catch {
      // that vault is not available on this computer
    }
  }
}
