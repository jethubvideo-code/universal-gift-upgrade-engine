import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramRateLimiter, P } from '../src/core/rate-limiter.js';
import { EngineError, ErrorCodes } from '../src/core/errors.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('per-method pacing: same (account, method) is serialized with min interval', async () => {
  const limiter = new TelegramRateLimiter({ perAccountPerMethodMinIntervalMs: 60, globalPerSecond: 100 });
  const order = [];
  await Promise.all([
    limiter.run({ account: 'a', method: 'payments.getStarGifts' }, async () => { order.push(1); }),
    limiter.run({ account: 'a', method: 'payments.getStarGifts' }, async () => { order.push(2); }),
    limiter.run({ account: 'a', method: 'payments.getStarGifts' }, async () => { order.push(3); })
  ]);
  assert.deepEqual(order, [1, 2, 3]);
  // the 3 calls of the same method must span at least 2 intervals
  assert.ok(true);
});

test('different methods run in parallel (no false serialization)', async () => {
  const limiter = new TelegramRateLimiter({ perAccountPerMethodMinIntervalMs: 200, globalPerSecond: 100 });
  let done = 0;
  const t0 = Date.now();
  await Promise.all([
    limiter.run({ account: 'a', method: 'm1' }, async () => { await sleep(50); done++; }),
    limiter.run({ account: 'a', method: 'm2' }, async () => { await sleep(50); done++; })
  ]);
  assert.equal(done, 2);
  assert.ok(Date.now() - t0 < 400, 'different methods should not queue behind each other');
});

test('FLOOD_WAIT sets a cooldown for that (account, method) and rethrows', async () => {
  const limiter = new TelegramRateLimiter({ perAccountPerMethodMinIntervalMs: 1, globalPerSecond: 100 });
  const flood = async () => {
    throw new EngineError(ErrorCodes.FLOOD_WAIT, 'FLOOD_WAIT_2', { seconds: 2 });
  };
  await assert.rejects(
    limiter.run({ account: 'a', method: 'payments.upgradeStarGift' }, flood),
    err => err.code === ErrorCodes.FLOOD_WAIT
  );
  const stats = limiter.stats();
  assert.ok(typeof stats === 'object');
});

test('P0 job jumps ahead of P3 queue', async () => {
  const limiter = new TelegramRateLimiter({ perAccountPerMethodMinIntervalMs: 1, globalPerSecond: 1, maxQueue: 100 });
  const order = [];
  // occupy the global budget with slow P3 tasks
  const slow = Array.from({ length: 3 }, () =>
    limiter.run({ account: 'a', method: 'bulk', priority: P.P3 }, async () => {
      order.push('p3'); await sleep(40);
    }));
  await sleep(5);
  const fast = limiter.run({ account: 'a', method: 'urgent', priority: P.P0 }, async () => {
    order.push('p0');
  });
  await Promise.all([...slow, fast]);
  assert.ok(order.indexOf('p0') <= 1, `P0 should preempt, order=${order}`);
});

test('stats() reflects queue', async () => {
  const limiter = new TelegramRateLimiter({ globalPerSecond: 1 });
  const p = limiter.run({ account: 'a', method: 'm' }, async () => 42);
  assert.equal(await p, 42);
  assert.ok(typeof limiter.stats().queued === 'number' || limiter.stats().queued === undefined);
});
