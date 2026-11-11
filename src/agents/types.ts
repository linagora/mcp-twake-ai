import type { ServiceId } from '../broker.js';
import type { ServerEntry } from '../exporter.js';

export const AGENT_IDS = ['claude-code', 'hermes', 'claude-desktop', 'cursor', 'vscode'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export function isAgentId(value: string): value is AgentId {
  return (AGENT_IDS as readonly string[]).includes(value);
}

/** One MCP server entry, in the agent's own format. */
export type Entry = Record<string, unknown>;

export interface Capabilities {
  /** the agent answers elicitation/create: writes are approved in a dialog; otherwise every write is refused (spec §10.2) */
  elicitation: boolean;
  /** what the user does for the agent to load the change */
  reload: string;
}

export interface EntryChange {
  set: Record<string, Entry>;
  remove: string[];
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  /** where the entries live, as the user would look for them */
  target: string;
  capabilities: Capabilities;
  entryName(service: ServiceId): string;
  /** the launcher entry of one service, in the shape this agent stores */
  shape(base: ServerEntry): Entry;
  /** the agent is installed on this computer */
  detect(): Promise<boolean>;
  /** every MCP server entry the agent has now */
  read(): Promise<Record<string, Entry>>;
  /** sets and removes entries; on failure the agent is put back as it was, and the error is thrown */
  write(change: EntryChange): Promise<{ backup?: string }>;
}
