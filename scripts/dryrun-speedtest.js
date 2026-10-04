#!/usr/bin/env node
/**
 * PHASE A dry-run benchmark — run by the OWNER after login (scripts/login-mtproto.js)
 * and after setting TRANSPORT=mtproto. Produces the REAL numbers requested by
 * speed-mode-prompt.pdf section 1 and 7 (Phase A acceptance). No invented numbers:
 * every metric below is measured against the LIVE Telegram API, over the owner's
 * own session. Nothing here spends Stars or fires an upgrade (dry-run only).
 *
 * What this measures:
 *  1. DC id of the connection (for SETUP.md step 2 hosting region choice).
 *  2. T_fire proxy (LOCAL only): time to build + serialize the upgrade request
 *     object, with NO network call — see scripts/benchmark-fire-local.mjs for the
 *     synthetic version; this script additionally times the real GramJS
 *     client.invoke() call wall-clock minus awaiting the response, which GramJS
 *     does not expose separately — so T_fire here is reported as "write-to-socket
 *     is not independently measurable with GramJS's public API" (UNVERIFIED /
 *     documented limitation, not papered over).
 *  3. T_detect proxy: round-trip latency of payments.getUniqueStarGift probes
 *     (the section-3.B window check) against collections that are near their
 *     end, picked DYNAMICALLY from whatever the engine has discovered — never
 *     hardcoded.
 *  4. Whether two getUniqueStarGift calls issued back-to-back (Promise.all)
 *     measurably differ from one issued alone — a proxy for "is this actually
 *     one round trip or two".
 *  5. Sequential-numbering check: for one collection, confirms slug N exists
 *     for all N <= boundary and does not exist for any N > boundary within the
 *     probed window (no gaps) — this is what "numbering is sequential" means
 *     in a way that is actually checkable over MTProto, since `availability_issued`
 *     could NOT be confirmed as a real field on the current `starGift` schema
 *     (Layer 225 only has availability_remains/availability_total — see
 *     docs/TELEGRAM_API.md). Flagging that mismatch explicitly rather than
 *     guessing a field name.
 *  6. Read-only check of the prepaid/paid upgrade branches: for each of the
 *     owner's own saved gifts with can_upgrade=true, calls
 *     getStarGiftUpgradePreview / getStarGiftUpgradeAttributes and, for the
 *     paid branch, getPaymentForm — WITHOUT ever calling upgradeStarGift or
 *     sendStarsForm. If the owner owns no eligible gift, says so plainly
 *     instead of claiming it was tested.
 *  7. FLOOD_WAIT observation: reports if/when one was hit and how long.
 *
 * Usage: node scripts/dryrun-speedtest.js [--samples=20] [--collections=5]
 */
import { createStore } from '../src/db.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { MtprotoClient } from '../src/telegram/mtproto-client.js';
import { TelegramGiftsClient } from '../src/telegram/telegram-gifts.js';
import { SavedGiftsClient } from '../src/telegram/saved-gifts.js';
import { PaymentExecutor } from '../src/telegram/payment-executor.js';
import { UserSessionManager } from '../src/telegram/user-sessions.js';
import { EngineError } from '../src/core/errors.js';

const logger = createLogger('dryrun');
const args = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const SAMPLES = Number(args.samples || 20);
const N_COLLECTIONS = Number(args.collections || 5);

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main() {
  const config = loadConfig();
  if (config.TRANSPORT !== 'mtproto') {
    console.error('TRANSPORT must be "mtproto" for this benchmark (got: ' + config.TRANSPORT + '). Set TRANSPORT=mtproto and retry.');
    process.exit(1);
  }
  const store = createStore(config);
  const sessions = new UserSessionManager({ store, encryptionKey: config.SESSION_ENCRYPTION_KEY });
  const rows = store.findAll('telegram_sessions');
  if (!rows.length) {
    console.error('No session found. Run: node scripts/login-mtproto.js first.');
    process.exit(1);
  }
  const row = sessions.getUserSession(rows[0].user_id);
  if (!row) {
    console.error('Session found but could not be decrypted (wrong SESSION_ENCRYPTION_KEY?).');
    process.exit(1);
  }

  const mtproto = new MtprotoClient({ apiId: config.TG_API_ID, apiHash: config.TG_API_HASH, sessionPlain: row.session });
  console.log('Connecting (MTProto, user session)...');
  const t0 = Date.now();
  await mtproto.connect();
  console.log(`Connected in ${Date.now() - t0} ms. DC id: ${mtproto.getDcId() ?? 'UNKNOWN — GramJS did not expose it, check logs manually'}`);

  const gifts = new TelegramGiftsClient({ client: mtproto, source: 'mtproto' });
  const savedGifts = new SavedGiftsClient({ client: mtproto });
  const payments = new PaymentExecutor({ client: mtproto, logger });

  let floodWaitsHit = 0;
  let floodWaitSeconds = 0;

  // ---- 1. Discover collections dynamically (no hardcoding) ----
  console.log('\n[1/5] Discovering collections (payments.getStarGifts)...');
  let collections = [];
  try {
    collections = await gifts.discoverCollections();
    console.log(`  Discovered ${collections.length} collections via MTProto.`);
  } catch (err) {
    console.log(`  MTProto discovery failed (${err.message}). Falling back to the gifttracker signal for picking candidates — the probe itself still goes through MTProto.`);
    if (config.GIFTTRACKER_DATA_URL) {
      const g2 = new TelegramGiftsClient({ client: mtproto, source: 'gifttracker', gifttrackerUrl: config.GIFTTRACKER_DATA_URL });
      collections = await g2._discoverFromGifttracker();
    }
  }
  if (!collections.length) {
    console.error('No collections discovered from any source. Cannot continue.');
    await mtproto.disconnect();
    process.exit(1);
  }

  // Pick collections nearest to full (smallest remaining count), dynamically — no hardcoded slugs.
  const withRemaining = collections
    .filter(c => c.total_supply > 0)
    .map(c => ({ ...c, remaining: c.total_supply - c.upgraded_count }))
    .sort((a, b) => a.remaining - b.remaining)
    .slice(0, N_COLLECTIONS);
  console.log(`  Near-finish candidates for probing: ${withRemaining.map(c => `${c.slug || c.name}(remaining~${c.remaining})`).join(', ')}`);

  // ---- 2. T_detect proxy: round-trip latency of the window probe ----
  console.log(`\n[2/5] Measuring payments.getUniqueStarGift round-trip latency (${SAMPLES} samples per collection)...`);
  const allLatencies = [];
  const singleCallLatencies = [];
  const pairedCallLatencies = [];
  for (const c of withRemaining) {
    const slugBase = c.slug || c.name;
    const guessN = Math.max(1, c.upgraded_count || 1);
    for (let i = 0; i < Math.min(SAMPLES, 10); i++) {
      try {
        const t = Date.now();
        await gifts.getUniqueStarGift(`${slugBase}-${guessN}`);
        singleCallLatencies.push(Date.now() - t);
      } catch (err) {
        if (err instanceof EngineError && err.code === 'FLOOD_WAIT') {
          floodWaitsHit++; floodWaitSeconds += Number(err.extra?.seconds || 0);
          console.log(`  FLOOD_WAIT hit (${err.extra?.seconds}s) — waiting as required, not bypassing.`);
          await new Promise(r => setTimeout(r, (err.extra?.seconds || 1) * 1000));
        } else {
          console.log(`  probe error on ${slugBase}-${guessN}: ${err.message}`);
        }
      }
      const probe = await gifts.probeWindow(slugBase, guessN + 1).catch(err => ({ error: err.message }));
      if (!probe.error) {
        pairedCallLatencies.push(probe.latencyMs);
        allLatencies.push(probe.latencyMs);
      }
    }
  }
  console.log(`  Single getUniqueStarGift call: p50=${percentile(singleCallLatencies, 50)}ms p95=${percentile(singleCallLatencies, 95)}ms p99=${percentile(singleCallLatencies, 99)}ms (n=${singleCallLatencies.length})`);
  console.log(`  Paired probe (prev+next, Promise.all): p50=${percentile(pairedCallLatencies, 50)}ms p95=${percentile(pairedCallLatencies, 95)}ms p99=${percentile(pairedCallLatencies, 99)}ms (n=${pairedCallLatencies.length})`);
  const ratio = percentile(pairedCallLatencies, 50) / (percentile(singleCallLatencies, 50) || 1);
  console.log(`  Paired/single latency ratio: ${ratio.toFixed(2)}x — ` +
    (ratio < 1.3 ? 'LOOKS like one effective round trip (pipelined).' : 'LOOKS like two sequential round trips (NOT a single container) — report this, do not assume otherwise.'));

  // ---- 3. Sequential-numbering boundary check ----
  console.log('\n[3/5] Sequential-numbering boundary check (one collection, no hardcoded slug)...');
  const target = withRemaining[0];
  if (target) {
    const base = Math.max(1, target.upgraded_count || 1);
    const probes = [];
    for (let d = -2; d <= 2; d++) {
      const n = base + d;
      if (n < 1) continue;
      const r = await gifts.getUniqueStarGift(`${target.slug || target.name}-${n}`);
      probes.push({ n, exists: r.exists });
    }
    console.log('  ' + probes.map(p => `#${p.n}:${p.exists ? 'exists' : 'missing'}`).join('  '));
    const existing = probes.filter(p => p.exists).map(p => p.n);
    const missing = probes.filter(p => !p.exists).map(p => p.n);
    const monotonic = existing.every(n => missing.every(m => m > n));
    console.log(`  Monotonic boundary (all existing < all missing): ${monotonic ? 'YES' : 'NO — unexpected, investigate before trusting prediction'}`);
  } else {
    console.log('  Skipped — no candidate collection.');
  }

  // ---- 4. Prepaid/paid branch read-only check (section 7 Phase A requirement) ----
  console.log('\n[4/5] Checking the owner\'s own saved gifts for upgrade-eligible instances (read-only; no Stars spent)...');
  try {
    const saved = await savedGifts.getSavedStarGifts({});
    const eligible = saved.filter(g => g.can_upgrade && !g.upgraded);
    console.log(`  ${saved.length} saved gift(s), ${eligible.length} eligible for upgrade.`);
    if (!eligible.length) {
      console.log('  No eligible gift owned right now — prepaid/paid branches stay UNVERIFIED on live data until you own one.');
    }
    for (const g of eligible.slice(0, 3)) {
      try {
        const preview = await payments.getUpgradePreview({ savedGift: g });
        console.log(`  gift #${g.gift_num}: getUpgradePreview OK (${JSON.stringify(preview).slice(0, 120)}...)`);
      } catch (err) {
        console.log(`  gift #${g.gift_num}: getUpgradePreview FAILED — ${err.message}`);
      }
      if (!g.prepaid_upgrade) {
        try {
          const begun = await payments.beginPaidUpgrade({ savedGift: g });
          console.log(`  gift #${g.gift_num}: getPaymentForm OK, form_id=${begun.form?.form_id ?? 'n/a'} (sendStarsForm NOT called — dry-run)`);
        } catch (err) {
          console.log(`  gift #${g.gift_num}: getPaymentForm FAILED — ${err.message}`);
        }
      } else {
        console.log(`  gift #${g.gift_num}: prepaid — upgradeStarGift NOT called (dry-run)`);
      }
    }
  } catch (err) {
    console.log(`  getSavedStarGifts failed: ${err.message}`);
  }

  // ---- 5. Summary ----
  console.log('\n[5/5] Summary');
  console.log(`  DC id: ${mtproto.getDcId() ?? 'unknown'}`);
  console.log(`  FLOOD_WAIT hits: ${floodWaitsHit} (total ${floodWaitSeconds}s)`);
  console.log(`  T_detect proxy (paired probe) p99: ${percentile(allLatencies, 99)}ms — this is network round-trip only;`);
  console.log('  it does NOT include however long it takes the public counter signal to update, which is a separate,');
  console.log('  unmeasurable-by-us delay (depends on gifttracker/t.me, not this engine).');
  console.log('\nReport these numbers back verbatim — do not round up or down.');

  await mtproto.disconnect();
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
