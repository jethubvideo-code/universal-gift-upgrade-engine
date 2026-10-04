#!/usr/bin/env bash
# ============================================================================
# Universal Gift Upgrade Engine — Oracle Cloud Always Free (ARM/aarch64) setup
# Run this ON THE VM, in the web console (or SSH). One command installs
# everything: Node 20, the repo, dependencies (no native optional deps),
# a systemd service with auto-restart, and a .env template.
#
# Usage:  bash deploy/oracle-install.sh
# Requires: git clone of this repo first, OR run from the repo root.
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="gift-upgrade-engine"
ARCH="$(uname -m)"

echo "== Universal Gift Upgrade Engine: Oracle Free (${ARCH}) setup =="

# --- 1. Node 20 (NodeSource ARM build) ---
if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  echo "-- Installing Node 20 (${ARCH})..."
  if command -v apt-get >/dev/null; then
    apt-get update -y
    apt-get install -y ca-certificates curl gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  else
    echo "ERROR: unsupported package manager. Install Node >= 20 manually." >&2
    exit 1
  fi
fi
echo "-- Node: $(node -v)"

# --- 2. Dependencies. --omit=optional: better-sqlite3 would need a native
#     aarch64 compile; the engine uses the file backend (DB_BACKEND=file),
#     so the optional dep is deliberately skipped on Oracle ARM.
cd "$REPO_DIR"
npm install --omit=optional --no-audit --no-fund

# --- 3. .env template (edit after install: SETUP.md step 4) ---
if [ ! -f .env ]; then
  cat > .env <<'EOF'
# === Fill these in (SETUP.md steps 1 and 4) ===
TG_API_ID=
TG_API_HASH=
SESSION_ENCRYPTION_KEY=
TRANSPORT=mtproto
MODE=dry-run
DB_BACKEND=file
DB_DIR=data/state
PORT=8080
# Signal loop speed (ms). HOT_POLL_MS is the cadence while a target is HOT.
HOT_POLL_MS=500
POLL_INTERVAL_MS=10000
# BOT_TOKEN=  (notifications bot, optional for the worker)
EOF
  echo "-- .env template created. Fill it in:  nano $REPO_DIR/.env"
else
  echo "-- .env exists, keeping it."
fi

# --- 4. systemd service: auto-restart, always-on (survives VM reboots) ---
cat > /etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Universal Gift Upgrade Engine (Speed Mode worker)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${REPO_DIR}
EnvironmentFile=${REPO_DIR}/env.runtime
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=2
# Memory safety on the free VM (24 GB available; this is a generous cap)
MemoryMax=2G
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# systemd needs a plain env file (no inline comments, no quotes-with-spaces tricks)
if [ ! -f env.runtime ]; then
  grep -E '^[A-Z_]+=' .env | sed 's/^export //' > env.runtime
fi

systemctl daemon-reload
systemctl enable ${SERVICE_NAME}

echo ""
echo "== DONE =="
echo "Next steps (SETUP.md):"
echo "  1. nano $REPO_DIR/.env   (TG_API_ID, TG_API_HASH, SESSION_ENCRYPTION_KEY)"
echo "  2. regenerate runtime env:  grep -E '^[A-Z_]+=' .env > env.runtime"
echo "  3. one-time login (console only):  systemctl start ${SERVICE_NAME} is NOT run yet —"
echo "     run 'npm run login' first, it needs interactive input:"
echo "       cd $REPO_DIR && npm run login"
echo "  4. then:  systemctl start ${SERVICE_NAME} && systemctl status ${SERVICE_NAME}"
echo "  5. benchmark:  npm run dryrun   (real numbers for Phase A)"
