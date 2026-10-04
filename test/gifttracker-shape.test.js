/**
 * Regression: gifttracker-bot live data shape.
 * Real public snapshot (docs/gifts.json of gifttracker-bot, verified
 * 2026-10-04) uses { slug, name, issued, total, added } — NOT
 * total_supply/upgraded_count. A parser regression here silently zeroes the
 * whole prediction pipeline (never HOT), so the shape is pinned by test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramGiftsClient } from '../src/telegram/telegram-gifts.js';
import { createStore } from '../src/db.js';

// Exact live fixture (first rows of the public gifts.json, 2026-10-04).
const LIVE_FIXTURE = {
  gifts: [
    { slug: 'algorithmcup', name: 'algorithmcup', issued: 165, total: 188, added: 0 },
    { slug: 'PlushPepe', name: 'Plush Pepe', issued: 2825, total: 2861, added: 1 }
  ]
};

function clientWithFixture() {
  const store = createStore({ DB_BACKEND: 'memory' });
  return new TelegramGiftsClient({
    source: 'gifttracker',
    gifttrackerUrl: 'https://fixture.local/gifts.json',
    store,
    fetchImpl: async () => ({ ok: true, json: async () => LIVE_FIXTURE })
  });
}

test('GIFTTRACKER: live shape { slug, name, issued, total } maps correctly', async () => {
  const c = clientWithFixture();
  const cols = await c.discoverCollections();
  assert.equal(cols.length, 2);
  const pepe = cols.find(x => x.slug === 'PlushPepe');
  assert.equal(pepe.total_supply, 2861);
  assert.equal(pepe.upgraded_count, 2825);
  assert.equal(pepe.name, 'Plush Pepe');
});

test('GIFTTRACKER: getCollectionState produces the next expected number', async () => {
  const c = clientWithFixture();
  const st = await c.getCollectionState('PlushPepe');
  assert.equal(st.upgraded_count, 2825);
  assert.equal(st.remaining, 36);
  assert.equal(st.next_expected_number, 2826);
});
