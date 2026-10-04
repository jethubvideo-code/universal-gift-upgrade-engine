import test from 'node:test';
import assert from 'node:assert/strict';
import { LockManager } from '../src/core/locks.js';
import { MemoryStore } from '../src/db.js';
import { EngineError, ErrorCodes } from '../src/core/errors.js';

test('acquire / release / re-acquire', () => {
  const locks = new LockManager(new MemoryStore(), { ttlMs: 60000 });
  const t1 = locks.acquire('target:t1', { ownerId: 'w1' });
  assert.ok(t1);
  // second acquire while held fails
  assert.equal(locks.acquire('target:t1', { ownerId: 'w2' }), null);
  assert.equal(locks.release('target:t1', t1), true);
  // after release it is free again
  const t2 = locks.acquire('target:t1', { ownerId: 'w2' });
  assert.ok(t2);
});

test('release with wrong token does not unlock', () => {
  const locks = new LockManager(new MemoryStore(), {});
  const t = locks.acquire('k', { ownerId: 'w1' });
  assert.equal(locks.release('k', 'wrong-token'), false);
  assert.equal(locks.acquire('k', { ownerId: 'w2' }), null);
});

test('expired lock is stealable', () => {
  const store = new MemoryStore();
  const locks = new LockManager(store, { ttlMs: 20 });
  const t = locks.acquire('k', { ownerId: 'w1' });
  assert.ok(t);
  // force-expire
  const lockRow = store.findAll('locks').find(l => l.key === 'k' || l.id === 'k');
  if (lockRow) store.update('locks', lockRow.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
  const t2 = locks.acquire('k', { ownerId: 'w2' });
  assert.ok(t2, 'expired lock should be stealable');
});

test('RACE CONDITION: 50 parallel withLock on one key — exactly one winner per generation', async () => {
  const locks = new LockManager(new MemoryStore(), { ttlMs: 10000 });
  let wins = 0;
  let busy = 0;
  await Promise.allSettled(
    Array.from({ length: 50 }, (_, i) =>
      locks.withLock('target:race', () => { wins++; return 'done'; }, { ownerId: `w${i}` })
        .catch(err => { if (err.code === ErrorCodes.LOCK_BUSY) busy++; else throw err; })
    )
  );
  assert.equal(wins, 1, `exactly one winner expected, got ${wins}`);
  assert.equal(busy, 49);
});

test('different keys do not block each other', async () => {
  const locks = new LockManager(new MemoryStore(), { ttlMs: 10000 });
  let running = 0;
  let maxRunning = 0;
  const task = (key) => locks.withLock(key, async () => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise(r => setTimeout(r, 30));
    running--;
  }, { ownerId: key });
  await Promise.all([task('k1'), task('k2'), task('k3')]);
  assert.equal(maxRunning, 3, 'independent locks must run concurrently');
});

test('withLock always releases, even when fn throws', async () => {
  const locks = new LockManager(new MemoryStore(), {});
  await assert.rejects(
    locks.withLock('errkey', () => { throw new Error('boom'); }, { ownerId: 'w' })
  );
  const t = locks.acquire('errkey', { ownerId: 'w2' });
  assert.ok(t, 'lock must be free after fn failure');
});
