# Manual checklist, agent by agent

Run it with a real Twake.ai account, after `scripts/live.mjs` (`LIVE_EMAIL=… node scripts/live.mjs`). Tick the five points for each agent.

## Before you start

- [ ] `npx mcp-twake-ai setup` (from any folder but this repository) shows the banner, then signs in (in the browser, or with a code over SSH or with `--no-browser`).
- [ ] The installed agents are ticked in advance, and so are the services found for the account.
- [ ] The plan lists the `twake-*` entries (`twake_*` for Hermes); once confirmed, every server written is marked `✓ … starts`.

## Claude Code

- [ ] `mcp-twake-ai setup` with Claude Code ticked.
- [ ] A new `claude` session; `/mcp` lists the `twake-*` servers as connected.
- [ ] A read: "What is on my calendar tomorrow?"
- [ ] A write approved through elicitation: "Create a draft email to myself with the subject Test". The approval request shows in the terminal: accept it, then check the draft in Twake Mail.
- [ ] `mcp-twake-ai status`: everything is `✓`.

## Hermes

- [ ] `mcp-twake-ai setup` with Hermes ticked; `config.yaml` is unchanged outside `mcp_servers` (compare it with the copy `config.yaml.bak-<date>`).
- [ ] `/reload-mcp` in Hermes, or a restart.
- [ ] A read: "What is on my calendar tomorrow?"
- [ ] A write approved through elicitation (a draft email), with Hermes' approval request.
- [ ] `mcp-twake-ai status`: everything is `✓`.

## Claude Desktop

- [ ] `mcp-twake-ai setup` with Claude Desktop ticked; the guided setup warns that it cannot show approval requests.
- [ ] Quit Claude Desktop completely, then start it again; the `twake-*` servers appear in the connector settings.
- [ ] A read: "What is on my calendar tomorrow?"
- [ ] A write: it is refused with a clear message, and nothing is created.
- [ ] `mcp-twake-ai status`: everything is `✓`.

## Cursor

- [ ] `mcp-twake-ai setup` with Cursor ticked; `~/.cursor/mcp.json` keeps the other servers.
- [ ] The `twake-*` servers appear in Settings > MCP (otherwise, quit Cursor and start it again).
- [ ] A read: "What is on my calendar tomorrow?"
- [ ] A write approved through elicitation (a draft email).
- [ ] `mcp-twake-ai status`: everything is `✓`.

## VS Code

- [ ] `mcp-twake-ai setup` with VS Code ticked; `User/mcp.json` keeps its comments, the other servers and `inputs`.
- [ ] MCP Servers view: the `twake-*` servers start at the first chat message.
- [ ] A read: "What is on my calendar tomorrow?"
- [ ] A write approved through elicitation (a draft email).
- [ ] `mcp-twake-ai status`: everything is `✓`.

## To finish

- [ ] `mcp-twake-ai uninstall` shows what it would remove; `mcp-twake-ai uninstall --yes` removes the entries, revokes the authorizations and deletes the files; the Chat stores stay (unless `--delete-chat-stores`).
- [ ] "Twake AI" no longer appears in the connected devices of Twake Drive, nor do the "Twake AI · <agent>" devices in Twake Chat.
