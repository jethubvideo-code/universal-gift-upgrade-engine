# Deployment

## Two modes

| | GitHub-only (zero cost, zero servers) | Self-hosted (your own machine/VPS) |
|---|---|---|
| Reaction time | cron granularity (every ~5–15 min, best effort) | immediate |
| Bot | short polling window per run | 24/7 |
| Mini App | static Pages dashboard + bot commands | full authenticated API |
| Cost | free | your server |

Same engine code — only the entrypoint differs. You can start on GitHub and add your own server later (the user's words: "потом я сам могу добавить свой"). Nothing to migrate: state is already in `data/state/`.

## GitHub-only mode (default setup)

1. **Secrets** (repo → Settings → Secrets and variables → Actions):
   - `BOT_TOKEN` — already configured ✅
   - `TG_API_ID`, `TG_API_HASH`, `SESSION_ENCRYPTION_KEY` — only if you attach a user session for real upgrades (monitoring itself works without them via the `gifttracker` data source).
2. **Variables** (Settings → Secrets and variables → Actions → Variables):
   - `GIFTTRACKER_DATA_URL` — URL of your existing GiftTracker `docs/gifts.json` (public read-only collection counters).
   - `MINIAPP_URL` — `https://<user>.github.io/<repo>/` (after step 3).
3. **Pages**: repo → Settings → Pages → Source: *GitHub Actions*. The `deploy-pages.yml` workflow deploys the Mini App automatically on push.
4. **Schedule**: `.github/workflows/monitor.yml` runs every 15 minutes.

### Free tier math (IMPORTANT, no surprises)

- **Public repo**: Actions minutes are **unlimited and free** → keep `*/15`.
- **Private repo**: free quota is **2000 min/month**, billed per whole rounded minute (~2 min per run). Every 15 min ≈ 5760 min/month → **over quota**. Either make the repo public, or change the cron in `monitor.yml` to hourly (`5 * * * *` ≈ 1440 min/month).
- GitHub disables scheduled workflows after 60 days of repo inactivity. The state commits from the monitor keep the repo active; if you switch to hourly, also add the keepalive trick from the GiftTracker project (dummy commit on schedule) or push anything once a month.

### How state survives

Each run: checkout → engine cycle (`--once`) → bot polling window (30 s) → publish `docs/miniapp-data.json` → commit `data/state/*.json` back. The next run loads the exact same state (FileStore) — targets, hot jobs, locks, counters all continue. This is the restart-recovery design from the spec, just driven by cron instead of a live process.

**Honest limitation**: with cron granularity, a window between "number becomes available" and "the next run executes the upgrade" of up to ~15 minutes (public) exists. Sub-second reaction requires the self-hosted mode. No attempt is made to hide this.

## Self-hosted mode (optional upgrade path)

```bash
cp .env.example .env   # fill in the values
node src/index.js      # persistent worker + API on :8080
node bot/bot.js        # 24/7 bot polling (separate terminal / systemd unit)
```

systemd unit example:

```ini
[Unit]
Description=Gift Upgrade Engine
After=network-online.target

[Service]
WorkingDirectory=/opt/gift-engine
EnvironmentFile=/opt/gift-engine/.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Docker compose example:

```yaml
services:
  engine:
    image: node:20-slim
    working_dir: /app
    volumes: [".:/app", "engine-data:/app/data"]
    command: node src/index.js
    env_file: .env
    restart: unless-stopped
volumes:
  engine-data:
```

## GitHub Actions policy

Actions is used **only** for: CI (tests, secret scan), the scheduled monitor cycle, Pages deploy. It is **never** used for latency-critical execution in self-hosted mode — the persistent process owns that.

## Health check

- Local: `curl http://localhost:8080/api/health` (self-hosted).
- GitHub-only: the Actions run log of the monitor workflow is the health signal; a failing run is visible in the Actions tab and via GitHub notifications.
