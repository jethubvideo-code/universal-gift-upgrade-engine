import { TargetStates } from '../core/state-machine.js';

export class TargetIndex {
  constructor() {
    this.byKey = new Map(); // id -> target
    this.byColl = new Map(); // collectionId -> Set<id>
    this.byGift = new Map(); // giftId -> Set<id>
    this.byCollNum = new Map(); // `${collectionId}:${number}` -> Set<id>
    this.byUserMap = new Map(); // userId -> Set<id>
    this.hotSet = new Set(); // set of hot target ids
  }

  add(target) {
    if (!target || !target.id) return;
    this.remove(target.id);

    this.byKey.set(target.id, target);

    // collection index
    if (target.collection_id) {
      if (!this.byColl.has(target.collection_id)) this.byColl.set(target.collection_id, new Set());
      this.byColl.get(target.collection_id).add(target.id);
    }

    // gift index
    if (target.gift_id) {
      if (!this.byGift.has(target.gift_id)) this.byGift.set(target.gift_id, new Set());
      this.byGift.get(target.gift_id).add(target.id);
    }

    // collection + number index
    if (target.collection_id && target.target_number !== undefined) {
      const key = `${target.collection_id}:${target.target_number}`;
      if (!this.byCollNum.has(key)) this.byCollNum.set(key, new Set());
      this.byCollNum.get(key).add(target.id);
    }

    // user index
    if (target.user_id) {
      if (!this.byUserMap.has(target.user_id)) this.byUserMap.set(target.user_id, new Set());
      this.byUserMap.get(target.user_id).add(target.id);
    }

    if (target.status === TargetStates.HOT_TARGET) {
      this.hotSet.add(target.id);
    }
  }

  remove(id) {
    const existing = this.byKey.get(id);
    if (!existing) return;

    this.byKey.delete(id);
    this.hotSet.delete(id);

    if (existing.collection_id && this.byColl.has(existing.collection_id)) {
      this.byColl.get(existing.collection_id).delete(id);
    }

    if (existing.gift_id && this.byGift.has(existing.gift_id)) {
      this.byGift.get(existing.gift_id).delete(id);
    }

    if (existing.collection_id && existing.target_number !== undefined) {
      const key = `${existing.collection_id}:${existing.target_number}`;
      if (this.byCollNum.has(key)) {
        this.byCollNum.get(key).delete(id);
      }
    }

    if (existing.user_id && this.byUserMap.has(existing.user_id)) {
      this.byUserMap.get(existing.user_id).delete(id);
    }
  }

  replaceAll(targets = []) {
    this.byKey.clear();
    this.byColl.clear();
    this.byGift.clear();
    this.byCollNum.clear();
    this.byUserMap.clear();
    this.hotSet.clear();

    for (const t of targets) {
      this.add(t);
    }
  }

  get(id) {
    return this.byKey.get(id) || null;
  }

  byCollection(collectionId) {
    const set = this.byColl.get(collectionId);
    if (!set) return [];
    return Array.from(set).map((id) => this.byKey.get(id)).filter(Boolean);
  }

  byGiftId(giftId) {
    const set = this.byGift.get(giftId);
    if (!set) return [];
    return Array.from(set).map((id) => this.byKey.get(id)).filter(Boolean);
  }

  byNumber(collectionId, number) {
    const key = `${collectionId}:${number}`;
    const set = this.byCollNum.get(key);
    if (!set) return [];
    return Array.from(set).map((id) => this.byKey.get(id)).filter(Boolean);
  }

  byUser(userId) {
    const set = this.byUserMap.get(userId);
    if (!set) return [];
    return Array.from(set).map((id) => this.byKey.get(id)).filter(Boolean);
  }

  hot() {
    return Array.from(this.hotSet).map((id) => this.byKey.get(id)).filter(Boolean);
  }

  active() {
    return Array.from(this.byKey.values()).filter(
      (t) => t.status !== TargetStates.COMPLETED && t.status !== TargetStates.FAILED
    );
  }

  markHot(id) {
    this.hotSet.add(id);
    const target = this.byKey.get(id);
    if (target) {
      target.status = TargetStates.HOT_TARGET;
    }
  }

  unmarkHot(id) {
    this.hotSet.delete(id);
  }

  stats() {
    return {
      total: this.byKey.size,
      active: this.active().length,
      hot: this.hotSet.size
    };
  }
}
