# Contributing to mcp-twake-ai

Thank you for your interest in mcp-twake-ai! This project is part of the open source ecosystem of [Twake.ai](https://twake.ai), the sovereign Digital Workplace developed by [LINAGORA](https://linagora.com). Contributions of every kind are welcome: bug reports, documentation, tests, support for more agents, and code.

By participating, you agree to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to contribute

- **Report a bug**: open an issue with the _Bug report_ template.
- **Suggest a feature or a new agent to configure**: open an issue with the _Feature request_ template, and describe the use case before the solution.
- **Report a vulnerability**: never in a public issue; follow [SECURITY.md](SECURITY.md).
- **Improve the documentation**: typos, examples, agent-specific notes, translations.
- **Send a pull request**: for anything bigger than a small fix, open an issue first so we can agree on the approach.

## Development setup

Requirements: Node.js >= 22.13 and npm.

```bash
git clone https://github.com/linagora/mcp-twake-ai.git
cd mcp-twake-ai
npm install
npm run typecheck
npm test          # Vitest, against fake servers on 127.0.0.1
npm run build     # then: node build/bin.js
```

Run the built command with `node build/bin.js`: inside this repository, `npx mcp-twake-ai` finds the local package and does not run it.

Tests never touch a real server nor your own agents: identity provider, Twake Drive, Matrix and MCP servers are faked on `127.0.0.1`, and every test works in a temporary folder (`TWAKE_AI_HOME`, a temporary `HOME`). Do not add tests that need real credentials.

Two more checks, run by hand:

- `npm run test:e2e` writes into the real Claude Code when it is installed, in a temporary configuration folder;
- `LIVE_EMAIL=jane.doe@example.com node scripts/live.mjs` signs in to a real Twake.ai account in a temporary folder, checks every backend and the calendar through its MCP server, then signs out. [`docs/manual-checklist.md`](docs/manual-checklist.md) is the checklist to run in each agent before a release.

### Project structure

```
src/
  bin.ts, cli.ts     # entry point and commands
  wizard.ts          # the guided setup; prompter.ts, i18n.ts and banner.ts around it
  discovery.ts       # the Twake.ai services of an email address
  login*.ts, oidc.ts # sign-in: OIDC (PKCE, device flow), Twake Drive, Twake Chat devices
  broker.ts          # tokens for the MCP servers: cache, locks, renewal (token-cache, lock, vault)
  catalog.ts         # the six servers, their pinned versions and environments
  installer.ts       # installs the pinned servers into a private folder
  launcher.ts        # `run`: starts a server with its environment
  agents/            # one adapter per agent: Claude Code, Hermes, Claude Desktop, Cursor, VS Code
  exporter.ts        # `export` for any other agent
  status.ts, logout.ts, uninstall.ts, journal.ts
tests/               # Vitest; helpers/ holds the fake servers, e2e/ the real Claude Code test
scripts/             # live test against a real account, e2e runner
```

## Coding guidelines

- TypeScript in **strict mode**, ESM modules with `.js` import extensions.
- Messages are written for the user: they say what went wrong **and** what to do. The guided setup speaks English, and French with `TWAKE_AI_LANGUAGE=fr`: a new message goes into both languages of `src/i18n.ts`.
- `token` prints only the JSON token on stdout: everything else goes to stderr.
- Never log, print or write a secret (tokens, refresh tokens, codes, passwords); the journal goes through `mask()`. Never commit real hostnames, accounts or personal data in tests or docs: use `example.com` and `jdoe`.
- An agent's file is changed only through its adapter: plan first, only the entries mcp-twake-ai wrote, a backup, an atomic write, and the rest of the file kept as it was (comments, order, other servers).
- It must work on Linux, macOS and Windows: CI runs the tests on all three.
- A change in behaviour comes with a test that fails without it.

## Commits and pull requests

- Branch from `main`: `feat/…`, `fix/…`, `docs/…`, `refactor/…`, `test/…`, `chore/…`.
- Follow [Conventional Commits](https://www.conventionalcommits.org/): `feat: configure Windsurf`.
- Keep pull requests focused on one concern, describe what changes and why, and link the related issue.
- Before opening the pull request: `npm run typecheck`, `npm run build` and `npm test` must pass (CI runs them on Linux, macOS and Windows).
- Add a line to [CHANGELOG.md](CHANGELOG.md) under _Unreleased_ for any user-visible change.

## License

By contributing, you agree that your contributions are licensed under the [GNU Affero General Public License v3.0](LICENSE).
