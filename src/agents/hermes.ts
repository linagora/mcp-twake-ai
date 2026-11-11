import { join } from 'node:path';
import { isMap, parseDocument } from 'yaml';
import { hermesEntryName } from '../catalog.js';
import { TwakeAiError } from '../errors.js';
import { backupFile, readText, restoreFile, writeFileAtomic } from './config-file.js';
import type { AgentAdapter, Entry } from './types.js';

/** Hermes gives up on an approval after 300 s; the server waits 330 s (catalog); a tool call may take 420 s in all. */
export const HERMES_TOOL_TIMEOUT_S = 420;
export const HERMES_ELICITATION_TIMEOUT_S = 300;

/** Hermes reads its MCP servers from `mcp_servers` in config.yaml: edited as a YAML document, so comments and layout stay. */
export function hermesAgent(home: string, now: () => Date): AgentAdapter {
  const file = join(home, 'config.yaml');
  const load = async () => {
    const doc = parseDocument((await readText(file)) ?? '');
    const error = doc.errors[0];
    if (error) {
      const line = error.linePos?.[0]?.line;
      throw new TwakeAiError('damaged_file', `${file} is not valid YAML (${error.code}${line ? `, line ${line}` : ''}): fix it, then run again. Nothing was changed.`);
    }
    const servers = doc.get('mcp_servers');
    if (servers !== undefined && servers !== null && !isMap(servers)) {
      throw new TwakeAiError('damaged_file', `${file} has mcp_servers that is not a mapping: fix it, then run again. Nothing was changed.`);
    }
    return doc;
  };
  const read = async (): Promise<Record<string, Entry>> => {
    const servers = ((await load()).toJS() as { mcp_servers?: Record<string, Entry> } | null)?.mcp_servers;
    return servers ?? {};
  };
  return {
    id: 'hermes',
    label: 'Hermes',
    target: file,
    capabilities: { elicitation: true, reload: 'Run /reload-mcp in Hermes, or restart it.' },
    entryName: hermesEntryName,
    shape: (base) => ({
      command: base.command,
      args: base.args,
      ...(Object.keys(base.env).length ? { env: base.env } : {}),
      timeout: HERMES_TOOL_TIMEOUT_S,
      elicitation: { enabled: true, timeout: HERMES_ELICITATION_TIMEOUT_S },
    }),
    detect: async () => (await readText(file)) !== undefined,
    read,
    async write(change) {
      const doc = await load();
      if (!isMap(doc.get('mcp_servers'))) doc.set('mcp_servers', doc.createNode({}));
      for (const name of change.remove) doc.deleteIn(['mcp_servers', name]);
      for (const [name, entry] of Object.entries(change.set)) doc.setIn(['mcp_servers', name], doc.createNode(entry));
      const out = doc.toString({ flowCollectionPadding: false });
      const backup = await backupFile(file, now());
      try {
        await writeFileAtomic(file, out);
        await load();
      } catch (error) {
        await restoreFile(file, backup).catch(() => undefined);
        throw error;
      }
      return { backup };
    },
  };
}
