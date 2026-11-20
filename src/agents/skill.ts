import { readFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readText, writeFileAtomic } from './config-file.js';
import type { AgentAdapter, Entry, EntryChange } from './types.js';

/**
 * The twake-batch-approval skill (spec §6), shipped with mcp-twake-ai and installed by setup for the agents that read
 * skills (Claude Code, Hermes): `<skills folder>/twake-batch-approval/SKILL.md`. It is one more entry of the agent,
 * `skill:twake-batch-approval` → `{ skill: <text> }`, planned, fingerprinted and removed like the server entries: a
 * SKILL.md changed by hand is left alone without --force.
 */
export const BATCH_SKILL_DIR = 'twake-batch-approval';
const PREFIX = 'skill:';
export const BATCH_SKILL_ENTRY = `${PREFIX}${BATCH_SKILL_DIR}`;

/** The SKILL.md shipped in the package (skills/ next to build/ and src/). */
export async function batchSkillText(): Promise<string> {
  return readFile(new URL(`../../skills/${BATCH_SKILL_DIR}/SKILL.md`, import.meta.url), 'utf8');
}

export const isSkillEntry = (name: string): boolean => name.startsWith(PREFIX);

/** The adapter, also keeping the skills in `skillsDir`; `text` is the SKILL.md to install. */
export function withSkills(adapter: AgentAdapter, skillsDir: string, text: string): AgentAdapter {
  const fileOf = (name: string) => join(skillsDir, name.slice(PREFIX.length), 'SKILL.md');
  const known = [BATCH_SKILL_ENTRY];
  const readSkills = async (): Promise<Record<string, Entry>> => {
    const out: Record<string, Entry> = {};
    for (const name of known) {
      const skill = await readText(fileOf(name));
      if (skill !== undefined) out[name] = { skill };
    }
    return out;
  };
  const removeSkill = async (name: string) => {
    await rm(fileOf(name), { force: true });
    // the folder goes too when nothing else is in it
    await rmdir(join(skillsDir, name.slice(PREFIX.length))).catch(() => undefined);
  };
  return {
    ...adapter,
    skills: { [BATCH_SKILL_ENTRY]: { skill: text } },
    read: async () => ({ ...(await adapter.read()), ...(await readSkills()) }),
    async write(change: EntryChange) {
      const servers: EntryChange = {
        set: Object.fromEntries(Object.entries(change.set).filter(([name]) => !isSkillEntry(name))),
        remove: change.remove.filter((name) => !isSkillEntry(name)),
      };
      const touched = [...Object.keys(change.set), ...change.remove].filter(isSkillEntry);
      const before = await readSkills();
      try {
        for (const [name, entry] of Object.entries(change.set)) if (isSkillEntry(name)) await writeFileAtomic(fileOf(name), String(entry.skill ?? ''));
        for (const name of change.remove) if (isSkillEntry(name)) await removeSkill(name);
        if (Object.keys(servers.set).length === 0 && servers.remove.length === 0) return {};
        return await adapter.write(servers);
      } catch (error) {
        // the agent is put back as it was: its own entries by its adapter, the skills here
        for (const name of touched) {
          const previous = before[name];
          if (previous === undefined) await removeSkill(name).catch(() => undefined);
          else await writeFileAtomic(fileOf(name), String(previous.skill)).catch(() => undefined);
        }
        throw error;
      }
    },
  };
}
