/**
 * Business gift scanner tests — this is the feature that was MISSING: before
 * it existed, getBusinessAccountGifts/upgradeGift were fully implemented but
 * never called by anything. Verifies the owner's actual question: "I own an
 * un-upgraded gift — how does the engine find it and upgrade it automatically
 * through my account, without me telling it the number in advance."
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/db.js';
import { TargetManager } from '../src/engine/target-manager.js';
import { classifyGift, scanOwnedGifts, autoActOnOwnedGifts } from '../src/engine/business-scanner.js';
import { UpgradeExecutor } from '../src/telegram/upgrade-executor.js';

function fakeBackend(gifts, { starBalance = 1000, upgradeImpl = null } = {}) {
  return {
    async getSavedStarGifts() { return gifts; },
    async getStarBalance() { return starBalance; },
    findForTarget(list, { target_number }) { return (list || []).find(g => g.gift_num === Number(target_number)) || null; },
    async upgradePrepaid({ savedGift }) { return (upgradeImpl || (async () => ({ status: 'COMPLETED' })))({ savedGift }); },
    async beginPaidUpgrade({ savedGift }) { return { ok: true, savedGift }; }
  };
}

test('classifyGift: already upgraded / cannot upgrade / free prepaid / affordable / too expensive', () => {
  assert.equal(classifyGift({ upgraded: true }).status, 'ALREADY_UPGRADED');
  assert.equal(classifyGift({ upgraded: false, can_upgrade: false }).status, 'CANNOT_UPGRADE');
  assert.equal(classifyGift({ upgraded: false, can_upgrade: true, prepaid_upgrade: true }).status, 'FREE_UPGRADE_READY');
  assert.equal(classifyGift({ upgraded: false, can_upgrade: true, prepaid_upgrade: false, upgrade_stars: 500 }, { starBalance: 1000 }).status, 'AFFORDABLE');
  assert.equal(classifyGift({ upgraded: false, can_upgrade: true, prepaid_upgrade: false, upgrade_stars: 5000 }, { starBalance: 1000 }).status, 'TOO_EXPENSIVE');
});

test('scanOwnedGifts: real question — owned un-upgraded gift is FOUND without any pre-existing target', async () => {
  const backend = fakeBackend([
    { gift_id: 'g1', gift_num: 2826, owned_gift_id: 'o1', can_upgrade: true, upgraded: false, prepaid_upgrade: true, upgrade_stars: null, collection_id: 'PlushPepe', slug: 'PlushPepe' }
  ]);
  const scan = await scanOwnedGifts({ backend, userSession: { session: 'bc1' } });
  assert.equal(scan.total, 1);
  assert.equal(scan.upgradable_count, 1);
  assert.equal(scan.gifts[0].status, 'FREE_UPGRADE_READY');
  assert.equal(scan.gifts[0].cost, 0);
});

test('autoActOnOwnedGifts: matches an EXISTING target by number and upgrades it through the business backend (dry-run never spends)', async () => {
  const store = new MemoryStore();
  const targets = new TargetManager(store);
  const backend = fakeBackend([
    { gift_id: 'g1', gift_num: 2826, owned_gift_id: 'o1', can_upgrade: true, upgraded: false, prepaid_upgrade: true, upgrade_stars: null, collection_id: 'PlushPepe', slug: 'PlushPepe' }
  ]);
  const executor = new UpgradeExecutor({ savedGifts: backend, payments: backend, mode: 'dry-run' });
  const t = targets.create({ user_id: 'u1', collection_id: 'PlushPepe', gift_id: 'g1', target_number: 2826, auto_upgrade: true, max_upgrade_stars: 1000 });
  const notified = [];
  const notifier = { notifyUser: (u, k, p) => notified.push({ u, k, p }) };

  const report = await autoActOnOwnedGifts({
    userId: 'u1', backend, userSession: { session: 'bc1' }, store, targets, executor, notifier
  });

  assert.equal(report.upgraded.length, 1, 'the matched target must be upgraded');
  assert.equal(report.upgraded[0].gift_num, 2826);
  assert.ok(notified.some(n => n.k === 'UPGRADE_COMPLETED'));
});

test('autoActOnOwnedGifts: NO target exists, but wildcard auto-upgrade is on -> owned gift upgraded anyway', async () => {
  const store = new MemoryStore();
  const targets = new TargetManager(store);
  const backend = fakeBackend([
    { gift_id: 'g2', gift_num: 999, owned_gift_id: 'o2', can_upgrade: true, upgraded: false, prepaid_upgrade: false, upgrade_stars: 300, collection_id: 'SomeColl', slug: 'SomeColl' }
  ], { starBalance: 1000 });
  const executor = new UpgradeExecutor({ savedGifts: backend, payments: backend, mode: 'dry-run' });
  store.insert('business_settings', { id: 'bs-u2', user_id: 'u2', auto_upgrade_all: true, max_upgrade_stars_all: 500 });
  const notifier = { notifyUser: () => {} };

  const report = await autoActOnOwnedGifts({
    userId: 'u2', backend, userSession: { session: 'bc2' }, store, targets, executor, notifier
  });

  assert.equal(report.upgraded.length, 1, 'wildcard setting must act on an owned gift with no pre-existing target');
  assert.equal(report.upgraded[0].wildcard, true);
});

test('autoActOnOwnedGifts: no target, no wildcard, no execute capability -> notifies ONCE, deduped on repeat scan', async () => {
  const store = new MemoryStore();
  const targets = new TargetManager(store);
  const backend = fakeBackend([
    { gift_id: 'g3', gift_num: 1, owned_gift_id: 'o3', can_upgrade: true, upgraded: false, prepaid_upgrade: true, upgrade_stars: null, collection_id: 'X', slug: 'X' }
  ]);
  const notified = [];
  const notifier = { notifyUser: (u, k, p) => notified.push({ u, k, p }) };

  const r1 = await autoActOnOwnedGifts({ userId: 'u3', backend, userSession: { session: 'bc3' }, store, targets, executor: null, notifier });
  const r2 = await autoActOnOwnedGifts({ userId: 'u3', backend, userSession: { session: 'bc3' }, store, targets, executor: null, notifier });

  assert.equal(r1.notified.length, 1, 'first scan notifies once');
  assert.equal(r2.notified.length, 0, 'second scan of the same gift+status must NOT notify again');
  assert.equal(notified.filter(n => n.k === 'OWNED_GIFT_FOUND').length, 1);
});
