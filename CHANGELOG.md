# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Twake Chat no longer dies when a second client starts it: two agents, two folders of the same IDE or a reload used to fight over the agent's Matrix device, whose store one process owns ("the Matrix device store … is already used by process …"). The first client now starts one shared server per agent on loopback HTTP — bearer token in a `0600` file, one MCP session per client, so an approval request still reaches the client that asked — and the last client leaving stops it. The entries the agents have do not change, and no secret is written into their files. `status` shows the shared server while one runs (with a ✗ when it does not answer), and `logout` and `uninstall` stop it.
- A client that starts as the last one leaves keeps its server: it registers under the lock the leaving client takes, before that one looks for clients.
- A server left by a crash is stopped: a client killed with `kill -9` never says it leaves, and the server would have synced on until a reboot. A watchdog, started with the server, now stops it once no client lists itself for a few minutes, and stops a server that has answered nothing for 5 minutes. Each client touches its entry every 30 s, so a pid the system gave to another process (soon, on Windows and macOS) does not keep the server running; the watchdog only watches the server it was started with.
- A client stopped or killed while it starts the server no longer leaves a server nobody knows of, next to which the next client started a second one on the same store. mcp-twake-chat 0.6.1 listens only once its Matrix sign-in is done (an initial sync it gives up to 180 s, then the key backup restore): a start now has 5 minutes, and is recorded with the start time of its process, so that the next client, `status` and `logout` recognise a start of ours, however long it takes, and wait for it — outside the lock, which is only held for short steps. A start that still has not answered 30 s after its time is stopped as stalled. A client stopped by its agent during the start leaves the server starting for the next one.
- A client stopped by a signal (Ctrl-C, SIGTERM) closes its MCP session on the server, as one that exits normally does, instead of leaving it open for 6 hours while other clients keep the server running.
- Twake Chat closes a session left idle for 6 hours and answers 404 "Session not found: initialize again": the proxy now opens a new session and replays the request, instead of leaving an agent opened overnight with a dead `twake-chat`. When the server itself is gone (stopped by `login --chat`, a crash, the watchdog), the proxy joins or starts the next one; when none can be started, `twake-chat` exits, so that the agent starts it again.
- `logout`, `uninstall` and the watchdog never stop a process that is not their server: a `backend.json` surviving a reboot, whose pid now belongs to something else, used to be sent SIGTERM. A server is stopped only when it answers a JSON-RPC ping with the token of its start, or — for one that cannot answer — when its start was recorded in this boot with the token file next to it; the sessions are closed (HTTP DELETE) first. A starting client waits for that answer too, not just for an open port. When the server fails to start, the error quotes its last log line and gives the path of its log.
- A shared server that runs but does not answer in time (a long Matrix sync) is never replaced by a second one on the same store: the client asks it again for 10 s, then fails with an error naming its pid, and `logout` reports it instead of stopping or forgetting it. `logout` and `login --chat` wait for a server that is starting, then stop it, instead of failing on its lock after 10 s. `uninstall` keeps the folder and the Chat stores of a server it could not stop, says so, and exits with 1.
- `login --chat --agent <id>` stops the agent's shared server before giving it a new device: the server would have kept the old device's store and received the new device's token. The next client starts one on the new device, and connected clients move to it. When the server cannot be stopped, the device just created is signed out again instead of being left in the account.
- What an agent's entry sets for `twake-chat` (`MATRIX_*`, `MCP_*`, `TOM_*`, `USER_LANGUAGE`, `USER_TIMEZONE`, `LOG_LEVEL`) no longer reaches the shared server: it applied to every client, depending on which one started the server.
- The proxy relays JSON-RPC as it comes instead of rebuilding it method by method: `notifications/cancelled` (a search the user interrupts), progress, `ping`, `logging/setLevel` and the agent's own capabilities now cross both ways, and every request carries the `mcp-protocol-version` the server agreed on.

### Changed

- The MCP SDK is pinned to an exact version (`1.32.2`), like the other dependencies: a new minor must not reach every `npx mcp-twake-ai` on its own, in a tool that holds the SSO session.

## [0.3.2] - 2026-11-17

### Changed

- Mail is pinned to mcp-twake-mail 4.3.0: `reply_draft` prepares a reply that quotes the previous exchange, drafts carry attachments, `set_mailbox_subscription` shows a folder a mail app hides, and `search_emails participant=` finds every exchange with someone. Mail attaches files from the shared `~/Downloads/Twake` (`JMAP_UPLOAD_DIR`), so a file Drive or Chat saved there can be attached.

## [0.3.1] - 2026-11-12

### Fixed

- The calendar of twake.app is found: after sign-in, mcp-twake-ai also asks `https://calendar-backend.<domain>/dav/` for the calendars, after `https://twcalendar.<domain>/dav/`, and keeps the first that takes the Twake session. On twake.app there is no `_caldavs` record and `dav.twake.app` refuses the SSO token.

## [0.3.0] - 2026-11-11

### Fixed

- When the sign-in code expires during the guided setup, it no longer says to run `mcp-twake-ai login`: it asks for the address again, and says so.

### Added

- `setup --env <service>.<VARIABLE>=<value>` adds a variable of your own to a server's environment, for settings the servers document but mcp-twake-ai does not know (for example `dav.DAV_DEFAULT_CALENDAR`, so that an assistant reads your calendars instead of every calendar shared with you). The variables are kept in `config.json`, a sign-in to the same account keeps them, and every entry, `run`, `status --print-env` and `export` builds them; an empty value forgets one. Only the variables of the server itself (`DAV_…`, `JMAP_…`…), the `USER_…` ones and `LOG_LEVEL` are accepted; names that point at a server, say how to sign in to it or whose account it is, or may carry a secret are refused, and so are the folders for files (`*_DOWNLOAD_DIR`, `*_UPLOAD_DIR`), which Mail, Drive and Chat share, and `*_APPROVAL` / `*_APPROVAL_EXEMPT`, which would lift the approval of writes in every agent (`*_APPROVAL_TIMEOUT_MS` can be set). Names of a file a server reads (`*_PATH`, `*_FILE`) are refused too, except `JMAP_SIGNATURE_PATH`, which Mail appends to every mail: it must name a file directly in `~/.mcp-twake-mail/`. The README explains how to keep the calendar to your own (`dav.DAV_DEFAULT_CALENDAR`).
- `status --print-env <service>` shows the environment built for a server.

### Deprecated

- `status --env <service>` is the old name of `status --print-env`, kept as an alias; it warns on stderr, so that stdout still holds the environment alone. Two commands no longer share a flag name with two meanings (`setup --env` sets a variable, `status --print-env` shows one).

## [0.2.0] - 2026-11-11

### Added

- Mail, Drive and Chat share one folder for files, `~/Downloads/Twake`: an attachment Mail saves can go to the Drive or a Chat room without passing through the model. Requires mcp-twake-mail 4.2.0 (`download_attachment` with `save: true`), now the pinned version.

### Changed

- The repository is now `linagora/mcp-twake-ai`, like the package.
- Twake Drive registers mcp-twake-ai with the software id `github.com/linagora/mcp-twake-ai` (was `…/mcp-twake-wizard`). Clients registered before keep theirs, and are still removed by `logout` and `uninstall`.
- The README shows the guided setup step by step and an example in Claude Code; CONTRIBUTING, SECURITY, a code of conduct and issue templates were added.

## [0.1.0] - 2026-11-11

First release.

### Added

- `mcp-twake-ai setup`: the guided setup (email, one sign-in, agents and services, plan, check), and its non-interactive form with `--agents` and `--yes`, for Claude Code, Hermes, Claude Desktop, Cursor and VS Code.
- `login`, `token`, `run`: one sign-in at the Twake.ai identity provider (browser with PKCE, or a code from another device), the session kept in the OS keychain, fresh tokens for the six Twake.ai MCP servers, Twake Drive and one Twake Chat device per agent.
- `export`: the configuration for any other agent.
- `status`, `logout`, `uninstall`, and a journal with secrets masked.
- The calendar server is the one that takes the Twake session: the Twake Calendar side service when the DNS-discovered server takes only passwords.
