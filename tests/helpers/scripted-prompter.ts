import { SetupCancelled, type Prompter } from '../../src/prompter.js';

export const CANCEL = Symbol('cancel');

/** Answers the questions in order; CANCEL acts as Escape. Records the questions asked and the notes shown. */
export function scriptedPrompter(answers: unknown[]): Prompter & { asked: string[]; shown: string[] } {
  const queue = [...answers];
  const asked: string[] = [];
  const shown: string[] = [];
  const next = <T>(message: string): T => {
    asked.push(message);
    if (queue.length === 0) throw new Error(`no scripted answer for: ${message}`);
    const answer = queue.shift();
    if (answer === CANCEL) throw new SetupCancelled();
    return answer as T;
  };
  return {
    asked,
    shown,
    intro: (title) => void shown.push(title),
    note: (message, title) => void shown.push(title ? `${title}: ${message}` : message),
    outro: (message) => void shown.push(message),
    text: async (o) => {
      const value = next<string>(o.message);
      const problem = o.validate?.(value);
      if (problem) throw new Error(`scripted answer "${value}" is invalid: ${problem}`);
      return value;
    },
    confirm: async (o) => next<boolean>(o.message),
    multiselect: async (o) => next(o.message),
  };
}
