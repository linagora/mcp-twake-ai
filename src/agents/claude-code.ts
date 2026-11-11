import { stat } from 'node:fs/promises';
import { entryName } from '../catalog.js';
import { TwakeAiError } from '../errors.js';
import { runFile, type FileRunner } from '../run-file.js';
import { readText } from './config-file.js';
import { claudeCodeState, pathOf, type Place } from './locations.js';
import type { AgentAdapter, Entry } from './types.js';

/** A variable whatever its case: Windows has Path, POSIX PATH. */
const variable = (env: NodeJS.ProcessEnv, name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

/** The program `name` as the shell would find it in PATH (with PATHEXT on Windows). */
export async function findExecutable(name: string, place: Place): Promise<string | undefined> {
  const path = pathOf(place);
  const windows = place.platform === 'win32';
  const extensions = windows ? (variable(place.env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of (variable(place.env, 'PATH') ?? '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension.toLowerCase());
      try {
        const info = await stat(candidate);
        if (info.isFile() && (windows || (info.mode & 0o111) !== 0)) return candidate;
      } catch {
        // not in this folder
      }
    }
  }
  return undefined;
}

const SCOPE = ['--scope', 'user'];

/** `claude mcp add … -- <command> <args>`: no JSON on the command line, which cmd.exe would mangle for claude.cmd. */
function addArgs(name: string, entry: Entry): string[] {
  const env = Object.entries((entry.env ?? {}) as Record<string, string>).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
  return ['mcp', 'add', ...SCOPE, name, ...env, '--', String(entry.command), ...((entry.args ?? []) as unknown[]).map(String)];
}

/** Claude Code, through its own `claude mcp` commands: its .claude.json is only ever read (spec §10.1). */
export function claudeCodeAgent(place: Place, run: FileRunner = runFile): AgentAdapter {
  const state = claudeCodeState(place);
  const read = async (): Promise<Record<string, Entry>> => {
    const text = await readText(state);
    if (text === undefined) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new TwakeAiError('damaged_file', `${state} is not valid JSON: start Claude Code once to repair it, then run again. Nothing was changed.`);
    }
    const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers) ? (servers as Record<string, Entry>) : {};
  };
  const claude = async (name: string, args: string[]) => {
    const file = await findExecutable('claude', place);
    if (!file) throw new TwakeAiError('unsupported', 'The claude command is not in PATH: install Claude Code, then run again.');
    try {
      await run(file, args, { platform: place.platform, env: place.env, timeoutMs: 60_000 });
    } catch (error) {
      if (error instanceof TwakeAiError) throw error;
      const detail = String((error as { stderr?: string }).stderr ?? '').trim().split('\n').at(-1) || (error as Error).message;
      throw new TwakeAiError('unavailable', `claude mcp ${args[1]} ${name} failed: ${detail}`);
    }
  };
  return {
    id: 'claude-code',
    label: 'Claude Code',
    target: `claude mcp, user scope (${state})`,
    capabilities: { elicitation: true, reload: 'Start a new Claude Code session to load them.' },
    entryName,
    shape: (base) => ({ type: 'stdio', command: base.command, args: base.args, ...(Object.keys(base.env).length ? { env: base.env } : {}) }),
    detect: async () => (await findExecutable('claude', place)) !== undefined,
    read,
    async write(change) {
      const before = await read();
      const touched = new Set<string>();
      try {
        for (const name of [...change.remove, ...Object.keys(change.set)]) {
          if (before[name] === undefined) continue;
          touched.add(name);
          await claude(name, ['mcp', 'remove', ...SCOPE, name]);
        }
        for (const [name, entry] of Object.entries(change.set)) {
          touched.add(name);
          await claude(name, addArgs(name, entry));
        }
      } catch (error) {
        // Claude Code keeps no copy to put back: the entries touched are re-added as they were
        for (const name of touched) {
          await claude(name, ['mcp', 'remove', ...SCOPE, name]).catch(() => undefined);
          const previous = before[name];
          if (previous === undefined) continue;
          const again = typeof previous.command === 'string' ? addArgs(name, previous) : ['mcp', 'add-json', ...SCOPE, name, JSON.stringify(previous)];
          await claude(name, again).catch(() => undefined);
        }
        throw error;
      }
      return {};
    },
  };
}
