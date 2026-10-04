#!/usr/bin/env bash
# Bot command processor: run single-shot bot.js forever (it is restart-safe,
# offsets persist in the store). 2s gap between runs.
cd "$(dirname "$0")"
while true; do
  node bot/bot.js || true
  sleep 2
done
