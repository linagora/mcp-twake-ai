import { join } from 'node:path';
import { Document, isMap, isScalar, parseDocument, type YAMLMap } from 'yaml';
import { hermesEntryName } from '../catalog.js';
import { TwakeAiError } from '../errors.js';
import { backupFile, readText, restoreFile, writeFileAtomic } from './config-file.js';
import type { AgentAdapter, Entry } from './types.js';

/** Hermes gives up on an approval after 300 s; the server waits 330 s (catalog); a tool call may take 420 s in all. */
export const HERMES_TOOL_TIMEOUT_S = 420;
export const HERMES_ELICITATION_TIMEOUT_S = 300;

/** Hermes reads config.yaml with ruamel, as YAML 1.1: 0644 is an octal number there, 0612345678 a string. */
const YAML_11 = { version: '1.1' } as const;
const RENDER = { lineWidth: 0, flowCollectionPadding: false } as const;

/**
 * Hermes reads its MCP servers from `mcp_servers` in config.yaml. Only that block is rewritten (its comments and the
 * other servers kept); every byte outside it stays as it was.
 */
export function hermesAgent(home: string, now: () => Date): AgentAdapter {
  const file = join(home, 'config.yaml');
  const parse = (text: string) => {
    const doc = parseDocument(text, YAML_11);
    const error = doc.errors[0];
    if (error) {
      const line = error.linePos?.[0]?.line;
      throw new TwakeAiError('damaged_file', `${file} is not valid YAML (${error.code}${line ? `, line ${line}` : ''}): fix it, then run again. Nothing was changed.`);
    }
    if (doc.contents !== null && !isMap(doc.contents)) {
      throw new TwakeAiError('damaged_file', `${file} is not a YAML mapping: fix it, then run again. Nothing was changed.`);
    }
    const servers = doc.get('mcp_servers');
    if (servers !== undefined && servers !== null && !isMap(servers)) {
      throw new TwakeAiError('damaged_file', `${file} has mcp_servers that is not a mapping: fix it, then run again. Nothing was changed.`);
    }
    return doc;
  };
  const load = async () => parse((await readText(file)) ?? '');
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
      const text = (await readText(file)) ?? '';
      const doc = parse(text);
      const found = doc.get('mcp_servers', true);
      const servers = isMap(found) ? found : (doc.createNode({}) as YAMLMap);
      for (const name of change.remove) servers.delete(name);
      for (const [name, entry] of Object.entries(change.set)) servers.set(name, doc.createNode(entry));
      const out = spliceServers(text, doc, servers);
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

/** The file with only its mcp_servers block replaced by `servers` (appended when there was none). */
function spliceServers(text: string, doc: Document, servers: YAMLMap): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const root = doc.contents;
  if (isMap(root) && root.flow) {
    // a one-line {…} document: no block to splice into
    doc.set('mcp_servers', servers);
    return doc.toString(RENDER);
  }
  const piece = new Document({}, YAML_11);
  piece.set('mcp_servers', servers);
  let block = piece.toString(RENDER);
  const pair = isMap(root) ? root.items.find((item) => isScalar(item.key) && item.key.value === 'mcp_servers') : undefined;
  if (!pair || !isScalar(pair.key) || !pair.key.range) {
    return `${text === '' || text.endsWith('\n') ? text : text + eol}${block.replace(/\n/g, eol)}`;
  }
  const start = pair.key.range[0];
  const end = ((pair.value as { range?: [number, number, number] } | null)?.range ?? pair.key.range)[2];
  // `mcp_servers:` left empty ends before its line break, which stays
  if (!text.slice(start, end).endsWith('\n')) block = block.replace(/\n$/, '');
  return text.slice(0, start) + block.replace(/\n/g, eol) + text.slice(end);
}
