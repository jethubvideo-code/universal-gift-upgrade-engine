/**
 * @file src/core/locks.js
 * Distributed lock manager backed by store.tx and locks table.
 */

import crypto from 'node:crypto';
import { EngineError, ErrorCodes } from './errors.js';

export class LockManager {
  /**
   * @param {Object} store - Storage implementation
   * @param {Object} [options={}]
   * @param {number} [options.ttlMs=30000] - Lock expiration TTL in ms
   */
  constructor(store, { ttlMs = 30000 } = {}) {
    this.store = store;
    this.ttlMs = ttlMs;
  }

  /**
   * Attempt to acquire lock atomically inside store.tx.
   * @param {string} key - Lock key
   * @param {Object} [options={}]
   * @param {string} [options.ownerId] - Optional lock owner identifier
   * @returns {string|null} Lock token if acquired, null if busy
   */
  acquire(key, { ownerId } = {}) {
    return this.store.tx(() => {
      const now = new Date();
      const nowIso = now.toISOString();
      const existing = this.store.get('locks', key);

      if (existing) {
        const expiresAtMs = new Date(existing.expires_at).getTime();
        if (expiresAtMs > now.getTime()) {
          return null; // Active lock held by another process
        }
      }

      const token = ownerId ? `${ownerId}:${crypto.randomUUID()}` : crypto.randomUUID();
      const expiresAt = new Date(now.getTime() + this.ttlMs).toISOString();

      if (existing) {
        this.store.update('locks', key, {
          owner_token: token,
          expires_at: expiresAt,
          created_at: nowIso
        });
      } else {
        this.store.insert('locks', {
          key,
          owner_token: token,
          expires_at: expiresAt,
          created_at: nowIso
        });
      }

      return token;
    });
  }

  /**
   * Release a held lock if token matches.
   * @param {string} key - Lock key
   * @param {string} token - Lock token
   * @returns {boolean} True if lock released
   */
  release(key, token) {
    if (!token) return false;
    return this.store.tx(() => {
      const existing = this.store.get('locks', key);
      if (existing && existing.owner_token === token) {
        this.store.remove('locks', key);
        return true;
      }
      return false;
    });
  }

  /**
   * Execute fn within lock scope, releasing on finish.
   * @param {string} key - Lock key
   * @param {Function} fn - Async or sync function
   * @param {Object} [options={}]
   * @param {string} [options.ownerId] - Owner identifier
   * @returns {Promise<*>} Result of fn
   */
  async withLock(key, fn, { ownerId } = {}) {
    const token = this.acquire(key, { ownerId });
    if (!token) {
      throw new EngineError(ErrorCodes.LOCK_BUSY, `Lock busy for key: ${key}`);
    }
    try {
      return await fn();
    } finally {
      this.release(key, token);
    }
  }
}
