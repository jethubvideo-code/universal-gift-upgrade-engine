/**
 * Dynamic Gift Collection discovery + collection state.
 *
 * UNIVERSAL: every collection Telegram returns is discovered automatically.
 * No collection list is hardcoded. New collections appear in the monitor,
 * database, cache, engine and UI without any code change.
 *
 * Sources:
 *  - 'mtproto'      : official Telegram (payments.getStarGifts)
 *  - 'gifttracker'  : read-only integration with the existing GiftTracker project
 *                     (its docs/gifts.json), for environments without a user session.
 *
 * t.me/nft is used ONLY for public information / prediction — never as an
 * execution or verification API.
 */
import { EngineError, ErrorCodes } from '../core/errors.js';

export class TelegramGiftsClient {
  constructor({ client, limiter = null, store = null, source = 'mtproto', gifttrackerUrl = '' } = {}) {
    this.client = client;
    this.limiter = limiter;
    this.store = store;
    this.source = source;
    this.gifttrackerUrl = gifttrackerUrl;
  }

  async _invoke(method, params = {}) {
    if (!this.client) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'No MTProto client configured');
    if (this.limiter) return this.limiter.run({ account: 'service', method, priority: 3 }, () => this.client.invoke(method, params));
    return this.client.invoke(method, params);
  }

  /** Discover ALL collections dynamically (payments.getStarGifts). */
  async discoverCollections() {
    if (this.source === 'gifttracker') return this._discoverFromGifttracker();
    const res = await this._invoke('payments.getStarGifts', { hash: 0 });
    const gifts = res?.gifts || res?.items || [];
    return gifts.map(g => {
      const raw = g.gift || g;
      const coll = raw.collection || raw;
      return {
        gift_id: String(raw.id ?? raw.gift_id ?? ''),
        collection_id: String(coll.id ?? coll.collection_id ?? raw.id ?? ''),
        slug: raw.slug || coll.slug || '',
        name: raw.title || coll.title || raw.slug || '',
        total_supply: Number(coll.total_amount ?? raw.total_supply ?? 0),
        upgraded_count: Number(coll.upgraded_amount ?? raw.upgraded_count ?? 0),
        rarity: raw.rarity || coll.rarity || null
      };
    });
  }

  async _discoverFromGifttracker() {
    if (!this.gifttrackerUrl) {
      throw new EngineError(ErrorCodes.CONFIG_ERROR, 'GIFTTRACKER_DATA_URL required for source=gifttracker');
    }
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (process.env.GIFT_DATA_TOKEN) {
      // reading data from a PRIVATE sibling repo (GitHub Actions GITHUB_TOKEN)
      headers.Authorization = `Bearer ${process.env.GIFT_DATA_TOKEN}`;
    }
    const res = await fetch(this.gifttrackerUrl, { headers });
    if (!res.ok) throw new EngineError(ErrorCodes.NETWORK_ERROR, `gifttracker data ${res.status}`);
    const data = await res.json();
    const arr = Array.isArray(data) ? data : (data.gifts || data.collections || []);
    return arr.map(g => ({
      gift_id: String(g.gift_id ?? g.slug ?? g.name),
      collection_id: String(g.collection_id ?? g.slug ?? g.name),
      slug: g.slug || g.name,
      name: g.title || g.name || g.slug,
      total_supply: Number(g.total_supply ?? g.supply ?? 0),
      upgraded_count: Number(g.upgraded_count ?? g.upgraded ?? 0),
      rarity: g.rarity || null
    }));
  }

  /**
   * Current state of one collection.
   * NOTE: upgraded_count / next_expected_number are PREDICTION inputs.
   * The actual Telegram user state is the source of truth for upgrades.
   */
  async getCollectionState(collectionId) {
    const all = await this.discoverCollections();
    const coll = all.find(c => c.collection_id === collectionId || c.gift_id === collectionId);
    if (!coll) return null;
    const upgraded = coll.upgraded_count;
    const total = coll.total_supply;
    return {
      collection_id: coll.collection_id,
      total_supply: total,
      upgraded_count: upgraded,
      remaining: Math.max(0, total - upgraded),
      next_expected_number: Math.min(upgraded + 1, total),
      last_update: new Date().toISOString(),
      source: this.source,
      version: 1
    };
  }

  /** Upsert discovered collections + gifts into the store (dynamic discovery). */
  syncCollections(store = this.store) {
    if (!store) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'store required');
    const discovered = [];
    for (const row of this._syncBuffer || []) discovered.push(row);
    return { discovered, async run() { return null; } };
  }

  async sync(store = this.store) {
    if (!store) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'store required');
    const all = await this.discoverCollections();
    const seen = new Set();
    for (const c of all) {
      const key = c.collection_id;
      seen.add(key);
      const existing = (store.find('gift_collections', { collection_id: key }) || [])[0];
      const fields = {
        collection_id: key, title: c.name, slug: c.slug,
        total_supply: c.total_supply, updated_at: new Date().toISOString()
      };
      if (existing) store.update('gift_collections', existing.id, fields);
      else store.insert('gift_collections', {
        id: crypto.randomUUID(), ...fields, created_at: new Date().toISOString()
      });
      const gExisting = (store.find('gifts', { gift_id: c.gift_id }) || [])[0];
      const gFields = {
        gift_id: c.gift_id, collection_id: key, slug: c.slug, name: c.name,
        total_supply: c.total_supply, upgraded_count: c.upgraded_count,
        rarity: c.rarity, updated_at: new Date().toISOString()
      };
      if (gExisting) store.update('gifts', gExisting.id, gFields);
      else store.insert('gifts', { id: crypto.randomUUID(), ...gFields, created_at: new Date().toISOString() });
    }
    return all;
  }
}

export default TelegramGiftsClient;
