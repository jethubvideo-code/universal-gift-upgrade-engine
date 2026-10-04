/**
 * @file src/core/errors.js
 * Standard error types and error codes for Universal Gift Upgrade Engine.
 */

export const ErrorCodes = Object.freeze({
  FLOOD_WAIT: 'FLOOD_WAIT',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  NETWORK_ERROR: 'NETWORK_ERROR',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  UPGRADE_UNAVAILABLE: 'UPGRADE_UNAVAILABLE',
  ALREADY_UPGRADED: 'ALREADY_UPGRADED',
  INVALID_SAVED_GIFT: 'INVALID_SAVED_GIFT',
  SESSION_ERROR: 'SESSION_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  PRICE_LIMIT_EXCEEDED: 'PRICE_LIMIT_EXCEEDED',
  VERIFICATION_FAILED: 'VERIFICATION_FAILED',
  LOCK_BUSY: 'LOCK_BUSY',
  CONFIG_ERROR: 'CONFIG_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  STORAGE_ERROR: 'STORAGE_ERROR'
});

/**
 * Domain error class for all engine operations.
 */
export class EngineError extends Error {
  /**
   * @param {string} code - Error code from ErrorCodes
   * @param {string} message - Human-readable message
   * @param {Object} [extra={}] - Metadata (e.g., { seconds, retryable })
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.extra = extra || {};
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, EngineError);
    }
  }
}
