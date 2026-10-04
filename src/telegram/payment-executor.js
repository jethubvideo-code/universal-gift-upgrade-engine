/**
 * Payment executor — official Telegram upgrade payment flows.
 *
 * NEVER emulates UI. NEVER clicks browser buttons. NEVER bypasses Telegram.
 * FLOOD_WAIT / rate limits are respected via TelegramRateLimiter + RetryManager.
 *
 * IMPORTANT: exact TL constructor/parameter names must be re-validated against
 * the CURRENT Telegram layer before production use — the transport isolates
 * schema drift (see docs/TELEGRAM_API.md). No invented methods.
 *
 * Used per official Telegram API (recent layers):
 *  - payments.getStarGiftUpgradePreview
 *  - payments.getStarGiftUpgradeAttributes
 *  - payments.upgradeStarGift (InputSavedStarGift) — for prepaid upgrades
 *  - inputInvoiceStarGiftUpgrade → payments.getPaymentForm — for paid upgrades
 */
import { EngineError, ErrorCodes } from '../core/errors.js';

export class PaymentExecutor {
  constructor({ client, limiter = null, retry = null, metrics = null, logger = null } = {}) {
    this.client = client;
    this.limiter = limiter;
    this.retry = retry;
    this.metrics = metrics;
    this.logger = logger;
  }

  async _invoke(method, params = {}, { priority = 2 } = {}) {
    if (!this.client) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'No MTProto client configured');
    const call = async () => {
      if (this.limiter) {
        return this.limiter.run({ account: 'user', method, priority }, () => this.client.invoke(method, params));
      }
      return this.client.invoke(method, params);
    };
    if (this.retry) return this.retry.run(call, { label: method });
    return call();
  }

  _inputSavedGift(savedGift) {
    // Prepared per section 7 — the actual upgrade then performs only the final API calls.
    return {
      _: 'InputSavedStarGift',
      msg_id: savedGift.msg_id,
      saved_id: savedGift.saved_id
    };
  }

  /** Preview of the upgraded gift attributes (official method). */
  async getUpgradePreview({ savedGift }) {
    return this._invoke('payments.getStarGiftUpgradePreview', { saved_gift_id: savedGift.saved_id ?? savedGift.gift_id });
  }

  async getUpgradeAttributes({ savedGift }) {
    return this._invoke('payments.getStarGiftUpgradeAttributes', { saved_gift_id: savedGift.saved_id ?? savedGift.gift_id });
  }

  /** Upgraded gift is prepaid → official payments.upgradeStarGift with InputSavedStarGift. */
  async upgradePrepaid({ savedGift }) {
    return this._invoke('payments.upgradeStarGift', { saved_gift: this._inputSavedGift(savedGift) }, { priority: 0 });
  }

  /**
   * Paid upgrade: inputInvoiceStarGiftUpgrade → payments.getPaymentForm →
   * the official Telegram payment flow. Price is charged by Telegram only;
   * if the price exceeds the user's limit we NEVER reach this method —
   * UpgradeExecutor returns PRICE_LIMIT_EXCEEDED before any payment call.
   */
  async beginPaidUpgrade({ savedGift, target = null }) {
    const invoice = {
      _: 'inputInvoiceStarGiftUpgrade',
      saved_gift: this._inputSavedGift(savedGift)
    };
    const form = await this._invoke('payments.getPaymentForm', { invoice }, { priority: 0 });
    return { invoice, form };
  }
}

export default PaymentExecutor;
