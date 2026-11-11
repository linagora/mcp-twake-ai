import { describe, expect, it } from 'vitest';
import { runWizard, type WizardKit } from '../src/wizard.js';
import { CANCEL, scriptedPrompter } from './helpers/scripted-prompter.js';

function fakeKit(o: { signedIn?: boolean; conflicts?: boolean } = {}) {
  const calls: string[] = [];
  const kit: WizardKit = {
    lang: 'en',
    banner: () => 'BANNER',
    session: async () => (o.signedIn ? { email: 'jdoe@linagora.com' } : undefined),
    signIn: async (email) => {
      calls.push(`signIn ${email}`);
      return { email };
    },
    agents: async () => [
      { id: 'claude-code', label: 'Claude Code', detected: true, elicitation: true },
      { id: 'claude-desktop', label: 'Claude Desktop', detected: true, elicitation: false },
      { id: 'cursor', label: 'Cursor', detected: false, elicitation: true },
    ],
    services: async () => [
      { id: 'mail', label: 'Mail', preselected: true },
      { id: 'drive', label: 'Drive', preselected: false },
    ],
    plan: async (agents, services) => {
      calls.push(`plan ${agents.join(',')} ${services.join(',')}`);
      return { text: '+ twake-mail add', conflicts: o.conflicts ? [{ agent: 'claude-code', label: 'Claude Code', name: 'twake-mail', key: 'claude-code/twake-mail' }] : [] };
    },
    apply: async (agents, services, accepted) => {
      calls.push(`apply ${agents.join(',')} ${services.join(',')} [${[...accepted].join(',')}]`);
      return { code: 0, reload: ['Claude Code: start a new session.'] };
    },
    check: async () => [{ ok: true, line: '✓ Claude Code · twake-mail starts, 12 tools' }],
    revoke: async () => void calls.push('revoke'),
    describe: (error) => (error as Error).message,
  };
  return { kit, calls };
}

describe('the guided setup', () => {
  it('signs in, lets the user choose, shows the plan, applies, checks and sums up', async () => {
    const { kit, calls } = fakeKit();
    const prompter = scriptedPrompter(['jdoe@linagora.com', ['claude-code', 'claude-desktop'], ['mail'], true]);
    expect(await runWizard(kit, prompter, '24.22.1')).toBe(0);
    expect(calls).toEqual(['signIn jdoe@linagora.com', 'plan claude-code,claude-desktop mail', 'apply claude-code,claude-desktop mail []']);
    expect(prompter.shown.join('\n')).toContain('Claude Desktop cannot show approval requests');
    expect(prompter.shown.join('\n')).toContain('✓ Claude Code · twake-mail starts, 12 tools');
    expect(prompter.shown.join('\n')).toContain('What is on my calendar tomorrow?');
  });

  it('keeps an open session, asking only to continue with it', async () => {
    const { kit, calls } = fakeKit({ signedIn: true });
    const prompter = scriptedPrompter([true, ['claude-code'], ['mail'], true]);
    expect(await runWizard(kit, prompter, '24.22.1')).toBe(0);
    expect(prompter.asked[0]).toBe('Continue as jdoe@linagora.com?');
    expect(calls[0]).toBe('plan claude-code mail');
  });

  it('asks before replacing an entry it did not write', async () => {
    const { kit, calls } = fakeKit({ conflicts: true });
    const prompter = scriptedPrompter([true, ['claude-code'], ['mail'], false, true]);
    expect(await runWizard({ ...kit, session: async () => ({ email: 'jdoe@linagora.com' }) }, prompter, '24.22.1')).toBe(0);
    expect(prompter.asked).toContain('Claude Code: replace twake-mail, which was configured outside mcp-twake-ai or changed by hand?');
    expect(calls.at(-1)).toBe('apply claude-code mail []');
  });

  it('asks about an entry to remove as a removal', async () => {
    const { kit } = fakeKit({ signedIn: true });
    const removing: WizardKit = {
      ...kit,
      plan: async () => ({ text: '! twake-dav', conflicts: [{ agent: 'claude-code', label: 'Claude Code', name: 'twake-dav', key: 'claude-code/twake-dav', removal: true }] }),
    };
    const prompter = scriptedPrompter([true, ['claude-code'], ['mail'], false, true]);
    expect(await runWizard(removing, prompter, '24.22.1')).toBe(0);
    expect(prompter.asked).toContain('Claude Code: remove twake-dav, which was changed by hand since mcp-twake-ai wrote it?');
  });

  it('revokes the sign-in made during setup when the user gives up', async () => {
    const { kit, calls } = fakeKit();
    const prompter = scriptedPrompter(['jdoe@linagora.com', CANCEL]);
    expect(await runWizard(kit, prompter, '24.22.1')).toBe(1);
    expect(calls).toEqual(['signIn jdoe@linagora.com', 'revoke']);
    expect(prompter.shown.at(-1)).toContain('nothing was changed');
  });

  it('does not revoke a session that was already open', async () => {
    const { kit, calls } = fakeKit({ signedIn: true });
    expect(await runWizard(kit, scriptedPrompter([true, CANCEL]), '24.22.1')).toBe(1);
    expect(calls).toEqual([]);
  });

  it('says why a sign-in failed and asks the email again', async () => {
    const { kit, calls } = fakeKit();
    let tries = 0;
    const flaky: WizardKit = {
      ...kit,
      signIn: async (email) => {
        if (tries++ === 0) throw new Error('example.con is not a Twake.ai domain');
        calls.push(`signIn ${email}`);
        return { email };
      },
    };
    const prompter = scriptedPrompter(['jdoe@example.con', 'jdoe@linagora.com', []]);
    expect(await runWizard(flaky, prompter, '24.22.1')).toBe(0);
    expect(prompter.shown).toContain('example.con is not a Twake.ai domain');
    expect(calls[0]).toBe('signIn jdoe@linagora.com');
  });

  it('revokes its sign-in and says why when the plan fails', async () => {
    const { kit, calls } = fakeKit();
    const failing: WizardKit = { ...kit, plan: async () => { throw new Error('No Twake Project server was found'); } };
    const prompter = scriptedPrompter(['jdoe@linagora.com', ['claude-code'], ['mail']]);
    expect(await runWizard(failing, prompter, '24.22.1')).toBe(1);
    expect(calls).toEqual(['signIn jdoe@linagora.com', 'revoke']);
    expect(prompter.shown.at(-1)).toBe('Setup stopped: No Twake Project server was found');
  });

  it('keeps the session when writing the agents fails, as entries may already use it', async () => {
    const { kit, calls } = fakeKit();
    const failing: WizardKit = { ...kit, apply: async () => { throw new Error('npm could not install'); } };
    const prompter = scriptedPrompter(['jdoe@linagora.com', ['claude-code'], ['mail'], true]);
    expect(await runWizard(failing, prompter, '24.22.1')).toBe(1);
    expect(calls).not.toContain('revoke');
  });

  it('signs in with the address given on the command line, without asking it', async () => {
    const { kit, calls } = fakeKit({ signedIn: true });
    const prompter = scriptedPrompter([[]]);
    expect(await runWizard(kit, prompter, '24.22.1', { email: 'jdoe@linagora.com' })).toBe(0);
    expect(prompter.asked).toEqual(['Which agents should get the Twake.ai servers?']);
    expect(calls).toEqual(['signIn jdoe@linagora.com', 'revoke']);
  });

  it('stops on an old Node, saying how to fix it', async () => {
    const { kit } = fakeKit();
    const prompter = scriptedPrompter([]);
    expect(await runWizard(kit, prompter, '20.11.0')).toBe(1);
    expect(prompter.shown.join('\n')).toContain('needs Node 22.13 or later');
  });
});
