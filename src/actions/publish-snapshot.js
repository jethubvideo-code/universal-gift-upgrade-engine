/**
 * Publishes the public Mini App snapshot (docs/miniapp-data.json).
 *
 * GitHub-only mode: GitHub Pages serves the Mini App statically; this script
 * writes the public data it reads. Contains NO secrets, NO user identities.
 * Targets are published without user_id (set PUBLISH_TARGETS=false to disable
 * entirely) — per-user target management happens via the bot.
 */
import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { createStore } from '../db.js';
import { loadConfig } from '../core/config.js';
import { Metrics } from '../core/metrics.js';

const publishTargets = process.env.PUBLISH_TARGETS !== 'false';

function main() {
  const config = loadConfig();
  const store = createStore(config);

  const collections = store.findAll('gift_collections')
    .map(c => ({ collection_id: c.collection_id, title: c.title, slug: c.slug, total_supply: c.total_supply, upgraded_count: c.upgraded_count }))
    .slice(0, 500);

  const state = store.findAll('collection_state')
    .map(s => ({
      collection_id: s.collection_id, total_supply: s.total_supply,
      upgraded_count: s.upgraded_count, remaining: s.remaining,
      next_expected_number: s.next_expected_number, last_update: s.last_update
    }));

  const targets = publishTargets ? store.findAll('targets')
    .filter(t => !['COMPLETED', 'FAILED'].includes(t.status))
    .map(t => ({
      id: t.id, collection_id: t.collection_id,
      collection_title: (store.find('gift_collections', { collection_id: t.collection_id })[0] || {}).title || null,
      gift_id: t.gift_id, target_number: t.target_number,
      auto_upgrade: Boolean(t.auto_upgrade),
      max_upgrade_stars: t.max_upgrade_stars, status: t.status
    })) : [];

  const events = store.findAll('target_events').slice(-80)
    .map(e => ({ target_id: e.target_id, from_status: e.from_status, to_status: e.to_status, reason: e.reason, created_at: e.created_at }));

  const snapshot = {
    snapshot_at: new Date().toISOString(),
    collections_monitored: state.length,
    active_targets: targets.length,
    collections, state, targets, events,
    metrics: {
      upgrades_success: store.count('targets', { status: 'COMPLETED' }),
      upgrades_failed: store.count('targets', { status: 'FAILED' })
    }
  };

  const dir = process.env.SNAPSHOT_DIR || 'docs';
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, 'miniapp-data.json.tmp');
  const out = join(dir, 'miniapp-data.json');
  writeFileSync(tmp, JSON.stringify(snapshot));
  renameSync(tmp, out);
  console.log(`Snapshot published: ${out} (${collections.length} collections, ${targets.length} targets)`);
}

main();
