# Recette manuelle par agent

À faire avec un vrai compte Twake.ai, après `scripts/live.mjs` (`LIVE_EMAIL=… node scripts/live.mjs`). Pour chaque agent, cocher les cinq points.

## Avant de commencer

- [ ] `npx mcp-twake-ai setup` affiche la bannière, puis se connecte (navigateur, ou code avec `--no-browser` en SSH).
- [ ] Les agents installés sont pré-cochés, et les services trouvés pour le compte aussi.
- [ ] Le plan liste les entrées `twake-*` (`twake_*` pour Hermes) ; après confirmation, chaque serveur écrit est marqué `✓ … starts`.

## Claude Code

- [ ] `mcp-twake-ai setup` avec Claude Code coché.
- [ ] Nouvelle session `claude` ; `/mcp` liste les serveurs `twake-*` connectés.
- [ ] Lecture : « Qu'y a-t-il dans mon agenda demain ? »
- [ ] Écriture approuvée par élicitation : « Crée un brouillon d'email à moi-même avec pour sujet Test » ; la demande d'approbation s'affiche dans le terminal, l'accepter, vérifier le brouillon dans Twake Mail.
- [ ] `mcp-twake-ai status` : tout est `✓`.

## Hermes

- [ ] `mcp-twake-ai setup` avec Hermes coché ; `config.yaml` est inchangé hors de `mcp_servers` (comparer avec la copie `config.yaml.bak-<date>`).
- [ ] `/reload-mcp` dans Hermes, ou redémarrage.
- [ ] Lecture : « Qu'y a-t-il dans mon agenda demain ? »
- [ ] Écriture approuvée par élicitation (brouillon d'email), avec la demande d'approbation de Hermes.
- [ ] `mcp-twake-ai status` : tout est `✓`.

## Claude Desktop

- [ ] `mcp-twake-ai setup` avec Claude Desktop coché ; le parcours prévient qu'il ne sait pas afficher les demandes d'approbation.
- [ ] Quitter complètement Claude Desktop, puis le relancer ; les serveurs `twake-*` apparaissent dans les réglages des connecteurs.
- [ ] Lecture : « Qu'y a-t-il dans mon agenda demain ? »
- [ ] Écriture : la demande est refusée avec un message clair, sans rien créer.
- [ ] `mcp-twake-ai status` : tout est `✓`.

## Cursor

- [ ] `mcp-twake-ai setup` avec Cursor coché ; `~/.cursor/mcp.json` garde les autres serveurs.
- [ ] Les serveurs `twake-*` apparaissent dans Settings > MCP (sinon, quitter et relancer Cursor).
- [ ] Lecture : « Qu'y a-t-il dans mon agenda demain ? »
- [ ] Écriture approuvée par élicitation (brouillon d'email).
- [ ] `mcp-twake-ai status` : tout est `✓`.

## VS Code

- [ ] `mcp-twake-ai setup` avec VS Code coché ; `User/mcp.json` garde ses commentaires, les autres serveurs et `inputs`.
- [ ] Vue MCP Servers : les serveurs `twake-*` démarrent au premier message de chat.
- [ ] Lecture : « Qu'y a-t-il dans mon agenda demain ? »
- [ ] Écriture approuvée par élicitation (brouillon d'email).
- [ ] `mcp-twake-ai status` : tout est `✓`.

## Pour finir

- [ ] `mcp-twake-ai uninstall` montre ce qu'il retirerait ; `mcp-twake-ai uninstall --yes` retire les entrées, révoque les autorisations et supprime les fichiers ; les stores Chat restent (sauf `--delete-chat-stores`).
- [ ] « Twake AI » n'apparaît plus dans les appareils connectés de Twake Drive, ni les devices « Twake AI · <agent> » dans Twake Chat.
