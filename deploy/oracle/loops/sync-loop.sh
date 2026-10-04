#!/usr/bin/env bash
# State + Mini App site sync: commit local engine state, rebase on remote,
# rebuild the static site, push. Every 3 minutes.
cd "$(dirname "$0")"
while true; do
  git add data docs 2>/dev/null || true
  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -q -m "vm: state + site update" || true
  fi
  git pull --rebase -q -X theirs origin main 2>/dev/null || true
  if DB_BACKEND=file node scripts/build-site.js >/dev/null 2>&1; then
    git add docs 2>/dev/null || true
    if ! git diff --cached --quiet 2>/dev/null; then
      git commit -q -m "vm: site rebuild" || true
    fi
  fi
  git push -q origin main 2>/dev/null || true
  sleep 180
done
