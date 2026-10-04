import { randomUUID } from 'node:crypto';

export function audit(store, { actor_type = 'system', actor_id = 'system', action, entity_type, entity_id, details }) {
  if (!store) return;
  const now = new Date().toISOString();
  return store.insert('audit_logs', {
    id: randomUUID(),
    actor_type,
    actor_id,
    action,
    entity_type: entity_type || null,
    entity_id: entity_id || null,
    details_json: JSON.stringify(details || {}),
    created_at: now
  });
}
