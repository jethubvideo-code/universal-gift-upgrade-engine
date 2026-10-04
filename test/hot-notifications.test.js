/**
 * Semi-automatic mode notifications (owner decision 2026-10-04): the engine
 * catches the moment, the owner presses the final upgrade button. Verifies
 * the two NEW notification points inside HotTargetEngine transitions:
 *  - TARGET_HOT (entering HOT_TARGET): immediate actionable message, deduped 30 min
 *  - TARGET_APPROACHING (WATCHING -> PREDICTED): prepare-ahead hint, deduped 6h
 * And that a notifier whose notifyUser returns undefined (sync mock) never
 * breaks the upgrade flow (regression found by the simulator suite).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/db.js';
import { TargetManager } from '../src/engine/target-manager.js';
import { HotTargetEngine } from '../src/engine/hot-target-engine.js';

function setup() {
  const store = new MemoryStore();
  const targets = new TargetManager(store);
  const calls = [];
  const notifier = {
    notifyUser(userId, kind, payload, opts = {}) { calls.push({ userId, kind, payload, opts }); }
  };
  const engine = new HotTargetEngine({ store, targets, notifier, logger: { warn() {}, info() {}, error() {} } });
  return { store, targets, engine, calls };
}

const stateFor = (cid, next) => ({
  collection_id: cid, total_supply: 1000, upgraded_count: next - 1,
  next_expected_number: next
});

test('TARGET_HOT fires when next expected == target number (P1)', async () => {
  const { store, targets, engine, calls } = setup();
  targets.create({ user_id: 'u1', collection_id: 'c1', gift_id: 'c1', target_number: 100 });
  await engine.onCollectionUpdate(stateFor('c1', 100));
  assert.ok(calls.some(c => c.kind === 'TARGET_HOT' && c.payload.target.target_number === 100));
  assert.ok(calls[0].opts.dedupKey, 'hot notification must carry a dedup key');
  assert.equal(calls[0].opts.dedupMinutes, 30);
});

test('TARGET_APPROACHING fires on P2 (distance <= 3), before the hot moment', async () => {
  const { targets, engine, calls } = setup();
  targets.create({ user_id: 'u1', collection_id: 'c1', gift_id: 'c1', target_number: 100 });
  await engine.onCollectionUpdate(stateFor('c1', 97));
  const near = calls.find(c => c.kind === 'TARGET_APPROACHING');
  assert.ok(near, 'approaching notification must fire at distance 3');
  assert.equal(near.opts.dedupMinutes, 360);
  assert.ok(!calls.some(c => c.kind === 'TARGET_HOT'), 'no hot notification while still 3 away');
});

test('nothing fires on P3 (far away) — no spam', async () => {
  const { targets, engine, calls } = setup();
  targets.create({ user_id: 'u1', collection_id: 'c1', gift_id: 'c1', target_number: 100 });
  await engine.onCollectionUpdate(stateFor('c1', 50));
  assert.equal(calls.length, 0);
});

test('sync notifier mock returning undefined never breaks the transition flow (regression)', async () => {
  const store = new MemoryStore();
  const targets = new TargetManager(store);
  const engine = new HotTargetEngine({
    store, targets,
    notifier: { notifyUser: () => undefined }, // no promise at all
    logger: { warn() {}, info() {}, error() {} }
  });
  const t = targets.create({ user_id: 'u1', collection_id: 'c1', gift_id: 'c1', target_number: 100 });
  await engine.onCollectionUpdate(stateFor('c1', 100));
  const row = targets.get(t.id);
  assert.equal(row.status, 'HOT_TARGET', 'transition must still happen');
});
