# mcp-twake-ai

[![npm version](https://img.shields.io/npm/v/mcp-twake-ai)](https://www.npmjs.com/package/mcp-twake-ai)
[![CI](https://github.com/linagora/mcp-twake-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/linagora/mcp-twake-ai/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js >= 22.13](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org/)

<p align="center">
  <img src="assets/banner.png" alt="MCP Twake.ai: sets up the MCP servers of the Twake.ai platform in your AI agents" width="660">
</p>

**One command connects your AI agent to [Twake.ai](https://twake.ai): Mail, Calendar, Drive, Chat, Space and Project, with a single sign-in.**

```bash
npx mcp-twake-ai setup
```

## What is it?

`mcp-twake-ai` sets up the six Twake.ai [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers in your AI agents (Claude Code, Hermes, Claude Desktop, Cursor and VS Code), and gives any other agent a ready-made configuration.

You type your email address and sign in once at your Twake.ai identity provider. `mcp-twake-ai` finds your services, writes them into the agents you choose, then stays behind as their token broker: the refresh token sits in your operating system's keychain, and each MCP server gets a fresh access token whenever it needs one. No password or token is written into an agent's configuration.

## Part of Twake.ai

[Twake.ai](https://twake.ai) is the truly open source and sovereign Digital Workplace developed by [LINAGORA](https://linagora.com): Twake Mail, Twake Calendar, Twake Drive, Twake Chat, Twake Space and Twake Visio with a single account, hosted in France or on your own infrastructure.

`mcp-twake-ai` installs and connects its six open source MCP servers:

| MCP server                                                         | Twake.ai service                        | Protocol          |
| ------------------------------------------------------------------ | --------------------------------------- | ----------------- |
| [mcp-twake-mail](https://github.com/linagora/mcp-twake-mail)       | Twake Mail                              | JMAP              |
| [mcp-twake-dav](https://github.com/linagora/mcp-twake-dav)         | Twake Calendar and contacts             | CalDAV / CardDAV  |
| [mcp-twake-drive](https://github.com/linagora/mcp-twake-drive)     | Twake Drive                             | cozy-stack API    |
| [mcp-twake-chat](https://github.com/linagora/mcp-twake-chat)       | Twake Chat                              | Matrix            |
| [mcp-twake-space](https://github.com/linagora/mcp-twake-space)     | Twake Space (team spaces)               | Twake Space API   |
| [mcp-twake-project](https://github.com/linagora/mcp-twake-project) | Twake Project (projects, boards, tasks) | Twake Project API |

## Requirements

- **Node.js** >= 22.13
- An account on the Twake.ai SaaS
- One of the agents above, or any MCP client for `export`

Your identity provider needs the public OIDC client `twake-ai-agents` (PKCE, `offline_access`, loopback redirect URIs `http://127.0.0.1:8765/callback` to `:8767`, device flow, and the audiences of the Twake.ai backends). It exists on the Twake.ai SaaS; another client can be used with `--client-id` or `TWAKE_AI_OIDC_CLIENT_ID`.

## Start here

Run it in a terminal, from any folder:

```bash
npx mcp-twake-ai setup
```

The guided setup asks a few questions and changes nothing before you confirm. It speaks English (`TWAKE_AI_LANGUAGE=fr` switches it to French), and pressing Escape at any question leaves everything as it was.

**1. Your Twake.ai email address.** It is enough to find your services.

<img src="assets/setup-1-email.png" alt="The banner of mcp-twake-ai setup, then the question: your Twake.ai email address" width="760">

**2. Sign in once.** Your browser opens on your Twake.ai sign-in page. Over SSH, without a display or with `--no-browser`, the terminal shows a code to enter from your phone or another computer instead:

<img src="assets/setup-2-code.png" alt="The services found for jdoe@example.com, then the address to open and the code WDJB-MJHT" width="760">

<img src="assets/setup-3-sso.png" alt="The Device Authorization page of the identity provider, with the code WDJBMJHT ready to authorize" width="620">

**3. Choose the agents and the services.** The agents found on this computer, and the services of your account, are ticked in advance.

<img src="assets/setup-4-choose.png" alt="Claude Code and Cursor chosen; Mail, Calendar, Space and Project ticked among the services" width="760">

**4. Check the plan, and confirm.** Each agent gets one entry per service: `twake-mail`, `twake-dav`…

<img src="assets/setup-5-plan.png" alt="The plan: four twake entries to add in Claude Code and in Cursor, then Apply this plan? Yes" width="760">

**5. Done.** The servers are installed, written into your agents, and each one is started once to check it answers.

<img src="assets/setup-6-done.png" alt="The servers installed and written, each server checked, and what to do to finish in each agent" width="760">

Under `npx`, `mcp-twake-ai` copies itself into its private folder, so that your agents never depend on npx's cache, and puts a `mcp-twake-ai` command in `~/.local/bin` (`%LOCALAPPDATA%\twake-ai\bin` on Windows).

## Use it from Claude Code

Start a new `claude` session: `/mcp` lists the `twake-*` servers. Then ask in plain words. Reads happen at once; every write is shown to you for approval first (illustrative, abridged session):

```text
> What's on my calendar tomorrow? Draft a reply to Pierre's last email with my free slots.

⏺ twake-dav - get_events_in_range (MCP)(when: "tomorrow")
  ⎿  3 events: 09:30 Team stand-up · 11:00 Budget review · 15:00 Call with Acme

⏺ twake-mail - search_emails (MCP)(from: "pierre", limit: 1)
  ⎿  "Workshop next week?" from Pierre Martin, yesterday at 17:42

⏺ twake-mail - create_draft (MCP)(to: ["pierre.martin@example.com"], subject: "Re: Workshop next week?", …)

  ╭─ twake-mail asks for your approval ────────────────╮
  │ Create a draft                                     │
  │ to: pierre.martin@example.com                      │
  │ subject: Re: Workshop next week?                   │
  │                                                    │
  │ ❯ Accept   Decline                                 │
  ╰────────────────────────────────────────────────────╯
  ⎿  Draft saved

⏺ Tomorrow you have the stand-up at 9:30, the budget review at 11:00 and the
  Acme call at 15:00. You are free from 13:00 to 15:00 and after 16:00: the
  reply to Pierre proposing these slots is in your Drafts, ready to send.
```

More to try:

- "Summarize my unread emails from today."
- "Find the latest version of the budget file in my Drive."
- "Which tasks are due this week in the Website project?"
- "Post the meeting notes in the #team room."

## Commands

### Setup without questions

```sh
mcp-twake-ai setup --email jane.doe@example.com --agents detected   # signs in, shows what would change
mcp-twake-ai setup --agents detected                      # shows what would change, writes nothing
mcp-twake-ai setup --agents claude-code,hermes --yes      # writes it
mcp-twake-ai setup --agents cursor --services mail,dav --yes
```

With `--email`, `setup` first signs in to that account if it is not the current one. With `--yes`, it connects Twake Drive and gives each agent its own Twake Chat device when those services are chosen, installs the pinned servers, then writes the agents.

| Agent (`--agents`)                | Where                                                                                                   | Approval of writes                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Claude Code (`claude-code`)       | `claude mcp add --scope user`                                                                           | in Claude Code                                |
| Hermes (`hermes`)                 | `config.yaml` in `$HERMES_HOME`, `~/.hermes` (`%LOCALAPPDATA%\hermes` on Windows) or its active profile | in Hermes                                     |
| Claude Desktop (`claude-desktop`) | `claude_desktop_config.json`                                                                            | not supported: reads work, writes are refused |
| Cursor (`cursor`)                 | `~/.cursor/mcp.json`                                                                                    | in Cursor                                     |
| VS Code (`vscode`)                | `Code/User/mcp.json` of the default profile                                                             | in VS Code                                    |

- It only changes the entries it wrote. An entry with the same name configured by hand, or changed since, is left alone unless you add `--force`.
- A file is copied to `<file>.bak-<date>` before it changes. Comments and other settings are kept.
- An agent whose write fails is put back as it was; the others are still written.
- Running it again changes nothing. With fewer `--services`, it removes the entries you left out.
- It exits with 1 when something you asked for was not done (an agent not installed, an entry left alone).

### Check, sign out, uninstall

```sh
mcp-twake-ai status                             # session, Drive, every entry, and each server started once
mcp-twake-ai status --no-start                  # the same without starting the servers
mcp-twake-ai status --print-env mail --agent cursor  # the environment run builds for a server
mcp-twake-ai logout                             # revokes every authorization and forgets the secrets
mcp-twake-ai uninstall                          # shows what it would remove; add --yes to do it
```

- `status` checks the Twake session, Twake Drive, each agent's Chat device, that every entry is the one mcp-twake-ai wrote, and that each server answers through its entry. It exits with 1 when something is wrong, and says what.
- `logout` revokes the session at the identity provider, removes "Twake AI" from the Drive connected devices, signs every Chat device out, then deletes the secrets and the cached tokens.
- `uninstall --yes` removes the entries it wrote (`--force` for those changed by hand), signs out, and deletes the servers, the configuration, the cache and the journal. The Twake Chat stores hold the local index of your messages: they are kept unless you add `--delete-chat-stores`.

### Any other agent: `export`

```bash
mcp-twake-ai export --agent zed                         # every service found and connected
mcp-twake-ai export --agent cursor --services mail,chat --out ./cursor-config
mcp-twake-ai export --agent zed --raw                   # the servers and their full environment
```

`export` installs the pinned servers into mcp-twake-ai's private folder and writes `mcpServers.json` (Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI…), `vscode-mcp.json`, `hermes.yaml`, `codex.toml`, `claude-code.sh` and one `<service>.env` per service, with a README saying where each goes. No file holds a secret.

### Tokens for your own MCP configuration

`setup` and `export` write everything for you. To configure a Twake.ai MCP server by hand, install `mcp-twake-ai` for good (`npm install -g mcp-twake-ai`), sign in, and give the server its token command, with the absolute path of `mcp-twake-ai` (some agents, such as Claude Desktop started from the Finder, do not see your `PATH`):

```bash
mcp-twake-ai login --email jane.doe@example.com
claude mcp add twake-project --scope user \
  -e TWAKE_PROJECT_URL=https://projects.example.com \
  -e "TWAKE_PROJECT_TOKEN_COMMAND=$(command -v mcp-twake-ai) token project" \
  -e TWAKE_PROJECT_OIDC_ISSUER=https://sso.example.com/ \
  -- npx -y mcp-twake-project
```

`mcp-twake-ai token <mail|dav|space|project>` prints `{"access_token": "...", "expires_at": <epoch s>}`. It serves the cached token while it is valid for more than 60 seconds, and otherwise renews it under a lock shared by every process, so several servers in several agents never spend the same refresh token twice. When the session has expired, it says to run `mcp-twake-ai login`.

## Files

| What                                       | Where (Linux, macOS)                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| Configuration (no secret)                  | `~/.config/twake-ai/config.json`                                                          |
| Refresh token                              | the OS keychain, service `twake-ai`; otherwise `~/.config/twake-ai/secrets.json` (`0600`) |
| Cached access tokens                       | `~/.cache/twake-ai/tokens/` (`0600`)                                                      |
| Journal (steps and errors, secrets masked) | `~/.local/state/twake-ai/twake-ai.log`                                                    |

On Windows: `%APPDATA%\twake-ai` and `%LOCALAPPDATA%\twake-ai`. `TWAKE_AI_HOME` groups everything under one directory.

## Security

Sign-in with PKCE, the session in the OS keychain, no secret in your agents' files, tokens sent only to HTTPS servers of your own domain, and every write approved by you. [SECURITY.md](SECURITY.md) details the security model and how to report a vulnerability privately.

## Development

```bash
npm install
npm test          # Vitest, against fake servers on 127.0.0.1
npm run typecheck
npm run build     # then: node build/bin.js
```

`LIVE_EMAIL=jane.doe@example.com node scripts/live.mjs` signs in to a real account in a temporary folder, checks each backend and lists the calendars through the calendar's MCP server, then signs out and makes sure the session is revoked. [`docs/manual-checklist.md`](docs/manual-checklist.md) is the checklist to run in each agent.

## Contributing

Contributions are welcome: read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md). Please report vulnerabilities privately as described in [SECURITY.md](SECURITY.md). Release notes are in [CHANGELOG.md](CHANGELOG.md).

## License

Licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

Copyright © 2026 [LINAGORA](https://linagora.com)

## About

`mcp-twake-ai` is developed by [LINAGORA](https://linagora.com), French open source software publisher, as part of [Twake.ai](https://twake.ai). For support, hosting or integration of Twake.ai and its AI connectors, contact LINAGORA at <https://linagora.com>.
