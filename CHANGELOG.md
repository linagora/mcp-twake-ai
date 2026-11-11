# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- When the sign-in code expires during the guided setup, it no longer says to run `mcp-twake-ai login`: it asks for the address again, and says so.

### Added

- `setup --env <service>.<VARIABLE>=<value>` adds a variable of your own to a server's environment, for settings the servers document but mcp-twake-ai does not know (for example `dav.DAV_DEFAULT_CALENDAR`, so that an assistant reads your calendars instead of every calendar shared with you). The variables are kept in `config.json`, a sign-in to the same account keeps them, and every entry, `run`, `status --print-env` and `export` builds them; an empty value forgets one. Only the variables of the server itself (`DAV_…`, `JMAP_…`…), the `USER_…` ones and `LOG_LEVEL` are accepted; names that point at a server, say how to sign in to it or whose account it is, or may carry a secret are refused, and so are the folders for files (`*_DOWNLOAD_DIR`, `*_UPLOAD_DIR`), which Mail, Drive and Chat share. `JMAP_SIGNATURE_PATH`, which Mail appends to every mail, must name a file directly in `~/.mcp-twake-mail/`.
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
