# Test plan

Run everything with **zero dependencies** (Node 20 built-in test runner):

```bash
node --test test/        # unit + TEST MODE simulator (section 32)
node --test test/perf/   # performance tests (section 33)
```

CI runs both on every push (`.github/workflows/ci.yml`).

## Coverage map

### Section 32 — TEST MODE simulator (`test/simulator.test.js`)

| Scenario | Verified |
|---|---|
| 120 collections, full flow, counter 7775 → 7776 → 7777 | exact state path WATCHING → PREDICTED → HOT_TARGET → VERIFYING → UPGRADE_READY → UPGRADING → CONFIRMING → COMPLETED recorded in target_events |
| Idempotency | exactly one execution, one verify, duplicate job returns cached COMPLETED |
| No real Stars | fake payment recorder only, TEST MODE cannot debit anything |
| Notification | UPGRADE_COMPLETED sent |
| Audit | state transition logged for every step |
| Latencies | detection / verification / execution histograms recorded |
| 500 users, same collection + same number | all 500 complete, one feed drives all |
| Race: two concurrent handleHot | one COMPLETED, other LOCK_BUSY, exactly one execution |
| FLOOD_WAIT once | job stays QUEUED, target back to WATCHING, retry on next cycle succeeds |
| Price above limit | PRICE_LIMIT_EXCEEDED, zero executions, zero Stars |
| can_upgrade = false | FAILED, zero executions (counter never trusted alone) |
| Multi-user / multi-collection | independent states per target |
| Restart recovery | fresh index from persisted store restores all active targets |

### Section 33 — performance (`test/perf/perf.test.js`)

| Case | Requirement | Measured on CI-class runner |
|---|---|---|
| Index rebuild, 10,000 targets / 120 collections | < 2 s | ~17 ms |
| byNumber O(1) lookup | < 5 ms | ~0.09 ms |
| onCollectionUpdate over 10k-target store | completes | ~18 ms |
| 100 simultaneous collection updates (1000 targets) | all hot targets detected | ~33 ms, PREDICTED+HOT_TARGET > 0 |
| 200 concurrent locks / 50 keys | exactly one winner per key | 50 acquired, ~2 ms |
| 500 limiter-scheduled calls | completes | ~0.6 s |
| Restart recovery, 5,000 targets | all active restored | ~5 ms |

### Unit tests

- `state-machine.test.js` — 13 states, all valid/invalid transitions, event atomicity
- `db.test.js` — MemoryStore CRUD/tx, **FileStore restart persistence**, backend selection
- `locks.test.js` — acquire/release, token check, expiry steal, 50-way race, concurrency
- `rate-limiter.test.js` — per-method pacing, parallel methods, FLOOD_WAIT cooldown, P0 preemption
- `retry-manager.test.js` — temporary retried with backoff, permanent immediate, max retries
- `target-index.test.js` — all lookups, 500 users same number, markHot, replaceAll recovery, ANY-number validation

## The 12 post-implementation checks

1. ✅ Works with ALL supported collections (120+ discovered dynamically in tests)
2. ✅ Any #N accepted (1, 7, 777, 1234, 7777, 10000, 999999 all pass validation)
3. ✅ Handles 1000+ and 10,000+ targets (perf suite)
4. ✅ One poll per collection regardless of user count
5. ✅ Shared worker pool with P0–P3 priorities
6. ✅ Actual verification via official API before upgrade (executor.verify)
7. ✅ No UI emulation / browser clicking anywhere (payment-executor uses API only)
8. ✅ Idempotency + atomicity + retry logic (upgrade_jobs, LockManager, RetryManager)
9. ✅ Telegram limits respected (central rate limiter, FLOOD_WAIT handling)
10. ✅ No hardcoded collection/number anywhere (grep-verifiable)
11. ✅ Restart recovery in all modes (index rebuild, QUEUED jobs resume, cache reload, lock purge)
12. ✅ T.me/nft only as public info/prediction source, never execution (code-verifiable)

## Manual checks before production

1. Re-validate TL schema names against the current Telegram layer (docs/TELEGRAM_API.md).
2. Run one real cycle in monitoring-only mode and inspect `data/state/` + the Actions log.
3. Verify the bot answers `/start`, `/targets`, `/state` in a real chat.
4. Open the Pages Mini App URL from Telegram once to confirm it renders.
