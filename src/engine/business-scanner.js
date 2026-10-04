/**
 * Business account gift scanner — answers the owner's real question:
 * "у меня есть подарок не улучшенный — как он сканирует, как улучшает
 * автоматически через мой аккаунт".
 *
 * Before this file existed, BotApiBusinessBackend (getBusinessAccountGifts,
 * upgradeGift, etc.) was fully implemented but NEVER CALLED anywhere except
 * to store the connection id. The engine only ever acted on gifts matching a
 * TARGET the user explicitly created with a known number via /add or the
 * Mini App deep link — it never looked at "what gifts do I actually own
 * right now" on its own. This module closes that gap:
 *
 *   scanOwnedGifts()  — read-only: lists every owned gift via the business
 *                        connection, classifies each (already upgraded /
 *                        can't upgrade / prepaid-free / paid-affordable /
 *                        paid-too-expensive), used by /mygifts.
 *   autoActOnOwnedGifts() — same scan, THEN for gifts matching the user's
 *                        "auto-upgrade any owned gift" setting (opt-in,
 *                        /autoupgrade command), executes the upgrade
 *                        through UpgradeExecutor (respects MODE: dry-run
 *                        never spends, live does). Also matches owned
 *                        gifts against existing number-targets so a target
 *                        created BEFORE the gift was owned still fires.
 *                        Every notification is deduped (one notify per
 *                        gift+reason) via the owned_gift_notifications table.
 */
import crypto from 'node:crypto';
import { EngineError } from '../core/errors.js';

/** Classify one normalized owned gift (see normalizeOwnedGift shape). */
export function classifyGift(gift, { starBalance = null } = {}) {
  if (gift.upgraded) return { status: 'ALREADY_UPGRADED', actionable: false };
  if (!gift.can_upgrade) return { status: 'CANNOT_UPGRADE', actionable: false, reason: gift.was_refunded ? 'REFUNDED' : 'NOT_UPGRADABLE' };
  if (gift.prepaid_upgrade) {
    return { status: 'FREE_UPGRADE_READY', actionable: true, cost: 0,
      message: 'Апгрейд уже ПРЕДОПЛАЧЕН — апгрейд бесплатный, можно сделать прямо сейчас.' };
  }
  const price = Number(gift.upgrade_stars ?? 0);
  if (!price) return { status: 'PRICE_UNKNOWN', actionable: false };
  if (starBalance != null && starBalance >= price) {
    return { status: 'AFFORDABLE', actionable: true, cost: price,
      message: `Апгрейд стоит ${price}⭐ — на балансе хватает (${starBalance}⭐).` };
  }
  return { status: 'TOO_EXPENSIVE', actionable: false, cost: price,
    message: starBalance != null
      ? `Апгрейд стоит ${price}⭐, на балансе только ${starBalance}⭐ — не хватает ${price - starBalance}⭐.`
      : `Апгрейд стоит ${price}⭐.` };
}

/**
 * Read-only scan: every owned gift + classification + star balance.
 * Never spends anything, never writes to the store (except nothing).
 */
export async function scanOwnedGifts({ backend, userSession, logger = null } = {}) {
  if (!backend || typeof backend.getSavedStarGifts !== 'function') {
    throw new EngineError('CONFIG_ERROR', 'No business backend available for scanning');
  }
  let starBalance = null;
  if (typeof backend.getStarBalance === 'function') {
    try { starBalance = await backend.getStarBalance({ userSession }); } catch (err) {
      if (logger) logger.warn('getStarBalance failed during scan', { error: err.message });
    }
  }
  const gifts = await backend.getSavedStarGifts({ userSession });
  const classified = gifts.map(g => ({ gift: g, ...classifyGift(g, { starBalance }) }));
  return {
    star_balance: starBalance,
    total: gifts.length,
    upgradable_count: classified.filter(c => c.actionable).length,
    gifts: classified
  };
}

/**
 * Full scan + act: for every actionable gift, either (a) it matches an
 * EXISTING number-target (fires the real HotTargetEngine/UpgradeExecutor
 * path, respecting that target's own max_upgrade_stars and auto_upgrade
 * flag — unchanged, strict), or (b) the user has a wildcard "auto-upgrade
 * any owned gift up to N stars" setting enabled (new, opt-in via
 * /autoupgrade), in which case it executes directly through the same
 * UpgradeExecutor with the SAME MODE semantics (dry-run never spends).
 * Everything else is a deduped NOTIFICATION only — never silently ignored,
 * never silently charged.
 */
export async function autoActOnOwnedGifts({
  userId, backend, userSession, store, targets, executor, notifier, logger = null, metrics = null
} = {}) {
  const scan = await scanOwnedGifts({ backend, userSession, logger });
  const settings = (store.find('business_settings', { user_id: String(userId) }) || [])[0];
  const wildcardOn = settings?.auto_upgrade_all === true;
  const wildcardMax = settings?.max_upgrade_stars_all != null ? Number(settings.max_upgrade_stars_all) : null;

  const userTargets = (targets?.listActive ? targets.listActive() : (store.find('targets', { user_id: String(userId) }) || []))
    .filter(t => String(t.user_id) === String(userId));

  const results = { upgraded: [], notified: [], skipped: 0 };

  for (const entry of scan.gifts) {
    const g = entry.gift;
    if (!entry.actionable) continue;

    // (a) does an existing number-target match this concrete gift?
    const matchedTarget = userTargets.find(t =>
      Number(t.target_number) === Number(g.gift_num) &&
      !['COMPLETED', 'FAILED'].includes(t.status)
    );

    const notifyKey = `${userId}:${g.owned_gift_id || g.gift_id}:${entry.status}`;
    const already = (store.find('owned_gift_notifications', { key: notifyKey }) || []).length > 0;

    if (matchedTarget && matchedTarget.auto_upgrade && executor) {
      // Real target match: execute through the normal verified path, which
      // re-checks price against THAT target's own max_upgrade_stars.
      try {
        const idempotencyKey = `upgrade:${matchedTarget.id}:${matchedTarget.target_number}`;
        const verifyRes = await executor.verify({ userSession, target: matchedTarget, savedGift: g });
        if (verifyRes.ok) {
          const execRes = await executor.execute({ userSession, target: matchedTarget, savedGift: g, idempotencyKey });
          results.upgraded.push({ gift_num: g.gift_num, target_id: matchedTarget.id, result: execRes });
          // The upgrade itself already succeeded above — a bookkeeping
          // status-transition failure (e.g. the target wasn't walked through
          // the usual VERIFYING/HOT_TARGET steps because this path matched it
          // directly from a business scan) must NEVER swallow the success
          // notification. Isolated in its own try/catch, logged, not fatal.
          if (targets?.applyTransition) {
            try { await targets.applyTransition(matchedTarget.id, 'COMPLETED', { reason: 'Business scan auto-upgrade' }); }
            catch (transErr) { if (logger) logger.warn('Status transition after scan-upgrade failed (upgrade itself succeeded)', { target_id: matchedTarget.id, error: transErr.message }); }
          }
          if (notifier) notifier.notifyUser(userId, 'UPGRADE_COMPLETED', { target: matchedTarget, result: execRes });
        } else if (!already) {
          notify(store, notifier, userId, notifyKey, `Таргет #${g.gift_num} найден, но: ${verifyRes.reason}`);
          results.notified.push(notifyKey);
        } else { results.skipped++; }
      } catch (err) {
        if (logger) logger.warn('autoActOnOwnedGifts: target execution failed', { error: err.message });
        if (!already) {
          notify(store, notifier, userId, notifyKey, `Не удалось улучшить #${g.gift_num}: ${err.message}`);
          results.notified.push(notifyKey);
        }
      }
      continue;
    }

    // (b) wildcard auto-upgrade (opt-in, no pre-known number needed)
    if (wildcardOn && executor && (entry.cost === 0 || (wildcardMax != null && entry.cost <= wildcardMax))) {
      try {
        const wildcardTarget = {
          id: `wildcard-${g.owned_gift_id || g.gift_id}`,
          user_id: userId, target_number: g.gift_num, gift_id: g.gift_id,
          auto_upgrade: true, max_upgrade_stars: wildcardMax ?? 999999999
        };
        const idempotencyKey = `upgrade:wildcard:${userId}:${g.owned_gift_id || g.gift_id}`;
        const execRes = await executor.execute({ userSession, target: wildcardTarget, savedGift: g, idempotencyKey });
        results.upgraded.push({ gift_num: g.gift_num, wildcard: true, result: execRes });
        if (notifier) notifier.notifyUser(userId, 'UPGRADE_COMPLETED', { target: wildcardTarget, result: execRes });
      } catch (err) {
        if (logger) logger.warn('autoActOnOwnedGifts: wildcard execution failed', { error: err.message });
      }
      continue;
    }

    // (c) nothing to execute automatically — notify once per gift+status.
    if (!already && entry.message) {
      notify(store, notifier, userId, notifyKey, `🎁 Подарок #${g.gift_num}: ${entry.message}`);
      results.notified.push(notifyKey);
    } else {
      results.skipped++;
    }
  }

  return { scan, ...results };
}

function notify(store, notifier, userId, key, text) {
  store.insert('owned_gift_notifications', { id: crypto.randomUUID(), key, user_id: String(userId), created_at: new Date().toISOString() });
  if (notifier) notifier.notifyUser(userId, 'OWNED_GIFT_FOUND', { text });
}
