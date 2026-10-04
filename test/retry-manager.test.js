import test from 'node:test';
import assert from 'node:assert/strict';
import { RetryManager, classifyError } from '../src/core/retry-manager.js';
import { EngineError, ErrorCodes } from '../src/core/errors.js';

test('classifyError: temporary vs permanent', () => {
  assert.equal(classifyError(new EngineError(ErrorCodes.FLOOD_WAIT, 'x')).kind, 'temporary');
  assert.equal(classifyError(new EngineError(ErrorCodes.RATE_LIMIT, 'x')).kind, 'temporary');
  assert.equal(classifyError(new EngineError(ErrorCodes.TIMEOUT, 'x')).kind, 'temporary');
  assert.equal(classifyError(new EngineError(ErrorCodes.NETWORK_ERROR, 'x')).kind, 'temporary');
  assert.equal(classifyError(new EngineError(ErrorCodes.LOCK_BUSY, 'x')).kind, 'temporary');
  assert.equal(classifyError(new EngineError(ErrorCodes.ALREADY_UPGRADED, 'x')).kind, 'permanent');
  assert.equal(classifyError(new EngineError(ErrorCodes.INVALID_SAVED_GIFT, 'x')).kind, 'permanent');
  assert.equal(classifyError(new EngineError(ErrorCodes.AUTH_ERROR, 'x')).kind, 'permanent');
  assert.equal(classifyError(new EngineError(ErrorCodes.PRICE_LIMIT_EXCEEDED, 'x')).kind, 'permanent');
  assert.equal(classifyError(new EngineError(ErrorCodes.UPGRADE_UNAVAILABLE, 'x')).kind, 'permanent');
});

test('temporary error is retried and succeeds', async () => {
  const rm = new RetryManager({ maxRetries: 5, baseMs: 1, maxMs: 10 });
  let calls = 0;
  const res = await rm.run(async () => {
    calls++;
    if (calls < 3) throw new EngineError(ErrorCodes.TIMEOUT, 'flaky');
    return 'ok';
  }, { label: 't' });
  assert.equal(res, 'ok');
  assert.equal(calls, 3);
});

test('permanent error throws immediately, no retry', async () => {
  const rm = new RetryManager({ maxRetries: 5, baseMs: 1 });
  let calls = 0;
  await assert.rejects(
    rm.run(async () => {
      calls++;
      throw new EngineError(ErrorCodes.ALREADY_UPGRADED, 'nope');
    }),
    err => err.code === ErrorCodes.ALREADY_UPGRADED
  );
  assert.equal(calls, 1);
});

test('max retries exceeded -> throws last error (no infinite loop)', async () => {
  const rm = new RetryManager({ maxRetries: 3, baseMs: 1, maxMs: 2 });
  let calls = 0;
  await assert.rejects(
    rm.run(async () => {
      calls++;
      throw new EngineError(ErrorCodes.NETWORK_ERROR, 'down');
    }),
    err => err.code === ErrorCodes.NETWORK_ERROR
  );
  assert.equal(calls, 4); // initial call + 3 retries
});

test('onRetry hook fires with attempt info', async () => {
  const rm = new RetryManager({ maxRetries: 4, baseMs: 1, maxMs: 2 });
  const attempts = [];
  let calls = 0;
  await rm.run(async () => {
    calls++;
    if (calls < 3) throw new EngineError(ErrorCodes.RATE_LIMIT, 'r');
  }, { onRetry: (info) => attempts.push(info) });
  assert.equal(attempts.length, 2);
});
