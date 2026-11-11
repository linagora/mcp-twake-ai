import { createHash } from 'node:crypto';
import type { ServiceId } from '../broker.js';
import type { CatalogContext } from '../catalog.js';
import { launcherEntry } from '../exporter.js';
import type { AgentAdapter, Entry, EntryChange } from './types.js';

/** What identifies an entry whatever the agent adds around it: `type: "stdio"` is the default, and an empty env is no env. */
export function normalizeEntry(entry: Entry): Entry {
  const { type, env, ...rest } = entry;
  const out: Entry = { ...rest };
  if (type !== undefined && type !== 'stdio') out.type = type;
  const empty = typeof env === 'object' && env !== null && Object.keys(env).length === 0;
  if (env !== undefined && !empty) out.env = env;
  return out;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map((key) => [key, canonical(object[key])]));
  }
  return value;
}

/** A short digest of an entry, kept in config.json to recognise the entries mcp-twake-ai wrote. */
export function fingerprint(entry: Entry): string {
  return createHash('sha256').update(JSON.stringify(canonical(normalizeEntry(entry)))).digest('hex').slice(0, 16);
}

/** The entries one agent should have: each service through the launcher. */
export function wantedEntries(adapter: AgentAdapter, services: ServiceId[], ctx: CatalogContext, env: Record<string, string>): Record<string, Entry> {
  return Object.fromEntries(services.map((service) => [adapter.entryName(service), adapter.shape(launcherEntry(service, adapter.id, ctx, env))]));
}

export type ActionKind = 'add' | 'update' | 'keep' | 'remove' | 'forget' | 'replace-foreign' | 'replace-modified' | 'remove-modified';

export interface EntryAction {
  name: string;
  kind: ActionKind;
  /** the entry wanted, for add, update, keep and replace-* */
  entry?: Entry;
}

/** An entry mcp-twake-ai did not write, or one changed by hand since: only with an explicit yes (spec §10.1). */
export function needsConsent(action: EntryAction): boolean {
  return action.kind === 'replace-foreign' || action.kind === 'replace-modified' || action.kind === 'remove-modified';
}

/** What to do with each entry, from what the agent has, what is wanted, and what mcp-twake-ai wrote before (name → fingerprint). */
export function planEntries(current: Record<string, Entry>, wanted: Record<string, Entry>, owned: Record<string, string>): EntryAction[] {
  const actions: EntryAction[] = [];
  for (const [name, entry] of Object.entries(wanted)) {
    const now = current[name];
    if (now === undefined) actions.push({ name, kind: 'add', entry });
    else if (fingerprint(now) === fingerprint(entry)) actions.push({ name, kind: 'keep', entry });
    else if (owned[name] === undefined) actions.push({ name, kind: 'replace-foreign', entry });
    else if (fingerprint(now) !== owned[name]) actions.push({ name, kind: 'replace-modified', entry });
    else actions.push({ name, kind: 'update', entry });
  }
  for (const [name, print] of Object.entries(owned)) {
    if (name in wanted) continue;
    const now = current[name];
    if (now === undefined) actions.push({ name, kind: 'forget' });
    else actions.push({ name, kind: fingerprint(now) === print ? 'remove' : 'remove-modified' });
  }
  return actions.sort((a, b) => a.name.localeCompare(b.name));
}

/** The change to write and the entries owned afterwards; what needs consent and does not get it is left alone. */
export function resolvePlan(
  actions: EntryAction[],
  owned: Record<string, string>,
  consent: (action: EntryAction) => boolean,
): { change: EntryChange; owned: Record<string, string>; skipped: EntryAction[] } {
  const change: EntryChange = { set: {}, remove: [] };
  const next = { ...owned };
  const skipped: EntryAction[] = [];
  for (const action of actions) {
    if (needsConsent(action) && !consent(action)) {
      skipped.push(action);
      continue;
    }
    switch (action.kind) {
      case 'add':
      case 'update':
      case 'replace-foreign':
      case 'replace-modified':
        change.set[action.name] = action.entry!;
        next[action.name] = fingerprint(action.entry!);
        break;
      case 'keep':
        next[action.name] = fingerprint(action.entry!);
        break;
      case 'remove':
      case 'remove-modified':
        change.remove.push(action.name);
        delete next[action.name];
        break;
      case 'forget':
        delete next[action.name];
        break;
    }
  }
  return { change, owned: next, skipped };
}
