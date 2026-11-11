import { describe, expect, it } from 'vitest';
import { clackPrompter, SetupCancelled } from '../src/prompter.js';
import { CANCEL, scriptedPrompter } from './helpers/scripted-prompter.js';

describe('the scripted prompter', () => {
  it('answers in order and records what was asked', async () => {
    const prompter = scriptedPrompter(['jdoe@linagora.com', ['cursor'], true]);
    expect(await prompter.text({ message: 'email' })).toBe('jdoe@linagora.com');
    expect(await prompter.multiselect({ message: 'agents', options: [{ value: 'cursor', label: 'Cursor' }] })).toEqual(['cursor']);
    expect(await prompter.confirm({ message: 'apply?' })).toBe(true);
    expect(prompter.asked).toEqual(['email', 'agents', 'apply?']);
  });

  it('cancels like Escape', async () => {
    await expect(scriptedPrompter([CANCEL]).confirm({ message: 'apply?' })).rejects.toBeInstanceOf(SetupCancelled);
  });
});

describe('the clack prompter', () => {
  it('has every question of the Prompter interface', () => {
    const prompter = clackPrompter();
    for (const name of ['intro', 'note', 'text', 'confirm', 'multiselect', 'outro'] as const) expect(typeof prompter[name]).toBe('function');
  });
});
