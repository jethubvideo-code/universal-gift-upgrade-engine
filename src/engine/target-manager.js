import { EngineError, ErrorCodes } from '../core/errors.js';
import { TargetStates, transition } from '../core/state-machine.js';
import { audit } from '../services/audit.js';
import { randomUUID } from 'node:crypto';

export class TargetManager {
  constructor(store) {
    this.store = store;
  }

  create({ user_id, collection_id, gift_id, target_number, auto_upgrade = false, max_upgrade_stars = null, priority = 3 }) {
    const num = Number(target_number);
    if (!Number.isInteger(num) || num < 1) {
      throw new EngineError(ErrorCodes.VERIFICATION_FAILED, 'target_number must be an integer >= 1');
    }

    const row = {
      id: randomUUID(),
      user_id: String(user_id),
      collection_id: String(collection_id),
      gift_id: String(gift_id),
      target_number: num,
      auto_upgrade: auto_upgrade ? 1 : 0,
      max_upgrade_stars: max_upgrade_stars != null ? Number(max_upgrade_stars) : null,
      priority: Number(priority),
      status: TargetStates.WATCHING,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null
    };

    const inserted = this.store.insert('targets', row);
    audit(this.store, {
      actor_type: 'user',
      actor_id: String(user_id),
      action: 'CREATE_TARGET',
      entity_type: 'target',
      entity_id: inserted.id,
      details: { collection_id, gift_id, target_number: num }
    });

    return inserted;
  }

  get(id) {
    return this.store.get('targets', id);
  }

  listByUser(userId) {
    return this.store.find('targets', { user_id: String(userId) });
  }

  listActive() {
    const all = this.store.findAll('targets');
    return all.filter((t) => t.status !== TargetStates.COMPLETED && t.status !== TargetStates.FAILED);
  }

  listByStatus(status) {
    return this.store.find('targets', { status });
  }

  setAutoUpgrade(id, { auto_upgrade, max_upgrade_stars }) {
    const existing = this.get(id);
    if (!existing) {
      throw new EngineError(ErrorCodes.NOT_FOUND, `Target ${id} not found`);
    }

    const patch = {};
    if (auto_upgrade !== undefined) patch.auto_upgrade = auto_upgrade ? 1 : 0;
    if (max_upgrade_stars !== undefined) patch.max_upgrade_stars = max_upgrade_stars != null ? Number(max_upgrade_stars) : null;

    const updated = this.store.update('targets', id, patch);
    audit(this.store, {
      actor_type: 'user',
      actor_id: existing.user_id,
      action: 'SET_AUTO_UPGRADE',
      entity_type: 'target',
      entity_id: id,
      details: patch
    });

    return updated;
  }

  applyTransition(id, to, { reason, details } = {}) {
    const target = this.get(id);
    if (!target) {
      throw new EngineError(ErrorCodes.NOT_FOUND, `Target ${id} not found`);
    }

    const { row: newRow, event } = transition(target, to, { reason, details });
    this.store.update('targets', id, newRow);
    this.store.insert('target_events', event);

    audit(this.store, {
      actor_type: 'system',
      actor_id: 'target-manager',
      action: 'STATE_TRANSITION',
      entity_type: 'target',
      entity_id: id,
      details: { from: target.status, to, reason }
    });

    return newRow;
  }

  delete(id) {
    const existing = this.get(id);
    if (!existing) return false;
    return this.store.remove('targets', id);
  }
}
