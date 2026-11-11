import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * `claude mcp add|add-json|remove --scope user` as Claude Code 2.1 behaves (checked 2026-11-11): the user scope is
 * `mcpServers` of $CLAUDE_CONFIG_DIR/.claude.json, add refuses an existing name, remove a missing one (exit 1).
 * FAKE_CLAUDE_FAIL_ON=<name> makes adding that name fail. Every call is logged to claude-calls.jsonl.
 */
const FAKE_CLAUDE = `const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.CLAUDE_CONFIG_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'claude-calls.jsonl'), JSON.stringify(args) + '\\n');
const state = path.join(dir, '.claude.json');
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };
let data = {};
try { data = JSON.parse(fs.readFileSync(state, 'utf8')); } catch {}
data.mcpServers = data.mcpServers || {};
const save = () => fs.writeFileSync(state, JSON.stringify(data, null, 2));
const scope = args.indexOf('--scope');
const rest = args.filter((_, i) => scope < 0 || (i !== scope && i !== scope + 1)).slice(2);
if (args[0] !== 'mcp') fail('unknown command ' + args[0]);
if (args[1] === 'remove') {
  if (!data.mcpServers[rest[0]]) fail('No MCP server named "' + rest[0] + '" in user scope');
  delete data.mcpServers[rest[0]];
  save();
} else if (args[1] === 'add') {
  const dash = rest.indexOf('--');
  const name = rest[0];
  const env = {};
  for (let i = 1; i < dash; i++) if (rest[i] === '-e') { const [key, ...value] = rest[++i].split('='); env[key] = value.join('='); }
  if (process.env.FAKE_CLAUDE_FAIL_ON === name) fail('Cannot add ' + name + ': disk full');
  if (data.mcpServers[name]) fail('MCP server ' + name + ' already exists in user config');
  data.mcpServers[name] = { type: 'stdio', command: rest[dash + 1], args: rest.slice(dash + 2), env };
  save();
} else if (args[1] === 'add-json') {
  if (data.mcpServers[rest[0]]) fail('MCP server ' + rest[0] + ' already exists in user config');
  data.mcpServers[rest[0]] = JSON.parse(rest[1]);
  save();
} else fail('unknown mcp command ' + args[1]);
`;

/** A fake `claude` in "<dir>/bin dir" (a space, like C:\\Program Files): a shell script, or claude.cmd on Windows. */
export async function installFakeClaude(dir: string): Promise<{ binDir: string; configDir: string; calls(): Promise<string[][]> }> {
  const binDir = join(dir, 'bin dir');
  const configDir = join(dir, 'claude config');
  await mkdir(binDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const script = join(binDir, 'fake-claude.cjs');
  await writeFile(script, FAKE_CLAUDE);
  if (process.platform === 'win32') {
    await writeFile(join(binDir, 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    await writeFile(join(binDir, 'claude'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(join(binDir, 'claude'), 0o755);
  }
  const calls = async () =>
    (await readFile(join(configDir, 'claude-calls.jsonl'), 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  return { binDir, configDir, calls };
}

/** The environment of this process with PATH replaced (whatever its case on Windows). */
export function withPath(path: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (key.toUpperCase() !== 'PATH') env[key] = value;
  return { ...env, PATH: path, ...extra };
}
