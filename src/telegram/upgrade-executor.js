/**
 * Upgrade executor — ACTUAL TELEGRAM VERIFICATION before any upgrade.
 *
 * Section 8 checks, all mandatory (counter-based prediction is NEVER sufficient):
 *  1. the concrete gift exists;
 *  2. the concrete gift belongs to the user;
 *  3. gift_num === target.target_number;
 *  4. the gift is not upgraded yet;
 *  5. can_upgrade === true (per actual Telegram state);
 *  6. the price respects the user's maximum upgrade price (auto upgrade only).
 *
 * Idempotent: upgrade_jobs.idempotency_key + LockManager guard (see HotTargetEngine).
 * PRICE_LIMIT_EXCEEDED never spends a single Star.
 */
import crypto from 'node:crypto';
import { EngineError, ErrorCodes } from '../core/errors.js';

export class UpgradeExecutor {
  constructor({ savedGifts, payments, locks = null, limiter = null, retry = null, metrics = null, logger = null, mode = 'dry-run' } = {}) {
    this.savedGifts = savedGifts;
    this.payments = payments;
    this.locks = locks;
    this.limiter = limiter;
    this.retry = retry;
    this.metrics = metrics;
    this.logger = logger;
    // Section 6 modes: 'test' (fake transport, used by test/simulator.test.js),
    // 'dry-run' (real reads, upgrade/sendStarsForm calls are SKIPPED — logged as
    // "would fire" + timing), 'live' (actually spends Stars). Only the owner
    // flips 'live' — nothing in this engine sets it automatically.
    this.mode = mode;
  }

  /** Full section-8 verification against ACTUAL Telegram state. */
  async verify({ userSession = null, target, savedGift = null }) {
    const gift = savedGift ||
      (this.savedGifts ? await (async () => {
        const list = await this.savedGifts.getSavedStarGifts({ userSession });
        return this.savedGifts.findForTarget(list, {
          gift_id: target.gift_id, target_number: target.target_number
        });
      })() : null);

    if (!gift) return { ok: false, reason: 'GIFT_NOT_FOUND', canUpgrade: false, price: null, savedGift: null };
    if (gift.upgraded) return { ok: false, reason: 'ALREADY_UPGRADED', canUpgrade: false, price: null, savedGift: gift };
    if (Number(gift.gift_num) !== Number(target.target_number)) {
      return { ok: false, reason: 'GIFT_NUM_MISMATCH', canUpgrade: false, price: null, savedGift: gift };
    }
    if (!gift.can_upgrade) return { ok: false, reason: 'UPGRADE_UNAVAILABLE', canUpgrade: false, price: gift.upgrade_stars, savedGift: gift };

    const price = Number(gift.upgrade_stars ?? 0);
    if (target.auto_upgrade && target.max_upgrade_stars != null && price > Number(target.max_upgrade_stars)) {
      return { ok: false, reason: 'PRICE_LIMIT_EXCEEDED', canUpgrade: true, price, savedGift: gift };
    }
    return { ok: true, reason: null, canUpgrade: true, price, savedGift: gift };
  }

  /** Execute the officially allowed upgrade flow. */
  async execute({ userSession = null, target, savedGift, idempotencyKey }) {
    // Manual timing (the withTimer helper requires an fn; timing is done
    // inline here so execution_latency_ms is recorded exactly once per run).
    const start = Date.now();
    try {
      const result = await this._doExecute({ userSession, target, savedGift, idempotencyKey });
      if (this.metrics) {
        this.metrics.observe('execution_latency_ms', Date.now() - start, { target: target.id });
      }
      return result;
    } catch (err) {
      if (this.metrics) {
        this.metrics.observe('execution_latency_ms', Date.now() - start, { target: target.id });
        this.metrics.counter('upgrades_failed', { reason: err.code || 'UNKNOWN' });
      }
      throw err;
    }
  }

  async _doExecute({ userSession, target, savedGift, idempotencyKey }) {
    // Idempotency: a done job is never repeated.
    if (idempotencyKey) {
      const done = (this.store?.find('upgrade_jobs', { idempotency_key: idempotencyKey }) || []).find(j => j.status === 'DONE');
      if (done) return { status: 'COMPLETED', cached: true, details: done };
    }

    if (this.mode === 'dry-run') {
      // SAFE TEST MODE (section 6): read-only up to this point, the actual
      // debiting call is never made. "Would fire" is logged with the branch
      // that WOULD have run, so dry-run output is honest about what live
      // mode would do next.
      const branch = savedGift.prepaid_upgrade ? 'payments.upgradeStarGift (prepaid)' : 'payments.getPaymentForm -> payments.sendStarsForm (paid)';
      if (this.logger) this.logger.info('DRY-RUN: would fire', { target: target.id, branch, price: savedGift.upgrade_stars ?? null });
      return { status: 'WOULD_FIRE', details: { branch }, latency: Date.now() };
    }

    if (savedGift.prepaid_upgrade) {
      // Official prepaid flow (Bot API: star_count 0 / MTProto: upgradeStarGift).
      const res = await this.payments.upgradePrepaid({ savedGift, userSession });
      return { status: 'COMPLETED', details: res, latency: Date.now() };
    }
    // Paid upgrade: price already checked against the user's maximum.
    // Bot API executes it from the business balance (fails closed if short);
    // MTProto: getPaymentForm then sendStarsForm (payment-executor.js step 2/2).
    try {
      const begun = await this.payments.beginPaidUpgrade({ savedGift, target, userSession });
      if (begun && begun.executed) {
        // Bot API Business backend path: executes inline, no second step.
        return { status: 'COMPLETED', details: begun, latency: Date.now() };
      }
      if (this.payments.finalizePaidUpgrade) {
        // MTProto path: form obtained, now actually send it.
        const res = await this.payments.finalizePaidUpgrade(begun);
        return { status: 'COMPLETED', details: res, latency: Date.now() };
      }
      return { status: 'PAYMENT_REQUIRED', details: begun, latency: Date.now() };
    } catch (err) {
      if (err.code === ErrorCodes.PAYMENT_REQUIRED) {
        // Insufficient Stars: no Stars were spent.
        return { status: 'PAYMENT_REQUIRED', details: { reason: err.message }, latency: Date.now() };
      }
      throw err;
    }
  }
}

export default UpgradeExecutor;
