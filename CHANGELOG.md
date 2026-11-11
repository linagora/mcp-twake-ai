# Changelog

All notable changes to this project are documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The repository is now `linagora/mcp-twake-ai`, like the package.
- The README shows the guided setup step by step and an example in Claude Code; CONTRIBUTING, SECURITY, a code of conduct and issue templates were added.

## [0.1.0] - 2026-11-11

First release.

### Added

- `mcp-twake-ai setup`: the guided setup (email, one sign-in, agents and services, plan, check), and its non-interactive form with `--agents` and `--yes`, for Claude Code, Hermes, Claude Desktop, Cursor and VS Code.
- `login`, `token`, `run`: one sign-in at the Twake.ai identity provider (browser with PKCE, or a code from another device), the session kept in the OS keychain, fresh tokens for the six Twake.ai MCP servers, Twake Drive and one Twake Chat device per agent.
- `export`: the configuration for any other agent.
- `status`, `logout`, `uninstall`, and a journal with secrets masked.
- The calendar server is the one that takes the Twake session: the Twake Calendar side service when the DNS-discovered server takes only passwords.
