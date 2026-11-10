# twake-ai : feuille de route d'implémentation

Spec : `docs/superpowers/specs/2026-11-10-twake-ai-wizard-design.md`

La spec est découpée en quatre plans. Chacun livre un logiciel qui fonctionne et qui se teste seul, et chacun s'appuie sur le précédent. Seul le plan 1 est écrit en détail. Les suivants seront rédigés juste avant leur exécution, à partir du code réel du plan qui les précède.

| Plan | Livre | Sections de la spec | Dépend de |
|---|---|---|---|
| **1. Socle et broker OIDC** (`2026-11-10-twake-ai-plan-1-socle-broker-oidc.md`) | `twake-ai login`, `twake-ai token <mail\|dav\|space\|project>` : le `my-token-broker` des README, utilisable tout de suite à la main | 5.2 (discovery, auth OIDC, vault), 5.3, 6, 7.1 (OIDC), 7.2, 7.4 | — |
| **2. Drive et Chat** (`2026-11-10-twake-ai-plan-2-drive-chat.md`) | `token drive`, `token chat --agent X`, `login --agent X`, mode sans navigateur par URL collée | 6 (étape 7, apps activées), 7.1 (cozy, Matrix), 7.2 | plan 1 |
| **3. Lanceur, agents, export** | installation des MCP en versions figées dans le préfixe privé, `twake-ai run`, les cinq adaptateurs d'agents, `twake-ai export` | 5.3 (préfixe), 9, 10, 11 | plans 1 et 2 |
| **4. Parcours complet et exploitation** | `twake-ai setup` interactif et non interactif (bannière, i18n fr/en), `status`, `logout`, `uninstall`, journal, CI sur 3 OS, test réel | 8, 12, 13.4, 13.5 | plans 1 à 3 |

## Plan 2 : Drive et Chat (périmètre)

- **OAuth cozy :**
  - `POST /auth/register` (client « Twake AI », scopes du README de mcp-twake-drive), PKCE vers le loopback, `POST /auth/access_token`, refresh sous le verrou `cozy`.
  - Secret du client et refresh token dans le coffre.
  - `DELETE /auth/register/:id` disponible pour le plan 4.
- **Sonde `allow_oauth_token`** (`POST /oidc/access_token` avec des valeurs factices) : si l'échange est activé, on l'utilise à la place de la redirection.
- **Apps activées :** `GET /settings/context` → `additional_platform_apps`, conservées dans la configuration.
- **Matrix, un device par agent :**
  - `/_matrix/client/v3/login/sso/redirect/<idp>` vers le loopback, puis `POST /login` (`m.login.token`, `refresh_token: true`, `initial_device_display_name: "Twake AI · <agent>"`), refresh sous le verrou `matrix-<agent>`.
  - Sortie : `device_id` et `user_id`.
  - `login/get_token` (MSC3882) quand Synapse le permet.
- **Sans navigateur, pour cozy et Matrix :** afficher l'URL, puis lire l'URL de retour collée par l'utilisateur.
- Faux cozy et faux Synapse sur `127.0.0.1`, sur le modèle du faux IdP du plan 1.

## Plan 3 : lanceur, agents, export (périmètre)

- **Installateur :** `npm install --prefix <dataDir>/prefix` avec les six MCP et `twake-ai` en versions figées ; chemin absolu de Node noté dans la configuration.
- **URL issues de SRV (DNS non authentifié) :** avant de leur confier le jeton aux quatre audiences, les contraindre (cible dans le domaine de l'email, ou dans une liste connue du SaaS) ou les faire confirmer pendant `setup`. Décision reportée depuis la revue finale du plan 1.
- **`catalog`, sous forme de données :** paquet, version, construction de l'environnement par service et par agent. `TOKEN_CMD` met les chemins entre apostrophes POSIX, car les MCP passent par `/bin/sh -c`.
- **`twake-ai run <service> --agent X` :** environnement, lancement, relais de stdio et des signaux, propagation du code de sortie. Test de bout en bout avec une élicitation qui traverse le lanceur.
- **Cinq adaptateurs :** Claude Code (`claude mcp add-json` / `remove`), Hermes (`yaml` Document API, sauvegarde horodatée), Claude Desktop, Cursor, VS Code. Chacun avec `detect`, `capabilities`, `plan`, `apply`, `remove`, l'empreinte des entrées, l'écriture atomique et la restauration en cas d'échec.
- **`twake-ai export` :** `mcpServers.json`, `vscode-mcp.json`, `hermes.yaml`, `codex.toml`, `claude-code.sh`, `<service>.env`, `commands.txt`, `README.md` ; options `--raw` et `--agent`.

## Plan 4 : parcours complet et exploitation (périmètre)

- **`setup` :**
  - bannière (dégradé `#2F6BFF` → `#00D1C1`, `NO_COLOR`, version compacte sous 60 colonnes) ;
  - `@clack/prompts`, i18n fr/en à partir des codes d'erreur ;
  - plan, puis confirmation, puis application ;
  - mode non interactif (`--email --agents --services --yes`) ;
  - révocation des autorisations en cas d'abandon.
- **`status` :** matrice agents × services, et poignée de main MCP (`initialize` puis `tools/list`) à travers le lanceur ; `--env`.
- **`logout` complet et `uninstall`** (section 12.3 de la spec).
- **Raccourci `twake-ai`** à un chemin stable.
- **Journal** avec les jetons masqués.
- **CI** Ubuntu, macOS et Windows, avec Node 22.13 et la dernière LTS ; **`scripts/live.mjs`** et liste de recette manuelle par agent.

## Prérequis extérieurs

| Prérequis | Bloque | Responsable |
|---|---|---|
| Client OIDC « twake-ai-agents » dans le LemonLDAP du SaaS (spec 7.4) | le test réel des plans 1 à 4 (le code se teste avec le faux IdP) | IdP / exploitation SaaS |
| Les six MCP lancent `*_TOKEN_COMMAND` avec `cmd.exe` sous Windows | Windows aux plans 3 et 4 | dépôts MCP |
| Prise en charge de l'élicitation par Claude Desktop et Cursor | la table de capacités du plan 3 | à vérifier au début du plan 3 |
| Synapse : refresh tokens et MSC3882 | les choix du plan 2 (sans eux, le plan 2 fonctionne quand même) | à vérifier au début du plan 2 |
