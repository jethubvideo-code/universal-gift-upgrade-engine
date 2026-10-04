import test from 'node:test';
import assert from 'node:assert/strict';
import { TargetIndex } from '../src/engine/target-index.js';
import { TargetManager } from '../src/engine/target-manager.js';
import { MemoryStore } from '../src/db.js';

const mk = (store) => {
  const targets = new TargetManager(store);
  const index = new TargetIndex();
  const add = (opts) => { const row = targets.create(opts); index.add(row); return row; };
  return { targets, index, add };
};

test('index lookups: byCollection / byNumber / byGiftId / byUser', () => {
  const { index, add } = mk(new MemoryStore());
  add({ user_id: 'u1', collection_id: 'coll-A', gift_id: 'g-1', target_number: 7777 });
  add({ user_id: 'u1', collection_id: 'coll-A', gift_id: 'g-1', target_number: 10000 });
  add({ user_id: 'u2', collection_id: 'coll-B', gift_id: 'g-2', target_number: 1234 });

  assert.equal(index.byCollection('coll-A').length, 2);
  assert.equal(index.byCollection('coll-B').length, 1);
  assert.equal(index.byNumber('coll-A', 7777).length, 1);
  assert.equal(index.byNumber('coll-A', 7777)[0].target_number, 7777);
  assert.equal(index.byGiftId('g-2').length, 1);
  assert.equal(index.byUser('u1').length, 2);
  assert.equal(index.byUser('u2').length, 1);
});

test('MULTI-TARGET: same user, same collection, different numbers — independent state each', () => {
  const { index, add } = mk(new MemoryStore());
  add({ user_id: 'u1', collection_id: 'coll-A', gift_id: 'g', target_number: 7777 });
  add({ user_id: 'u1', collection_id: 'coll-A', gift_id: 'g', target_number: 8888 });
  add({ user_id: 'u1', collection_id: 'coll-B', gift_id: 'g2', target_number: 1234 });
  add({ user_id: 'u1', collection_id: 'coll-C', gift_id: 'g3', target_number: 10000 });
  const mine = index.byUser('u1');
  assert.equal(mine.length, 4);
  assert.deepEqual(mine.map(t => t.collection_id).sort(), ['coll-A', 'coll-A', 'coll-B', 'coll-C']);
});

test('500 users watching the SAME number of the SAME collection — index finds all instantly', () => {
  const { index, add } = mk(new MemoryStore());
  for (let i = 0; i < 500; i++) {
    add({ user_id: `u${i}`, collection_id: 'coll-X', gift_id: 'g', target_number: 5555 });
  }
  assert.equal(index.byNumber('coll-X', 5555).length, 500);
  assert.equal(index.byCollection('coll-X').length, 500);
});

test('markHot / unmarkHot / hot() / active()', () => {
  const { index, add } = mk(new MemoryStore());
  const a = add({ user_id: 'u', collection_id: 'c', gift_id: 'g', target_number: 1 });
  const b = add({ user_id: 'u', collection_id: 'c', gift_id: 'g', target_number: 2 });
  index.markHot(a.id);
  assert.equal(index.hot().length, 1);
  assert.equal(index.active().length, 2);
  index.unmarkHot(a.id);
  assert.equal(index.hot().length, 0);
  void b;
});

test('replaceAll: restart recovery rebuilds all indexes', () => {
  const { index, add } = mk(new MemoryStore());
  add({ user_id: 'u1', collection_id: 'c1', gift_id: 'g1', target_number: 7 });
  add({ user_id: 'u2', collection_id: 'c2', gift_id: 'g2', target_number: 777 });
  // simulate restart: fresh index, rows reloaded from store
  const fresh = new TargetIndex();
  fresh.replaceAll([index.get('nonexistent')].filter(Boolean));
  assert.equal(fresh.stats().total, 0);
  // real path: manager loads from store
  const store = new MemoryStore();
  const tm = new TargetManager(store);
  const row = tm.create({ user_id: 'u', collection_id: 'c', gift_id: 'g', target_number: 7777 });
  const ix2 = new TargetIndex();
  ix2.replaceAll(store.findAll('targets'));
  assert.equal(ix2.byNumber('c', 7777).length, 1);
  assert.equal(ix2.get(row.id).status, 'WATCHING');
});

test('TargetManager validates target_number (ANY integer >= 1, no special cases)', () => {
  const store = new MemoryStore();
  const tm = new TargetManager(store);
  for (const n of [1, 7, 777, 1234, 10000, 999999]) {
    const t = tm.create({ user_id: 'u', collection_id: 'c', gift_id: 'g', target_number: n });
    assert.equal(t.target_number, n);
    assert.equal(t.status, 'WATCHING');
  }
  assert.throws(() => tm.create({ user_id: 'u', collection_id: 'c', gift_id: 'g', target_number: 0 }));
  assert.throws(() => tm.create({ user_id: 'u', collection_id: 'c', gift_id: 'g', target_number: 'abc' }));
  assert.throws(() => tm.create({ user_id: 'u', collection_id: 'c', gift_id: 'g', target_number: 3.5 }));
});
