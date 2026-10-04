/**
 * PERFORMANCE TESTS — section 33.
 *
 * 120 collections, 1000+ targets, 10,000+ targets, simultaneous HOT TARGET
 * events, index rebuild latency, restart recovery.
 * Real measured numbers are printed — no marketing values.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { MemoryStore } from '../../src/db.js';
import { TargetManager } from '../../src/engine/target-manager.js';
import { TargetIndex } from '../../src/engine/target-index.js';
import { TargetScheduler } from '../../src/engine/target-scheduler.js';
import { HotTargetEngine } from '../../src/engine/hot-target-engine.js';
import { LockManager } from '../../src/core/locks.js';
import { TelegramRateLimiter } from '../../src/core/rate-limiter.js';
import { Metrics } from '../../src/core/metrics.js';
import { createLogger } from '../../src/core/logger.js';

const logger = createLogger('perf');

function buildHot(store, index) {
  const metrics = new Metrics();
  return {
    metrics,
    hot: new HotTargetEngine({
      store,
      targets: new TargetManager(store),
      index,
      monitor: null,
      cache: null,
      sessions: null,
      savedGifts: null,
      executor: null,
      scheduler: new TargetScheduler({ concurrency: 8 }),
      locks: new LockManager(store, {}),
      limiter: new TelegramRateLimiter({ globalPerSecond: 200, perAccountPerMethodMinIntervalMs: 1 }),
      notifier: null,
      metrics,
      logger
    })
  };
}

function seed(store, nCollections, nTargets, hotNum = 1000) {
  const tm = new TargetManager(store);
  for (let c = 0; c < nCollections; c++) {
    store.insert('gift_collections', {
      id: `c${c}`, collection_id: `perf-coll-${c}`, title: `C${c}`,
      total_supply: 100000, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z'
    });
  }
  for (let i = 0; i < nTargets; i++) {
    const c = `perf-coll-${i % nCollections}`;
    tm.create({
      user_id: `user-${i}`, collection_id: c, gift_id: `g-${i % nCollections}`,
      target_number: (i % 3 === 0) ? hotNum : 50000 + i  // every 3rd target watches the hot number
    });
  }
  return tm;
}

test('INDEX: 10,000 targets across 120 collections — rebuild + lookups', () => {
  const store = new MemoryStore();
  seed(store, 120, 10000);

  const t0 = performance.now();
  const index = new TargetIndex();
  index.replaceAll(store.findAll('targets'));
  const rebuildMs = performance.now() - t0;
  console.log(`  index rebuild (10k targets): ${rebuildMs.toFixed(1)} ms`);
  assert.ok(rebuildMs < 2000, 'index rebuild must be < 2s');

  const t1 = performance.now();
  const hits = index.byNumber('perf-coll-0', 1000);
  const lookupMs = performance.now() - t1;
  console.log(`  byNumber lookup: ${lookupMs.toFixed(4)} ms, hits: ${hits.length}`);
  assert.ok(hits.length > 0);
  assert.ok(lookupMs < 5, 'O(1) index lookup must be < 5ms');
  assert.equal(index.stats().total, 10000);
});

test('EVALUATION: onCollectionUpdate across 10k-target store (one collection)', async () => {
  const store = new MemoryStore();
  const index = new TargetIndex();
  seed(store, 120, 10000);
  index.replaceAll(store.findAll('targets'));
  const { hot, metrics } = buildHot(store, index);

  const state = {
    collection_id: 'perf-coll-0', total_supply: 100000, upgraded_count: 999,
    remaining: 99001, next_expected_number: 1000, last_update: new Date().toISOString(),
    source: 'perf', version: 1
  };
  const t0 = performance.now();
  await hot.onCollectionUpdate(state);   // ~84 targets of that collection evaluated
  const ms = performance.now() - t0;
  console.log(`  onCollectionUpdate (10k-target store, ~84 evaluated): ${ms.toFixed(1)} ms`);
  assert.ok(ms < 5000);
  assert.ok(metrics.snapshot().histograms.detection_latency_ms.count > 0);
});

test('SIMULTANEOUS HOT TARGETS: 100 collections flip at once', async () => {
  const store = new MemoryStore();
  const index = new TargetIndex();
  seed(store, 100, 1000); // 10 targets per collection
  index.replaceAll(store.findAll('targets'));
  const { hot } = buildHot(store, index);

  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 100 }, (_, c) => hot.onCollectionUpdate({
      collection_id: `perf-coll-${c}`, total_supply: 100000, upgraded_count: 999,
      remaining: 99001, next_expected_number: 1000, last_update: new Date().toISOString(),
      source: 'perf', version: 1
    }))
  );
  const ms = performance.now() - t0;
  console.log(`  100 simultaneous collection updates (1000 targets): ${ms.toFixed(1)} ms`);
  const predicted = store.find('targets', { status: 'PREDICTED' }).length;
  const hotN = store.find('targets', { status: 'HOT_TARGET' }).length;
  console.log(`  resulting states: PREDICTED=${predicted}, HOT_TARGET=${hotN}`);
  assert.ok(ms < 5000);
  assert.ok(predicted + hotN > 0, 'targets must have advanced in priority');
});

test('LOCKS: 200 concurrent lock attempts across 50 keys — one winner per key', async () => {
  const store = new MemoryStore();
  const locks = new LockManager(store, { ttlMs: 60000 });
  const t0 = performance.now();
  let acquired = 0;
  await Promise.allSettled(
    Array.from({ length: 200 }, (_, i) =>
      locks.withLock(`key-${i % 50}`, () => { acquired++; }, { ownerId: `w${i}` })
        .catch(() => {})
    )
  );
  const ms = performance.now() - t0;
  console.log(`  200 lock attempts / 50 keys: ${ms.toFixed(1)} ms, acquired=${acquired}`);
  assert.equal(acquired, 50, 'one winner per key');
});

test('RATE LIMITER: 500 queued calls through the limiter', async () => {
  const limiter = new TelegramRateLimiter({ globalPerSecond: 500, perAccountPerMethodMinIntervalMs: 1 });
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      limiter.run({ account: `a${i % 10}`, method: `m${i % 5}`, priority: i % 4 }, async () => i)
    )
  );
  const ms = performance.now() - t0;
  console.log(`  500 limiter-scheduled calls: ${ms.toFixed(1)} ms`);
  assert.ok(ms < 5000);
});

test('RESTART RECOVERY: full state restore at scale', () => {
  const store = new MemoryStore();
  seed(store, 120, 5000);
  const t0 = performance.now();
  const index = new TargetIndex();
  index.replaceAll(store.findAll('targets'));   // restart recovery path
  const stats = index.stats();
  const ms = performance.now() - t0;
  console.log(`  restart recovery (5k targets): ${ms.toFixed(1)} ms -> active=${stats.active}, total=${stats.total}`);
  assert.equal(stats.total, 5000);
  assert.equal(stats.active, 5000);
  assert.ok(ms < 2000);
});
