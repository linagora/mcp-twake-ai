# Security Policy

mcp-twake-ai signs you in to your [Twake.ai](https://twake.ai) account, keeps the session on your computer and hands access tokens to the MCP servers your AI agents start. We take its security seriously and thank everyone who reports issues responsibly.

## Supported versions

Security fixes are released for the latest minor version.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions or pull requests.**

Report them privately, by one of these channels:

1. GitHub private vulnerability reporting: [Report a vulnerability](https://github.com/linagora/mcp-twake-ai/security/advisories/new);
2. email to **dpo@linagora.com**.

Please include:

- the affected version or commit;
- a description of the issue and its impact;
- steps to reproduce or a proof of concept;
- any suggested fix or mitigation.

We will acknowledge your report within **5 business days**, keep you informed of the progress, and agree with you on a disclosure date once a fix is available. With your permission, we will credit you in the release notes.

## Security model

- **One sign-in, standard and public.** mcp-twake-ai is a public OIDC client: no client secret ships with it. The browser sign-in uses the authorization code flow with PKCE (S256) and a loopback redirect on `127.0.0.1`; the sign-in from another device uses the device authorization grant (RFC 8628), with PKCE as well.
- **The refresh token stays in the OS keychain** (macOS Keychain, Windows Credential Manager, Secret Service). Without a usable keychain it goes to `secrets.json`, readable by you only (`0600`). Access tokens are cached the same way, and renewed under a lock shared by every process, so a refresh token is never spent twice.
- **No secret in the agents' files.** Each entry written into an agent starts `mcp-twake-ai run <service>`, which hands the server a command that prints a token: nothing secret lands in `~/.claude.json`, `mcp.json`, `config.yaml`, or in the files `export` writes.
- **Twake Chat's shared server stays on this computer.** The one Matrix process each agent shares listens on `127.0.0.1` only, and every request needs a bearer token that mcp-twake-ai generates and keeps in a `0600` file: a client of that server is a client of the agent's own Chat device, so nothing else on the network can reach it, and no other local user can read its token.
- **Tokens go only where your domain says.** Every address must use HTTPS (plain http only towards `localhost`). The identity provider's discovery document must speak for the issuer your domain announces, and the DNS-discovered servers that receive a token must be inside your email's domain.
- **Writes are approved by you.** The Twake.ai MCP servers ask for your approval, through MCP elicitation, before every write; an agent that cannot show the request (Claude Desktop) gets its writes refused.
- **Your agents' files are respected.** `setup` shows its plan first, only changes the entries it wrote (an entry configured by hand is replaced only with your consent), copies a file to `<file>.bak-<date>` before changing it, and writes atomically.
- **Leaving is complete.** `logout` revokes the session at the identity provider, removes "Twake AI" from the Twake Drive connected devices and signs every Chat device out; `uninstall` also removes the entries, the servers and every file of mcp-twake-ai.
- **The journal masks secrets.** `twake-ai.log` keeps the steps and errors, never a token, code or password.

General recommendations:

- Give your agent only the services and tools it needs.
- Keep human confirmation for every action that writes, sends, shares or deletes.
- Prompt injection: emails, events, documents and messages may be written by third parties; treat them as untrusted content.
- To keep the whole chain sovereign, pair it with a self-hosted or European AI model.
