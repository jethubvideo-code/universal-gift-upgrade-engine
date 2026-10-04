/**
 * Applies targets queued from the Mini App (Base44 bridge) to the engine store.
 *
 * Runs after each bot poll cycle (GitHub Actions, every 5 min):
 *  1. GET claim  — bridge atomically flips PENDING -> CLAIMED and returns them
 *  2. for each:  TargetManager.create() (universal: ANY collection, ANY number,
 *     max_stars price limit), idempotent per bridge row
 *  3. POST resolve — APPLIED (with target_key) or FAILED (with error)
 *
 * The claim/resolve protocol guarantees at-least-once with no double-apply:
 * a row stays CLAIMED if this runner dies mid-flight and is re-claimed on the
 * next cycle, while resolve marks the final outcome exactly once.
 *
 * Env: QUEUE_URL, ENGINE_SYNC_TOKEN
 * Exit 0 on bridge outage — never fail the poll cycle because of the bridge.
 */
import { createStore } from '../src/db.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { TargetManager } from '../src/engine/target-manager.js';

const logger = createLogger('apply');

async function main() {
  const url = process.env.QUEUE_URL;
  const token = process.env.ENGINE_SYNC_TOKEN;
  if (!url || !token) {
    logger.warn('QUEUE_URL / ENGINE_SYNC_TOKEN not set — pending targets not fetched');
    return;
  }

  // 1. claim
  const claimRes = await fetch(url, { headers: { 'x-engine-token': token } });
  if (!claimRes.ok) throw new Error(`claim responded ${claimRes.status}`);
  const { pending } = await claimRes.json();
  if (!pending || pending.length === 0) return;
  logger.info('Claimed pending targets', { count: pending.length });

  const config = loadConfig();
  const store = createStore(config);
  const targets = new TargetManager(store);

  // 2. apply
  const results = [];
  for (const row of pending) {
    try {
      // idempotency: if a target with this key already exists, treat as applied
      const dupe = store.find('targets', { user_id: String(row.user_id), collection_id: String(row.collection_id), target_number: Number(row.target_number) })
        .find(t => ['WATCHING', 'PREDICTED', 'HOT_TARGET', 'UPGRADING'].includes(t.status));
      if (dupe) {
        results.push({ id: row.id, status: 'APPLIED', target_key: dupe.id });
        continue;
      }
      const created = targets.create({
        user_id: String(row.user_id),
        collection_id: String(row.collection_id),
        gift_id: String(row.collection_id), // slug-keyed gifts; engine resolves via collection
        target_number: Number(row.target_number),
        max_upgrade_stars: row.max_stars != null ? Number(row.max_stars) : null
      });
      if (store.flushAll) store.flushAll();
      results.push({ id: row.id, status: 'APPLIED', target_key: created.id });
      logger.info('Target applied', { collection: row.collection_id, number: row.target_number });
    } catch (err) {
      results.push({ id: row.id, status: 'FAILED', error: String(err.message || err) });
      logger.warn('Target failed', { id: row.id, error: err.message });
    }
  }

  // 3. resolve
  const resolveRes = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-engine-token': token },
    body: JSON.stringify({ results })
  });
  if (!resolveRes.ok) throw new Error(`resolve responded ${resolveRes.status}`);
  const done = await resolveRes.json();
  logger.info('Queue resolved', { applied: done.applied, failed: done.failed });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('Apply-pending failed', { error: err.message });
    process.exit(0); // CLAIMED rows are re-claimed next cycle; never break the poll
  });
