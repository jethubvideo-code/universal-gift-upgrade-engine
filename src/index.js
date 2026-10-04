/**
 * Composition root — Universal Gift Upgrade Engine.
 *
 * Modes:
 *  - node src/index.js          → persistent worker + HTTP API (self-hosted server mode)
 *  - node src/index.js --once   → GITHUB ACTIONS MODE: one full monitoring cycle,
 *                                 state persisted to the repo (FileStore), then exit.
 *                                 The scheduled workflow commits data/state back.
 *  - TEST_MODE=true             → simulator-friendly, no real Telegram calls.
 *
 * RESTART RECOVERY (both modes): active targets re-indexed, hot targets
 * re-evaluated, pending upgrade_jobs resumed, collection_state cache reloaded,
 * expired locks purged.
 */
import crypto from 'node:crypto';
import { createStore } from './db.js';
import { loadConfig } from './core/config.js';
import { createLogger } from './core/logger.js';
import { Metrics } from './core/metrics.js';
import { TelegramRateLimiter } from './core/rate-limiter.js';
import { RetryManager } from './core/retry-manager.js';
import { LockManager } from './core/locks.js';
import { TargetManager } from './engine/target-manager.js';
import { TargetIndex } from './engine/target-index.js';
import { TargetScheduler } from './engine/target-scheduler.js';
import { CollectionStateCache } from './engine/collection-state.js';
import { CollectionMonitor } from './engine/collection-monitor.js';
import { HotTargetEngine } from './engine/hot-target-engine.js';
import { MtprotoClient } from './telegram/mtproto-client.js';
import { BotApiClient, BotApiBusinessBackend, BusinessConnectionManager } from './telegram/botapi-business.js';
import { TelegramGiftsClient } from './telegram/telegram-gifts.js';
import { SavedGiftsClient } from './telegram/saved-gifts.js';
import { PaymentExecutor } from './telegram/payment-executor.js';
import { UpgradeExecutor } from './telegram/upgrade-executor.js';
import { UserSessionManager } from './telegram/user-sessions.js';
import { Notifier } from './services/notifications.js';
import { TargetStates } from './core/state-machine.js';

export async function createEngine({ config = loadConfig(), store = null, transport = null } = {}) {
  const logger = createLogger('engine');
  const metrics = new Metrics();
  const limiter = new TelegramRateLimiter({});
  const retry = new RetryManager({});
  const locks = new LockManager(store, {});

  store = store || createStore(config);

  const targets = new TargetManager(store);
  const index = new TargetIndex();
  const scheduler = new TargetScheduler({ concurrency: config.POLL_CONCURRENCY || 8 });
  const cache = new CollectionStateCache({ ttlMs: config.CACHE_TTL_MS || 60000 });

  // Restart recovery 1/3: rebuild the in-memory index from persisted targets.
  index.replaceAll(targets.listActive());
  // Restart recovery 2/3: reload collection state cache.
  cache.load(store);
  // Restart recovery 3/3: purge expired locks left by a crashed run.
  const nowIso = new Date().toISOString();
  for (const lock of store.findAll('locks')) {
    if (lock.expires_at < nowIso) store.remove('locks', lock.id);
  }

  // Telegram transport — Variant B (Bot API Business, owner decision 0.4)
  // or Variant A (user MTProto session). Both normalize to the same
  // engine-facing interfaces below.
  let mtproto = null;
  let sessions = null;
  let backend = null; // BotApiBusinessBackend when TRANSPORT=botapi
  const useBotApi = !transport && config.TRANSPORT === 'botapi';
  if (useBotApi) {
    try {
      const botApi = new BotApiClient({ botToken: config.BOT_TOKEN, fetchImpl: globalThis.fetch?.bind(globalThis) });
      backend = new BotApiBusinessBackend({ client: botApi, limiter, logger });
      sessions = new BusinessConnectionManager({ store });
      if (config.BUSINESS_CONNECTION_ID) {
        logger.info('Bot API Business transport active (env BUSINESS_CONNECTION_ID set)');
      } else {
        logger.info('Bot API Business transport active (connections arrive via the business_connection bot update)');
      }
    } catch (err) {
      logger.warn('Bot API business backend unavailable — engine runs in monitoring-only mode', { error: err.message });
      backend = null;
    }
  } else if (transport || (config.TG_API_ID && config.TG_API_HASH && config.SESSION_ENCRYPTION_KEY)) {
    try {
      sessions = new UserSessionManager({ store, encryptionKey: config.SESSION_ENCRYPTION_KEY });
      mtproto = new MtprotoClient({ transport, apiId: config.TG_API_ID, apiHash: config.TG_API_HASH });
      await mtproto.connect();
      logger.info('MTProto connected');
    } catch (err) {
      logger.warn('MTProto unavailable — engine runs in monitoring-only mode', { error: err.message });
      mtproto = null;
    }
  }

  const gifts = new TelegramGiftsClient({
    client: mtproto,
    limiter,
    store,
    source: config.COLLECTION_SOURCE || 'mtproto',
    gifttrackerUrl: config.GIFTTRACKER_DATA_URL
  });

  const savedGifts = backend || new SavedGiftsClient({ client: mtproto, limiter });
  const payments = backend || new PaymentExecutor({ client: mtproto, limiter, retry, metrics, logger });
  const executor = new UpgradeExecutor({ savedGifts, payments, locks, limiter, retry, metrics, logger });
  const notifier = new Notifier({ botToken: config.BOT_TOKEN, store });

  const hot = new HotTargetEngine({
    store, targets, index, monitor: null, cache, sessions, savedGifts,
    executor, scheduler, locks, limiter, notifier, metrics, logger
  });

  const monitor = new CollectionMonitor({
    gifts, cache, scheduler,
    onUpdate: (state) => hot.onCollectionUpdate(state),
    logger, metrics
  });
  hot.monitor = monitor;

  // Dynamic discovery: sync all collections from the chosen source.
  let collections = [];
  try {
    collections = await gifts.sync(store);
    logger.info('Collections synced', { count: collections.length });
  } catch (err) {
    logger.warn('Collection sync failed (will retry next cycle)', { error: err.message });
  }

  // One shared poll per tracked collection (never per user).
  const tracked = new Set();
  for (const target of index.active()) {
    const cid = target.collection_id;
    if (!tracked.has(cid)) {
      tracked.add(cid);
      monitor.track(cid);
    }
  }
  metrics.gauge('collections_monitored', tracked.size);
  metrics.gauge('active_targets', index.stats().active);

  async function refreshAll() {
    for (const cid of tracked) {
      try {
        await monitor.refresh(cid);
      } catch (err) {
        logger.warn('Collection refresh failed', { collection: cid, error: err.message });
      }
    }
  }

  async function syncUsers() {
    // ensure users table holds chat ids for notifications
    for (const u of store.findAll('users')) void u;
  }

  return {
    config, store, logger, metrics, limiter, retry, locks,
    targets, index, scheduler, cache, monitor, hot, gifts,
    sessions, executor, notifier, collections,
    refreshAll, tracked,
    async stop() {
      scheduler.stopAll();
      if (mtproto) await mtproto.disconnect().catch(() => {});
      if (store.flushAll) store.flushAll();
      logger.info('Engine stopped');
    }
  };
}

/** GITHUB ACTIONS MODE: one full cycle, then flush state and exit. */
export async function runOnce(engine) {
  const { logger, metrics } = engine;
  const start = Date.now();
  // re-track collections for targets created since boot
  for (const target of engine.index.active()) {
    if (!engine.tracked.has(target.collection_id)) {
      engine.tracked.add(target.collection_id);
      engine.monitor.track(target.collection_id);
    }
  }
  await engine.refreshAll();
  // Resume pending upgrade jobs from previous runs (restart recovery).
  const pending = engine.store.find('upgrade_jobs', { status: 'QUEUED' });
  for (const job of pending) {
    const target = engine.targets.get(job.target_id);
    if (target && target.status !== TargetStates.COMPLETED) {
      await engine.hot.handleHot(target).catch(err =>
        logger.warn('Pending job resume failed', { job: job.id, error: err.message }));
    }
  }
  if (engine.store.flushAll) engine.store.flushAll();
  logger.info('Cycle complete', { ms: Date.now() - start, metrics: metrics.snapshot() });
  return metrics.snapshot();
}

export async function main() {
  const once = process.argv.includes('--once') || process.env.RUN_ONCE === '1';
  const config = loadConfig();
  const engine = await createEngine({ config });
  if (once) {
    await runOnce(engine);
    await engine.stop();
    return;
  }
  // Persistent server mode: scheduler polls run in the background.
  let http = null;
  try {
    const { createApi } = await import('../api/server.js');
    http = createApi(engine, config);
    http.listen(config.PORT || 8080, () =>
      engine.logger.info(`API listening on ${config.PORT || 8080}`));
  } catch (err) {
    engine.logger.warn('API server not started', { error: err.message });
  }
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    engine.logger.info(`Received ${sig}, shutting down`);
    if (http) http.close();
    await engine.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
