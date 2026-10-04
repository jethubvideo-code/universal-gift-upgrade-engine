# Architecture

## Pipeline

```
GLOBAL COLLECTION MONITOR          one poll per collection (never per user)
        │
COLLECTION STATE CACHE            TTL cache: total_supply / upgraded_count / next_expected_number
        │
TARGET INDEX                      O(1) lookups: byCollection / byGiftId / byNumber / byUser / hot
        │
HOT TARGET QUEUE (P0–P3)          priority queue in the shared scheduler
        │
USER TARGETS                      WATCHING → PREDICTED → HOT_TARGET → VERIFYING →
                                  UPGRADE_READY → UPGRADING → CONFIRMING → COMPLETED
```

## Module map

| Module | Responsibility |
|---|---|
| `src/core/state-machine.js` | 13 target states + validated transitions, event per transition |
| `src/core/locks.js` | Atomic locks (store.tx), TTL expiry, withLock concurrency guard |
| `src/core/rate-limiter.js` | Central TelegramRateLimiter: global RPS, per-account per-method pacing, P0–P3 priorities, FLOOD_WAIT cooldown |
| `src/core/retry-manager.js` | Temporary vs permanent error classification, exponential backoff, max attempts |
| `src/core/metrics.js` | Counters / gauges / histograms (latencies) |
| `src/db.js` | MemoryStore / FileStore (GitHub mode) / SQLite fallback |
| `src/engine/target-manager.js` | Target CRUD, transitions, audit log |
| `src/engine/target-index.js` | In-memory indexes, markHot, restart recovery (replaceAll) |
| `src/engine/collection-monitor.js` | Shared polling, adaptive scheduling, one poll per collection |
| `src/engine/collection-state.js` | TTL cache, next_expected_number prediction |
| `src/engine/hot-target-engine.js` | Priority evaluation, pre-staging, verified upgrade flow, idempotency |
| `src/telegram/*` | MTProto client (GramJS optional), dynamic collection discovery, saved gifts, payment/upgrade executors, encrypted user sessions |
| `src/services/notifications.js` | Bot API notifications |
| `src/services/audit.js` | Append-only audit log for every state change |
| `src/services/miniapp-auth.js` | Telegram Mini App initData HMAC validation |
| `bot/bot.js` | Command interface (persistent long-poll or short one-shot cycle) |
| `api/server.js` | Protected Mini App API (initData auth) for self-hosted mode |
| `miniapp/` | Mini App UI (GitHub Pages-ready static frontend) |
| `src/actions/publish-snapshot.js` | Publishes public `docs/miniapp-data.json` for the Pages dashboard |

## Universal scaling

- **120 collections / 500 targets / 1000+ targets / 10,000+ targets** — same code path. Collections are discovered dynamically (`payments.getStarGifts`); no list is hardcoded.
- One poll per collection regardless of how many users watch it: 500 users watching the same collection cause exactly one refresh.
- Shared worker pool (`TargetScheduler`, concurrency configurable) executes hot jobs at P0 priority; no per-user polling threads.

Measured (CI runner-class hardware, see `test/perf/`):

| Operation | Result |
|---|---|
| Index rebuild, 10,000 targets | ~17 ms |
| `byNumber` O(1) lookup | ~0.09 ms |
| `onCollectionUpdate` (10k-target store) | ~18 ms |
| 100 simultaneous collection updates (1000 targets) | ~33 ms |
| 200 concurrent lock attempts / 50 keys | ~2 ms, exactly 50 winners |
| Restart recovery, 5,000 targets | ~5 ms |

## Priority semantics

| Priority | Meaning | Trigger |
|---|---|---|
| P0 | verified hot target / upgrade execution | `state.verified_available` or exact number match |
| P1 | exact `next_expected_number` match | prediction hit |
| P2 | within distance threshold (≤3 from expected) | near |
| P3 | routine monitoring | everything else |

Counters are a **prediction**. The actual Telegram state (`can_upgrade`, ownership, `gift_num`, price) is verified before any upgrade — see `docs/TELEGRAM_API.md`.

## GitHub-only mode vs self-hosted mode

| Aspect | GitHub-only (default) | Self-hosted |
|---|---|---|
| Compute | scheduled Actions run (`node src/index.js --once`) | persistent process + API |
| State | `data/state/*.json` committed back to the repo (FileStore) | same FileStore or SQLite |
| Reaction time | cron granularity (best effort every ~5–15 min) | immediate, in-process |
| Bot | short polling cycle per run | 24/7 long polling |
| Mini App | static Pages dashboard + bot commands | full authenticated API |

Both modes share the exact same engine code; only the entrypoint differs.
