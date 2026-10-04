#!/usr/bin/env bash
# Guided /login processor: picks up pending login_requests and walks users
# through phone/code/2FA. Exits instantly when the queue is empty.
cd "$(dirname "$0")"
while true; do
  node scripts/login-mtproto-guided.js || true
  sleep 20
done
