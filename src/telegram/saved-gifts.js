/**
 * Saved Gifts API (official Telegram: payments.getSavedStarGifts).
 *
 * Distinguishes a Gift COLLECTION (e.g. all "Plush Pepe" items — no special
 * cases, just an example of naming) from the USER'S CONCRETE GIFT INSTANCE
 * (one saved gift with its own gift_num, msg_id, saved_id).
 *
 * Normalized fields: gift_id, gift_num, msg_id, saved_id, slug, can_upgrade,
 * upgraded, prepaid_upgrade, upgrade_stars, collection_id.
 * Snake/camel case both handled because TL schema drifts between layers —
 * see docs/TELEGRAM_API.md.
 */
import { EngineError, ErrorCodes } from '../core/errors.js';

export class SavedGiftsClient {
  constructor({ client, limiter = null, clientResolver = null } = {}) {
    this.client = client;
    this.limiter = limiter;
    // clientResolver: async (userSession) => per-user MTProto client (multi-user)
    this.clientResolver = clientResolver;
  }

  async _invoke(method, params = {}, { userSession = null } = {}) {
    let client = this.client;
    if (userSession && this.clientResolver) {
      client = await this.clientResolver(userSession);
    }
    if (!client) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'No MTProto client configured');
    if (this.limiter) return this.limiter.run({ account: 'user', method, priority: 2 }, () => client.invoke(method, params));
    return client.invoke(method, params);
  }

  /** All saved gifts of the user, normalized. */
  async getSavedStarGifts({ userSession = null } = {}) {
    if (!this.client && !this.clientResolver) return []; // degraded / TEST MODE without transport
    const res = await this._invoke('payments.getSavedStarGifts', {}, { userSession });
    const gifts = res?.gifts || res?.saved_gifts || res?.items || [];
    return gifts.map(g => {
      const raw = g.gift || g.saved_gift || g;
      const coll = raw.collection || {};
      return {
        gift_id: String(raw.gift_id ?? raw.id ?? raw.stargift_id ?? ''),
        gift_num: Number(raw.num ?? raw.gift_num ?? raw.number ?? 0),
        msg_id: g.msg_id ?? raw.msg_id ?? null,
        saved_id: g.saved_id ?? g.id ?? null,
        slug: raw.slug ?? coll.slug ?? '',
        can_upgrade: Boolean(raw.can_upgrade ?? g.can_upgrade ?? false),
        upgraded: Boolean(raw.upgraded ?? g.upgraded ?? false),
        prepaid_upgrade: Boolean(raw.prepaid_upgrade ?? g.prepaid_upgrade ?? false),
        upgrade_stars: raw.upgrade_stars ?? null,
        collection_id: String(coll.id ?? coll.collection_id ?? '')
      };
    });
  }

  /** Match the concrete user gift instance for a target (gift_num === target_number). */
  findForTarget(saved, { gift_id = null, target_number = null } = {}) {
    if (!Array.isArray(saved)) return null;
    return saved.find(g => {
      const numMatch = target_number != null && g.gift_num === Number(target_number);
      const giftMatch = gift_id != null ? g.gift_id === String(gift_id) : true;
      return numMatch && giftMatch;
    }) || null;
  }
}

export default SavedGiftsClient;
