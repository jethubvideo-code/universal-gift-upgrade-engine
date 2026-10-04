export class CollectionStateCache {
  constructor({ ttlMs = 60000 } = {}) {
    this.ttlMs = ttlMs;
    this.cache = new Map(); // collectionId -> { state, timestamp }
  }

  get(collectionId) {
    const entry = this.cache.get(collectionId);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      return null; // expired
    }
    return entry.state;
  }

  set(collectionId, state) {
    const nextExpected = this.computeNextExpected(state.total_supply || 0, state.upgraded_count || 0);
    const fullState = {
      collection_id: collectionId,
      total_supply: state.total_supply || 0,
      upgraded_count: state.upgraded_count || 0,
      remaining: (state.total_supply || 0) - (state.upgraded_count || 0),
      next_expected_number: state.next_expected_number ?? nextExpected,
      last_update: state.last_update || new Date().toISOString(),
      source: state.source || 'mtproto',
      version: state.version || 1
    };
    this.cache.set(collectionId, { state: fullState, timestamp: Date.now() });
    return fullState;
  }

  computeNextExpected(totalSupply, upgradedCount) {
    if (totalSupply <= 0) return 1;
    return Math.min(upgradedCount + 1, totalSupply);
  }

  stale(collectionId) {
    const entry = this.cache.get(collectionId);
    if (!entry) return true;
    return Date.now() - entry.timestamp > this.ttlMs;
  }

  all() {
    return Array.from(this.cache.values()).map((e) => e.state);
  }

  persist(store) {
    if (!store) return;
    for (const { state } of this.cache.values()) {
      store.insert('collection_state', state);
    }
  }

  load(store) {
    if (!store) return;
    const rows = store.findAll('collection_state');
    for (const row of rows) {
      this.set(row.collection_id, row);
    }
  }
}
