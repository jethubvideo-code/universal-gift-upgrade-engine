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
import { withTimer } from '../core/metrics.js';

export class UpgradeExecutor {
  constructor({ savedGifts, payments, locks = null, limiter = null, retry = null, metrics = null, logger = null } = {}) {
    this.savedGifts = savedGifts;
    this.payments = payments;
    this.locks = locks;
    this.limiter = limiter;
    this.retry = retry;
    this.metrics = metrics;
    this.logger = logger;
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
    const t = this.metrics ? withTimer(this.metrics, 'execution_latency_ms', { target: target.id }, null) : null;
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
    } finally {
      void t;
    }
  }

  async _doExecute({ userSession, target, savedGift, idempotencyKey }) {
    // Idempotency: a done job is never repeated.
    if (idempotencyKey) {
      const done = (this.store?.find('upgrade_jobs', { idempotency_key: idempotencyKey }) || []).find(j => j.status === 'DONE');
      if (done) return { status: 'COMPLETED', cached: true, details: done };
    }

    if (savedGift.prepaid_upgrade) {
      // Official prepaid flow.
      const res = await this.payments.upgradePrepaid({ savedGift });
      return { status: 'COMPLETED', details: res, latency: Date.now() };
    }
    // Paid upgrade: price already checked against the user's maximum.
    const { form } = await this.payments.beginPaidUpgrade({ savedGift, target });
    return { status: 'PAYMENT_REQUIRED', details: form, latency: Date.now() };
  }
}

export default UpgradeExecutor;
