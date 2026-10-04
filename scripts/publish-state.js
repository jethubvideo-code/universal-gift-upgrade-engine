/**
 * Publishes the engine state snapshot to the Base44 bridge (Mini App read model).
 *
 * Runs after each engine cycle (GitHub Actions). Reads the file store and POSTs:
 *  - collections: [{collection_id, title, total, issued, next}] for ALL discovered
 *    collections (counters come from the gifts table which the gifttracker sync
 *    keeps fresh for every collection, tracked or not)
 *  - targets: ALL active targets (server-side only; the public endpoint strips
 *    user data, the per-user endpoint filters by verified Telegram initData)
 *  - engine: meta (transport, monitoring mode, business link status)
 *
 * Env: STATE_PUBLISH_URL, ENGINE_SYNC_TOKEN
 * Exit 0 even on bridge failure — publishing must never break the engine cycle.
 */
import { createStore } from '../src/db.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';

const logger = createLogger('publish');

async function main() {
  const config = loadConfig();
  const store = createStore(config);

  const gifts = store.findAll('gifts');
  const collections = gifts.map(g => {
    const total = Number(g.total_supply || 0);
    const issued = Number(g.upgraded_count || 0);
    return {
      collection_id: g.collection_id,
      title: g.name || g.collection_id,
      total,
      issued,
      next: issued < total ? issued + 1 : null,
      updated_at: g.updated_at || null
    };
  }).sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  const activeStatuses = new Set(['WATCHING', 'PREDICTED', 'HOT_TARGET', 'UPGRADING']);
  const targets = store.findAll('targets')
    .filter(t => activeStatuses.has(t.status))
    .map(t => ({
      key: t.id, user_id: t.user_id, collection_id: t.collection_id,
      target_number: t.target_number, max_stars: t.max_upgrade_stars,
      auto_upgrade: !!t.auto_upgrade, status: t.status, created_at: t.created_at
    }));

  const connections = store.findAll('business_connections');
  const engine = {
    transport: config.TRANSPORT || 'botapi',
    monitoring_only: !!config.MONITORING_ONLY,
    business_linked: connections.some(c => c.user_id || c.id),
    business_connections: connections.length,
    collections: collections.length,
    active_targets: targets.length,
    published_at: new Date().toISOString()
  };

  const snapshot = { engine, collections, targets };

  const url = process.env.STATE_PUBLISH_URL;
  const token = process.env.ENGINE_SYNC_TOKEN;
  if (!url || !token) {
    logger.warn('STATE_PUBLISH_URL / ENGINE_SYNC_TOKEN not set — snapshot not published');
    return;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-engine-token': token },
    body: JSON.stringify({ snapshot })
  });
  if (!res.ok) throw new Error(`bridge responded ${res.status}`);
  const body = await res.json();
  logger.info('State published', { collections: body.collections, targets: targets.length });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Publish failed', { error: err.message });
    process.exit(0); // never fail the engine cycle because of the bridge
  });
