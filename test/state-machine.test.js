import test from 'node:test';
import assert from 'node:assert/strict';
import { TargetStates, canTransition, transition } from '../src/core/state-machine.js';
import { EngineError } from '../src/core/errors.js';

test('all 13 states are defined', () => {
  const expected = ['WATCHING', 'PREDICTED', 'HOT_TARGET', 'VERIFYING', 'UPGRADE_READY',
    'PAYMENT_REQUIRED', 'UPGRADING', 'CONFIRMING', 'COMPLETED', 'FAILED',
    'PRICE_LIMIT_EXCEEDED', 'UNAVAILABLE', 'LOCKED'];
  for (const s of expected) {
    assert.equal(TargetStates[s], s, `state ${s} missing`);
  }
});

test('happy path transitions are allowed', () => {
  const path = ['WATCHING', 'PREDICTED', 'HOT_TARGET', 'VERIFYING', 'UPGRADE_READY',
    'UPGRADING', 'CONFIRMING', 'COMPLETED'];
  for (let i = 0; i < path.length - 1; i++) {
    assert.equal(canTransition(path[i], path[i + 1]), true, `${path[i]} -> ${path[i + 1]}`);
  }
});

test('temporary-error retry path: UPGRADING -> WATCHING is allowed', () => {
  assert.equal(canTransition('UPGRADING', 'WATCHING'), true);
  assert.equal(canTransition('CONFIRMING', 'WATCHING'), false);
  assert.equal(canTransition('COMPLETED', 'WATCHING'), false);
});

test('invalid transitions are rejected', () => {
  assert.equal(canTransition('WATCHING', 'COMPLETED'), false);
  assert.equal(canTransition('COMPLETED', 'WATCHING'), false);
  assert.equal(canTransition('WATCHING', 'UPGRADING'), false);
});

test('price limit and unavailable paths exist', () => {
  assert.equal(canTransition('VERIFYING', 'PRICE_LIMIT_EXCEEDED'), true);
  assert.equal(canTransition('UNAVAILABLE', 'WATCHING'), true);
  assert.equal(canTransition('FAILED', 'WATCHING'), true);
});

test('transition() produces new row + event, validates', () => {
  const row = { id: 't1', status: 'WATCHING', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  const { row: next, event } = transition(row, TargetStates.PREDICTED, { reason: 'near' });
  assert.equal(next.status, 'PREDICTED');
  assert.equal(event.from_status, 'WATCHING');
  assert.equal(event.to_status, 'PREDICTED');
  assert.equal(event.target_id, 't1');
  assert.ok(event.id);
  assert.ok(event.created_at);
  assert.throws(() => transition(row, 'UPGRADING'), EngineError);
  // original row untouched (atomicity of the copy)
  assert.equal(row.status, 'WATCHING');
});

test('COMPLETED sets completed_at', () => {
  const row = { id: 't2', status: 'CONFIRMING', created_at: 'x', updated_at: 'y' };
  const { row: next } = transition(row, 'COMPLETED', {});
  assert.ok(next.completed_at);
});
