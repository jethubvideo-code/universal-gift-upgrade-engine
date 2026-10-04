/**
 * @file src/core/config.js
 * Parses, validates, and freezes configuration settings.
 */

import { EngineError, ErrorCodes } from './errors.js';

/**
 * Load, validate, and freeze configuration settings from env.
 * @param {Object} [env=process.env]
 * @returns {Readonly<Object>} Frozen config object
 */
export function loadConfig(env = process.env) {
  const testMode = env.TEST_MODE === 'true';

  const config = {
    BOT_TOKEN: env.BOT_TOKEN || '',
    TG_API_ID: env.TG_API_ID ? parseInt(env.TG_API_ID, 10) : null,
    TG_API_HASH: env.TG_API_HASH || '',
    SESSION_ENCRYPTION_KEY: env.SESSION_ENCRYPTION_KEY || '',
    DB_BACKEND: env.DB_BACKEND || 'sqlite',
    DB_DIR: env.DB_DIR || 'data/state',
    DB_PATH: env.DB_PATH || './engine.db',
    TEST_MODE: testMode,
    PORT: env.PORT ? parseInt(env.PORT, 10) : 8080,
    MINIAPP_URL: env.MINIAPP_URL || '',
    POLL_CONCURRENCY: env.POLL_CONCURRENCY ? parseInt(env.POLL_CONCURRENCY, 10) : 8,
    CACHE_TTL_MS: env.CACHE_TTL_MS ? parseInt(env.CACHE_TTL_MS, 10) : 60000,
    WORKER_TICK_MS: env.WORKER_TICK_MS ? parseInt(env.WORKER_TICK_MS, 10) : 250,
    COLLECTION_SOURCE: env.COLLECTION_SOURCE || 'mtproto',
    GIFTTRACKER_DATA_URL: env.GIFTTRACKER_DATA_URL || ''
  };

  if (!testMode) {
    const required = ['BOT_TOKEN', 'TG_API_ID', 'TG_API_HASH', 'SESSION_ENCRYPTION_KEY'];
    for (const key of required) {
      if (!config[key]) {
        throw new EngineError(
          ErrorCodes.CONFIG_ERROR,
          `Missing required configuration field: ${key}`
        );
      }
    }
  }

  return Object.freeze(config);
}
