import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { planEntries, type EntryAction } from './agents/entries.js';
import { isAgentId, type AgentAdapter, type AgentId } from './agents/types.js';
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

/** Removes the private prefix, the configuration, the secrets file, the cache and the journal; the Chat stores on request. */
export async function removeFiles(paths: AppPaths, deleteChatStores: boolean): Promise<string[]> {
  const targets = [prefixDir(paths), paths.configFile, paths.vaultFile, paths.cacheDir, journalFile(paths), `${journalFile(paths)}.1`, paths.locksDir];
  if (deleteChatStores) targets.push(join(paths.dataDir, 'chat'));
  for (const target of targets) await rm(target, { recursive: true, force: true });
  return targets;
}
