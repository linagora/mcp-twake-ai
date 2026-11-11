import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { entryName } from '../catalog.js';
import { TwakeAiError } from '../errors.js';
import type { ServerEntry } from '../exporter.js';
import { backupFile, readText, restoreFile, writeFileAtomic } from './config-file.js';
import { claudeDesktopConfig, cursorConfig, isDirectory, pathOf, vscodeConfig, type Place } from './locations.js';
import type { AgentAdapter, AgentId, Capabilities, Entry } from './types.js';

interface JsonAgent {
  id: AgentId;
  label: string;
  file: string;
  /** the object that holds the servers */
  key: 'mcpServers' | 'servers';
  /** the folder whose presence means the agent is installed */
  home: string;
  capabilities: Capabilities;
  shape(base: ServerEntry): Entry;
}

const withEnv = (base: ServerEntry) => (Object.keys(base.env).length ? { env: base.env } : {});
const plain = (base: ServerEntry): Entry => ({ command: base.command, args: base.args, ...withEnv(base) });
const stdio = (base: ServerEntry): Entry => ({ type: 'stdio', ...plain(base) });

function damaged(file: string, why: string): TwakeAiError {
  return new TwakeAiError('damaged_file', `${file} ${why}: fix it, then run again. Nothing was changed.`);
}

/** The servers of a JSON (or JSONC) settings file; a file the agent itself could not read is refused. */
function servers(a: JsonAgent, raw: string): Record<string, Entry> {
  // editors on Windows may start the file with a byte order mark: JSON parsers refuse it, the agents do not
  const text = raw.replace(/^\uFEFF/, '');
  if (text.trim() === '') return {};
  const errors: ParseError[] = [];
  const config = parse(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) throw damaged(a.file, `is not valid JSON (${printParseErrorCode(errors[0]!.error)} at character ${errors[0]!.offset})`);
  if (typeof config !== 'object' || config === null || Array.isArray(config)) throw damaged(a.file, 'is not a JSON object');
  const found = (config as Record<string, unknown>)[a.key];
  if (found === undefined) return {};
  if (typeof found !== 'object' || found === null || Array.isArray(found)) throw damaged(a.file, `has "${a.key}" that is not an object`);
  return found as Record<string, Entry>;
}

/** An agent whose servers live in a JSON file: only the entries named change; comments, layout and other keys stay. */
function jsonAgent(a: JsonAgent, now: () => Date): AgentAdapter {
  const read = async () => servers(a, (await readText(a.file)) ?? '');
  return {
    id: a.id,
    label: a.label,
    target: a.file,
    capabilities: a.capabilities,
    entryName,
    shape: a.shape,
    detect: () => isDirectory(a.home),
    read,
    async write(change) {
      const raw = (await readText(a.file)) ?? '';
      const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
      const text = raw.slice(bom.length);
      servers(a, text);
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const formattingOptions = { insertSpaces: true, tabSize: 2, eol };
      let out = text.trim() === '' ? `{}${eol}` : text;
      for (const name of change.remove) out = applyEdits(out, modify(out, [a.key, name], undefined, { formattingOptions }));
      for (const [name, entry] of Object.entries(change.set)) out = applyEdits(out, modify(out, [a.key, name], entry, { formattingOptions }));
      const backup = await backupFile(a.file, now());
      try {
        await writeFileAtomic(a.file, bom + out);
        servers(a, (await readText(a.file)) ?? '');
      } catch (error) {
        await restoreFile(a.file, backup).catch(() => undefined);
        throw error;
      }
      return { backup };
    },
  };
}

export function claudeDesktopAgent(place: Place, now: () => Date): AgentAdapter {
  const file = claudeDesktopConfig(place);
  return jsonAgent(
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      file,
      key: 'mcpServers',
      home: pathOf(place).dirname(file),
      // no source confirms elicitation in Claude Desktop (checked 2026-11-11): writes are refused there
      capabilities: { elicitation: false, reload: 'Quit Claude Desktop completely, then start it again.' },
      shape: plain,
    },
    now,
  );
}

export function cursorAgent(place: Place, now: () => Date): AgentAdapter {
  const file = cursorConfig(place);
  return jsonAgent(
    {
      id: 'cursor',
      label: 'Cursor',
      file,
      key: 'mcpServers',
      home: pathOf(place).dirname(file),
      capabilities: { elicitation: true, reload: 'If Cursor does not show the servers, quit it completely and start it again.' },
      shape: stdio,
    },
    now,
  );
}

export function vscodeAgent(place: Place, now: () => Date): AgentAdapter {
  const file = vscodeConfig(place);
  return jsonAgent(
    {
      id: 'vscode',
      label: 'VS Code',
      file,
      key: 'servers',
      home: pathOf(place).dirname(file),
      capabilities: { elicitation: true, reload: 'VS Code starts the servers at the next chat message (or from the MCP Servers view).' },
      shape: stdio,
    },
    now,
  );
}
