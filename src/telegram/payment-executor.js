/**
 * Payment executor — official Telegram upgrade payment flows.
 *
 * NEVER emulates UI. NEVER clicks browser buttons. NEVER bypasses Telegram.
 * FLOOD_WAIT / rate limits are respected via TelegramRateLimiter + RetryManager.
 *
 * RE-VERIFIED 2026-10-04 against core.telegram.org, Layer 225 (official schema
 * pages, read live — not invented):
 *  - payments.upgradeStarGift#aed6e4f5  flags:# keep_original_details:flags.0?true
 *      stargift:InputSavedStarGift = Updates           (param is `stargift`, NOT `saved_gift`)
 *  - inputInvoiceStarGiftUpgrade#4d818d5d  flags:# keep_original_details:flags.0?true
 *      stargift:InputSavedStarGift = InputInvoice       (param is `stargift`, NOT `saved_gift`)
 *  - payments.sendStarsForm#7998c914  form_id:long invoice:InputInvoice = payments.PaymentResult
 *  - inputSavedStarGiftUser#69279795  msg_id:int = InputSavedStarGift   (gift received by the OWNER personally)
 *  - inputSavedStarGiftChat#f101aa7f  peer:InputPeer saved_id:long = InputSavedStarGift (channel-owned gift —
 *      UNVERIFIED here: no `peer` is wired, only the owner's personal gifts are supported)
 *  - payments.getStarGiftUpgradePreview / getStarGiftUpgradeAttributes: method existence confirmed on
 *      core.telegram.org; the exact parameter name for "which gift" was NOT confirmed in this pass
 *      (page content truncated) — UNVERIFIED, kept as `stargift` by analogy with the two constructors
 *      above; re-check docs/TELEGRAM_API.md note before relying on these two calls.
 *
 * STARGIFT_ALREADY_UPGRADED / STARGIFT_UPGRADE_UNAVAILABLE / PAYMENT_REQUIRED /
 * SAVED_ID_EMPTY are the documented errors for payments.upgradeStarGift — mapped
 * in UpgradeExecutor / the error taxonomy below.
 */
import { EngineError, ErrorCodes } from '../core/errors.js';

export class PaymentExecutor {
  constructor({ client, limiter = null, retry = null, metrics = null, logger = null, clientResolver = null } = {}) {
    this.client = client;
    this.limiter = limiter;
    this.retry = retry;
    this.metrics = metrics;
    this.logger = logger;
    // clientResolver: async (userSession) => per-user MTProto client (multi-user)
    this.clientResolver = clientResolver;
  }

  async _invoke(method, params = {}, { priority = 2, userSession = null } = {}) {
    let client = this.client;
    if (userSession && this.clientResolver) {
      client = await this.clientResolver(userSession);
    }
    if (!client) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'No MTProto client configured');
    const call = async () => {
      if (this.limiter) {
        return this.limiter.run({ account: 'user', method, priority }, () => client.invoke(method, params));
      }
      return client.invoke(method, params);
    };
    if (this.retry) return this.retry.run(call, { label: method });
    return call();
  }

  /**
   * Confirmed TL schema (core.telegram.org, Layer 225):
   *   inputSavedStarGiftUser#69279795 msg_id:int = InputSavedStarGift
   *   inputSavedStarGiftChat#f101aa7f peer:InputPeer saved_id:long = InputSavedStarGift
   * savedStarGift carries msg_id for gifts received personally (our only
   * supported case right now) and saved_id for gifts received by a channel
   * the owner administers. The channel case needs a `peer` the engine does
   * not currently resolve — fails loudly (CONFIG_ERROR) instead of guessing.
   */
  _inputSavedGift(savedGift) {
    if (savedGift.msg_id != null) {
      return { _: 'inputSavedStarGiftUser', msg_id: savedGift.msg_id };
    }
    if (savedGift.saved_id != null) {
      throw new EngineError(ErrorCodes.CONFIG_ERROR,
        'UNVERIFIED/unsupported: gift saved via a channel (inputSavedStarGiftChat requires a `peer`, not wired)');
    }
    throw new EngineError(ErrorCodes.INVALID_SAVED_GIFT, 'savedGift has neither msg_id nor saved_id');
  }

  /** Preview of the upgraded gift attributes (official method; param name UNVERIFIED — see file header). */
  async getUpgradePreview({ savedGift }) {
    return this._invoke('payments.getStarGiftUpgradePreview', { stargift: this._inputSavedGift(savedGift) });
  }

  async getUpgradeAttributes({ savedGift }) {
    return this._invoke('payments.getStarGiftUpgradeAttributes', { stargift: this._inputSavedGift(savedGift) });
  }

  /** Prepaid upgrade → official payments.upgradeStarGift({ stargift: InputSavedStarGift }). */
  async upgradePrepaid({ savedGift, userSession = null }) {
    return this._invoke('payments.upgradeStarGift', { stargift: this._inputSavedGift(savedGift) }, { priority: 0, userSession });
  }

  /**
   * Paid upgrade step 1/2: inputInvoiceStarGiftUpgrade → payments.getPaymentForm.
   * Price is charged by Telegram only; if the price exceeds the user's limit we
   * NEVER reach this method — UpgradeExecutor returns PRICE_LIMIT_EXCEEDED first.
   */
  async beginPaidUpgrade({ savedGift, target = null, userSession = null }) {
    const invoice = {
      _: 'inputInvoiceStarGiftUpgrade',
      stargift: this._inputSavedGift(savedGift)
    };
    const form = await this._invoke('payments.getPaymentForm', { invoice }, { priority: 0, userSession });
    return { invoice, form };
  }

  /**
   * Paid upgrade step 2/2: payments.sendStarsForm({ form_id, invoice }) — the
   * actual Stars charge + upgrade. Confirmed: payments.sendStarsForm#7998c914
   * form_id:long invoice:InputInvoice = payments.PaymentResult. Possible result:
   * payments.paymentResult (done) or payments.paymentVerificationNeeded (3-D
   * Secure-style extra step — NOT expected for a Stars-only purchase, surfaced
   * as-is if Telegram ever returns it).
   */
  async finalizePaidUpgrade({ form, invoice, userSession = null }) {
    if (!form || form.form_id == null) {
      throw new EngineError(ErrorCodes.CONFIG_ERROR, 'finalizePaidUpgrade requires a form with form_id (call beginPaidUpgrade first)');
    }
    return this._invoke('payments.sendStarsForm', { form_id: form.form_id, invoice }, { priority: 0, userSession });
  }
}

export default PaymentExecutor;
