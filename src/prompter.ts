import { confirm, intro, isCancel, multiselect, note, outro, text } from '@clack/prompts';

/** The user pressed Escape or Ctrl-C during setup. */
export class SetupCancelled extends Error {
  constructor() {
    super('setup cancelled');
  }
}

/** The questions of setup, behind an interface a test can script (spec §5.2). */
export interface Prompter {
  intro(title: string): void;
  note(message: string, title?: string): void;
  text(o: { message: string; placeholder?: string; initialValue?: string; validate?(value: string): string | undefined }): Promise<string>;
  confirm(o: { message: string; initialValue?: boolean }): Promise<boolean>;
  multiselect<T>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initialValues?: T[] }): Promise<T[]>;
  outro(message: string): void;
}

const answered = <T>(value: T): Exclude<T, symbol> => {
  if (isCancel(value)) throw new SetupCancelled();
  return value as Exclude<T, symbol>;
};

export function clackPrompter(): Prompter {
  return {
    intro: (title) => intro(title),
    note: (message, title) => note(message, title),
    outro: (message) => outro(message),
    text: async (o) => answered(await text({ message: o.message, placeholder: o.placeholder, initialValue: o.initialValue, validate: (value) => o.validate?.(value ?? '') })),
    confirm: async (o) => answered(await confirm({ message: o.message, initialValue: o.initialValue })),
    multiselect: async <T>(o: { message: string; options: { value: T; label: string; hint?: string }[]; initialValues?: T[] }) =>
      answered(await multiselect<T>({ message: o.message, options: o.options as never, initialValues: o.initialValues, required: false })),
  };
}
