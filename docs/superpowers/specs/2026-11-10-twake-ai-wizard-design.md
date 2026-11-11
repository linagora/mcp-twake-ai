# mcp-twake-ai : wizard d'installation et broker d'authentification des MCP Twake.ai

- **Date** : 2026-11-10
- **Statut** : design validé en brainstorming, spec à relire
- **Paquet npm** : `mcp-twake-ai` (nom libre sur npm au 2026-11-11). La commande porte le même nom (`mcp-twake-ai setup`, `mcp-twake-ai login`…). Gardent `twake-ai` : les dossiers de données, les variables `TWAKE_AI_*`, le service du trousseau, le journal et le client OIDC `twake-ai-agents`.
- **Licence** : AGPL-3.0, comme les six MCP

## 1. Objectif

Twake.ai publie six serveurs MCP (mail, dav, drive, chat, space, project). Chacun s'installe, se configure et s'authentifie à sa façon, et leurs six README renvoient tous à un `my-token-broker` qui n'existe pas. `mcp-twake-ai` comble ce manque : un client du SaaS Twake.ai tape son adresse email, se connecte une fois en SSO, choisit ses agents et repart avec les six MCP opérationnels.

### Critères de succès

1. Un client SaaS passe de rien aux six MCP opérationnels dans les agents de son choix, avec **une seule saisie de mot de passe SSO**, en moins de 5 minutes.
2. Aucun secret ni jeton dans les configurations d'agents.
3. `mcp-twake-ai status` est entièrement vert à la fin du `setup`.
4. Relancer `setup` ne change rien quand rien n'a changé (idempotence).
5. Les jetons se renouvellent sans intervention tant que la session hors ligne de l'IdP est valide ; quand elle expire, l'agent dit à l'utilisateur de lancer `mcp-twake-ai login`.

## 2. Périmètre v1

| Dans le périmètre | Hors périmètre |
|---|---|
| Clients du SaaS Twake.ai (découverte depuis l'email) | Instances auto-hébergées (la saisie manuelle des URL existe en repli, sans garantie côté IdP) |
| Agents : Claude Code, Hermes Agent, Claude Desktop, Cursor, VS Code | Daemon HTTP partagé pour Chat |
| Export de fichiers pour tout autre harnais | Mode lecture seule, exclusion d'outils |
| macOS, Linux, Windows, serveur sans navigateur | Commande `update` séparée (relancer `setup` suffit) |
| Les six MCP, sans aucune modification de leur code | Passerelle MCP qui agrège les six serveurs |
| CLI en français et en anglais | Interface web complète, télémétrie |

## 3. Contexte : les six MCP

| Service (`id`) | Paquet npm (version au 2026-11-10) | Node | Authentification utilisée par mcp-twake-ai | Particularités |
|---|---|---|---|---|
| `mail` | `mcp-twake-mail` 4.1.0 | ≥ 20 | `JMAP_AUTH_METHOD=command`, `JMAP_TOKEN_COMMAND` | a déjà son propre `setup` ; non utilisé |
| `dav` | `mcp-twake-dav` 4.2.0 | ≥ 20.3 | `DAV_AUTH_METHOD=command`, `DAV_TOKEN_COMMAND` | `DAV_ORGANIZER_EMAIL` obligatoire avec un jeton SSO ; `DAV_HREF_PREFIX` selon le serveur |
| `drive` | `mcp-twake-drive` 0.4.0 | ≥ 20 | `TWAKE_DRIVE_TOKEN_COMMAND` | OAuth cozy-stack propre à l'instance |
| `chat` | `mcp-twake-chat` 0.6.0 | ≥ 22.13 | `MATRIX_TOKEN_COMMAND` (fournit aussi `device_id` et `user_id`) | store E2EE lié au device, verrouillé : un seul processus par device |
| `space` | `mcp-twake-space` 0.2.1 | ≥ 22 | `TWAKE_SPACE_TOKEN_COMMAND` + `TWAKE_SPACE_OIDC_ISSUER` | jeton OIDC avec l'audience `twakespace` et les claims `uuid`, `email`, `sid`, `org_id` |
| `project` | `mcp-twake-project` 0.2.1 | ≥ 22 | `TWAKE_PROJECT_TOKEN_COMMAND` + `TWAKE_PROJECT_OIDC_ISSUER` | jeton OIDC avec l'audience `twake-projects` |

Les six serveurs demandent l'accord de l'utilisateur avant chaque écriture, par élicitation MCP (`*_APPROVAL=elicit` par défaut). Chacun nomme sa variable différemment : `JMAP_APPROVAL`, `DAV_APPROVAL`, `TWAKE_DRIVE_APPROVAL`, `MATRIX_APPROVAL`, `TWAKE_SPACE_APPROVAL`, `TWAKE_PROJECT_APPROVAL`, et de même pour `*_APPROVAL_TIMEOUT_MS`.

## 4. Décisions

| Sujet | Décision |
|---|---|
| Cible | Clients du SaaS Twake.ai |
| Agents v1 | Claude Code, Hermes, Claude Desktop, Cursor, VS Code, plus `export` pour les autres |
| Forme | CLI dans le terminal ; navigateur ouvert uniquement pour le SSO |
| Architecture | Un paquet `mcp-twake-ai` = wizard + broker de jetons + lanceur. Les MCP restent inchangés |
| Client OIDC | Un client public unique « twake-ai-agents », créé par LINAGORA dans le LemonLDAP du SaaS |
| Drive | OAuth cozy classique (l'échange OIDC → cozy est désactivé sur le SaaS) |
| Chat | Un device Matrix par agent |
| OS | macOS, Linux, Windows, serveur sans navigateur |
| Installation | Préfixe privé, versions figées des MCP, pas de `npx -y` au lancement |
| Configs d'agents | Elles appellent le lanceur `mcp-twake-ai run <service> --agent <id>`, sans variables d'env |

## 5. Architecture

```
                    ┌──────────────── mcp-twake-ai (npm, TypeScript, Node ≥ 22.13) ───────────────┐
 utilisateur ──►    │  setup ─► discovery ─► auth (login) ─► catalog ─► agents (écriture)    │
                    │  token <service> [--agent X] ─► auth (refresh) ─► stdout JSON           │
                    │  run <service> --agent X ─► catalog ─► lance le MCP (stdio relayé)      │
                    │  login · status · export · logout · uninstall                           │
                    │                         vault (coffre OS + verrou)                      │
                    └─────────────────────────────────────────────────────────────────────────┘
 agent ─lance─► mcp-twake-ai run X ─lance─► mcp-twake-X ─*_TOKEN_COMMAND─► mcp-twake-ai token X
```

### 5.1 Commandes

| Commande | Rôle |
|---|---|
| `setup` | Parcours complet, interactif ou non (`--email --agents --services --yes`). Idempotent : sert aussi à mettre à jour, ajouter ou retirer des agents et des services |
| `login [--agent X]` | Refait l'authentification seulement (OIDC, cozy, ou le device Chat d'un agent) |
| `token <service> [--agent X]` | Broker : écrit un jeton valide sur stdout |
| `run <service> --agent X` | Lanceur : construit l'environnement du MCP et le démarre |
| `status [--env <service>]` | Matrice de santé agents × services ; `--env` affiche l'environnement généré, sans secret |
| `export --agent X [--services …] [--raw] [--out DIR]` | Génère les fichiers de configuration pour un harnais quelconque |
| `logout` | Révoque toutes les autorisations et efface les secrets |
| `uninstall` | Retire les entrées d'agents, fait `logout`, supprime le préfixe |

### 5.2 Modules

Chaque module a un seul rôle et se teste seul.

| Module | Rôle | Interface |
|---|---|---|
| `discovery` | email → `TwakeEnvironment` | `discover(email)`, puis `complete(env, userinfo, cozyContext)` après la connexion |
| `auth` | autorisation OIDC (PKCE loopback ou device flow), OAuth cozy, sessions Matrix par agent, révocation | `login(target)`, `token(service, agent?)`, `logout()` |
| `vault` | secrets dans le coffre de l'OS (`@napi-rs/keyring`), fichier 0600 en repli ; verrous inter-processus | `get/set/delete`, `withLock(name, fn)` |
| `catalog` | les six MCP sous forme de données : paquet et version figée, construction de l'environnement, nom d'entrée par agent, réglages propres à chaque agent | table, sans effet de bord |
| `agents` | un adaptateur par agent | `detect()`, `capabilities()`, `plan(servers)`, `apply(plan)`, `remove()` |
| `launcher` | `run` : environnement, lancement, relais de stdio et des signaux | `run(service, agent)` |
| `exporter` | génération des fichiers d'export | `export(agent, services, options)` |
| `cli` | commandes, questions (derrière une interface remplaçable en test), bannière, i18n fr/en | |

Bibliothèques pressenties : `@clack/prompts` (questions), `open` (navigateur), `yaml` (édition YAML qui préserve les commentaires), `smol-toml` (export TOML), `proper-lockfile` (verrous), `@napi-rs/keyring` (coffres), `@modelcontextprotocol/sdk` (poignée de main de `status`).

### 5.3 Installation et fichiers sur disque

- `npx mcp-twake-ai setup` s'installe avec les six MCP, en **versions figées**, dans un préfixe privé :
  - Linux et macOS : `~/.local/share/twake-ai/`
  - Windows : `%LOCALAPPDATA%\twake-ai\`
- Un raccourci `mcp-twake-ai` est créé à un chemin stable (`~/.local/bin/mcp-twake-ai`, ou l'équivalent Windows) pour l'utilisateur. Les configurations d'agents, elles, utilisent toujours des chemins absolus, parce que certains agents (Claude Desktop lancé depuis le Finder, par exemple) n'héritent pas du `PATH` de l'utilisateur.
- `~/.config/twake-ai/config.json` (rien de secret) contient :
  - l'email, l'environnement découvert, la langue et le fuseau ;
  - le chemin absolu de Node retenu au `setup` ;
  - les versions installées ;
  - les agents déclarés, avec, pour chaque entrée écrite, son nom et l'empreinte de ce qui a été écrit ;
  - l'identifiant du client OAuth cozy, et le `user_id` et le `device_id` Matrix par agent.
- Coffre de l'OS : refresh token OIDC, refresh token cozy et secret du client cozy, jetons Matrix par agent.
- `~/.cache/twake-ai/tokens/<autorisation>.json` (0600, un fichier par autorisation : `oidc`, `cozy`, `matrix-<agent>`) : jeton d'accès en cache avec son `expires_at`. Ça évite de solliciter le Trousseau macOS à chaque appel. Un fichier par autorisation permet à deux autorisations de se renouveler en même temps sans écraser le cache l'une de l'autre.
- Variable `TWAKE_AI_HOME` : si elle est définie, tous ces répertoires sont regroupés sous ce chemin (tests, test réel, plusieurs comptes).
- `~/.local/share/twake-ai/chat/<agent>/` : store E2EE et index de Chat, un par agent.
- `~/.local/state/twake-ai/twake-ai.log` : journal, jetons masqués.

Les équivalents Windows suivent `%APPDATA%` et `%LOCALAPPDATA%`.

## 6. Découverte

Relevée le 2026-11-10 sur le SaaS LINAGORA (`prenom@linagora.com`) :

| Étape | Source | Résultat |
|---|---|---|
| 1 | `https://<domaine>/.well-known/matrix/client` | `m.homeserver` (`matrix.linagora.com`), `t.server` (ToM, `tom.linagora.com`), `m.authentication.issuer` (`https://sso.linagora.com/`), `app.twake.chat.common_settings.application_url` (`https://{username}-settings.twake.linagora.com/`) |
| 2 | `<issuer>/.well-known/openid-configuration` | endpoints authorize, token, userinfo, revoke ; PKCE S256 ; `device_authorization_endpoint` ; scope et claim `workplaceFqdn` |
| 3 | DNS `SRV _jmap._tcp.<domaine>` | `jmap.linagora.com:443`, puis la session JMAP via `/.well-known/jmap` sur cet hôte (à défaut, `/jmap/session`) |
| 4 | DNS `SRV _caldavs._tcp.<domaine>` | `dav.linagora.com:443` |
| 5 | convention `space.<domaine>` et `projects.<domaine>`, vérifiée par une requête | `space.linagora.com`, `projects.linagora.com` (marquées « devinées » dans l'interface) |
| 6 | après connexion : userinfo `workplaceFqdn` | instance cozy exacte (ex. `jdoe.twake.linagora.com`) ; le modèle `{username}` de l'étape 1 ne sert qu'en repli |
| 7 | après connexion : `GET https://<instance>/settings/context` | `additional_platform_apps` : apps activées pour l'organisation (`mail`, `chat`, `space`, `project`, `calendar`…), utilisées pour pré-cocher les services |
| 8 | `GET <homeserver>/_matrix/client/v3/login` | flux `m.login.sso` (IdP `oidc-twake`) et `m.login.token` |

Toute URL peut être corrigée à la main pendant le `setup`. Un domaine sans `.well-known/matrix/client` n'est pas un domaine du SaaS Twake.ai : le wizard le dit, puis propose la saisie manuelle.

## 7. Authentification et broker

### 7.1 Trois autorisations

| Autorisation | Sert à | Obtention | Renouvellement |
|---|---|---|---|
| OIDC « twake-ai-agents » | `mail`, `dav`, `space`, `project` (**le même jeton d'accès**, qui porte les quatre audiences) | PKCE vers `http://127.0.0.1:<port>/callback` ; device flow sans navigateur | refresh token de LemonLDAP |
| OAuth cozy | `drive` | `POST /auth/register` (client « Twake AI », visible dans les appareils connectés du compte), puis `/auth/authorize` en PKCE ; transparent grâce à la session LemonLDAP déjà ouverte | refresh token cozy |
| Matrix, une par agent | `chat --agent X` | `/_matrix/client/v3/login/sso/redirect/oidc-twake?redirectUrl=<loopback>`, puis `POST /login` (`m.login.token`, `refresh_token: true`, `initial_device_display_name: "Twake AI · <agent>"`) | `POST /_matrix/client/v3/refresh` si Synapse fournit un refresh token ; sinon jeton sans expiration |

Scopes cozy, repris du README de mcp-twake-drive : `io.cozy.files io.cozy.files.* io.cozy.notes io.cozy.permissions io.cozy.sharings:GET io.cozy.settings:GET io.cozy.contacts:GET`.

**Échange OIDC → cozy :** `POST /oidc/access_token` répond `{"error":"this endpoint is not enabled"}` sur le contexte `linagora_default` (vérifié le 2026-11-10 avec des valeurs factices, en `oidc_token` comme en `id_token`). `auth` le sonde de la même façon. Si l'exploitation l'active un jour, Drive passera par cet échange, sans redirection ni navigateur.

**Sans navigateur** (variable `SSH_CONNECTION` présente, pas d'affichage, ou `--no-browser`) :

- OIDC passe par le device flow.
- Drive et Chat n'ont pas de device flow. Le wizard affiche l'URL à ouvrir sur un autre appareil, et l'utilisateur colle en retour l'URL finale. La page de retour ne se charge pas, mais son adresse contient le `code` ou le `loginToken`.

**Devices Chat suivants :** si Synapse permet `POST /_matrix/client/v1/login/get_token` (MSC3882), les devices des agents suivants sont créés à partir du premier, sans navigateur. Sinon, une redirection SSO par agent, enchaînées automatiquement.

### 7.2 Contrat de `mcp-twake-ai token`

- Succès : code 0, et sur stdout `{"access_token": "...", "expires_at": <epoch s>}`. Pour `chat`, on ajoute `"device_id"` et `"user_id"`.
- Échec : code non nul, et sur stderr une phrase qui dit quoi faire, par exemple « Session Twake expirée : lancez `mcp-twake-ai login` ». Rien n'est écrit sur stdout.
- Le jeton d'accès en cache est servi s'il lui reste plus de 60 s. Sinon :
  1. prendre le verrou de l'autorisation ;
  2. **relire le cache**, car un autre processus a pu renouveler entre-temps ;
  3. renouveler seulement si le jeton est toujours périmé ;
  4. écrire le nouveau refresh token dans le coffre, puis le cache ;
  5. libérer le verrou.

  Ça protège la rotation des refresh tokens quand plusieurs MCP, dans plusieurs agents, demandent un jeton au même moment.
- Verrou indisponible pendant plus de 10 s : erreur explicite, sans tenter de renouvellement concurrent.
- `token` refuse de lire un cache ou un fichier de repli dont les permissions sont plus larges que 0600.

### 7.3 `logout`

1. Révocation du refresh token OIDC (`revocation_endpoint`).
2. Suppression du client cozy (`DELETE /auth/register/:client_id`).
3. `POST /_matrix/client/v3/logout` pour chaque device Matrix.
4. Effacement du coffre et du cache.

Chaque étape est tentée même si la précédente échoue. Le récapitulatif liste ce qui n'a pas pu être révoqué.

### 7.4 Prérequis côté IdP (LINAGORA, LemonLDAP du SaaS)

Client OIDC « twake-ai-agents » :

- public (sans secret), PKCE S256 obligatoire ;
- `offline_access` (refresh token) ; dire si les refresh tokens tournent à chaque usage ;
- device flow autorisé ;
- redirections loopback sur une **liste de ports fixes**, par exemple `http://127.0.0.1:8765/callback`, `:8766`, `:8767`. Rien ne garantit que LemonLDAP ignore le port comme le prévoit la RFC 8252 ;
- audiences additionnelles : `twake-projects`, `twakespace`, ainsi que celles qu'acceptent JMAP (`jmap.linagora.com`) et DAV (`dav.linagora.com`) ;
- claims userinfo : `email`, `uuid`, `sid`, `org_id` (pour Space) et `workplaceFqdn`.

## 8. Parcours `setup`

Au lancement, une bannière s'affiche, toujours dans cette disposition, quelle que soit la largeur du terminal :

```
  ███╗   ███╗ ██████╗██████╗
  ████╗ ████║██╔════╝██╔══██╗
  ██╔████╔██║██║     ██████╔╝
  ██║╚██╔╝██║██║     ██╔═══╝
  ██║ ╚═╝ ██║╚██████╗██║
  ╚═╝     ╚═╝ ╚═════╝╚═╝

  ████████╗██╗    ██╗ █████╗ ██╗  ██╗███████╗    █████╗ ██╗
  ╚══██╔══╝██║    ██║██╔══██╗██║ ██╔╝██╔════╝   ██╔══██╗██║
     ██║   ██║ █╗ ██║███████║█████╔╝ █████╗     ███████║██║
     ██║   ██║███╗██║██╔══██║██╔═██╗ ██╔══╝     ██╔══██║██║
     ██║   ╚███╔███╔╝██║  ██║██║  ██╗███████╗██╗██║  ██║██║
     ╚═╝    ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝╚═╝╚═╝  ╚═╝╚═╝

  Your sovereign Digital Workplace, connected to your AI agent
  Sets up the MCP servers of the Twake.ai platform in your AI agents.
  Mail · Calendar · Drive · Chat · Space · Project        v1.0.0
```

- Dégradé horizontal truecolor du bleu Twake (`#2F6BFF`) vers le cyan (`#00D1C1`), sous-titre en gris (`#9AA4B5`).
- Pas de couleur si `NO_COLOR` est défini ou si la sortie n'est pas un terminal.
- Pas de bannière en mode non interactif.
- Le parcours est en anglais (décision du 2026-11-11). `TWAKE_AI_LANGUAGE=fr` le passe en français. La langue des serveurs MCP (`USER_LANGUAGE`) suit toujours celle du système.

Étapes :

1. **Prérequis** : Node ≥ 22.13. Sinon, le wizard explique comment l'installer et s'arrête.
2. **Email**, puis découverte (section 6). Les services trouvés s'affichent : `✓` découvert, `~` deviné puis vérifié. Chaque URL peut être corrigée.
3. **Connexion OIDC** (section 7.1), puis `complete()` : instance cozy et apps activées.
4. **Agents** : détection automatique, agents détectés pré-cochés.
   - Claude Code : `claude` trouvé dans le `PATH`.
   - Hermes : `~/.hermes/config.yaml` ou `$HERMES_HOME`.
   - Claude Desktop, Cursor, VS Code : leur répertoire de configuration existe.
5. **Services** : pré-cochés selon `additional_platform_apps`.
6. **Connexions complémentaires** : OAuth cozy si Drive est choisi ; un device Matrix par agent si Chat est choisi.
7. **Réglages déduits, sans question** : langue = locale de l'instance cozy (`/settings/instance`), fuseau = celui du système. Réglages propres à chaque agent : section 9.
8. **Élicitation** : pour un agent qui ne la gère pas, le wizard l'explique (section 10.2).
9. **Plan** : diff par agent, entrées remplacées, sauvegardes. Une seule confirmation.
10. **Application** : installation dans le préfixe, écriture des configurations, puis `status` restreint aux entrées écrites.
11. **Récapitulatif** : ce qui marche, les redémarrages à faire (Claude Desktop, Hermes), et trois exemples de questions à poser à l'agent.

Rien n'est écrit, ni configuration ni préfixe, avant la confirmation de l'étape 9. Les autorisations obtenues aux étapes 3 et 6 sont révoquées si l'utilisateur abandonne.

## 9. Lanceur `mcp-twake-ai run`

Une entrée d'agent ne contient que :

```
command: <chemin absolu de node>
args:    [<préfixe>/node_modules/mcp-twake-ai/dist/cli.js, "run", "<service>", "--agent", "<agent>"]
```

`run` lit `config.json`, construit l'environnement à partir de `catalog` et lance `<préfixe>/node_modules/mcp-twake-<x>/build/index.js` avec le même Node. stdin, stdout et stderr sont relayés tels quels, les signaux sont transmis, et le code de sortie est propagé.

Environnement construit par service. `TOKEN_CMD` désigne `"<node>" "<cli.js>" token <service>`, avec `--agent <agent>` pour `chat` :

| Service | Variables |
|---|---|
| `mail` | `JMAP_SESSION_URL`, `JMAP_AUTH_METHOD=command`, `JMAP_TOKEN_COMMAND` |
| `dav` | `DAV_URL`, `DAV_AUTH_METHOD=command`, `DAV_TOKEN_COMMAND`, `DAV_ORGANIZER_EMAIL=<email>`, `DAV_HREF_PREFIX` si le serveur en a besoin |
| `drive` | `TWAKE_DRIVE_URL=https://<workplaceFqdn>`, `TWAKE_DRIVE_TOKEN_COMMAND` |
| `chat` | `MATRIX_USER_ID`, `MATRIX_TOKEN_COMMAND`, `MATRIX_HOMESERVER_URL`, `TOM_URL`, `MATRIX_E2EE_RECOVERY=tom`, `MATRIX_STORE_DIR=<data>/chat/<agent>` |
| `space` | `TWAKE_SPACE_URL`, `TWAKE_SPACE_TOKEN_COMMAND`, `TWAKE_SPACE_OIDC_ISSUER` |
| `project` | `TWAKE_PROJECT_URL`, `TWAKE_PROJECT_TOKEN_COMMAND`, `TWAKE_PROJECT_OIDC_ISSUER` |
| tous | `USER_LANGUAGE`, `USER_TIMEZONE` |
| tous, avec `--agent hermes` | `<PRÉFIXE>_APPROVAL_TIMEOUT_MS=330000`, pour attendre un peu plus longtemps que l'élicitation Hermes |

Les variables que l'utilisateur définit déjà dans l'environnement de l'agent gardent la priorité. C'est la soupape pour les cas particuliers.

## 10. Adaptateurs d'agents

### 10.1 Écriture

| Agent (`id`) | Fichier | Méthode | Noms d'entrées | Réglages propres |
|---|---|---|---|---|
| Claude Code (`claude-code`) | portée `user` | `claude mcp add --scope user <nom> [-e K=V] -- <command> <args…>` et `claude mcp remove --scope user` : pas de JSON sur la ligne de commande, que `cmd.exe` abîmerait avec `claude.cmd` sous Windows ; jamais d'édition directe de `~/.claude.json` (lu seulement, ou dans `$CLAUDE_CONFIG_DIR`), que Claude Code réécrit lui-même | `twake-mail`, `twake-dav`, `twake-drive`, `twake-chat`, `twake-space`, `twake-project` | aucun |
| Hermes (`hermes`) | `$HERMES_HOME/config.yaml`, sinon `~/.hermes` (`%LOCALAPPDATA%\hermes` sous Windows), ou le profil actif (`active_profile` → `profiles/<nom>`) | bibliothèque `yaml` (API Document : commentaires et ordre préservés), sauvegarde `config.yaml.bak-<AAAAMMJJTHHMMSSZ>` | `twake_mail`, `twake_dav`… | `timeout: 420`, `elicitation: {enabled: true, timeout: 300}` |
| Claude Desktop (`claude-desktop`) | `claude_desktop_config.json` (chemin selon l'OS) | JSON + sauvegarde | `twake-*` | rappel de redémarrage ; signale si l'application tourne |
| Cursor (`cursor`) | `~/.cursor/mcp.json` | JSON `mcpServers` + sauvegarde | `twake-*` | |
| VS Code (`vscode`) | `<base>/Code/User/mcp.json` du profil par défaut, où `<base>` = `$VSCODE_APPDATA`, sinon Application Support, `%APPDATA%` ou `~/.config` | JSON `servers`, `type: "stdio"` + sauvegarde | `twake-*` | |

Règles communes :

- **Écriture atomique** : fichier temporaire dans le même répertoire, puis renommage. Une sauvegarde est faite avant la première modification.
- **Propriété des entrées** : `mcp-twake-ai` ne touche qu'aux entrées qu'il a écrites. Il les reconnaît à leur nom et à l'empreinte notée dans `config.json`.
- **Entrée inconnue du même nom** (par exemple un `twake-drive` configuré à la main), ou entrée modifiée depuis le dernier passage : le plan l'indique (« remplace une entrée configurée hors wizard ») et demande une confirmation explicite, entrée par entrée.
- **Échec chez un agent** : cet agent est restauré depuis sa sauvegarde. Les autres agents ne sont pas affectés, et le récapitulatif indique l'état de chacun.

### 10.2 Élicitation

| Agent | Élicitation |
|---|---|
| Claude Code, Hermes, VS Code (depuis 1.102), Cursor (depuis 1.5) | gérée (vérifié le 2026-11-11) |
| Claude Desktop | non confirmée au 2026-11-11 : traitée comme non gérée ; la table des capacités vit dans l'adaptateur |

Quand un agent ne gère pas l'élicitation :

- On garde `elicit` par défaut. Les lectures fonctionnent, et chaque écriture est refusée sans rien faire, avec un message clair.
- Passer en `*_APPROVAL=client` reste possible, mais seulement après un avertissement explicite : un « toujours autoriser » dans le client supprime alors la protection. Le choix est enregistré par couple agent × service.

## 11. Export pour les autres harnais

```
mcp-twake-ai export --agent <id> [--services mail,drive,…] [--raw] [--out ./twake-ai-export]
```

- `--agent <id>` déclare un nouvel agent (`zed`, `windsurf`…). Si Chat fait partie des services, l'export crée tout de suite son device Matrix : le broker ne pourra pas ouvrir de navigateur plus tard, quand le MCP lui demandera un jeton.
- **Par défaut**, les entrées passent par le lanceur. **`--raw`** donne les commandes MCP directes avec toutes les variables d'env en clair ; `*_TOKEN_COMMAND` pointe toujours vers `mcp-twake-ai token`.
- Aucun secret dans les fichiers générés.

| Fichier | Couvre |
|---|---|
| `mcpServers.json` | la famille Claude Desktop : Cursor, Windsurf, Cline, Gemini CLI… |
| `vscode-mcp.json` | VS Code |
| `hermes.yaml` | Hermes, avec les délais d'élicitation alignés |
| `codex.toml` | `[mcp_servers.*]` de Codex CLI |
| `claude-code.sh` | commandes `claude mcp add-json` prêtes à lancer |
| `<service>.env`, `commands.txt` | tout autre harnais : commande, arguments et variables en clair |
| `README.md` | où va chaque fichier, et les points à surveiller (élicitation, timeouts, un device Chat par agent) |

## 12. Erreurs, `status`, désinstallation

### 12.1 Erreurs

| Situation | Comportement |
|---|---|
| Domaine sans `.well-known/matrix/client` | « Ce n'est pas un domaine Twake.ai SaaS », puis saisie manuelle proposée |
| URL devinée (space, project) qui ne répond pas | service décoché, raison affichée |
| IdP, homeserver ou instance injoignable | message qui nomme le service et l'URL, arrêt sans rien écrire |
| Connexion annulée ou expirée (5 min en loopback, durée du code en device flow) | arrêt sans rien écrire |
| Port loopback occupé | port suivant de la liste fixe ; tous occupés → erreur qui nomme les ports |
| Échec d'écriture chez un agent | restauration de cet agent (section 10.1) |
| Jeton impossible à obtenir à l'exécution | `token` sort en erreur (section 7.2) ; le MCP la remonte, l'agent dit de lancer `mcp-twake-ai login` |
| Verrou bloqué plus de 10 s | erreur explicite |
| Node retenu au `setup` introuvable (mise à jour via nvm…) | `run` sort avec « Node introuvable : relancez `mcp-twake-ai setup` » ; `status` le signale |
| Clés E2EE de Chat non récupérables via ToM | Chat fonctionne pour les nouveaux messages ; `status` l'indique |

### 12.2 `status`

Une matrice agents × services, avec, pour chaque case :

1. l'entrée existe et correspond à l'empreinte notée ;
2. le chemin de Node est valide ;
3. l'autorisation fonctionne, vérifiée par un appel léger : userinfo pour OIDC, `/settings/instance` pour cozy, `/_matrix/client/v3/account/whoami` pour Matrix ;
4. le MCP démarre : le lanceur fait une poignée de main MCP (`initialize` puis `tools/list`) et la referme. Ça marche pour les six serveurs, sans dépendre de leurs commandes `check`, qui varient d'un dépôt à l'autre.

`status --env <service> [--agent X]` affiche l'environnement que `run` construirait, sans les jetons.

### 12.3 `uninstall`

1. Retrait des entrées d'agents dont l'empreinte correspond ; pour les autres, l'outil demande.
2. `logout` (section 7.3).
3. Suppression du préfixe et du raccourci `mcp-twake-ai`.
4. Stores Chat : supprimés **seulement après confirmation**, car ils contiennent l'index local des messages.
5. Suppression de `config.json`, du cache et du journal.

### 12.4 Journal

`twake-ai.log` reçoit les étapes et les erreurs. Tout jeton, code ou secret y est masqué. Aucune télémétrie.

## 13. Tests

Vitest, comme les six MCP. Aucun accès réseau en CI.

### 13.1 Unitaires, contre des faux serveurs écrits à la main

| Module | Faux | Cas clés |
|---|---|---|
| `discovery` | `fetch` et résolveur DNS factices ; fixtures enregistrées sur linagora.com le 2026-11-10 | SaaS complet ; domaine non Twake ; space ou project injoignables ; URL corrigée à la main ; repli sur le modèle `{username}` |
| `auth` | faux IdP (authorize, token, device, userinfo, revoke), faux cozy (register, authorize, access_token), faux Synapse (login, refresh, logout, get_token) | PKCE loopback ; device flow (`authorization_pending`, `slow_down`, expiration) ; repli par URL collée ; refresh révoqué → code et message ; sonde `allow_oauth_token` dans les deux états |
| concurrence | N processus `mcp-twake-ai token` lancés en même temps | le faux IdP ne reçoit qu'un seul refresh ; aucun refresh token invalidé |
| `vault` | backend en mémoire, backend fichier | permissions 0600 ; refus d'un fichier trop ouvert |
| `catalog` | | environnement attendu pour chaque service et chaque agent (instantanés) |
| `agents` | fichiers de référence réalistes : Hermes avec commentaires et d'autres serveurs, un `twake-drive` existant configuré à la main ; faux binaire `claude` qui enregistre ses arguments | plan ; application ; idempotence (une deuxième application ne change rien) ; conflit d'empreinte ; restauration sur échec d'écriture |
| `exporter` | fichiers de référence par format | chaque fichier relu par un vrai parseur JSON, YAML ou TOML ; aucun secret dans les fichiers |

### 13.2 Lanceur, de bout en bout

Un mini serveur MCP factice vérifie que `run` construit le bon environnement, relaie stdio et les signaux, propage le code de sortie et **laisse passer une élicitation dans les deux sens**.

### 13.3 Vrais MCP

Les six paquets, en versions figées, sont installés dans un préfixe temporaire. `status` fait sa poignée de main `initialize` puis `tools/list` sur chacun : le catalogue correspond bien à ce qu'ils attendent.

### 13.4 CI

Ubuntu, macOS et Windows, avec Node 22.13 et la dernière LTS. Les coffres de secrets de chaque OS y sont testés pour de vrai.

### 13.5 Test réel, à la demande

`LIVE_EMAIL=… node scripts/live.mjs` contre twake.linagora.com, dans un `HOME` temporaire : découverte, connexion interactive, un jeton par service, `status`, `logout`, puis vérification que les jetons sont révoqués. Une liste de recette manuelle par agent le complète : une question en lecture, puis une écriture approuvée par élicitation.

## 14. Demandes côté serveur

| Demande | Équipe | Bloquant ? |
|---|---|---|
| Client OIDC « twake-ai-agents » (section 7.4) | IdP / exploitation SaaS | **oui** |
| ~~Les six MCP lancent `*_TOKEN_COMMAND` avec `execFile('/bin/sh', ['-c', …])`~~ : corrigé le 2026-11-11 (mail#22, dav#25, drive#12, chat#10, space#8, project#9). Ils passent par `exec`, donc par `cmd.exe /d /s /c` sous Windows, et un job `windows-latest` le vérifie. Versions 4.1.1, 4.2.1, 0.4.1, 0.6.1, 0.2.2 et 0.2.2 | dépôts MCP | **oui pour Windows**, jusqu'à leur publication sur npm |
| Ajouter les URL de Space et Project dans `.well-known/matrix/client` (par exemple sous une clé `app.twake.ai`) | exploitation SaaS | non : la convention `<service>.<domaine>` sert de repli |
| Activer `allow_oauth_token` sur les contextes cozy du SaaS, avec `userinfo_url` vers l'IdP | exploitation cozy | non : sert à Drive sans redirection ni navigateur |
| Activer `login/get_token` (MSC3882) sur Synapse | exploitation Matrix | non : évite une redirection par agent pour Chat |
| README de mcp-twake-chat : installation par npm (correction prête sur la branche `docs/npm-install`) | dépôt mcp-twake-chat | non |
| Une fois `mcp-twake-ai` publié, renvoyer vers lui comme broker dans les six README, à la place de `my-token-broker` | dépôts MCP | non |

## 15. À vérifier au début de l'implémentation

1. Prise en charge de l'élicitation par Claude Desktop et Cursor.
2. ~~Comment chaque MCP exécute `*_TOKEN_COMMAND`~~ : vérifié le 2026-11-10, les six passaient par `/bin/sh -c`. Depuis le 2026-11-11, ils passent par le shell du système (section 14). Sous Linux et macOS, `TOKEN_CMD` met chaque chemin entre apostrophes POSIX. Sous Windows, il le met entre guillemets doubles pour `cmd.exe`, et refuse un chemin contenant `"`, `%`, `!` ou un saut de ligne, que `cmd.exe` modifierait.
3. Les audiences acceptées par `jmap.linagora.com` et `dav.linagora.com` avec un jeton OIDC. (`dav.linagora.com` sert DAV à la racine : `/.well-known/caldav` redirige vers `/calendars`, donc pas de `DAV_HREF_PREFIX`. `jmap.linagora.com/.well-known/jmap` redirige vers `/jmap/session`.)
4. Si LemonLDAP fait tourner les refresh tokens, et quelle est la durée de la session hors ligne.
5. Si Synapse renvoie un refresh token avec `refresh_token: true`, et si `login/get_token` est activé.
6. L'URL de la session JMAP à partir de la cible SRV (`/.well-known/jmap`).
7. Le comportement de `@napi-rs/keyring` sur un Linux sans session graphique (serveur Hermes), et le repli automatique sur le fichier 0600.
