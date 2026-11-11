import { describe, expect, it } from 'vitest';
import { fingerprint, needsConsent, planEntries, resolvePlan, wantedEntries } from '../../src/agents/entries.js';
import type { AgentAdapter } from '../../src/agents/types.js';
import { appPaths } from '../../src/paths.js';
import { sampleContext } from '../helpers/sample-config.js';

const ctx = sampleContext(appPaths({ platform: 'linux', env: { TWAKE_AI_HOME: '/t' }, home: '/home/j' }), 'linux');
const cursor: AgentAdapter = {
  id: 'cursor',
  label: 'Cursor',
  target: '/home/j/.cursor/mcp.json',
  capabilities: { elicitation: true, reload: '' },
  entryName: (service) => `twake-${service}`,
  shape: (base) => ({ type: 'stdio', command: base.command, args: base.args, ...(Object.keys(base.env).length ? { env: base.env } : {}) }),
  detect: async () => true,
  read: async () => ({}),
  write: async () => ({}),
};
const entry = (service: string) => ({ command: 'node', args: ['cli', 'run', service] });
const hand = { command: 'npx', args: ['my-server'] };
const kinds = (actions: { name: string; kind: string }[]) => actions.map((action) => [action.name, action.kind]);

describe('fingerprint', () => {
  it('ignores what agents add around an entry', () => {
    const mail = entry('mail');
    expect(fingerprint(mail)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint({ type: 'stdio', ...mail, env: {} })).toBe(fingerprint(mail));
    expect(fingerprint({ args: mail.args, command: mail.command })).toBe(fingerprint(mail));
    expect(fingerprint(entry('dav'))).not.toBe(fingerprint(mail));
    expect(fingerprint({ ...mail, type: 'http' })).not.toBe(fingerprint(mail));
  });
});

describe('wantedEntries', () => {
  it('starts each service through the launcher, in the shape of the agent', () => {
    expect(wantedEntries(cursor, ['mail', 'chat'], ctx, {})).toEqual({
      'twake-mail': { type: 'stdio', command: '/usr/bin/node', args: ['/opt/twake-ai/build/bin.js', 'run', 'mail', '--agent', 'cursor'] },
      'twake-chat': { type: 'stdio', command: '/usr/bin/node', args: ['/opt/twake-ai/build/bin.js', 'run', 'chat', '--agent', 'cursor'] },
    });
    expect(wantedEntries(cursor, ['mail'], ctx, { TWAKE_AI_HOME: '/accounts/work' })['twake-mail']).toMatchObject({ env: { TWAKE_AI_HOME: '/accounts/work' } });
  });
});

describe('planEntries', () => {
  it('adds, keeps, updates, removes and forgets the entries mcp-twake-ai owns, and nothing else', () => {
    const owned = { 'twake-mail': fingerprint(entry('mail')), 'twake-dav': fingerprint(entry('dav')), 'twake-space': fingerprint(entry('space')), 'twake-drive': fingerprint(entry('drive')) };
    const actions = planEntries(
      { 'twake-mail': entry('mail'), 'twake-dav': entry('dav'), 'twake-space': entry('space'), github: hand },
      { 'twake-mail': { ...entry('mail'), args: ['cli2', 'run', 'mail'] }, 'twake-dav': entry('dav'), 'twake-chat': entry('chat') },
      owned,
    );
    expect(kinds(actions)).toEqual([
      ['twake-chat', 'add'],
      ['twake-dav', 'keep'],
      ['twake-drive', 'forget'],
      ['twake-mail', 'update'],
      ['twake-space', 'remove'],
    ]);
    expect(actions.some(needsConsent)).toBe(false);
  });

  it('asks before touching an entry it did not write, or one changed by hand since', () => {
    const actions = planEntries(
      { 'twake-mail': hand, 'twake-dav': { ...entry('dav'), env: { DEBUG: '1' } }, 'twake-space': { ...entry('space'), args: ['edited'] } },
      { 'twake-mail': entry('mail'), 'twake-dav': entry('dav') },
      { 'twake-dav': fingerprint(entry('dav')), 'twake-space': fingerprint(entry('space')) },
    );
    expect(kinds(actions)).toEqual([
      ['twake-dav', 'replace-modified'],
      ['twake-mail', 'replace-foreign'],
      ['twake-space', 'remove-modified'],
    ]);
    expect(actions.every(needsConsent)).toBe(true);
  });

  it('treats an entry that is not an object (emptied by hand) as one it did not write', () => {
    expect(kinds(planEntries({ 'twake-mail': null as unknown as Record<string, unknown> }, { 'twake-mail': entry('mail') }, {}))).toEqual([['twake-mail', 'replace-foreign']]);
  });

  it('adopts an identical entry it has no record of', () => {
    expect(kinds(planEntries({ 'twake-mail': { type: 'stdio', ...entry('mail'), env: {} } }, { 'twake-mail': entry('mail') }, {}))).toEqual([['twake-mail', 'keep']]);
  });
});

describe('resolvePlan', () => {
  const actions = planEntries(
    { 'twake-mail': hand, 'twake-dav': entry('dav'), 'twake-space': entry('space') },
    { 'twake-mail': entry('mail'), 'twake-dav': entry('dav'), 'twake-chat': entry('chat') },
    { 'twake-space': fingerprint(entry('space')) },
  );

  it('applies what needs no consent, records the fingerprints, and leaves the rest alone', () => {
    const resolved = resolvePlan(actions, { 'twake-space': fingerprint(entry('space')) }, () => false);
    expect(resolved.change).toEqual({ set: { 'twake-chat': entry('chat') }, remove: ['twake-space'] });
    expect(resolved.owned).toEqual({ 'twake-chat': fingerprint(entry('chat')), 'twake-dav': fingerprint(entry('dav')) });
    expect(kinds(resolved.skipped)).toEqual([['twake-mail', 'replace-foreign']]);
  });

  it('replaces an entry it did not write once given consent', () => {
    const resolved = resolvePlan(actions, {}, (action) => action.name === 'twake-mail');
    expect(resolved.change.set['twake-mail']).toEqual(entry('mail'));
    expect(resolved.owned['twake-mail']).toBe(fingerprint(entry('mail')));
    expect(resolved.skipped).toEqual([]);
  });
});
