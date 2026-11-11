# mcp-twake-ai, plan 4b : `setup` guidé, bannière, fr/en, auto-installation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npx mcp-twake-ai setup`, lancé dans un terminal sans autre option, conduit tout le parcours de la spec (section 8).
- Il affiche la bannière, vérifie Node, connecte le compte et laisse choisir les agents et les services.
- Il montre le plan, demande une seule confirmation (plus une par entrée à remplacer), puis il applique.
- Il vérifie que chaque serveur écrit démarre et termine par un récapitulatif, en français ou en anglais.
- Un abandon révoque ce qui a été autorisé pendant le parcours.
- Lancé par `npx`, l'outil s'installe lui-même dans le préfixe privé, pour que les entrées ne pointent pas vers le cache de npx, et crée un raccourci `mcp-twake-ai`.

**Architecture:**
- **`src/banner.ts`** : la bannière (dégradé `#2F6BFF` → `#00D1C1`, `NO_COLOR`, ligne compacte sous 60 colonnes).
- **`src/i18n.ts`** : les textes du parcours en `en` et `fr`.
- **`src/prompter.ts`** : l'interface `Prompter`, son implémentation `@clack/prompts`, et `SetupCancelled`.
- **`src/wizard.ts`** : le parcours. Il ne connaît ni la CLI ni les fichiers : un `WizardKit` lui fournit se connecter, détecter les agents, planifier, appliquer, vérifier et révoquer.
- **`src/cli.ts`** :
  - `setupCommand` est découpé en `runSetup(request)`, qui sert au mode non interactif et au parcours ;
  - `setup` sans `--agents` dans un terminal lance le parcours ;
  - `--email` connecte le compte en mode non interactif.
- **`src/self-install.ts`** : sous `npx`, installation de `mcp-twake-ai` dans le préfixe, et raccourci (`~/.local/bin/mcp-twake-ai`, ou `%LOCALAPPDATA%\twake-ai\bin\mcp-twake-ai.cmd`).
- **`scripts/live.mjs`** : le test réel contre un vrai compte Twake.ai, à la demande.

**Tech Stack:** celle du plan 4a, plus `@clack/prompts` 1.8.1. La 1.9.0, publiée le 2026-11-09, est trop récente.

**Spec:** `docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md`, sections 5.3 (préfixe et raccourci), 8 (parcours `setup` et bannière), 10.2 (élicitation) et 13.5 (test réel).

## Global Constraints

- **Contraintes reprises :** toutes celles des plans 1 à 4a.
- **Bannière :** le texte de la spec, section 8, et la version du paquet. Dégradé truecolor par colonne, sous-titre en `#9AA4B5`. Pas de couleur si `NO_COLOR` est défini ou si la sortie n'est pas un terminal. Sous 60 colonnes, une ligne `Twake.ai  v<version>`. Pas de bannière en mode non interactif.
- **Langue :** `detectLanguage(env)` (`TWAKE_AI_LANGUAGE`, les variables de locale, puis la locale du système). Les textes du parcours existent dans les deux langues. Les messages d'erreur de la CLI restent en anglais.
- **Parcours** (spec 8) :
  1. Node ≥ 22.13 ;
  2. email, s'il n'y a pas encore de session ;
  3. connexion ;
  4. agents, les détectés étant pré-cochés ;
  5. services, ceux de `defaultServices` et Drive si l'instance est connue étant pré-cochés ;
  6. élicitation expliquée pour un agent qui ne la gère pas ;
  7. plan, puis une confirmation par entrée à remplacer, puis une confirmation finale ;
  8. application (connexions Drive et Chat, installation, écriture) ;
  9. `status` des entrées écrites ;
  10. récapitulatif : rechargements à faire et trois exemples de questions.

  Rien n'est écrit avant la confirmation finale.
- **Abandon** (Ctrl-C ou Échap) : si la connexion OIDC a eu lieu pendant ce parcours, `logout` révoque ce qu'elle a autorisé. Message « rien n'a été modifié », code 1.
- **Interactivité :** `setup` sans `--agents` ni `--yes`, avec stdin et stdout sur un terminal, lance le parcours. Sinon, l'erreur d'usage actuelle.
- **Auto-installation :**
  - **Déclenchement :** le chemin de la CLI contient un dossier `_npx` (cache de `npx`).
  - **Installation :** `mcp-twake-ai@<sa version>` va dans `<prefix>/mcp-twake-ai`, comme les serveurs.
  - **Chemin de la CLI :** les entrées et les commandes de jeton utilisent celui du paquet installé.
  - **Raccourci :** sous POSIX, `~/.local/bin/mcp-twake-ai` (script `#!/bin/sh` qui fait `exec "<node>" "<cli>" "$@"`, `0755`). Sous Windows, `%LOCALAPPDATA%\twake-ai\bin\mcp-twake-ai.cmd`. Si ce dossier n'est pas dans le `PATH`, le récapitulatif le dit.
  - **Désinstallation :** `uninstall` supprime le raccourci.

## Review Focus

- **Abandon après la connexion** (Échap à la question des agents) : le refresh token obtenu est révoqué et aucun agent n'est écrit. Test dans la tâche 5.
- **Session déjà ouverte :** le parcours ne redemande pas l'email et ne révoque pas cette session en cas d'abandon. Test dans la tâche 5.
- **Entrée configurée à la main :** le parcours demande, entrée par entrée ; un « non » la laisse en place. Test dans la tâche 5.
- **Terminal étroit ou `NO_COLOR` :** ligne compacte, aucune séquence ANSI. Test dans la tâche 1.
- **Lancement par `npx`** : les entrées pointent vers `<prefix>/mcp-twake-ai/…/bin.js`, jamais vers `_npx`. Test dans la tâche 6.

---

### Task 1 : bannière

**Files:**
- Create: `src/banner.ts`
- Test: `tests/banner.test.ts`

**Interfaces:**
- Produces: `renderBanner(o: { version: string; columns: number; color: boolean }): string` ; `wantsColor(env, isTTY: boolean): boolean`.

- [ ] **Step 1: Write the failing test**

`tests/banner.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { renderBanner, wantsColor } from '../src/banner.js';

const ESC = '\x1b[';

describe('the banner', () => {
  it('draws Twake.ai with a blue-to-cyan gradient and a grey subtitle', () => {
    const banner = renderBanner({ version: '1.0.0', columns: 100, color: true });
    expect(banner).toContain(`${ESC}38;2;47;107;255m█`);
    expect(banner).toContain(`${ESC}38;2;0;209;193m`);
    expect(banner).toContain(`${ESC}38;2;154;164;181mMail · Agenda · Drive · Chat · Space · Project`);
    expect(banner).toContain('v1.0.0');
  });

  it('has no escape sequence without color', () => {
    const banner = renderBanner({ version: '1.0.0', columns: 100, color: false });
    expect(banner).not.toContain('\x1b');
    expect(banner).toContain('████████╗██╗    ██╗');
    expect(banner).toContain('Votre Digital Workplace souveraine, connectée à votre agent IA');
  });

  it('is one line under 60 columns', () => {
    expect(renderBanner({ version: '1.0.0', columns: 59, color: false }).trim()).toBe('Twake.ai  v1.0.0');
  });

  it('is colored only on a terminal, and never with NO_COLOR', () => {
    expect(wantsColor({}, true)).toBe(true);
    expect(wantsColor({}, false)).toBe(false);
    expect(wantsColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(wantsColor({ NO_COLOR: '' }, true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/banner.test.ts`
Expected: FAIL, `../src/banner.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/banner.ts` :

```ts
const ART = [
  '████████╗██╗    ██╗ █████╗ ██╗  ██╗███████╗    █████╗ ██╗',
  '╚══██╔══╝██║    ██║██╔══██╗██║ ██╔╝██╔════╝   ██╔══██╗██║',
  '   ██║   ██║ █╗ ██║███████║█████╔╝ █████╗     ███████║██║',
  '   ██║   ██║███╗██║██╔══██║██╔═██╗ ██╔══╝     ██╔══██║██║',
  '   ██║   ╚███╔███╔╝██║  ██║██║  ██╗███████╗██╗██║  ██║██║',
  '   ╚═╝    ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝╚═╝',
];
const FROM = [0x2f, 0x6b, 0xff];
const TO = [0x00, 0xd1, 0xc1];
const GREY = '\x1b[38;2;154;164;181m';
const RESET = '\x1b[0m';

/** Colored on a terminal, unless NO_COLOR is set to anything (https://no-color.org). */
export function wantsColor(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  return isTTY && !env.NO_COLOR;
}

function gradient(line: string, width: number): string {
  return (
    [...line]
      .map((char, i) => {
        if (char === ' ') return char;
        const t = width > 1 ? i / (width - 1) : 0;
        const [r, g, b] = FROM.map((from, k) => Math.round(from + (TO[k]! - from) * t));
        return `\x1b[38;2;${r};${g};${b}m${char}`;
      })
      .join('') + RESET
  );
}

/** The banner of `setup` (spec §8): Twake.ai in a blue-to-cyan gradient, or one line on a narrow terminal. */
export function renderBanner(o: { version: string; columns: number; color: boolean }): string {
  if (o.columns < 60) return `\n  ${o.color ? gradient('Twake.ai', 8) : 'Twake.ai'}  v${o.version}\n\n`;
  const width = Math.max(...ART.map((line) => [...line].length));
  const grey = (text: string) => (o.color ? `${GREY}${text}${RESET}` : text);
  const art = ART.map((line) => `  ${o.color ? gradient(line, width) : line}`).join('\n');
  const services = 'Mail · Agenda · Drive · Chat · Space · Project';
  return `\n${art}\n\n  ${grey('Votre Digital Workplace souveraine, connectée à votre agent IA')}\n  ${grey(`${services}${' '.repeat(8)}v${o.version}`)}\n\n`;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/banner.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/banner.ts tests/banner.test.ts
git commit -m "feat: the Twake.ai banner of setup"
```

---

### Task 2 : textes du parcours en anglais et en français

**Files:**
- Create: `src/i18n.ts`
- Test: `tests/i18n.test.ts`

**Interfaces:**
- Produces: `Lang = 'en' | 'fr'` ; `MESSAGES: Record<Lang, Record<MessageKey, string>>` ; `MessageKey` ; `t(lang, key, vars?: Record<string, string | number>): string`.

- [ ] **Step 1: Write the failing test**

`tests/i18n.test.ts` :

```ts
import { describe, expect, it } from 'vitest';
import { MESSAGES, t } from '../src/i18n.js';

describe('the texts of setup', () => {
  it('exist in English and in French, with the same placeholders', () => {
    expect(Object.keys(MESSAGES.fr).sort()).toEqual(Object.keys(MESSAGES.en).sort());
    for (const key of Object.keys(MESSAGES.en) as (keyof typeof MESSAGES.en)[]) {
      const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(holes(MESSAGES.fr[key]), key).toEqual(holes(MESSAGES.en[key]));
    }
  });

  it('fill their placeholders', () => {
    expect(t('fr', 'signedInAs', { email: 'jdoe@linagora.com' })).toBe('Connecté en tant que jdoe@linagora.com.');
    expect(t('en', 'signedInAs', { email: 'jdoe@linagora.com' })).toBe('Signed in as jdoe@linagora.com.');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/i18n.test.ts`
Expected: FAIL, `../src/i18n.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/i18n.ts` :

```ts
export type Lang = 'en' | 'fr';

const EN = {
  nodeTooOld: 'mcp-twake-ai needs Node {required} or later, and this is Node {current}: install a recent Node from https://nodejs.org, then run setup again.',
  askEmail: 'Your Twake.ai email address',
  emailInvalid: 'An email address looks like name@company.com',
  continueAs: 'Continue as {email}?',
  signedInAs: 'Signed in as {email}.',
  chooseAgents: 'Which agents should get the Twake.ai servers?',
  agentDetected: 'found on this computer',
  agentMissing: 'not found',
  chooseServices: 'Which services?',
  noElicitation: '{agent} cannot show approval requests: it can read, and every write it asks for is refused.',
  planTitle: 'What setup will do',
  replaceEntry: '{agent}: replace {name}, which was configured outside mcp-twake-ai or changed by hand?',
  confirmApply: 'Apply this plan?',
  cancelled: 'Setup cancelled: nothing was changed.',
  revoked: 'The sign-in made during this setup is revoked.',
  checking: 'Checking that each server starts…',
  doneTitle: 'Done',
  reload: 'To finish',
  tryAsking: 'Try asking your agent',
  example1: 'What is on my calendar tomorrow?',
  example2: 'Summarize my unread emails from today.',
  example3: 'Find the latest version of the budget file in my Drive.',
  shortcutNotInPath: 'Add {dir} to your PATH to type mcp-twake-ai from anywhere.',
  nothingChosen: 'No agent chosen: nothing to do.',
} as const;

export type MessageKey = keyof typeof EN;

const FR: Record<MessageKey, string> = {
  nodeTooOld: 'mcp-twake-ai demande Node {required} ou plus récent, et celui-ci est Node {current} : installez un Node récent depuis https://nodejs.org, puis relancez setup.',
  askEmail: 'Votre adresse email Twake.ai',
  emailInvalid: 'Une adresse email a la forme nom@entreprise.com',
  continueAs: 'Continuer avec {email} ?',
  signedInAs: 'Connecté en tant que {email}.',
  chooseAgents: 'Quels agents doivent recevoir les serveurs Twake.ai ?',
  agentDetected: 'trouvé sur cet ordinateur',
  agentMissing: 'absent',
  chooseServices: 'Quels services ?',
  noElicitation: "{agent} ne sait pas afficher les demandes d'approbation : il peut lire, et chaque écriture qu'il demande est refusée.",
  planTitle: 'Ce que setup va faire',
  replaceEntry: '{agent} : remplacer {name}, configurée hors de mcp-twake-ai ou modifiée à la main ?',
  confirmApply: 'Appliquer ce plan ?',
  cancelled: "Setup annulé : rien n'a été modifié.",
  revoked: 'La connexion faite pendant ce setup est révoquée.',
  checking: 'Vérification du démarrage de chaque serveur…',
  doneTitle: 'Terminé',
  reload: 'Pour finir',
  tryAsking: 'Essayez de demander à votre agent',
  example1: "Qu'y a-t-il dans mon agenda demain ?",
  example2: "Résume mes emails non lus d'aujourd'hui.",
  example3: 'Trouve la dernière version du fichier de budget dans mon Drive.',
  shortcutNotInPath: 'Ajoutez {dir} à votre PATH pour taper mcp-twake-ai depuis n’importe où.',
  nothingChosen: 'Aucun agent choisi : rien à faire.',
};

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en: EN, fr: FR };

export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (hole, name: string) => (name in vars ? String(vars[name]) : hole));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/i18n.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/i18n.ts tests/i18n.test.ts
git commit -m "feat: the texts of setup in English and French"
```

---

### Task 3 : questions (`Prompter`) et faux scénarisé

**Files:**
- Create: `src/prompter.ts`, `tests/helpers/scripted-prompter.ts`
- Modify: `package.json`, `package-lock.json` (`@clack/prompts@1.8.1`)
- Test: `tests/prompter.test.ts`

**Interfaces:**
- Produces:
  - `Prompter { intro(title); note(message, title?); text(o: { message; placeholder?; initialValue?; validate?(value): string | undefined }): Promise<string>; confirm(o: { message; initialValue? }): Promise<boolean>; multiselect<T>(o: { message; options: { value: T; label: string; hint?: string }[]; initialValues?: T[] }): Promise<T[]>; outro(message) }` ;
  - `SetupCancelled extends Error` (lancée quand l'utilisateur annule) ;
  - `clackPrompter(): Prompter` ;
  - `scriptedPrompter(answers: unknown[]): Prompter & { asked: string[]; shown: string[] }`, où une réponse `CANCEL` simule Échap.

- [ ] **Step 1: Add the dependency**

Run: `npm install --save @clack/prompts@1.8.1`
Expected: `package.json` lists `"@clack/prompts": "^1.8.1"`.

- [ ] **Step 2: Write the failing test**

`tests/helpers/scripted-prompter.ts` :

```ts
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
```

`tests/prompter.test.ts` :

```ts
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
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/prompter.test.ts`
Expected: FAIL, `../src/prompter.js` cannot be resolved.

- [ ] **Step 4: Write the implementation**

`src/prompter.ts` :

```ts
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

const answered = <T>(value: T | symbol): T => {
  if (isCancel(value)) throw new SetupCancelled();
  return value as T;
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
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/prompter.test.ts && npm run typecheck`
Expected: PASS (3 tests), typecheck propre (si le type `Option<T>` de clack refuse `as never`, ajuster le transtypage et le consigner).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/prompter.ts tests/helpers/scripted-prompter.ts tests/prompter.test.ts
git commit -m "feat: the questions of setup, with clack and a scripted fake"
```

---

### Task 4 : `runSetup` partagé, et `--email` en mode non interactif

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: `setupCommand` existant (plan 3b).
- Produces:
  - `SetupRequest { agents: AgentId[]; services?: ServiceId[]; apply: boolean; consent(agent: AgentId, action: EntryAction): boolean; noBrowser?: boolean; quiet?: boolean }` ;
  - `runSetup(request, io, d): Promise<{ code: number; conflicts: { agent: AgentId; action: EntryAction }[]; written: AgentId[] }>` ;
  - `setup --email <address>` connecte le compte d'abord, s'il n'y a pas de session.

- [ ] **Step 1: Write the failing test**

`tests/cli.test.ts`, in `describe('main: Twake Drive and Twake Chat', …)`:

```ts
  it('signs in first with --email when there is no session yet', async () => {
    const deps = await testDeps();
    await mkdir(join(deps.home, '.cursor'), { recursive: true });
    deps.runInstall = fakeNpm(deps.paths);
    const io = captureIo();
    expect(await main(['setup', '--email', 'alice@example.com', '--agents', 'cursor', '--services', 'chat'], io, deps)).toBe(0);
    expect(io.out).toContain('Signed in as alice@example.com');
    expect(io.out).toContain('Nothing was changed');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/cli.test.ts -t "signs in first"`
Expected: FAIL (`--email` is an unknown option of setup: exit 2).

- [ ] **Step 3: Write the implementation**

Dans `src/cli.ts`, `setupCommand` devient une analyse des options suivie d'un appel à `runSetup`. Le corps actuel de `setupCommand`, à partir de `const config = await loadConfig(d.paths);`, passe dans `runSetup`, avec ces changements :
- `names` vient de `request.agents` ;
- `chosen` vient de `request.services ?? defaultServices(config)` ;
- `force` disparaît au profit de `request.consent(adapter.id, action)` ;
- les lignes `if (!values.yes) …` deviennent `if (!request.apply) …` ;
- le résultat est `{ code, conflicts, written }`, où `conflicts` liste les actions `needsConsent` du plan et `written` les agents écrits avec succès ;
- avec `request.quiet`, `printPlan` et les messages « Nothing was changed » ne sont pas affichés (le parcours les montre à sa façon).

```ts
interface SetupRequest {
  agents: AgentId[];
  services?: ServiceId[];
  apply: boolean;
  consent(agent: AgentId, action: EntryAction): boolean;
  noBrowser?: boolean;
  quiet?: boolean;
}

/** setup --agents …: the non-interactive setup (spec §8). Without --agents on a terminal: the guided one (task 5). */
async function setupCommand(args: string[], io: Io, d: CliDeps): Promise<number> {
  const { values } = usageErrors(() =>
    parseArgs({
      args,
      options: {
        agents: { type: 'string' },
        services: { type: 'string' },
        yes: { type: 'boolean' },
        force: { type: 'boolean' },
        'no-browser': { type: 'boolean' },
        email: { type: 'string' },
      },
      strict: true,
    }),
  );
  if (values.email !== undefined && !(await loadConfig(d.paths).catch(() => undefined))) {
    const code = await loginCommand(['--email', values.email, ...(values['no-browser'] ? ['--no-browser'] : [])], io, d);
    if (code !== 0) return code;
  }
  const adapters = await createAdapters({ platform: d.platform, env: d.env, home: d.home, now: () => new Date(d.now() * 1000) });
  const detected = await detectAgents(adapters);
  if (values.agents === undefined) {
    throw new TwakeAiError('usage', `setup needs --agents: ${AGENT_IDS.join(', ')}, or "detected" (found here: ${detected.join(', ') || 'none'}).\n\n${USAGE}`);
  }
  const names = values.agents === 'detected' ? detected : [...new Set(values.agents.split(',').map((name) => name.trim()))];
  for (const name of names) {
    if (!isAgentId(name)) throw new TwakeAiError('usage', `"${name}" is not an agent mcp-twake-ai configures (${AGENT_IDS.join(', ')}): for any other one, use export.\n\n${USAGE}`);
  }
  if (names.length === 0) throw new TwakeAiError('usage', `No agent was found on this computer: name them with --agents.\n\n${USAGE}`);
  const services = values.services === undefined ? undefined : values.services.split(',').map((s) => s.trim());
  for (const service of services ?? []) {
    if (!isServiceId(service)) throw new TwakeAiError('usage', `"${service}" is not a Twake.ai service (${SERVICE_IDS.join(', ')}).\n\n${USAGE}`);
  }
  const force = values.force ?? false;
  const result = await runSetup(
    { agents: names as AgentId[], services: services as ServiceId[] | undefined, apply: values.yes ?? false, consent: () => force, noBrowser: values['no-browser'] },
    io,
    d,
  );
  return result.code;
}
```

`USAGE` : la ligne de `setup` devient `  mcp-twake-ai setup [--email <address>] --agents <ids|detected> [--services <list>] [--yes] [--force] [--no-browser]`.

- [ ] **Step 4: Run it to verify it passes, then the whole suite**

Run: `npx vitest run tests/cli.test.ts && npm test && npm run typecheck`
Expected: PASS ; les tests `setup` du plan 3b restent verts sans changement.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts tests/cli.test.ts
git commit -m "refactor: runSetup serves both setups; setup --email signs in first"
```

---

### Task 5 : le parcours guidé

**Files:**
- Create: `src/wizard.ts`
- Modify: `src/cli.ts` (`CliDeps.prompter?`, `CliDeps.interactive`, le kit, l'aiguillage de `setup`)
- Test: `tests/wizard.test.ts`

**Interfaces:**
- Consumes: `Prompter`, `SetupCancelled` (tâche 3) ; `t`, `Lang` (tâche 2) ; `renderBanner`, `wantsColor` (tâche 1) ; `runSetup` (tâche 4) ; `logout` (plan 4a) ; `handshake`, `entryStates` (plan 4a).
- Produces:
  - `WizardKit { lang; banner(): string; session(): Promise<{ email: string } | undefined>; signIn(email): Promise<{ email: string }>; agents(): Promise<{ id: AgentId; label: string; detected: boolean; elicitation: boolean }[]>; services(): Promise<{ id: ServiceId; label: string; preselected: boolean }[]>; plan(agents, services): Promise<{ text: string; conflicts: { agent: AgentId; label: string; name: string; key: string }[] }>; apply(agents, services, accepted: Set<string>): Promise<{ code: number; reload: string[] }>; check(agents): Promise<{ ok: boolean; line: string }[]>; revoke(): Promise<void> }` ;
  - `runWizard(kit, prompter, nodeVersion): Promise<number>`.

- [ ] **Step 1: Write the failing test**

`tests/wizard.test.ts` :

```ts
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

  it('stops on an old Node, saying how to fix it', async () => {
    const { kit } = fakeKit();
    const prompter = scriptedPrompter([]);
    expect(await runWizard(kit, prompter, '20.11.0')).toBe(1);
    expect(prompter.shown.join('\n')).toContain('needs Node 22.13 or later');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/wizard.test.ts`
Expected: FAIL, `../src/wizard.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/wizard.ts` :

```ts
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
}

const atLeast = (version: string, floor: string) => {
  const [a = 0, b = 0] = version.split('.').map(Number);
  const [x = 0, y = 0] = floor.split('.').map(Number);
  return a > x || (a === x && b >= y);
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The guided setup (spec §8). Returns the exit code. */
export async function runWizard(kit: WizardKit, prompter: Prompter, nodeVersion: string): Promise<number> {
  const say = (key: MessageKey, vars?: Record<string, string | number>) => t(kit.lang, key, vars);
  prompter.intro(kit.banner());
  if (!atLeast(nodeVersion, REQUIRED_NODE)) {
    prompter.outro(say('nodeTooOld', { required: REQUIRED_NODE, current: nodeVersion }));
    return 1;
  }
  let signedInNow = false;
  try {
    let session = await kit.session();
    if (session && !(await prompter.confirm({ message: say('continueAs', { email: session.email }), initialValue: true }))) session = undefined;
    if (!session) {
      const email = await prompter.text({ message: say('askEmail'), placeholder: 'jane.doe@company.com', validate: (value) => (EMAIL.test(value.trim()) ? undefined : say('emailInvalid')) });
      session = await kit.signIn(email.trim());
      signedInNow = true;
      prompter.note(say('signedInAs', { email: session.email }));
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
    const applied = await kit.apply(chosenAgents, chosenServices, accepted);
    prompter.note((await kit.check(chosenAgents)).map((check) => check.line).join('\n'), say('checking'));
    const examples = [say('example1'), say('example2'), say('example3')].map((example) => `  « ${example} »`).join('\n');
    prompter.note(applied.reload.join('\n'), say('reload'));
    prompter.outro(`${say('tryAsking')}:\n${examples}`);
    return applied.code;
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    if (signedInNow) {
      await kit.revoke().catch(() => undefined);
      prompter.note(say('revoked'));
    }
    prompter.outro(say('cancelled'));
    return 1;
  }
}
```

`src/cli.ts` :
- `CliDeps` : `/** the questions of the guided setup; undefined: clack on the terminal */ prompter?: Prompter;` et `/** stdin and stdout are a terminal */ interactive: boolean;` ; `defaultDeps()` : `interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY)`. Les `testDeps()` de `tests/cli.test.ts` mettent `interactive: false`.
- Dans `setupCommand`, avant l'erreur « setup needs --agents » : `if (values.agents === undefined && !values.yes && d.interactive) return runWizard(wizardKit(io, d), d.prompter ?? clackPrompter(), process.versions.node);`
- La fonction `wizardKit(io, d): WizardKit` assemble :
  - `lang: detectLanguage(d.env)` ;
  - `banner` : `renderBanner({ version: packageVersion(), columns: process.stdout.columns ?? 80, color: wantsColor(d.env, Boolean(process.stdout.isTTY)) })` ;
  - `session` : `loadConfig` puis `{ email }` ;
  - `signIn` : `loginCommand(['--email', email], io, d)`, une erreur si le code n'est pas 0, puis `{ email: config.email }` ;
  - `agents` : `createAdapters` et `detect()` sur chaque adaptateur, avec `capabilities.elicitation` ;
  - `services` : `SERVICE_IDS` avec les libellés `Mail`, `Calendar & contacts`, `Drive`, `Chat`, `Space`, `Project`, pré-cochés selon `defaultServices(config)`, plus `drive` si `config.environment.cozy.instance` ;
  - `plan` : `runSetup({ agents, services, apply: false, consent: () => false, quiet: true })`, avec un `Io` qui capture la sortie dans `text` ; les `conflicts` reçoivent `key = \`${agent}/${action.name}\`` ;
  - `apply` : `runSetup({ agents, services, apply: true, consent: (agent, action) => accepted.has(\`${agent}/${action.name}\`) })` ; `reload` reprend `capabilities.reload` de chaque agent écrit ;
  - `check` : pour chaque agent écrit, `entryStates` puis `handshake` sur chaque entrée `ok`, une ligne `✓ <label> · <nom> starts, <n> tools` ou `✗ <label> · <nom> <raison>` ;
  - `revoke` : `logout` avec la configuration et le coffre courants.

Un test CLI vérifie l'aiguillage :

```ts
  it('runs the guided setup on a terminal when no agent is named', async () => {
    const deps = await testDeps();
    deps.interactive = true;
    deps.prompter = scriptedPrompter(['alice@example.com', [], ['mail']]);
    const io = captureIo();
    expect(await main(['setup'], io, deps)).toBe(0);
    expect((deps.prompter as ReturnType<typeof scriptedPrompter>).shown.join('\n')).toContain('No agent chosen: nothing to do.');
    expect(idp.revoked).toHaveLength(1);
  });
```

(Il va dans `describe('main: second sign-in and failures', …)` ; importer `scriptedPrompter` de `./helpers/scripted-prompter.js`.)

- [ ] **Step 4: Run them to verify they pass, then the whole suite**

Run: `npx vitest run tests/wizard.test.ts tests/cli.test.ts && npm test && npm run typecheck`
Expected: PASS (6 tests in wizard, the new CLI test, the rest unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/wizard.ts src/cli.ts tests/wizard.test.ts tests/cli.test.ts
git commit -m "feat: the guided setup, from the banner to the summary"
```

---

### Task 6 : auto-installation sous `npx`, et raccourci

**Files:**
- Create: `src/self-install.ts`
- Modify: `src/cli.ts` (`setup` l'appelle avant d'écrire les agents ; `uninstall` retire le raccourci), `src/uninstall.ts`
- Test: `tests/self-install.test.ts`

**Interfaces:**
- Consumes: `serverDir`, `npmRunner`, `type Runner` (installer) ; `windowsQuote` n'est pas nécessaire (le raccourci `.cmd` met ses chemins entre guillemets doubles, refusés s'ils contiennent `"` ou `%`).
- Produces: `isNpxCache(cliPath): boolean` ; `selfInstall(paths, version, run?): Promise<string>` (chemin du `bin.js` installé) ; `shortcutPath(place): string` ; `writeShortcut(place, nodePath, cliPath): Promise<{ path: string; inPath: boolean }>` ; `removeShortcut(place): Promise<void>`.

- [ ] **Step 1: Write the failing test**

`tests/self-install.test.ts` :

```ts
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isNpxCache, removeShortcut, selfInstall, shortcutPath, writeShortcut } from '../src/self-install.js';
import { serverDir } from '../src/installer.js';
import { tempDir, tempPaths } from './helpers/tmp.js';

describe('self-install', () => {
  it('recognizes the npx cache', () => {
    expect(isNpxCache('/home/j/.npm/_npx/4f1c2d/node_modules/mcp-twake-ai/build/bin.js')).toBe(true);
    expect(isNpxCache('C:\\Users\\j\\AppData\\Local\\npm-cache\\_npx\\4f1c\\node_modules\\mcp-twake-ai\\build\\bin.js')).toBe(true);
    expect(isNpxCache('/usr/lib/node_modules/mcp-twake-ai/build/bin.js')).toBe(false);
  });

  it('installs its own version into the private prefix, once', async () => {
    const { paths } = await tempPaths();
    const calls: string[][] = [];
    const run = async (_command: string, args: string[]) => {
      calls.push(args);
      const dir = join(serverDir(paths, 'mcp-twake-ai'), 'node_modules', 'mcp-twake-ai');
      await mkdir(join(dir, 'build'), { recursive: true });
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'mcp-twake-ai', version: '1.2.3', bin: { 'mcp-twake-ai': 'build/bin.js' } }));
      await writeFile(join(dir, 'build', 'bin.js'), '');
    };
    const cli = await selfInstall(paths, '1.2.3', run);
    expect(cli).toBe(join(serverDir(paths, 'mcp-twake-ai'), 'node_modules', 'mcp-twake-ai', 'build', 'bin.js'));
    expect(calls[0]).toContain('mcp-twake-ai@1.2.3');
    expect(await selfInstall(paths, '1.2.3', run)).toBe(cli);
    expect(calls).toHaveLength(1);
  });

  it('writes a shortcut that starts the installed command, and says whether it is in PATH', async () => {
    const home = await tempDir();
    const place = { platform: process.platform, env: { LOCALAPPDATA: join(home, 'AppData', 'Local'), PATH: '' }, home };
    const { path, inPath } = await writeShortcut(place, '/usr/bin/node', '/prefix/mcp-twake-ai/build/bin.js');
    expect(path).toBe(shortcutPath(place));
    expect(inPath).toBe(false);
    const text = await readFile(path, 'utf8');
    expect(text).toContain('"/usr/bin/node" "/prefix/mcp-twake-ai/build/bin.js"');
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o111).not.toBe(0);
    const again = await writeShortcut({ ...place, env: { ...place.env, PATH: ['/usr/bin', join(path, '..')].join(delimiter) } }, '/usr/bin/node', '/x.js');
    expect(again.inPath).toBe(true);
    await removeShortcut(place);
    await expect(stat(path)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/self-install.test.ts`
Expected: FAIL, `../src/self-install.js` cannot be resolved.

- [ ] **Step 3: Write the implementation**

`src/self-install.ts` :

```ts
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import type { Place } from './agents/locations.js';
import { pathOf } from './agents/locations.js';
import { TwakeAiError } from './errors.js';
import { npmRunner, serverDir, type Runner } from './installer.js';
import type { AppPaths } from './paths.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const PACKAGE = 'mcp-twake-ai';

/** npx runs packages from a cache that npm may empty at any time: entries must not point there. */
export function isNpxCache(cliPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(cliPath);
}

/** Installs this version of mcp-twake-ai into the private prefix (spec §5.3) and returns its command (build/bin.js). */
export async function selfInstall(paths: AppPaths, version: string, run: Runner = npmRunner): Promise<string> {
  const dir = serverDir(paths, PACKAGE);
  const pkgDir = join(dir, 'node_modules', PACKAGE);
  const installed = async () => {
    try {
      const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as { version?: string };
      return pkg.version;
    } catch {
      return undefined;
    }
  };
  if ((await installed()) !== version) {
    await mkdir(dir, { recursive: true });
    await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--prefix', dir, '--no-audit', '--no-fund', '--save-exact', `${PACKAGE}@${version}`]);
    if ((await installed()) !== version) throw new TwakeAiError('unavailable', `npm did not install ${PACKAGE}@${version} into ${dir}.`);
  }
  return join(pkgDir, 'build', 'bin.js');
}

/** ~/.local/bin/mcp-twake-ai, or %LOCALAPPDATA%\twake-ai\bin\mcp-twake-ai.cmd on Windows. */
export function shortcutPath(place: Place): string {
  const path = pathOf(place);
  if (place.platform === 'win32') return path.join(place.env.LOCALAPPDATA || path.join(place.home, 'AppData', 'Local'), 'twake-ai', 'bin', `${PACKAGE}.cmd`);
  return path.join(place.home, '.local', 'bin', PACKAGE);
}

/** A command at a stable path for the user (the agents always use absolute paths). */
export async function writeShortcut(place: Place, nodePath: string, cliPath: string): Promise<{ path: string; inPath: boolean }> {
  const path = shortcutPath(place);
  const p = pathOf(place);
  if (/["%\r\n]/.test(nodePath + cliPath)) throw new TwakeAiError('unsupported', `${cliPath} cannot be written into a shortcut: install mcp-twake-ai under another folder.`);
  await mkdir(p.dirname(path), { recursive: true });
  if (place.platform === 'win32') await writeFile(path, `@"${nodePath}" "${cliPath}" %*\r\n`);
  else {
    await writeFile(path, `#!/bin/sh\nexec "${nodePath}" "${cliPath}" "$@"\n`);
    await chmod(path, 0o755);
  }
  const dirs = (Object.entries(place.env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? '').split(p.delimiter);
  return { path, inPath: dirs.some((dir) => dir && p.resolve(dir) === p.resolve(p.dirname(path))) };
}

export async function removeShortcut(place: Place): Promise<void> {
  await rm(shortcutPath(place), { force: true });
}
```

Le chemin du raccourci POSIX met `nodePath` et `cliPath` entre guillemets doubles. Un `$` ou un backtick dans ces chemins serait interprété par `sh` : ils sont refusés avec `"` et `%`, en ajoutant `$` et `` ` `` à la classe de caractères du `if`.

`src/cli.ts` :
- dans `runSetup`, juste avant `ensureInstalled`, si `isNpxCache(d.cliPath)` : `const cli = await selfInstall(d.paths, packageVersion(), d.runInstall)` ; le contexte du catalogue et les entrées utilisent alors `cli` (remplacer `d.cliPath` par une variable `cliPath` calculée une fois, passée à `catalogContext`). Le plan, affiché avant `--yes`, montre déjà ce chemin final : le calcul se fait donc avant le plan, l'installation elle-même seulement avec `apply`.
- après l'écriture des agents, `writeShortcut({ platform, env, home }, d.nodePath, cliPath)` ; si `!inPath`, une ligne `Add <dir> to your PATH to type mcp-twake-ai from anywhere.` ;
- `uninstall --yes` appelle `removeShortcut`.

Un test CLI : `deps.cliPath = join(deps.home, '.npm', '_npx', 'abc', 'node_modules', 'mcp-twake-ai', 'build', 'bin.js')` et un `runInstall` qui installe aussi un faux `mcp-twake-ai` (même forme que dans `tests/self-install.test.ts`). Après `setup --agents cursor --services mail --yes`, l'entrée de Cursor pointe vers `<prefix>/mcp-twake-ai/node_modules/mcp-twake-ai/build/bin.js`, et `shortcutPath` existe.

- [ ] **Step 4: Run them to verify they pass, then the whole suite**

Run: `npx vitest run tests/self-install.test.ts tests/cli.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/self-install.ts src/cli.ts src/uninstall.ts tests/self-install.test.ts tests/cli.test.ts
git commit -m "feat: under npx, mcp-twake-ai installs itself and adds a shortcut"
```

---

### Task 7 : test réel à la demande, et documentation

**Files:**
- Create: `scripts/live.mjs`, `docs/manual-checklist.md`
- Modify: `README.md`, `docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md`

**Interfaces:**
- Consumes: la CLI construite (`build/bin.js`).

- [ ] **Step 1: Write the script**

`scripts/live.mjs` : avec `LIVE_EMAIL` (obligatoire), dans un `TWAKE_AI_HOME` temporaire, il lance tour à tour, par la CLI construite et en affichant chaque étape :
1. `login --email $LIVE_EMAIL` (navigateur, ou `--no-browser` si `LIVE_NO_BROWSER=1`) ;
2. `token` pour `mail`, `dav`, `space` et `project`, en vérifiant `access_token` et `expires_at` ;
3. `status --no-start` ;
4. `logout` ;
5. `token mail`, qui doit échouer avec « mcp-twake-ai login ».

Il s'arrête à la première étape qui échoue, en la nommant, et supprime le dossier temporaire. Chaque étape est une fonction `step(name, args, check)` qui appelle `execFileSync(process.execPath, [cli, ...args], { env, stdio: ['inherit', 'pipe', 'inherit'] })`.

- [ ] **Step 2: Manual checklist**

`docs/manual-checklist.md`, en français, une section par agent (Claude Code, Hermes, Claude Desktop, Cursor, VS Code) :
1. `mcp-twake-ai setup` ;
2. redémarrage ou rechargement de l'agent ;
3. une question en lecture (« Qu'y a-t-il dans mon agenda demain ? ») ;
4. une écriture approuvée par élicitation (« Crée un brouillon d'email à moi-même »), sauf pour Claude Desktop, où l'écriture doit être refusée avec un message clair ;
5. `mcp-twake-ai status`.

- [ ] **Step 3: Documentation**

- `README.md` : en tête, `npx mcp-twake-ai setup` devient la façon recommandée de commencer (parcours guidé, bannière, en français ou en anglais selon la langue du système), avant l'installation globale ; une phrase sur le raccourci et l'auto-installation sous `npx` ; une section « Live test » qui renvoie vers `scripts/live.mjs` et `docs/manual-checklist.md`.
- Feuille de route : plan 4b livré ; ce qui reste dépend de l'extérieur (client OIDC, publication npm des MCP et de mcp-twake-ai).

- [ ] **Step 4: Run the suite, then commit**

Run: `npm test && npm run typecheck && node --check scripts/live.mjs`
Expected: PASS.

```bash
git add scripts/live.mjs docs/manual-checklist.md README.md docs/superpowers/plans/2026-11-10-twake-ai-roadmap.md
git commit -m "docs: live test script and the manual checklist per agent"
```
