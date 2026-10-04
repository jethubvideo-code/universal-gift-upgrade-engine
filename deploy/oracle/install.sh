#!/usr/bin/env bash
# =============================================================================
# Universal Gift Upgrade Engine — Oracle Free ARM installer (Ubuntu 22.04/24.04)
# One command on a fresh VM:
#   curl -fsSL https://raw.githubusercontent.com/jethubvideo-code/universal-gift-upgrade-engine/main/deploy/oracle/install.sh | sudo bash
# (or: sudo bash deploy/oracle/install.sh from inside the repo)
#
# Installs:
#   /opt/gift-engine            — repo clone + node deps
#   /etc/gift-engine.env        — secrets (root-readable only)
#   systemd: gift-engine (persistent hot-cycle worker)
#            gift-bot       (bot long-poll loop)
#            gift-login     (guided /login processor loop)
#            gift-sync      (state + Mini App site push every 3 min)
# =============================================================================
set -euo pipefail
APP_DIR=/opt/gift-engine
ENV_FILE=/etc/gift-engine.env
UNITS_DIR=/etc/systemd/system

echo "== Universal Gift Upgrade Engine · Oracle ARM install =="

if [ "$(id -u)" != 0 ]; then echo "Run as root (sudo)."; exit 1; fi
ARCH=$(uname -m)
echo "Arch: $ARCH"
if [ "$ARCH" != "aarch64" ]; then echo "WARNING: expected aarch64 (ARM). Continuing anyway."; fi

# ---------- 1. Node.js 20 ----------
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]; then
  echo "-- Installing Node.js 20 (NodeSource)…"
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates gnupg git
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
echo "Node: $(node -v)"

# ---------- 2. Repo ----------
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  echo "-- Updating existing clone…"
  git -C "$APP_DIR" pull --rebase -q -X theirs origin main 2>/dev/null || true
else
  echo "-- Cloning repo…"
  git clone -q https://github.com/jethubvideo-code/universal-gift-upgrade-engine.git "$APP_DIR"
fi
git -C "$APP_DIR" config user.name "gift-engine-vm"
git -C "$APP_DIR" config user.email "engine@lvlonebot"

echo "-- Installing node deps…"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund -q

# ---------- 3. Secrets env ----------
if [ -f "$ENV_FILE" ]; then
  echo "-- $ENV_FILE already exists — keeping it."
else
  echo "-- Creating $ENV_FILE (interactive, values hidden)…"
  read -r -p "BOT_TOKEN (from @BotFather): " BOT_TOKEN
  read -r -p "TG_API_ID  [33186964]: " TG_API_ID; TG_API_ID=${TG_API_ID:-33186964}
  read -r -p "TG_API_HASH (my.telegram.org): " TG_API_HASH
  read -r -p "OWNER_CHAT_ID [8396883978]: " OWNER_CHAT_ID; OWNER_CHAT_ID=${OWNER_CHAT_ID:-8396883978}
  # NEW key on this VM: old sessions in git can't be decrypted anyway
  # (the old key lives only in GitHub secrets) — the owner re-logins via /login once.
  SESSION_KEY=$(openssl rand -hex 32)
  umask 077
  cat > "$ENV_FILE" <<ENVEOF
# Universal Gift Engine — VM secrets (managed by install.sh)
BOT_TOKEN=${BOT_TOKEN}
TG_API_ID=${TG_API_ID}
TG_API_HASH=${TG_API_HASH}
OWNER_CHAT_ID=${OWNER_CHAT_ID}
SESSION_ENCRYPTION_KEY=${SESSION_KEY}
TRANSPORT=mtproto
ENGINE_MODE=live
DB_BACKEND=file
RUN_ONCE=0
POLL_INTERVAL_MS=10000
HOT_POLL_MS=500
NODE_ENV=production
ENVEOF
  chmod 600 "$ENV_FILE"
  echo "-- New SESSION_ENCRYPTION_KEY generated. The owner re-logins once via /login."
fi

# ---------- 4. Deploy key (for pushing state + Mini App site) ----------
KEY_FILE="$APP_DIR/.deploy_key"
if [ ! -f "$KEY_FILE" ]; then
  echo "-- Generating deploy key…"
  ssh-keygen -t ed25519 -N '' -f "$KEY_FILE" -q
fi
PUB=$(cat "${KEY_FILE}.pub")
echo ""
echo "====================================================================="
echo " ADD THIS KEY TO GITHUB (one time):"
echo "   github.com/jethubvideo-code/universal-gift-upgrade-engine"
echo "   → Settings → Deploy keys → Add deploy key → paste:"
echo ""
echo "$PUB"
echo ""
read -r -p "Added? Press Enter to continue… " _ok
cat > "$APP_DIR/.git_ssh" <<SSHEOF
#!/bin/sh
exec ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new "\$@"
SSHEOF
chmod +x "$APP_DIR/.git_ssh"
git -C "$APP_DIR" remote set-url origin git@github.com:jethubvideo-code/universal-gift-upgrade-engine.git
git -C "$APP_DIR" config core.sshCommand "$APP_DIR/.git_ssh"

# ---------- 5. Loops + systemd units ----------
cp -f deploy/oracle/loops/*.sh "$APP_DIR/" 2>/dev/null || true
chmod +x "$APP_DIR"/*.sh 2>/dev/null || true

cat > "$UNITS_DIR/gift-engine.service" <<'UNIT'
[Unit]
Description=Gift Engine — persistent monitor + auto-upgrade worker
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/gift-engine
EnvironmentFile=/etc/gift-engine.env
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=5
Nice=-5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > "$UNITS_DIR/gift-bot.service" <<'UNIT'
[Unit]
Description=Gift Engine — bot command loop
After=network-online.target gift-engine.service
Wants=network-online.target

[Service]
WorkingDirectory=/opt/gift-engine
EnvironmentFile=/etc/gift-engine.env
ExecStart=/opt/gift-engine/bot-loop.sh
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > "$UNITS_DIR/gift-login.service" <<'UNIT'
[Unit]
Description=Gift Engine — guided /login processor loop
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/gift-engine
EnvironmentFile=/etc/gift-engine.env
ExecStart=/opt/gift-engine/login-loop.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

cat > "$UNITS_DIR/gift-sync.service" <<'UNIT'
[Unit]
Description=Gift Engine — state + Mini App site sync loop
After=network-online.target gift-engine.service
Wants=network-online.target

[Service]
WorkingDirectory=/opt/gift-engine
EnvironmentFile=/etc/gift-engine.env
ExecStart=/opt/gift-engine/sync-loop.sh
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now gift-engine gift-bot gift-login gift-sync

echo ""
echo "== DONE. Status: =="
sleep 3
systemctl --no-pager -l status gift-engine gift-bot gift-login gift-sync | head -40 || true
echo ""
echo "Live logs:   journalctl -u gift-engine -f"
echo "After the engine is confirmed running, DISABLE the GitHub Actions"
echo "engine-cycle / bot-poll workflows (avoid double upgrades) — ask the agent."
