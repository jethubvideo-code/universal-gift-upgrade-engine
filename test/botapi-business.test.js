/**
 * Variant B — Bot API Business backend tests.
 * All Telegram interactions are faked via an injected fetchImpl (TEST MODE):
 * no real network, no real Stars, no real Telegram.
 *
 * Method shapes verified against the official Bot API reference
 * (Bot API 10.3, fetched 2026-10-04): upgradeGift, getBusinessAccountGifts,
 * getBusinessAccountStarBalance, getBusinessConnection, BusinessBotRights,
 * OwnedGiftRegular.unique_gift_number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BotApiClient, BotApiBusinessBackend, BusinessConnectionManager, normalizeOwnedGift } from '../src/telegram/botapi-business.js';
import { createStore } from '../src/db.js';
import { EngineError, ErrorCodes } from '../src/core/errors.js';

/** Fake Bot API: routes by method, scriptable responses + call log. */
function fakeBotApi(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    const method = url.split('/').pop();
    const params = JSON.parse(opts.body || '{}');
    calls.push({ method, params });
    const handler = routes[method];
    if (!handler) {
      return { ok: false, status: 500, statusText: `no route for ${method}`, json: async () => ({ ok: false, description: `no route for ${method}` }) };
    }
    const out = await handler(params, calls.length);
    if (out instanceof Error) {
      return { ok: false, status: out.status || 400, statusText: out.message, json: async () => out.body || { ok: false, description: out.message } };
    }
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ ok: true, result: out }) };
  };
  fn.calls = calls;
  return fn;
}

const ownedGift = (over = {}) => ({
  type: 'regular',
  gift: { id: 'plush_pepe', sticker: {}, star_count: 100, upgrade_star_count: 1000 },
  owned_gift_id: 'OG-1',
  send_date: 1791000000,
  can_be_upgraded: true,
  prepaid_upgrade_star_count: 0,
  unique_gift_number: 7777,
  ...over
});

test('BOTAPI: OwnedGiftRegular normalization (unique_gift_number -> gift_num)', () => {
  const g = normalizeOwnedGift(ownedGift());
  assert.equal(g.gift_num, 7777);
  assert.equal(g.gift_id, 'plush_pepe');
  assert.equal(g.owned_gift_id, 'OG-1');
  assert.equal(g.can_upgrade, true);
  assert.equal(g.prepaid_upgrade, false);
  assert.equal(g.upgrade_stars, 1000);
});

test('BOTAPI: unique gifts and refunded gifts are not upgradable candidates', () => {
  assert.equal(normalizeOwnedGift({ type: 'unique', gift: {} }), null);
  const refunded = normalizeOwnedGift(ownedGift({ was_refunded: true }));
  assert.equal(refunded.can_upgrade, false);
});

test('BOTAPI: getSavedStarGifts paginates via next_offset and matches target #7777', async () => {
  const fetchImpl = fakeBotApi({
    getBusinessAccountGifts: async (p, n) => n === 1
      ? { total_count: 2, gifts: [ownedGift()], next_offset: 'p2' }
      : { total_count: 2, gifts: [ownedGift({ owned_gift_id: 'OG-2', unique_gift_number: 7778 })] }
  });
  const backend = new BotApiBusinessBackend({ client: new BotApiClient({ botToken: 'T', fetchImpl }) });
  const list = await backend.getSavedStarGifts({ userSession: 'BC-42' });
  assert.equal(list.length, 2);
  assert.equal(fetchImpl.calls[0].params.business_connection_id, 'BC-42');
  assert.equal(fetchImpl.calls[1].params.offset, 'p2');
  const match = backend.findForTarget(list, { gift_id: 'plush_pepe', target_number: 7777 });
  assert.equal(match.owned_gift_id, 'OG-1');
});

test('BOTAPI: FAILS CLOSED when unique_gift_number is absent (no number proof, no upgrade)', async () => {
  const fetchImpl = fakeBotApi({
    getBusinessAccountGifts: async () => ({ gifts: [ownedGift({ unique_gift_number: undefined })] })
  });
  const backend = new BotApiBusinessBackend({ client: new BotApiClient({ botToken: 'T', fetchImpl }) });
  const list = await backend.getSavedStarGifts({ userSession: 'BC' });
  // gift_num is 0 -> cannot equal any real target number -> no match
  assert.equal(backend.findForTarget(list, { gift_id: 'plush_pepe', target_number: 7777 }), null);
  assert.equal(list[0].gift_num, 0);
});

test('BOTAPI: prepaid upgrade calls upgradeGift with star_count 0', async () => {
  const fetchImpl = fakeBotApi({ upgradeGift: async () => true });
  const backend = new BotApiBusinessBackend({ client: new BotApiClient({ botToken: 'T', fetchImpl }) });
  const res = await backend.upgradePrepaid({
    savedGift: { owned_gift_id: 'OG-1', prepaid_upgrade: true },
    userSession: 'BC-42'
  });
  assert.equal(res, true);
  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'upgradeGift');
  assert.equal(call.params.business_connection_id, 'BC-42');
  assert.equal(call.params.owned_gift_id, 'OG-1');
  assert.equal(call.params.star_count, 0);
});

test('BOTAPI: paid upgrade checks balance first, executes with gift.upgrade_star_count', async () => {
  const fetchImpl = fakeBotApi({
    getBusinessAccountStarBalance: async () => ({ star_amount: 5000 }),
    upgradeGift: async () => true
  });
  const backend = new BotApiBusinessBackend({ client: new BotApiClient({ botToken: 'T', fetchImpl }) });
  const res = await backend.beginPaidUpgrade({
    savedGift: { owned_gift_id: 'OG-1', upgrade_stars: 1000 },
    userSession: 'BC-42'
  });
  assert.equal(res.executed, true);
  assert.equal(fetchImpl.calls[0].method, 'getBusinessAccountStarBalance');
  assert.equal(fetchImpl.calls[1].params.star_count, 1000);
});

test('BOTAPI: insufficient balance -> PAYMENT_REQUIRED, upgradeGift NEVER called', async () => {
  const fetchImpl = fakeBotApi({
    getBusinessAccountStarBalance: async () => ({ star_amount: 10 }),
    upgradeGift: async () => { throw new Error('must not be called'); }
  });
  const backend = new BotApiBusinessBackend({ client: new BotApiClient({ botToken: 'T', fetchImpl }) });
  await assert.rejects(
    () => backend.beginPaidUpgrade({ savedGift: { owned_gift_id: 'OG-1', upgrade_stars: 1000 }, userSession: 'BC' }),
    (err) => err instanceof EngineError && err.code === ErrorCodes.PAYMENT_REQUIRED
  );
  assert.equal(fetchImpl.calls.filter(c => c.method === 'upgradeGift').length, 0);
});

test('BOTAPI: rights validation reports every missing business right', async () => {
  const fetchImpl = fakeBotApi({
    getBusinessConnection: async () => ({ rights: { can_view_gifts_and_stars: true } })
  });
  const backend = new BotApiBusinessBackend({ client: new BotApiClient({ botToken: 'T', fetchImpl }) });
  await assert.rejects(
    () => backend.validateRights({ userSession: 'BC' }),
    (err) => {
      assert.equal(err.code, ErrorCodes.AUTH_ERROR);
      assert.match(err.message, /can_transfer_and_upgrade_gifts/);
      assert.match(err.message, /can_transfer_stars/);
      return true;
    }
  );
});

test('BOTAPI: 429 with retry_after -> FLOOD_WAIT with seconds', async () => {
  const fetchImpl = fakeBotApi({
    getBusinessAccountGifts: async () => {
      const e = new Error('Too Many Requests');
      e.status = 429;
      e.body = { ok: false, error_code: 429, parameters: { retry_after: 120 }, description: 'Too Many Requests: retry after 120' };
      return e;
    }
  });
  const backend = new BotApiBusinessBackend({ client: new BotApiClient({ botToken: 'T', fetchImpl }) });
  await assert.rejects(
    () => backend.getSavedStarGifts({ userSession: 'BC' }),
    (err) => err.code === ErrorCodes.FLOOD_WAIT && err.extra.seconds === 120
  );
});

test('BOTAPI: business_connection update stored and exposed as a user session', () => {
  const store = createStore({ DB_BACKEND: 'memory' });
  const mgr = new BusinessConnectionManager({ store });
  const saved = mgr.saveFromUpdate({
    business_connection_id: 'BC-77',
    user: { id: 4242 },
    user_chat_id: 4242,
    date: 1791000000,
    rights: { can_view_gifts_and_stars: true, can_transfer_and_upgrade_gifts: true }
  });
  assert.ok(saved);
  const sess = mgr.getUserSession(4242);
  assert.equal(sess.session, 'BC-77');
  assert.equal(mgr.getUserSession(9999), null);
  // disabled connection -> no session
  mgr.saveFromUpdate({ business_connection_id: 'BC-77', user: { id: 4242 }, rights: {}, is_enabled: false });
  assert.equal(mgr.getUserSession(4242), null);
});
