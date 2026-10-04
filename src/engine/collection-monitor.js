export class CollectionMonitor {
  constructor({ gifts, cache, scheduler, onUpdate, logger, metrics } = {}) {
    this.gifts = gifts;
    this.cache = cache;
    this.scheduler = scheduler;
    this.onUpdate = onUpdate;
    this.logger = logger;
    this.metrics = metrics;
    this.tracked = new Set();
  }

  track(collectionId) {
    if (!collectionId) return;
    if (this.tracked.has(collectionId)) return;
    this.tracked.add(collectionId);

    if (this.metrics) this.metrics.gauge('collections_monitored', this.tracked.size);

    if (this.scheduler) {
      this.scheduler.schedulePoll({
        key: `collection:${collectionId}`,
        priority: 3,
        intervalMs: 10000,
        fn: () => this.refresh(collectionId)
      });
    }
  }

  untrack(collectionId) {
    if (!this.tracked.has(collectionId)) return;
    this.tracked.delete(collectionId);
    if (this.metrics) this.metrics.gauge('collections_monitored', this.tracked.size);

    if (this.scheduler) {
      this.scheduler.cancel(`collection:${collectionId}`);
    }
  }

  async refresh(collectionId) {
    let state = null;
    if (this.gifts && typeof this.gifts.getCollectionState === 'function') {
      state = await this.gifts.getCollectionState(collectionId);
    } else {
      // Fallback state if gifts client not present
      state = {
        collection_id: collectionId,
        total_supply: 10000,
        upgraded_count: 0,
        next_expected_number: 1,
        last_update: new Date().toISOString()
      };
    }

    if (this.cache) {
      state = this.cache.set(collectionId, state);
    }

    if (this.onUpdate) {
      await this.onUpdate(state);
    }

    return state;
  }

  trackedCount() {
    return this.tracked.size;
  }

  /**
   * SPEED (Speed Mode): ONE signal fetch (one network round trip — a single
   * gifttracker JSON download or a single payments.getStarGifts call) feeding
   * the fresh state of EVERY tracked collection. This replaces N per-collection
   * fetches per tick with exactly 1, and is what the persistent worker's fast
   * loop calls. Per-collection refresh() stays for compatibility (--once mode).
   */
  async refreshAllTracked() {
    if (!this.tracked.size) return [];
    if (!this.gifts || typeof this.gifts.discoverCollections !== 'function') {
      return [];
    }
    const all = await this.gifts.discoverCollections();
    const byId = new Map(all.map(c => [String(c.collection_id), c]));
    const results = [];
    for (const cid of this.tracked) {
      const coll = byId.get(String(cid));
      if (!coll) continue;
      const upgraded = Number(coll.upgraded_count ?? 0);
      const total = Number(coll.total_supply ?? 0);
      let state = {
        collection_id: coll.collection_id,
        total_supply: total,
        upgraded_count: upgraded,
        remaining: Math.max(0, total - upgraded),
        next_expected_number: Math.min(upgraded + 1, total || upgraded + 1),
        last_update: new Date().toISOString(),
        source: coll.source || 'signal',
        version: 1
      };
      if (this.cache) state = this.cache.set(cid, state);
      results.push(state);
      if (this.onUpdate) {
        try {
          await this.onUpdate(state);
        } catch (err) {
          if (this.logger) this.logger.warn('onUpdate failed in batch refresh', { collection: cid, error: err.message });
        }
      }
    }
    return results;
  }

  /** Cancel the legacy per-collection poll timers (superseded by the worker's fast signal loop). */
  cancelPerCollectionPolls() {
    if (!this.scheduler) return;
    for (const cid of this.tracked) {
      this.scheduler.cancel(`collection:${cid}`);
    }
  }
}
