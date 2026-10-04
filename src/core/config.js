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
    GIFTTRACKER_DATA_URL: env.GIFTTRACKER_DATA_URL || '',
    // 'botapi' (Variant B, owner decision 0.4) or 'mtproto' (Variant A,
    // required by the Speed Mode pivot — see docs/DECISIONS.md 0.9).
    // Default stays 'botapi' so the existing GitHub Actions cycle keeps
    // working untouched; the new persistent worker sets TRANSPORT=mtproto
    // explicitly (SETUP.md).
    TRANSPORT: env.TRANSPORT === 'mtproto' ? 'mtproto' : 'botapi',
    BUSINESS_CONNECTION_ID: env.BUSINESS_CONNECTION_ID || '',
    // Section 6 (speed-mode-prompt.pdf): test (simulator) / dry-run (real
    // reads, upgrade never actually sent) / live (real Stars spent).
    // Defaults to the SAFEST option. Only 'live' spends real Stars, and it
    // is never set by this engine — the Mini App (owner only) is the one
    // place that is allowed to request it (Phase C; not implemented yet).
    MODE: ['test', 'dry-run', 'live'].includes(env.MODE) ? env.MODE : (testMode ? 'test' : 'dry-run')
  };

  if (!testMode) {
    // BOT_TOKEN is intentionally NOT hard-required: without it the engine
    // degrades to MONITORING-ONLY mode (collections sync, counters, hot
    // detection; notifications are stored, not sent; upgrades impossible
    // until a bot is linked). The dedicated bot entry (bot/bot.js) still
    // refuses to run without a token.
    if (config.TRANSPORT === 'botapi' && !config.BOT_TOKEN) {
      config.MONITORING_ONLY = true;
    }
    if (config.TRANSPORT === 'mtproto') {
      const required = ['BOT_TOKEN', 'TG_API_ID', 'TG_API_HASH', 'SESSION_ENCRYPTION_KEY'];
      for (const key of required) {
        if (!config[key]) {
          throw new EngineError(ErrorCodes.CONFIG_ERROR, `Missing required configuration field: ${key} (TRANSPORT=mtproto)`);
        }
      }
    }
    // botapi needs no MTProto credentials: the bot token IS the credential.
  }

  return Object.freeze(config);
}
