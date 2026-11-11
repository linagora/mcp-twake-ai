import type { AgentId } from './agents/types.js';
import type { ServiceId } from './broker.js';
import { t, type Lang, type MessageKey } from './i18n.js';
import { SetupCancelled, type Prompter } from './prompter.js';

export const REQUIRED_NODE = '22.13';

/** What the guided setup needs from the rest of mcp-twake-ai: it never touches files or the network itself. */
export interface WizardKit {
  lang: Lang;
  banner(): string;
  session(): Promise<{ email: string } | undefined>;
  signIn(email: string): Promise<{ email: string }>;
  agents(): Promise<{ id: AgentId; label: string; detected: boolean; elicitation: boolean }[]>;
  services(): Promise<{ id: ServiceId; label: string; preselected: boolean }[]>;
  plan(agents: AgentId[], services: ServiceId[]): Promise<{ text: string; conflicts: { agent: AgentId; label: string; name: string; key: string }[] }>;
  apply(agents: AgentId[], services: ServiceId[], accepted: Set<string>): Promise<{ code: number; reload: string[] }>;
  check(agents: AgentId[]): Promise<{ ok: boolean; line: string }[]>;
  revoke(): Promise<void>;
  /** one line for the user */
  describe(error: unknown): string;
}

const atLeast = (version: string, floor: string) => {
  const [a = 0, b = 0] = version.split('.').map(Number);
  const [x = 0, y = 0] = floor.split('.').map(Number);
  return a > x || (a === x && b >= y);
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The guided setup (spec §8). Returns the exit code. */
export async function runWizard(kit: WizardKit, prompter: Prompter, nodeVersion: string, options: { email?: string } = {}): Promise<number> {
  const say = (key: MessageKey, vars?: Record<string, string | number>) => t(kit.lang, key, vars);
  prompter.intro(kit.banner());
  if (!atLeast(nodeVersion, REQUIRED_NODE)) {
    prompter.outro(say('nodeTooOld', { required: REQUIRED_NODE, current: nodeVersion }));
    return 1;
  }
  let signedInNow = false;
  let applying = false;
  try {
    let session = options.email === undefined ? await kit.session() : undefined;
    if (session && !(await prompter.confirm({ message: say('continueAs', { email: session.email }), initialValue: true }))) session = undefined;
    let email = options.email;
    while (!session) {
      email ??= (await prompter.text({ message: say('askEmail'), placeholder: 'jane.doe@company.com', validate: (value) => (EMAIL.test(value.trim()) ? undefined : say('emailInvalid')) })).trim();
      try {
        session = await kit.signIn(email);
        signedInNow = true;
        prompter.note(say('signedInAs', { email: session.email }));
      } catch (error) {
        if (error instanceof SetupCancelled) throw error;
        // a mistyped address or a sign-in that did not complete: say why, and ask again
        prompter.note(kit.describe(error));
        email = undefined;
      }
    }
    const agents = await kit.agents();
    const chosenAgents = await prompter.multiselect<AgentId>({
      message: say('chooseAgents'),
      options: agents.map((agent) => ({ value: agent.id, label: agent.label, hint: say(agent.detected ? 'agentDetected' : 'agentMissing') })),
      initialValues: agents.filter((agent) => agent.detected).map((agent) => agent.id),
    });
    if (chosenAgents.length === 0) {
      prompter.outro(say('nothingChosen'));
      if (signedInNow) await kit.revoke();
      return 0;
    }
    const services = await kit.services();
    const chosenServices = await prompter.multiselect<ServiceId>({
      message: say('chooseServices'),
      options: services.map((service) => ({ value: service.id, label: service.label })),
      initialValues: services.filter((service) => service.preselected).map((service) => service.id),
    });
    for (const agent of agents) if (chosenAgents.includes(agent.id) && !agent.elicitation) prompter.note(say('noElicitation', { agent: agent.label }));
    const plan = await kit.plan(chosenAgents, chosenServices);
    prompter.note(plan.text, say('planTitle'));
    const accepted = new Set<string>();
    for (const conflict of plan.conflicts) {
      if (await prompter.confirm({ message: say('replaceEntry', { agent: conflict.label, name: conflict.name }), initialValue: false })) accepted.add(conflict.key);
    }
    if (!(await prompter.confirm({ message: say('confirmApply'), initialValue: true }))) throw new SetupCancelled();
    applying = true;
    const applied = await kit.apply(chosenAgents, chosenServices, accepted);
    prompter.note((await kit.check(chosenAgents)).map((check) => check.line).join('\n'), say('checking'));
    const quote = (example: string) => (kit.lang === 'fr' ? `  « ${example} »` : `  “${example}”`);
    const examples = [say('example1'), say('example2'), say('example3')].map(quote).join('\n');
    prompter.note(applied.reload.join('\n'), say('reload'));
    prompter.outro(`${say('tryAsking')}:\n${examples}`);
    return applied.code;
  } catch (error) {
    // once agents are being written they may point at this session: it stays
    if (signedInNow && !applying) {
      await kit.revoke().catch(() => undefined);
      prompter.note(say('revoked'));
    }
    prompter.outro(error instanceof SetupCancelled ? say('cancelled') : say('failed', { reason: kit.describe(error) }));
    return 1;
  }
}
