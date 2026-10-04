# Security

## Secrets

- **Never in the repository.** Secrets live only in GitHub Actions Secrets (server-side) or the process environment of your own server.
- CI runs a secret scan on every push (`.github/workflows/ci.yml`): bot token patterns, GitHub tokens, API keys, private keys, hardcoded `BOT_TOKEN=` assignments. A hit fails the build.
- The Mini App frontend contains **zero** secrets — it reads a public snapshot (`miniapp-data.json`) or talks to the authenticated API. Nothing secret can reach GitHub Pages.

## Sessions (AES-256-GCM)

- User MTProto sessions are encrypted at rest (AES-256-GCM, key derived via scrypt from `SESSION_ENCRYPTION_KEY`). Plaintext sessions never touch storage, logs, or git.
- **This system NEVER accepts SMS codes, 2FA passwords, or Telegram login codes in chat or any UI.** Sessions are created through the official Telegram authorization mechanism and only the finished session string is imported.
- Bot token and user sessions are entirely separate entities. A leaked bot token cannot touch user sessions or funds.

## Access control

- Mini App API endpoints (`/api/targets`, etc.) require valid Telegram Mini App `initData` (HMAC-SHA256 validation with the bot token) — `src/services/miniapp-auth.js`. `401` otherwise.
- Users can only see/modify their own targets (`user_id` check, `403` on foreign resources).
- The admin interface of the previous project is intentionally absent here; no special user IDs exist anywhere in this codebase.

## Data published by the monitor (GitHub-only mode)

`docs/miniapp-data.json` contains: collection titles/supplies, counters, target
statuses (number + collection + state), aggregate metrics. **No user identities,
no telegram ids, no session data.** If even target visibility is unwanted, set
`PUBLISH_TARGETS=false` in the workflow env — the dashboard then shows only
collection counters and metrics.

## GitHub Actions

- Workflows use minimal permissions (`contents: write` only for the state commit, `pages: write` only for the Pages deploy).
- `concurrency` groups prevent two monitor runs from racing on the state files.
- Secrets are referenced via `${{ secrets.* }}` only; they never appear in logs by default. Do not add `set -x` steps around secret-using commands.

## Reporting

Found a vulnerability? Use GitHub's *Report a vulnerability* (Security tab) or open a private security advisory — do not post exploit details in public issues.
