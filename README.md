# mcp-twake-ai

**Connect the Twake.ai MCP servers to your AI agent with one sign-in.**

`mcp-twake-ai` is the token broker the six [Twake.ai MCP servers](https://github.com/linagora/mcp-twake-project#part-of-twakeai) refer to as `my-token-broker`. It signs you in once at your Twake.ai identity provider, keeps the refresh token in your operating system's keychain (macOS Keychain, Windows Credential Manager, Secret Service), and prints a fresh access token whenever an MCP server asks for one.

> **Status: early.** This version serves the six Twake.ai services (Mail, Calendar and contacts, Drive, Chat, Space, Project), starts their MCP servers (`mcp-twake-ai run`) writes them into Claude Code, Hermes, Claude Desktop, Cursor and VS Code (`mcp-twake-ai setup`), and exports their configuration for any other agent (`mcp-twake-ai export`). The guided, interactive `setup` comes next.

## Requirements

- **Node.js** >= 22.13
- An account on the Twake.ai SaaS
- The OIDC client `twake-ai-agents` on your identity provider (public client, PKCE, `offline_access`, loopback redirect URIs `http://127.0.0.1:8765/callback` to `:8767`, device flow, and the audiences of the Twake.ai backends). Another client can be used with `--client-id` or `TWAKE_AI_OIDC_CLIENT_ID`.

## Install and sign in

```bash
npm install -g mcp-twake-ai
mcp-twake-ai login --email jane.doe@example.com
```

The MCP servers call `mcp-twake-ai` on their own, long after you signed in: it has to stay installed (`npx` would not leave a `mcp-twake-ai` command behind).

`mcp-twake-ai` finds your Twake.ai services from your address, opens your browser to sign in, and stores the session. Over SSH or without a display it shows a code to enter from another device instead (`--no-browser` forces it).

## Use it from an MCP server

Every Twake.ai MCP server takes a command that prints a token. Give it the absolute path of `mcp-twake-ai` (`command -v mcp-twake-ai` prints it): some agents, such as Claude Desktop started from the Finder, do not see your `PATH`.

```bash
claude mcp add twake-project --scope user \
  -e TWAKE_PROJECT_URL=https://projects.example.com \
  -e "TWAKE_PROJECT_TOKEN_COMMAND=$(command -v mcp-twake-ai) token project" \
  -e TWAKE_PROJECT_OIDC_ISSUER=https://sso.example.com/ \
  -- npx -y mcp-twake-project
```

`mcp-twake-ai token <mail|dav|space|project>` prints `{"access_token": "...", "expires_at": <epoch s>}`. It serves the cached token while it is valid for more than 60 seconds, and otherwise renews it under a lock shared by every process, so several servers in several agents never spend the same refresh token twice. When the session has expired it exits with an error that says to run `mcp-twake-ai login`, which signs you in again with the same identity provider client.

Every address `mcp-twake-ai` discovers must use HTTPS (plain http is accepted only for `localhost`), and the identity provider's discovery document must speak for the issuer your domain announces.

## Twake Drive and Twake Chat

```bash
mcp-twake-ai login --drive                 # registers "Twake AI" on your Twake Drive and connects it
mcp-twake-ai login --chat --agent hermes   # gives that agent its own Twake Chat device
```

- **Twake Drive** has its own sign-in (cozy-stack OAuth). Your Twake session is already open, so the browser only asks you to accept the permissions. `mcp-twake-ai token drive` then serves Drive tokens.
- **Twake Chat** encrypts messages end to end, and the encryption keys belong to a device. Each agent therefore gets its own device, "Twake AI · <agent>", listed in your Twake Chat sessions. `mcp-twake-ai token chat --agent hermes` prints the token together with its `device_id` and `user_id`, as mcp-twake-chat expects. Signing in again for the same agent replaces its device and logs the old one out.
- **Over SSH or without a display:** `mcp-twake-ai` prints the address to open on a phone or another computer. At the end, the browser shows a page that cannot load: paste its address back into the terminal.

## Configure your agents: `mcp-twake-ai setup`

```sh
mcp-twake-ai setup --agents detected                      # shows what would change, writes nothing
mcp-twake-ai setup --agents claude-code,hermes --yes      # writes it
mcp-twake-ai setup --agents cursor --services mail,dav --yes
```

`setup` writes one entry per service into each agent: `twake-mail`, `twake-dav`… (`twake_mail`… for Hermes). Each entry starts `mcp-twake-ai run <service> --agent <id>`, which builds the server's environment. With `--yes`, `setup` first connects Twake Drive and creates the Chat device of each agent when they are chosen and not connected yet, then installs the pinned servers.

| Agent (`--agents`) | Where | Approval of writes |
|---|---|---|
| Claude Code (`claude-code`) | `claude mcp add --scope user` | in Claude Code |
| Hermes (`hermes`) | `config.yaml` in `$HERMES_HOME`, `~/.hermes` (`%LOCALAPPDATA%\hermes` on Windows) or its active profile | in Hermes |
| Claude Desktop (`claude-desktop`) | `claude_desktop_config.json` | not supported: reads work, writes are refused |
| Cursor (`cursor`) | `~/.cursor/mcp.json` | in Cursor |
| VS Code (`vscode`) | `Code/User/mcp.json` of the default profile | in VS Code |

- It only changes the entries it wrote. An entry with the same name configured by hand, or changed since, is left alone unless you add `--force`.
- A file is copied to `<file>.bak-<date>` before it changes. Comments and other settings are kept.
- An agent whose write fails is put back as it was; the others are still written.
- Running it again changes nothing. With fewer `--services`, it removes the entries you left out.

## Any agent: `mcp-twake-ai export`

```bash
mcp-twake-ai export --agent zed                         # every service found and connected
mcp-twake-ai export --agent cursor --services mail,chat --out ./cursor-config
mcp-twake-ai export --agent zed --raw                   # the servers and their full environment
```

`export` installs the pinned Twake.ai MCP servers into mcp-twake-ai's private folder, creates the agent's Twake Chat device if needed, and writes `mcpServers.json` (Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI…), `vscode-mcp.json`, `hermes.yaml`, `codex.toml`, `claude-code.sh` and one `<service>.env` per service, with a README saying where each goes. By default the entries start `mcp-twake-ai run <service> --agent <id>`, which builds the server's environment (URLs, token command, language, time zone); variables already set in the agent's environment win. No file holds a secret.

## Files

| What | Where (Linux, macOS) |
|---|---|
| Configuration (no secret) | `~/.config/twake-ai/config.json` |
| Refresh token | the OS keychain, service `twake-ai`; otherwise `~/.config/twake-ai/secrets.json` (`0600`) |
| Cached access tokens | `~/.cache/twake-ai/tokens/` (`0600`) |

On Windows: `%APPDATA%\twake-ai` and `%LOCALAPPDATA%\twake-ai`. `TWAKE_AI_HOME` groups everything under one directory.

## Development

```bash
npm install
npm test          # Vitest, against fake servers on 127.0.0.1
npm run typecheck
npm run build     # then: node build/bin.js
```

## License

Licensed under the **GNU Affero General Public License v3.0** ([AGPL-3.0](LICENSE)).

Copyright © 2026 [LINAGORA](https://linagora.com)
