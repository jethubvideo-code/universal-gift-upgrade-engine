/**
 * Variant B — Bot API Business connection transport.
 *
 * Owner decision (Phase 0.4): Bot API Business instead of a user MTProto
 * session. The bot acts on gifts owned by a MANAGED BUSINESS ACCOUNT, with
 * privileges granted and revocable by the user in Telegram Business settings.
 *
 * VERIFIED against the official Bot API reference (Bot API 10.3, fetched
 * 2026-10-04, https://core.telegram.org/bots/api):
 *  - getBusinessConnection(business_connection_id) -> BusinessConnection { rights: BusinessBotRights }
 *  - getBusinessAccountGifts(business_connection_id, exclude_*, offset?, limit?)
 *      -> OwnedGifts { total_count, gifts: OwnedGiftRegular[], next_offset }
 *      requires right: can_view_gifts_and_stars
 *  - getBusinessAccountStarBalance(business_connection_id) -> StarAmount { star_amount }
 *      requires right: can_view_gifts_and_stars
 *  - upgradeGift(business_connection_id, owned_gift_id, keep_original_details?, star_count?)
 *      -> True. Requires right can_transfer_and_upgrade_gifts; additionally
 *      can_transfer_stars if the upgrade is paid. star_count: pass 0 when
 *      the gift's prepaid_upgrade_star_count > 0, otherwise pass
 *      gift.upgrade_star_count (paid from the business account balance).
 *  - BusinessBotRights: can_view_gifts_and_stars, can_transfer_and_upgrade_gifts,
 *      can_transfer_stars, can_convert_gifts_to_stars, ...
 *  - OwnedGiftRegular (business accounts): owned_gift_id, gift (Gift),
 *      can_be_upgraded, prepaid_upgrade_star_count, unique_gift_number
 *      ("Unique number reserved for this gift when upgraded"), is_saved,
 *      was_refunded, convert_star_count, is_upgrade_separate
 *  - Gift: id, sticker, star_count, upgrade_star_count, is_premium,
 *      has_colors, total_count, remaining_count
 *
 * KEY CORRECTNESS FACT: unique_gift_number is the number RESERVED for this
 * concrete gift when upgraded. Target verification (section 7.5) matches
 * the user's owned gift whose unique_gift_number === target.target_number.
 * If Telegram does not include the field for some gift, verification FAILS
 * CLOSED (GIFT_NOT_FOUND) — the engine never upgrades a gift it cannot
 * prove is the target number.
 *
 * UNVERIFIED (runtime behavior, cannot check without a live business
 * connection): whether unique_gift_number is always present for upgradable
 * owned gifts. Code assumes nothing — it fails closed.
 */
import { EngineError, ErrorCodes } from '../core/errors.js';

/** Low-level Bot API HTTP client (no MTProto). */
export class BotApiClient {
  /**
   * @param {object} opts
   * @param {string} opts.botToken
   * @param {string} [opts.apiUrl] default https://api.telegram.org
   * @param {typeof fetch} [opts.fetchImpl] injectable for tests
   */
  constructor({ botToken, apiUrl = 'https://api.telegram.org', fetchImpl = null } = {}) {
    if (!botToken) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'BOT_TOKEN required for the Bot API transport');
    this.botToken = botToken;
    this.apiUrl = apiUrl;
    this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis);
    if (typeof this.fetchImpl !== 'function') {
      throw new EngineError(ErrorCodes.CONFIG_ERROR, 'No fetch implementation available');
    }
  }

  /** Raw Bot API call. Normalizes transport errors into EngineError taxonomy. */
  async invoke(method, params = {}) {
    const url = `${this.apiUrl}/bot${this.botToken}/${method}`;
    let res;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });
    } catch (err) {
      const msg = String(err?.message || err);
      if (/ETIMEDOUT|TIMEOUT/i.test(msg)) throw new EngineError(ErrorCodes.TIMEOUT, msg);
      if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(msg)) {
        throw new EngineError(ErrorCodes.NETWORK_ERROR, msg);
      }
      throw err;
    }

    let body = null;
    try { body = await res.json(); } catch { body = null; }

    if (!res.ok || !body?.ok) {
      const desc = body?.description || res.statusText || 'Bot API error';
      // 429 Too Many Requests: { ok:false, error_code:429, parameters:{ retry_after } }
      if (res.status === 429 || body?.error_code === 429) {
        const seconds = Number(body?.parameters?.retry_after ?? 30);
        throw new EngineError(ErrorCodes.FLOOD_WAIT, `FLOOD_WAIT ${desc}`, { seconds, retryable: true });
      }
      if (/METHOD_NOT_FOUND|method not found/i.test(desc)) {
        throw new EngineError(ErrorCodes.CONFIG_ERROR, `Bot API method missing (Bot API too old?): ${method}: ${desc}`);
      }
      if (/bot was blocked|unauthorized|revoked/i.test(desc) || res.status === 401) {
        throw new EngineError(ErrorCodes.AUTH_ERROR, desc);
      }
      // Business/gift domain errors (e.g. BUSINESS_CONNECTION_* , RIGHTS_*):
      // surfaced as-is; the engine classifies permanent vs temporary upstream.
      throw new EngineError(ErrorCodes.UPGRADE_UNAVAILABLE, `${method}: ${desc}`, {
        botApiDescription: desc, error_code: body?.error_code
      });
    }
    return body.result;
  }
}

/** Normalize an OwnedGiftRegular row to the engine's saved-gift shape. */
export function normalizeOwnedGift(g) {
  if (!g || g.type !== 'regular') return null; // only regular gifts can be upgraded
  const gift = g.gift || {};
  const prepaid = Number(g.prepaid_upgrade_star_count ?? 0) > 0;
  return {
    gift_id: String(gift.id ?? ''),
    // Section 7.5 match key: the number RESERVED for this concrete gift.
    gift_num: Number(g.unique_gift_number ?? 0),
    msg_id: null,            // Bot API identifies gifts by owned_gift_id
    saved_id: g.owned_gift_id ?? null,
    owned_gift_id: g.owned_gift_id ?? null,
    slug: '',
    can_upgrade: g.can_be_upgraded === true && g.was_refunded !== true,
    upgraded: false,         // OwnedGiftUnique entries are filtered out above
    prepaid_upgrade: prepaid,
    prepaid_upgrade_star_count: Number(g.prepaid_upgrade_star_count ?? 0) || null,
    upgrade_stars: Number(gift.upgrade_star_count ?? 0) || null,
    is_saved: g.is_saved === true,
    was_refunded: g.was_refunded === true,
    convert_star_count: Number(g.convert_star_count ?? 0) || null
  };
}

const REQUIRED_RIGHTS = Object.freeze(['can_view_gifts_and_stars', 'can_transfer_and_upgrade_gifts']);

/**
 * Engine-facing backend for Variant B. Implements the same interface the
 * UpgradeExecutor consumes (getSavedStarGifts / findForTarget /
 * upgradePrepaid / beginPaidUpgrade) — a drop-in replacement for the
 * MTProto SavedGiftsClient + PaymentExecutor pair.
 *
 * Here `userSession` is a business connection id (a non-secret identifier);
 * the credential is the bot token, which never leaves env/secrets.
 */
export class BotApiBusinessBackend {
  constructor({ client, limiter = null, logger = null } = {}) {
    if (!client) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'BotApiClient required');
    this.client = client;
    this.limiter = limiter;
    this.logger = logger;
  }

  _cid(userSession) {
    // userSession may be { session: '<id>' } (from the session manager) or the id itself.
    const cid = userSession?.session ?? userSession ?? process.env.BUSINESS_CONNECTION_ID ?? null;
    if (!cid) throw new EngineError(ErrorCodes.SESSION_ERROR, 'No business connection for this user (link the bot in Telegram Business settings)');
    return String(cid);
  }

  async _call(method, params = {}, { priority = 2 } = {}) {
    if (this.limiter) {
      return this.limiter.run({ account: 'botapi', method, priority }, () => this.client.invoke(method, params));
    }
    return this.client.invoke(method, params);
  }

  /**
   * All owned (saved) gifts of the business account, paginated, normalized.
   * Same shape as SavedGiftsClient.getSavedStarGifts.
   */
  async getSavedStarGifts({ userSession = null } = {}) {
    const cid = this._cid(userSession);
    const out = [];
    let offset = '';
    // OwnedGifts.next_offset pagination (verified field).
    for (let page = 0; page < 50; page++) { // hard cap: 50 pages x 100 = 5000 gifts
      const res = await this._call('getBusinessAccountGifts', {
        business_connection_id: cid,
        ...(offset ? { offset } : {})
      });
      const gifts = (res?.gifts || []).map(normalizeOwnedGift).filter(Boolean);
      out.push(...gifts);
      if (!res?.next_offset || (res?.gifts || []).length === 0) break;
      offset = res.next_offset;
    }
    return out;
  }

  /** Section 7.5 match: unique_gift_number === target_number AND same gift type. */
  findForTarget(saved, { gift_id = null, target_number = null } = {}) {
    if (!Array.isArray(saved)) return null;
    const candidates = saved.filter(g => {
      const numOk = target_number != null && g.gift_num === Number(target_number);
      const giftOk = gift_id != null ? g.gift_id === String(gift_id) : true;
      return numOk && giftOk;
    });
    // Prefer an upgradable, non-refunded match; otherwise the strictest
    // (first) match so the executor reports the precise failure reason.
    return candidates.find(g => g.can_upgrade) || candidates[0] || null;
  }

  /** BusinessConnection with rights, fresh from Telegram. */
  async getConnection({ userSession = null } = {}) {
    return this._call('getBusinessConnection', { business_connection_id: this._cid(userSession) });
  }

  /** Validate the rights the engine needs. Throws AUTH_ERROR listing misses. */
  async validateRights({ userSession = null, needPaidUpgrades = true } = {}) {
    const conn = await this.getConnection({ userSession });
    const rights = conn?.rights || {};
    const missing = REQUIRED_RIGHTS.filter(r => rights[r] !== true);
    if (needPaidUpgrades && rights.can_transfer_stars !== true) missing.push('can_transfer_stars');
    if (missing.length) {
      throw new EngineError(ErrorCodes.AUTH_ERROR,
        `Business bot rights missing: ${missing.join(', ')}. Grant them in Telegram Business → Bots.`);
    }
    return rights;
  }

  /** StarAmount of the business account (verified method). */
  async getBalance({ userSession = null } = {}) {
    const res = await this._call('getBusinessAccountStarBalance', {
      business_connection_id: this._cid(userSession)
    });
    return Number(res?.star_amount ?? 0);
  }

  /**
   * Prepaid upgrade (verified: prepaid_upgrade_star_count > 0 → star_count 0).
   * Returns True on success per the official method.
   */
  async upgradePrepaid({ savedGift, userSession = null, keep_original_details = true } = {}) {
    if (!savedGift?.owned_gift_id) {
      throw new EngineError(ErrorCodes.INVALID_SAVED_GIFT, 'owned_gift_id required for the Bot API upgrade');
    }
    return this._call('upgradeGift', {
      business_connection_id: this._cid(userSession),
      owned_gift_id: savedGift.owned_gift_id,
      keep_original_details,
      star_count: 0
    }, { priority: 0 });
  }

  /**
   * Paid upgrade (verified: pass gift.upgrade_star_count, charged from the
   * business account balance, requires can_transfer_stars). FAILS CLOSED on
   * insufficient balance — no upgrade call is made in that case.
   */
  async beginPaidUpgrade({ savedGift, target = null, userSession = null, keep_original_details = true } = {}) {
    const price = Number(savedGift.upgrade_stars ?? 0);
    if (!(price > 0)) {
      throw new EngineError(ErrorCodes.UPGRADE_UNAVAILABLE, 'No upgrade price known — refusing to execute');
    }
    const balance = await this.getBalance({ userSession });
    if (balance < price) {
      throw new EngineError(ErrorCodes.PAYMENT_REQUIRED,
        `Insufficient Stars on the business account balance: have ${balance}, need ${price}`);
    }
    const res = await this._call('upgradeGift', {
      business_connection_id: this._cid(userSession),
      owned_gift_id: savedGift.owned_gift_id,
      keep_original_details,
      star_count: price
    }, { priority: 0 });
    void target;
    return { executed: true, star_count: price, result: res };
  }

  // Interface compatibility with PaymentExecutor (MTProto variant): preview
  // methods are Bot API-unavailable — fail honestly instead of faking.
  async getUpgradePreview() {
    throw new EngineError(ErrorCodes.CONFIG_ERROR, 'Upgrade preview is not exposed via Bot API');
  }
  async getUpgradeAttributes() {
    throw new EngineError(ErrorCodes.CONFIG_ERROR, 'Upgrade attributes are not exposed via Bot API');
  }
}

/**
 * Stores business connections arriving via the `business_connection` bot
 * update. Duck-type compatible with UserSessionManager: getUserSession(id)
 * returns { session: '<business_connection_id>' } so the rest of the engine
 * (HotTargetEngine) works unchanged.
 *
 * The business_connection_id is NOT a secret credential (the bot token is);
 * it is stored as an ordinary state record.
 */
export class BusinessConnectionManager {
  constructor({ store } = {}) {
    if (!store) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'store required');
    this.store = store;
  }

  /** Upsert from a Bot API `business_connection` update. */
  saveFromUpdate(bc) {
    if (!bc?.business_connection_id || !bc?.user?.id) return null;
    const user_id = String(bc.user.id);
    const existing = (this.store.find('business_connections', { user_id }) || [])[0];
    const row = {
      user_id,
      business_connection_id: bc.business_connection_id,
      user_chat_id: bc.user_chat_id ?? null,
      rights: bc.rights || {},
      is_enabled: bc.is_enabled ?? bc.enabled ?? true,
      date: bc.date ?? null,
      updated_at: new Date().toISOString()
    };
    if (existing) return this.store.update('business_connections', existing.id, row);
    return this.store.insert('business_connections', { id: `bc-${user_id}`, ...row });
  }

  /** UserSessionManager-compatible accessor. */
  getUserSession(userId) {
    const row = (this.store.find('business_connections', { user_id: String(userId) }) || [])[0];
    if (!row || row.is_enabled === false) return null;
    return { ...row, session: row.business_connection_id };
  }

  list() {
    return this.store.findAll('business_connections');
  }
}

export default BotApiBusinessBackend;
