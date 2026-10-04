/**
 * Speed Mode Phase B tests: prepared-fire hot path.
 *
 * Verifies the two speed-critical properties:
 *  1. The saved-gift fetch happens ONCE (at preStage, while the target is
 *     merely near) — the fire moment makes ZERO extra fetches because
 *     verify() receives the pre-staged savedGift.
 *  2. Two handleHot invocations in the same window (two onCollectionUpdate
 *     events racing) fire the executor exactly ONCE — synchronous claim.
 *  3. A stale prepared entry is NOT reused (fail-closed re-fetch).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/db.js';
import { TargetManager } from '../src/engine/target-manager.js';
import { TargetIndex } from '../src/engine/target-index.js';
import { TargetScheduler } from '../src/engine/target-scheduler.js';
import { CollectionStateCache } from '../src/engine/collection-state.js';
import { HotTargetEngine } from '../src/engine/hot-target-engine.js';
import { UpgradeExecutor } from '../src/telegram/upgrade-executor.js';
import { LockManager } from '../src/core/locks.js';
import { TelegramRateLimiter } from '../src/core/rate-limiter.js';
import { Metrics } from '../src/core/metrics.js';
import { createLogger } from '../src/core/logger.js';

const logger = createLogger('hotpath');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitUntil = async (fn, timeoutMs = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(20); }
  return fn();
};

function build({ savedGifts, payments } = {}) {
  const store = new MemoryStore();
  const targets = new TargetManager(store);
  const index = new TargetIndex();
  const scheduler = new TargetScheduler({ concurrency: 8 });
  const cache = new CollectionStateCache({ ttlMs: 60000 });
  const locks = new LockManager(store, {});
  const limiter = new TelegramRateLimiter({});
  const metrics = new Metrics();
  const notifier = { sent: [], notifyUser(u, k, p) { this.sent.push({ u, k, p }); } };
  const executor = new UpgradeExecutor({ savedGifts, payments, locks, limiter, metrics, logger, mode: 'test' });
  const hot = new HotTargetEngine({ store, targets, index, monitor: null, cache, sessions: null, savedGifts, executor, scheduler, locks, limiter, notifier, metrics, logger });
  return { store, targets, index, hot, executor };
}

test('SPEED: saved-gift fetch happens ONCE — fire moment makes zero extra fetches', async () => {
  let fetches = 0;
  const savedGifts = {
    async getSavedStarGifts() {
      fetches++;
      return [{
        gift_id: 'g', gift_num: 42, msg_id: 100, saved_id: 's1', slug: 'coll',
        can_upgrade: true, upgraded: false, prepaid_upgrade: true, upgrade_stars: 5000, collection_id: 'coll'
      }];
    },
    findForTarget(list, { gift_id, target_number }) {
      return (list || []).find(g => g.gift_num === Number(target_number)) || null;
    }
  };
  const payments = {
    async upgradePrepaid({ savedGift }) { return { status: 'COMPLETED', savedGift }; }
  };
  const eng = build({ savedGifts, payments });
  const t = eng.targets.create({ user_id: 'u1', collection_id: 'coll', gift_id: 'g', target_number: 42, auto_upgrade: true, max_upgrade_stars: 10000 });
  eng.index.add(t);

  await eng.hot.onCollectionUpdate({ collection_id: 'coll', total_supply: 100, upgraded_count: 41, remaining: 59, next_expected_number: 42, source: 'sim', version: 1 });
  await waitUntil(() => eng.targets.get(t.id).status === 'COMPLETED');

  assert.equal(eng.targets.get(t.id).status, 'COMPLETED');
  // preStage fetched once; verify reused the prepared entry and fetched ZERO more times.
  assert.equal(fetches, 1, `expected exactly 1 saved-gift fetch, got ${fetches}`);
});

test('SPEED: racing double-fire is claimed synchronously — executor runs exactly once', async () => {
  let executes = 0;
  const savedGifts = {
    async getSavedStarGifts() {
      return [{ gift_id: 'g', gift_num: 7, msg_id: 1, saved_id: 's', can_upgrade: true, upgraded: false, prepaid_upgrade: true, upgrade_stars: 100, collection_id: 'coll' }];
    },
    findForTarget: (list, { target_number }) => (list || []).find(g => g.gift_num === Number(target_number)) || null
  };
  const payments = {
    async upgradePrepaid() { executes++; await sleep(50); return { status: 'COMPLETED' }; }
  };
  const eng = build({ savedGifts, payments });
  const t = eng.targets.create({ user_id: 'u1', collection_id: 'coll', gift_id: 'g', target_number: 7, auto_upgrade: true, max_upgrade_stars: 1000 });
  eng.index.add(t);
  await eng.targets.applyTransition(t.id, 'HOT_TARGET', { reason: 'test' });
  await eng.hot.preStage(t);

  // LAYER 1 — same-tick race: the target lock makes the second call fail
  // fast with LOCK_BUSY instead of firing twice.
  const results = await Promise.allSettled([eng.hot.handleHot(t), eng.hot.handleHot(t)]);
  assert.equal(executes, 1, `executor must run exactly once, ran ${executes}`);
  const rejected = results.filter(r => r.status === 'rejected');
  const fulfilled = results.filter(r => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one of the racing calls proceeds');
  assert.equal(rejected.length, 1, 'the other is rejected (LOCK_BUSY)');
  assert.equal(rejected[0].reason.code, 'LOCK_BUSY');

  // LAYER 2 — sequential repeat after COMPLETED: the synchronous firedKeys
  // claim returns a cached result without touching the executor again.
  const again = await eng.hot.handleHot(t);
  assert.equal(executes, 1, 'sequential repeat must not execute again');
  assert.equal(again.deduped, 'in-process');
  assert.equal(again.status, 'COMPLETED');
});

test('SPEED: stale prepared entry is re-verified, never blindly trusted (fail-closed)', async () => {
  let fetches = 0;
  const savedGifts = {
    async getSavedStarGifts() {
      fetches++;
      return [{ gift_id: 'g', gift_num: 9, msg_id: 1, saved_id: 's', can_upgrade: true, upgraded: false, prepaid_upgrade: true, upgrade_stars: 100, collection_id: 'coll' }];
    },
    findForTarget: (list, { target_number }) => (list || []).find(g => g.gift_num === Number(target_number)) || null
  };
  const payments = { async upgradePrepaid() { return { status: 'COMPLETED' }; } };
  const eng = build({ savedGifts, payments });
  const t = eng.targets.create({ user_id: 'u1', collection_id: 'coll', gift_id: 'g', target_number: 9, auto_upgrade: true, max_upgrade_stars: 1000 });
  eng.index.add(t);
  await eng.targets.applyTransition(t.id, 'HOT_TARGET', { reason: 'test' });

  await eng.hot.preStage(t); // fetch #1
  assert.equal(fetches, 1);
  // Expire the prepared entry artificially.
  const entry = eng.hot.prepared.get(t.id);
  entry.preparedAtMs = Date.now() - 60000; // older than PREPARED_TTL_MS (30s)
  await eng.hot.handleHot(t);
  assert.ok(fetches >= 2, 'stale entry must trigger a re-fetch (fail-closed), not a blind fire');
});
