/**
 * @file src/core/state-machine.js
 * Target state machine definition and transition logic.
 */

import crypto from 'node:crypto';
import { EngineError, ErrorCodes } from './errors.js';

export const TargetStates = Object.freeze({
  WATCHING: 'WATCHING',
  PREDICTED: 'PREDICTED',
  HOT_TARGET: 'HOT_TARGET',
  VERIFYING: 'VERIFYING',
  UPGRADE_READY: 'UPGRADE_READY',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  UPGRADING: 'UPGRADING',
  CONFIRMING: 'CONFIRMING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  PRICE_LIMIT_EXCEEDED: 'PRICE_LIMIT_EXCEEDED',
  UNAVAILABLE: 'UNAVAILABLE',
  LOCKED: 'LOCKED'
});

export const TargetTransitions = Object.freeze({
  [TargetStates.WATCHING]: new Set([
    TargetStates.PREDICTED,
    TargetStates.HOT_TARGET,
    TargetStates.UNAVAILABLE,
    TargetStates.FAILED,
    TargetStates.LOCKED
  ]),
  [TargetStates.PREDICTED]: new Set([
    TargetStates.HOT_TARGET,
    TargetStates.WATCHING,
    TargetStates.UNAVAILABLE,
    TargetStates.FAILED
  ]),
  [TargetStates.HOT_TARGET]: new Set([
    TargetStates.VERIFYING,
    TargetStates.WATCHING,
    TargetStates.PREDICTED,
    TargetStates.UNAVAILABLE,
    TargetStates.FAILED
  ]),
  [TargetStates.VERIFYING]: new Set([
    TargetStates.UPGRADE_READY,
    TargetStates.WATCHING,
    TargetStates.PAYMENT_REQUIRED,
    TargetStates.UNAVAILABLE,
    TargetStates.FAILED,
    TargetStates.PRICE_LIMIT_EXCEEDED
  ]),
  [TargetStates.UPGRADE_READY]: new Set([
    TargetStates.UPGRADING,
    TargetStates.PAYMENT_REQUIRED,
    TargetStates.WATCHING,
    TargetStates.FAILED,
    TargetStates.PRICE_LIMIT_EXCEEDED,
    TargetStates.UNAVAILABLE
  ]),
  [TargetStates.PAYMENT_REQUIRED]: new Set([
    TargetStates.UPGRADING,
    TargetStates.UPGRADE_READY,
    TargetStates.FAILED,
    TargetStates.PRICE_LIMIT_EXCEEDED
  ]),
  [TargetStates.UPGRADING]: new Set([
    TargetStates.CONFIRMING,
    TargetStates.FAILED,
    TargetStates.UPGRADE_READY,
    // temporary error (FLOOD_WAIT / network) -> back to monitoring for retry
    TargetStates.WATCHING
  ]),
  [TargetStates.CONFIRMING]: new Set([
    TargetStates.COMPLETED,
    TargetStates.FAILED
  ]),
  [TargetStates.PRICE_LIMIT_EXCEEDED]: new Set([
    TargetStates.WATCHING,
    TargetStates.FAILED
  ]),
  [TargetStates.UNAVAILABLE]: new Set([
    TargetStates.WATCHING,
    TargetStates.FAILED
  ]),
  [TargetStates.LOCKED]: new Set([
    TargetStates.WATCHING,
    TargetStates.FAILED
  ]),
  [TargetStates.COMPLETED]: new Set([]),
  [TargetStates.FAILED]: new Set([
    TargetStates.WATCHING
  ])
});

/**
 * Check if state transition is allowed.
 * @param {string} from - Current status
 * @param {string} to - Target status
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const allowed = TargetTransitions[from];
  return Boolean(allowed && allowed.has(to));
}

/**
 * Perform target state transition.
 * @param {Object} row - Current target row
 * @param {string} to - Target state
 * @param {Object} [meta={}] - { reason, details }
 * @returns {{ row: Object, event: Object }}
 */
export function transition(row, to, { reason = '', details = {} } = {}) {
  if (!canTransition(row.status, to)) {
    throw new EngineError(
      ErrorCodes.VERIFICATION_FAILED,
      `Invalid target state transition from ${row.status} to ${to}`
    );
  }

  const now = new Date().toISOString();
  const newRow = {
    ...row,
    status: to,
    updated_at: now,
    ...(to === TargetStates.COMPLETED ? { completed_at: now } : {})
  };

  const event = {
    id: crypto.randomUUID(),
    target_id: row.id,
    from_status: row.status,
    to_status: to,
    reason: reason || null,
    details_json: JSON.stringify(details || {}),
    created_at: now
  };

  return { row: newRow, event };
}
