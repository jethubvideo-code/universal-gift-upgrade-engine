import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, FileStore, createStore, TABLES } from '../src/db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const row = (extra = {}) => ({
  id: 'x1', status: 'WATCHING',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...extra
});

test('MemoryStore CRUD', () => {
  const s = new MemoryStore();
  s.insert('targets', row());
  assert.equal(s.get('targets', 'x1').status, 'WATCHING');
  s.update('targets', 'x1', { status: 'HOT_TARGET' });
  assert.equal(s.get('targets', 'x1').status, 'HOT_TARGET');
  assert.equal(s.count('targets', { status: 'HOT_TARGET' }), 1);
  assert.equal(s.remove('targets', 'x1'), true);
  assert.equal(s.get('targets', 'x1'), null);
});

test('MemoryStore find with equality filter', () => {
  const s = new MemoryStore();
  s.insert('targets', row({ id: 'a', collection_id: 'c1', target_number: 7777 }));
  s.insert('targets', row({ id: 'b', collection_id: 'c1', target_number: 10000 }));
  assert.equal(s.find('targets', { collection_id: 'c1' }).length, 2);
  assert.equal(s.find('targets', { collection_id: 'c1', target_number: 7777 }).length, 1);
});

test('MemoryStore tx is atomic (sync)', () => {
  const s = new MemoryStore();
  const out = s.tx(() => {
    s.insert('targets', row({ id: 'tx' }));
    return s.count('targets');
  });
  assert.equal(out, 1);
});

test('FileStore persists across restarts (GitHub Actions mode)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uge-'));
  const s1 = new FileStore(dir);
  s1.insert('targets', row({ id: 'persist-me', target_number: 555 }));
  s1.insert('target_events', { id: 'e1', target_id: 'persist-me', from_status: 'WATCHING', to_status: 'PREDICTED', created_at: new Date().toISOString() });
  s1.flushAll();

  // "restart": a brand new store instance over the same directory
  const s2 = new FileStore(dir);
  assert.equal(s2.get('targets', 'persist-me').target_number, 555);
  assert.equal(s2.count('target_events'), 1);
  rmSync(dir, { recursive: true, force: true });
});

test('createStore selects backend', () => {
  assert.ok(createStore({}) instanceof MemoryStore);
  assert.ok(createStore({ DB_BACKEND: 'memory' }) instanceof MemoryStore);
  const dir = mkdtempSync(join(tmpdir(), 'uge-'));
  assert.ok(createStore({ DB_BACKEND: 'file', DB_DIR: dir }) instanceof FileStore);
  rmSync(dir, { recursive: true, force: true });
});

test('all schema tables exist', () => {
  const s = new MemoryStore();
  for (const t of TABLES) {
    assert.ok(s.tables.has(t), `table ${t} missing`);
  }
});
