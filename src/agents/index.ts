import { loadConfig, saveConfig } from '../config.js';
import { TwakeAiError } from '../errors.js';
import { withLock } from '../lock.js';
import type { AppPaths } from '../paths.js';
import type { FileRunner } from '../run-file.js';
import { claudeCodeAgent } from './claude-code.js';
import { resolvePlan, type EntryAction } from './entries.js';
import { hermesAgent } from './hermes.js';
import { claudeDesktopAgent, cursorAgent, vscodeAgent } from './json-config.js';
import { hermesHome, type Place } from './locations.js';
import { AGENT_IDS, type AgentAdapter, type AgentId } from './types.js';

export interface AgentsDeps extends Place {
  now(): Date;
  /** runs `claude`, replaceable in tests */
  run?: FileRunner;
}

/** The five agents mcp-twake-ai configures itself (spec §10.1). */
export async function createAdapters(d: AgentsDeps): Promise<Record<AgentId, AgentAdapter>> {
  const place = { platform: d.platform, env: d.env, home: d.home };
  return {
    'claude-code': claudeCodeAgent(place, d.run),
    hermes: hermesAgent(await hermesHome(place), d.now),
    'claude-desktop': claudeDesktopAgent(place, d.now),
    cursor: cursorAgent(place, d.now),
    vscode: vscodeAgent(place, d.now),
  };
}

export async function detectAgents(adapters: Record<AgentId, AgentAdapter>): Promise<AgentId[]> {
  const found: AgentId[] = [];
  for (const id of AGENT_IDS) if (await adapters[id].detect()) found.push(id);
  return found;
}

export interface AgentResult {
  agent: AgentId;
  status: 'unchanged' | 'written' | 'failed';
  /** the entries left alone because they need an explicit yes */
  skipped: EntryAction[];
  /** the entries mcp-twake-ai owns afterwards (name → fingerprint) */
  owned: Record<string, string>;
  backup?: string;
  error?: string;
}

/** Applies one agent's plan. A failure leaves that agent as it was (its adapter restores it) and is reported, not thrown. */
export async function applyAgent(
  adapter: AgentAdapter,
  actions: EntryAction[],
  owned: Record<string, string>,
  consent: (action: EntryAction) => boolean,
): Promise<AgentResult> {
  const resolved = resolvePlan(actions, owned, consent);
  const base = { agent: adapter.id, skipped: resolved.skipped };
  if (Object.keys(resolved.change.set).length === 0 && resolved.change.remove.length === 0) return { ...base, status: 'unchanged', owned: resolved.owned };
  try {
    const { backup } = await adapter.write(resolved.change);
    return { ...base, status: 'written', owned: resolved.owned, ...(backup ? { backup } : {}) };
  } catch (error) {
    return { ...base, status: 'failed', owned, error: error instanceof TwakeAiError ? error.message : String((error as Error)?.message ?? error) };
  }
}

/** Notes in config.json the entries mcp-twake-ai now owns in one agent. */
export async function recordOwned(paths: AppPaths, agent: AgentId, owned: Record<string, string>): Promise<void> {
  await withLock(paths.locksDir, 'config', async () => {
    const config = await loadConfig(paths);
    if (!config) return;
    await saveConfig(paths, { ...config, agents: { ...config.agents, [agent]: { entries: owned } } });
  });
}
