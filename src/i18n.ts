export type Lang = 'en' | 'fr';

const EN = {
  nodeTooOld: 'mcp-twake-ai needs Node {required} or later, and this is Node {current}: install a recent Node from https://nodejs.org, then run setup again.',
  askEmail: 'Your Twake.ai email address',
  emailInvalid: 'An email address looks like name@company.com',
  signInAgain: 'Enter your address to sign in again.',
  continueAs: 'Continue as {email}?',
  signedInAs: 'Signed in as {email}.',
  chooseAgents: 'Which agents should get the Twake.ai servers?',
  agentDetected: 'found on this computer',
  agentMissing: 'not found',
  chooseServices: 'Which services?',
  noElicitation: '{agent} cannot show approval requests: it can read, and every write it asks for is refused.',
  planTitle: 'What setup will do',
  replaceEntry: '{agent}: replace {name}, which was configured outside mcp-twake-ai or changed by hand?',
  removeEntry: '{agent}: remove {name}, which was changed by hand since mcp-twake-ai wrote it?',
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
  failed: 'Setup stopped: {reason}',
} as const;

export type MessageKey = keyof typeof EN;

const FR: Record<MessageKey, string> = {
  nodeTooOld: 'mcp-twake-ai demande Node {required} ou plus récent, et celui-ci est Node {current} : installez un Node récent depuis https://nodejs.org, puis relancez setup.',
  askEmail: 'Votre adresse email Twake.ai',
  emailInvalid: 'Une adresse email a la forme nom@entreprise.com',
  signInAgain: 'Saisissez votre adresse pour vous reconnecter.',
  continueAs: 'Continuer avec {email} ?',
  signedInAs: 'Connecté en tant que {email}.',
  chooseAgents: 'Quels agents doivent recevoir les serveurs Twake.ai ?',
  agentDetected: 'trouvé sur cet ordinateur',
  agentMissing: 'absent',
  chooseServices: 'Quels services ?',
  noElicitation: "{agent} ne sait pas afficher les demandes d'approbation : il peut lire, et chaque écriture qu'il demande est refusée.",
  planTitle: 'Ce que setup va faire',
  replaceEntry: '{agent} : remplacer {name}, configurée hors de mcp-twake-ai ou modifiée à la main ?',
  removeEntry: "{agent} : retirer {name}, modifiée à la main depuis que mcp-twake-ai l'a écrite ?",
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
  failed: 'Setup arrêté : {reason}',
};

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en: EN, fr: FR };

export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (hole, name: string) => (name in vars ? String(vars[name]) : hole));
}
