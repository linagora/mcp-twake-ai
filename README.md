# twake-ai

**Connect the Twake.ai MCP servers to your AI agent with one sign-in.**

`twake-ai` is the token broker the six [Twake.ai MCP servers](https://github.com/linagora/mcp-twake-project#part-of-twakeai) refer to as `my-token-broker`. It signs you in once at your Twake.ai identity provider, keeps the refresh token in your operating system's keychain (macOS Keychain, Windows Credential Manager, Secret Service), and prints a fresh access token whenever an MCP server asks for one.

> **Status: early.** This version serves Twake Mail, Twake Calendar and contacts, Twake Space, Twake Project, Twake Drive and Twake Chat. The agent configuration (`twake-ai setup`) and the export for other agents come next.

## Requirements

- **Node.js** >= 22.13
- An account on the Twake.ai SaaS
- The OIDC client `twake-ai-agents` on your identity provider (public client, PKCE, `offline_access`, loopback redirect URIs `http://127.0.0.1:8765/callback` to `:8767`, device flow, and the audiences of the Twake.ai backends). Another client can be used with `--client-id` or `TWAKE_AI_OIDC_CLIENT_ID`.

## Install and sign in

```bash
npm install -g twake-ai
twake-ai login --email jane.doe@example.com
```

The MCP servers call `twake-ai` on their own, long after you signed in: it has to stay installed (`npx` would not leave a `twake-ai` command behind).

`twake-ai` finds your Twake.ai services from your address, opens your browser to sign in, and stores the session. Over SSH or without a display it shows a code to enter from another device instead (`--no-browser` forces it).

## Use it from an MCP server

Every Twake.ai MCP server takes a command that prints a token. Give it the absolute path of `twake-ai` (`command -v twake-ai` prints it): some agents, such as Claude Desktop started from the Finder, do not see your `PATH`.

```bash
claude mcp add twake-project --scope user \
  -e TWAKE_PROJECT_URL=https://projects.example.com \
  -e "TWAKE_PROJECT_TOKEN_COMMAND=$(command -v twake-ai) token project" \
  -e TWAKE_PROJECT_OIDC_ISSUER=https://sso.example.com/ \
  -- npx -y mcp-twake-project
```

`twake-ai token <mail|dav|space|project>` prints `{"access_token": "...", "expires_at": <epoch s>}`. It serves the cached token while it is valid for more than 60 seconds, and otherwise renews it under a lock shared by every process, so several servers in several agents never spend the same refresh token twice. When the session has expired it exits with an error that says to run `twake-ai login`, which signs you in again with the same identity provider client.

Every address `twake-ai` discovers must use HTTPS (plain http is accepted only for `localhost`), and the identity provider's discovery document must speak for the issuer your domain announces.

## Twake Drive and Twake Chat

```bash
twake-ai login --drive                 # registers "Twake AI" on your Twake Drive and connects it
twake-ai login --chat --agent hermes   # gives that agent its own Twake Chat device
```

- **Twake Drive** has its own sign-in (cozy-stack OAuth). Your Twake session is already open, so the browser only asks you to accept the permissions. `twake-ai token drive` then serves Drive tokens.
- **Twake Chat** encrypts messages end to end, and the encryption keys belong to a device. Each agent therefore gets its own device, "Twake AI · <agent>", listed in your Twake Chat sessions. `twake-ai token chat --agent hermes` prints the token together with its `device_id` and `user_id`, as mcp-twake-chat expects. Signing in again for the same agent replaces its device and logs the old one out.
- **Over SSH or without a display:** `twake-ai` prints the address to open on a phone or another computer. At the end, the browser shows a page that cannot load: paste its address back into the terminal.

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
