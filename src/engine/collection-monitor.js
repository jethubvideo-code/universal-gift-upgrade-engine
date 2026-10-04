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
}
