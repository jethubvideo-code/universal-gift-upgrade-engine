/**
 * Builds the static GitHub Pages site from the engine state — ZERO external
 * services. Everything lives in this repository:
 *
 *   docs/index.html             — copy of engine-miniapp/index.html
 *   docs/state.json              — public read model: engine meta + ALL collections
 *                                  (counters only, NO user data)
 *   docs/targets/<sha256>.json   — per-user active targets, filename is the
 *                                  SHA-256 of the Telegram user id. The Mini App
 *                                  computes the same hash in-browser from initData
 *                                  and fetches only its own file.
 *
 * Runs after every engine cycle AND every bot poll (targets are created by both
 * the deep link handler and the /add command).
 *
 * Env: DB_BACKEND (file). Requires no tokens — pure local transformation.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { createStore } from '../src/db.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';

const logger = createLogger('site');
const ACTIVE = new Set(['WATCHING', 'PREDICTED', 'HOT_TARGET', 'UPGRADING']);

function writeJson(path, data) {
  writeFileSync(path, JSON.stringify(data));
}

async function main() {
  const config = loadConfig();
  const store = createStore(config);

  // ---- public collections read model (no user data) ----
  const gifts = store.findAll('gifts');
  const collections = gifts.map(g => {
    const total = Number(g.total_supply || 0);
    const issued = Number(g.upgraded_count || 0);
    return {
      collection_id: g.collection_id,
      title: g.name || g.collection_id,
      total,
      issued,
      next: issued < total ? issued + 1 : null
    };
  }).sort((a, b) => (a.title || '').localeCompare(b.title || ''));

  const titles = new Map(gifts.map(g => [g.collection_id, g.name || g.collection_id]));
  const connections = store.findAll('business_connections');
  const engine = {
    transport: config.TRANSPORT || 'botapi',
    monitoring_only: !!config.MONITORING_ONLY,
    business_linked: connections.some(c => c.user_id || c.id),
    collections: collections.length,
    active_targets: store.findAll('targets').filter(t => ACTIVE.has(t.status)).length,
    generated_at: new Date().toISOString()
  };

  // ---- per-user targets, hashed filenames ----
  const byUser = new Map();
  for (const t of store.findAll('targets')) {
    if (!ACTIVE.has(t.status)) continue;
    if (!t.user_id) continue;
    if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
    byUser.get(t.user_id).push({
      collection_id: t.collection_id,
      title: titles.get(t.collection_id) || t.collection_id,
      target_number: t.target_number,
      max_stars: t.max_upgrade_stars ?? null,
      auto_upgrade: !!t.auto_upgrade,
      status: t.status,
      updated_at: t.updated_at || t.created_at
    });
  }

  // ---- write docs/ atomically-ish: rebuild targets dir, overwrite files ----
  mkdirSync('docs/targets', { recursive: true });
  for (const f of readdirSync('docs/targets')) {
    if (f.endsWith('.json')) rmSync(`docs/targets/${f}`);
  }
  for (const [user, rows] of byUser) {
    const h = createHash('sha256').update(String(user)).digest('hex');
    writeJson(`docs/targets/${h}.json`, { targets: rows });
  }
  writeJson('docs/state.json', { engine, collections, updated_at: new Date().toISOString() });
  try {
    cpSync('engine-miniapp/index.html', 'docs/index.html');
  } catch (e) {
    logger.warn('engine-miniapp/index.html missing — kept previous docs/index.html');
  }
  logger.info('Site built', { collections: collections.length, users: byUser.size });
}

main()
  .then(() => process.exit(0))
  .catch((err) => { logger.error('Site build failed', { error: err.message }); process.exit(1); });
