/**
 * TEST MODE SIMULATOR — section 32 of the spec.
 *
 * Simulates (NO real Stars, NO real Telegram calls):
 *   - 120+ collections
 *   - counter progression 7775 -> 7776 -> 7777  (number used ONLY as example data)
 *   - full flow: WATCHING -> PREDICTED -> HOT_TARGET -> VERIFYING ->
 *     UPGRADE_READY -> UPGRADING -> CONFIRMING -> COMPLETED
 *   - race conditions, locks, rate limits, queue, retries
 *   - multiple users, multiple collections, multiple targets
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/db.js';
import { TargetManager } from '../src/engine/target-manager.js';
import { TargetIndex } from '../src/engine/target-index.js';
import { TargetScheduler } from '../src/engine/target-scheduler.js';
import { CollectionStateCache } from '../src/engine/collection-state.js';
import { HotTargetEngine } from '../src/engine/hot-target-engine.js';
import { LockManager } from '../src/core/locks.js';
import { TelegramRateLimiter } from '../src/core/rate-limiter.js';
import { Metrics } from '../src/core/metrics.js';
import { EngineError, ErrorCodes } from '../src/core/errors.js';
import { TargetStates } from '../src/core/state-machine.js';
import { createLogger } from '../src/core/logger.js';

const logger = createLogger('sim');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const waitUntil = async (fn, timeoutMs = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true;
    await sleep(25);
  }
  return fn();
};

function buildEngine({ store = new MemoryStore(), executor = null, savedGifts = null } = {}) {
  const targets = new TargetManager(store);
  const index = new TargetIndex();
  const scheduler = new TargetScheduler({ concurrency: 8 });
  const cache = new CollectionStateCache({ ttlMs: 60000 });
  const locks = new LockManager(store, { ttlMs: 30000 });
  const limiter = new TelegramRateLimiter({ globalPerSecond: 50, perAccountPerMethodMinIntervalMs: 5 });
  const metrics = new Metrics();
  const notifier = { sent: [], notifyUser(userId, kind, payload) { this.sent.push({ userId, kind, payload }); } };

  const exec = executor || makeFakeExecutor(store);
  const gifts = savedGifts || makeFakeSavedGifts();

  const hot = new HotTargetEngine({
    store, targets, index, monitor: null, cache,
    sessions: null, savedGifts: gifts, executor: exec,
    scheduler, locks, limiter, notifier, metrics, logger
  });

  const api = {
    store, targets, index, scheduler, cache, locks, limiter, metrics, notifier, hot, exec,
    addTarget(opts) { const row = targets.create(opts); index.add(row); return row; },
    feed(collectionId, upgradedCount, totalSupply = 10000) {
      const state = {
        collection_id: collectionId,
        total_supply: totalSupply,
        upgraded_count: upgradedCount,
        remaining: totalSupply - upgradedCount,
        next_expected_number: Math.min(upgradedCount + 1, totalSupply),
        last_update: new Date().toISOString(),
        source: 'simulator', version: 1
      };
      cache.set(collectionId, state);
      return hot.onCollectionUpdate(state);
    }
  };
  return api;
}

/** Fake Saved Gifts: user owns the concrete gift instance for the target number. */
function makeFakeSavedGifts() {
  return {
    getSavedStarGifts: async ({ userSession }) => {
      void userSession;
      return [{
        gift_id: 'sim-gift', gift_num: 7777, msg_id: 100, saved_id: 'saved-1',
        slug: 'sim', can_upgrade: true, upgraded: false,
        prepaid_upgrade: true, upgrade_stars: 10000, collection_id: 'sim-coll'
      }];
    },
    findForTarget: (list, { gift_id, target_number }) =>
      (list || []).find(g => g.gift_num === Number(target_number) &&
        (gift_id == null || g.gift_id === gift_id)) || null
  };
}

/** Fake executor: TEST MODE — records calls, never debits real Stars. */
function makeFakeExecutor(store, opts = {}) {
  const calls = { verify: 0, execute: 0, payments: 0, floodOnce: opts.floodOnce || false, floodUsed: false };
  return {
    calls,
    async verify({ target }) {
      calls.verify++;
      // section-8 checks simulated against fake saved state:
      const gift = { gift_num: target.target_number, upgraded: false, can_upgrade: true, upgrade_stars: 10000, prepaid_upgrade: true };
      if (opts.priceOverride != null) gift.upgrade_stars = opts.priceOverride;
      if (opts.unavailable) { gift.can_upgrade = false; return { ok: false, reason: 'UPGRADE_UNAVAILABLE', canUpgrade: false, price: null, savedGift: gift }; }
      // price is reported as-is; the engine's verified-price check decides
      return { ok: true, reason: null, canUpgrade: true, price: gift.upgrade_stars, savedGift: gift };
    },
    async execute({ target, idempotencyKey }) {
      // idempotency: a DONE job is never repeated
      const done = (store.find('upgrade_jobs', { idempotency_key: idempotencyKey }) || []).find(j => j.status === 'DONE');
      if (done) return { status: 'COMPLETED', cached: true };
      if (calls.floodOnce && !calls.floodUsed) {
        calls.floodUsed = true;
        throw new EngineError(ErrorCodes.FLOOD_WAIT, 'FLOOD_WAIT_2', { seconds: 2 });
      }
      calls.execute++;
      calls.payments++;
      return { status: 'COMPLETED', tx_id: 'sim-tx-' + target.id };
    }
  };
}

const events = (store, targetId) =>
  store.find('target_events', { target_id: targetId })
    .sort((a, b) => a.created_at < b.created_at ? -1 : 1)
    .map(e => e.to_status);

test('SECTION 32: full TEST MODE flow over 120+ collections, counter 7775 -> 7777', async () => {
  const eng = buildEngine();

  // 120 collections discovered dynamically (no hardcoding anywhere)
  for (let i = 0; i < 120; i++) {
    eng.store.insert('gift_collections', {
      id: `col-${i}`, collection_id: `sim-coll-${i}`,
      title: `Collection ${i}`, slug: `coll-${i}`, total_supply: 10000,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    });
  }
  // target on collection #42, number 7777 (example data only)
  const target = eng.addTarget({
    user_id: 'user-1', collection_id: 'sim-coll-42',
    gift_id: 'sim-gift', target_number: 7777,
    auto_upgrade: true, max_upgrade_stars: 25000
  });
  assert.equal(target.status, 'WATCHING');

  await eng.feed('sim-coll-42', 7775);   // next expected: 7776 — distance 1 -> P2 PREDICTED
  assert.equal(eng.targets.get(target.id).status, 'PREDICTED');

  await eng.feed('sim-coll-42', 7776);   // next expected: 7777 — MATCH -> HOT_TARGET (P0 job starts immediately)
  const inProgress = ['HOT_TARGET', 'VERIFYING', 'UPGRADE_READY', 'UPGRADING', 'CONFIRMING', 'COMPLETED'];
  assert.ok(inProgress.includes(eng.targets.get(target.id).status),
    `expected hot flow started, got ${eng.targets.get(target.id).status}`);

  // the P0 hot job runs through the scheduler
  assert.ok(await waitUntil(() => eng.targets.get(target.id).status === 'COMPLETED'),
    'flow must reach COMPLETED');
  assert.equal(eng.targets.get(target.id).status, 'COMPLETED');
  const path = events(eng.store, target.id);
  assert.deepEqual(path, [
    'PREDICTED', 'HOT_TARGET', 'VERIFYING', 'UPGRADE_READY',
    'UPGRADING', 'CONFIRMING', 'COMPLETED'
  ]);
  // ONE execution, idempotent
  assert.equal(eng.exec.calls.execute, 1);
  assert.equal(eng.exec.calls.verify, 1);
  // no real Stars: TEST MODE fake payment recorder only
  assert.equal(eng.exec.calls.payments, 1);
  // notification sent
  assert.ok(eng.notifier.sent.some(n => n.kind === 'UPGRADE_COMPLETED'));
  // audit log entries for every transition
  assert.ok(eng.store.count('audit_logs', { entity_id: target.id }) >= 7);
  // detection / verification / execution latencies recorded
  const snap = eng.metrics.snapshot();
  assert.ok(snap.histograms.detection_latency_ms.count > 0, 'detection latency recorded');
  assert.ok(snap.histograms.verification_latency_ms.count > 0, 'verification latency recorded');
  assert.ok(snap.histograms.execution_latency_ms.count > 0, 'execution latency recorded');
  assert.ok(snap.counters.upgrades_success, 'upgrade success counter');
});

test('500 users watching the SAME collection and SAME number — one feed drives all', async () => {
  const eng = buildEngine();
  for (let i = 0; i < 500; i++) {
    eng.addTarget({ user_id: `u${i}`, collection_id: 'hot-coll', gift_id: 'sim-gift', target_number: 5555 });
  }
  await eng.feed('hot-coll', 5554); // next = 5555 -> all 500 hot
  await sleep(250);
  const completed = eng.store.find('targets', { status: 'COMPLETED' }).length;
  assert.equal(completed, 500);
  assert.equal(eng.exec.calls.execute, 500);
});

test('RACE CONDITION: two concurrent handleHot on one target — one COMPLETED, one LOCK_BUSY', async () => {
  const eng = buildEngine();
  const target = eng.addTarget({ user_id: 'u1', collection_id: 'race-coll', gift_id: 'sim-gift', target_number: 7 });
  await eng.targets.applyTransition(target.id, 'HOT_TARGET', { reason: 'test' });
  const results = await Promise.allSettled([
    eng.hot.handleHot(target),
    eng.hot.handleHot(target)
  ]);
  const statuses = results.map(r => r.status);
  assert.ok(statuses.includes('fulfilled'), 'at least one must succeed');
  const rejections = results.filter(r => r.status === 'rejected').map(r => r.reason);
  for (const err of rejections) {
    assert.ok(err.code === ErrorCodes.LOCK_BUSY || /state/i.test(err.message),
      `expected LOCK_BUSY or state error, got ${err.message}`);
  }
  assert.equal(eng.targets.get(target.id).status, 'COMPLETED');
  assert.equal(eng.exec.calls.execute, 1, 'exactly one execution');
});

test('FLOOD_WAIT: temporary error retries on next cycle, target NOT failed permanently', async () => {
  const store = new MemoryStore();
  const exec = makeFakeExecutor(store, { floodOnce: true });
  const eng = buildEngine({ store, executor: exec });
  const target = eng.addTarget({ user_id: 'u1', collection_id: 'flood-coll', gift_id: 'sim-gift', target_number: 9 });
  await eng.targets.applyTransition(target.id, 'HOT_TARGET', { reason: 'test' });

  // first attempt hits FLOOD_WAIT
  await assert.rejects(eng.hot.handleHot(target), err => err.code === ErrorCodes.FLOOD_WAIT);
  assert.equal(eng.targets.get(target.id).status, 'WATCHING', 'temporary error -> back to WATCHING');
  // job stays QUEUED (retry with next cycle), attempts recorded
  assert.equal(eng.store.count('upgrade_attempts'), 1);
  assert.equal(eng.store.find('upgrade_jobs', { status: 'QUEUED' }).length, 1);

  // next cycle: counter matches again -> target goes hot again -> retry succeeds
  await eng.targets.applyTransition(target.id, 'HOT_TARGET', { reason: 'retry cycle' });
  const res = await eng.hot.handleHot(eng.targets.get(target.id));
  assert.equal(res.status, 'COMPLETED');
  assert.equal(eng.targets.get(target.id).status, 'COMPLETED');
});

test('PRICE LIMIT: price above maximum -> PRICE_LIMIT_EXCEEDED, no payment executed', async () => {
  const store = new MemoryStore();
  const exec = makeFakeExecutor(store, { priceOverride: 40000 });
  const eng = buildEngine({ store, executor: exec });
  const target = eng.addTarget({
    user_id: 'u1', collection_id: 'limit-coll', gift_id: 'sim-gift',
    target_number: 42, auto_upgrade: true, max_upgrade_stars: 25000
  });
  await eng.targets.applyTransition(target.id, 'HOT_TARGET', { reason: 'test' });
  const res = await eng.hot.handleHot(target);
  assert.equal(res.status, 'PRICE_LIMIT_EXCEEDED');
  assert.equal(eng.targets.get(target.id).status, 'PRICE_LIMIT_EXCEEDED');
  assert.equal(exec.calls.execute, 0, 'no execution when price exceeds limit');
  assert.equal(exec.calls.payments, 0, 'no Stars spent');
});

test('ACTUAL VERIFICATION: can_upgrade false -> target fails, counter never trusted alone', async () => {
  const store = new MemoryStore();
  const exec = makeFakeExecutor(store, { unavailable: true });
  const eng = buildEngine({ store, executor: exec });
  const target = eng.addTarget({ user_id: 'u1', collection_id: 'unav-coll', gift_id: 'sim-gift', target_number: 5 });
  await eng.targets.applyTransition(target.id, 'HOT_TARGET', { reason: 'test' });
  await assert.rejects(eng.hot.handleHot(target), err => /UPGRADE_UNAVAILABLE|VERIFICATION_FAILED/.test(err.code || err.message));
  assert.equal(eng.targets.get(target.id).status, 'FAILED');
  assert.equal(exec.calls.execute, 0, 'no upgrade when Telegram state says can_upgrade=false');
});

test('MULTI-COLLECTION / MULTI-TARGET: independent states per target', async () => {
  const eng = buildEngine();
  const t1 = eng.addTarget({ user_id: 'u1', collection_id: 'multi-a', gift_id: 'g', target_number: 100 });
  const t2 = eng.addTarget({ user_id: 'u1', collection_id: 'multi-b', gift_id: 'g', target_number: 200 });
  const t3 = eng.addTarget({ user_id: 'u2', collection_id: 'multi-b', gift_id: 'g', target_number: 200 });
  // collection A gets hot
  await eng.feed('multi-a', 99);
  // collection B is far away
  await eng.feed('multi-b', 50);
  const advanced = ['HOT_TARGET', 'VERIFYING', 'UPGRADE_READY', 'UPGRADING', 'CONFIRMING', 'COMPLETED'];
  assert.ok(advanced.includes(eng.targets.get(t1.id).status),
    `t1 must be in the hot flow, got ${eng.targets.get(t1.id).status}`);
  assert.equal(eng.targets.get(t2.id).status, 'WATCHING');
  assert.equal(eng.targets.get(t3.id).status, 'WATCHING');
  void t2; void t3;
});

test('RESTART RECOVERY: fresh index from the same store restores all active targets', async () => {
  const eng = buildEngine();
  eng.addTarget({ user_id: 'u1', collection_id: 'rec-coll', gift_id: 'g', target_number: 12345 });
  eng.addTarget({ user_id: 'u2', collection_id: 'rec-coll-2', gift_id: 'g', target_number: 5 });
  // simulate restart: brand-new index reloaded from persisted rows
  const freshIndex = new TargetIndex();
  freshIndex.replaceAll(eng.store.findAll('targets'));
  assert.equal(freshIndex.active().length, 2);
  assert.equal(freshIndex.byNumber('rec-coll', 12345).length, 1);
  assert.equal(freshIndex.byNumber('rec-coll-2', 5).length, 1);
  assert.equal(freshIndex.stats().total, 2);
});
