# Security Policy

## Reporting a vulnerability

Please report security issues privately via
[GitHub Security Advisories](https://github.com/fschmutz/claude-usage-panel/security/advisories/new)
rather than a public issue.

## Scope & design

This project is **read-only** with respect to your credentials. It reads the OAuth
token Claude Code already stores locally and calls Anthropic's official usage API.
The optional Cursor integration calls `api.cursor.com` with a key you provide; the
optional cost feature runs the `ccusage` you installed yourself, which computes
the cost from your local Claude Code logs. The panels never fetch it: there is
no download-and-run fallback from the npm registry, so without an installed
`ccusage` the cost line reads "unavailable". No telemetry, no third-party
servers.

The one deliberate exception is **named accounts** (`./install.sh cli`, the
account rows in the panels, the `switch_account` MCP tool): a switch you ask for
writes the tokens you previously saved for that account into Claude Code's
credential slot and updates the `oauthAccount` block of `~/.claude.json`. Saved
logins are kept as `0600` files in a `0700` directory under the panel's state dir,
and an idle saved login is refreshed with its own refresh token against
`platform.claude.com/v1/oauth/token` (Claude Code's own OAuth client) into that
store only - the live login is never refreshed or written by the panel outside a
switch. On macOS the tokens never go on a command line, where `ps` would show
them: the app writes the Keychain item through the Security framework, the CLI
and MCP server send it hex-encoded on stdin to `security -i`, and every write is
read back. Nothing is sent anywhere else. Uninstalling keeps the saved logins; delete
the directory to forget them.

Secrets are never committed - `gitleaks` runs in pre-commit and CI.
