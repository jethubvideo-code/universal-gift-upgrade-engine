# INTERFACES — module contract (single source of truth for all modules)

Conventions:
- Node >= 20, pure ESM (`"type":"module"`), **zero runtime dependencies**. Optional deps (`telegram` GramJS for MTProto, `better-sqlite3`) are loaded via dynamic `import()` inside try/catch and produce a clear CONFIG_ERROR if missing.
- All timestamps: ISO strings (`new Date().toISOString()`).
- IDs: `crypto.randomUUID()`.
- No hardcoded collection names, slugs or target numbers anywhere in `src/`. The literal `7777` etc. may appear ONLY in `test/` fixtures as example data.
- t.me/nft is never an execution API. Upgrades go through official Telegram MTProto only.
- Every state transition is written to `target_events` and `audit_logs` (via `src/services/audit.js`).
- All engine code is async where I/O is involved; store methods are synchronous (better-sqlite3 style).

## Store (`src/db.js`)
```js
export class MemoryStore {
  constructor(); init(tables: string[]) ; // no-op compatible
  insert(table, row) -> row           // row must contain id
  get(table, id) -> row | null
  update(table, id, patch) -> row    // sets updated_at; throws if missing
  find(table, filter) -> rows        // equality match on any fields
  findAll(table) -> rows
  remove(table, id) -> boolean
  count(table, filter) -> number
  tx(fn) -> result                   // atomic; MemoryStore: single-threaded sync execution IS atomic;
                                     // SQLite backend: BEGIN IMMEDIATE transaction
}
export class SQLiteStore { /* same interface, dynamic better-sqlite3, reads db/schema.sql */ }
export function createStore(config) -> store   // config.DB_BACKEND
export const TABLES = ['users','telegram_sessions','gift_collections','gifts','targets','target_events',
  'upgrade_jobs','upgrade_attempts','payments','notifications','audit_logs','collection_state','locks']
```
Locks (`locks` table) are acquired inside `store.tx` with expiry check — that is the atomic lock primitive.

## Errors (`src/core/errors.js`)
```js
export class EngineError extends Error { constructor(code, message, extra) } // extra: {seconds, retryable}
export const ErrorCodes = {
  FLOOD_WAIT, RATE_LIMIT, TIMEOUT, NETWORK_ERROR, PAYMENT_REQUIRED, UPGRADE_UNAVAILABLE,
  ALREADY_UPGRADED, INVALID_SAVED_GIFT, SESSION_ERROR, AUTH_ERROR, PRICE_LIMIT_EXCEEDED,
  VERIFICATION_FAILED, LOCK_BUSY, CONFIG_ERROR, NOT_FOUND, STORAGE_ERROR }
```

## Logger (`src/core/logger.js`)
```js
export function createLogger(name) // -> { info, warn, error, debug } ; JSON lines to stdout; never logs secrets
```

## Config (`src/core/config.js`)
```js
export function loadConfig(env = process.env) // frozen object; fields mirror .env.example:
// BOT_TOKEN, TG_API_ID, TG_API_HASH, SESSION_ENCRYPTION_KEY, DB_BACKEND, DB_PATH, TEST_MODE,
// PORT, MINIAPP_URL, POLL_CONCURRENCY, CACHE_TTL_MS, WORKER_TICK_MS, COLLECTION_SOURCE, GIFTTRACKER_DATA_URL
// throws EngineError(CONFIG_ERROR) if required fields missing when TEST_MODE=false
```

## State machine (`src/core/state-machine.js`)
```js
export const TargetStates = { WATCHING, PREDICTED, HOT_TARGET, VERIFYING, UPGRADE_READY,
  PAYMENT_REQUIRED, UPGRADING, CONFIRMING, COMPLETED, FAILED, PRICE_LIMIT_EXCEEDED, UNAVAILABLE, LOCKED }
export const TargetTransitions = { /* from -> Set of allowed to states */ }
export function canTransition(from, to) -> boolean
export function transition(row, to, { reason, details }) -> { row: newRow, event: {target_id, from_status, to_status, reason, details_json, created_at} }
```
Allowed transitions (summary): WATCHING→{PREDICTED,HOT_TARGET,UNAVAILABLE,FAILED,LOCKED}; PREDICTED→{HOT_TARGET,WATCHING,UNAVAILABLE,FAILED}; HOT_TARGET→{VERIFYING,WATCHING,PREDICTED,UNAVAILABLE,FAILED}; VERIFYING→{UPGRADE_READY,WATCHING,PAYMENT_REQUIRED,UNAVAILABLE,FAILED,PRICE_LIMIT_EXCEEDED}; UPGRADE_READY→{UPGRADING,PAYMENT_REQUIRED,WATCHING,FAILED,PRICE_LIMIT_EXCEEDED,UNAVAILABLE}; PAYMENT_REQUIRED→{UPGRADING,UPGRADE_READY,FAILED,PRICE_LIMIT_EXCEEDED}; UPGRADING→{CONFIRMING,FAILED,UPGRADE_READY}; CONFIRMING→{COMPLETED,FAILED}; any→FAILED/LOCKED where sensible; PRICE_LIMIT_EXCEEDED→{WATCHING,FAILED}; UNAVAILABLE→{WATCHING,FAILED}; COMPLETED/FAILED terminal (FAILED may re-enter WATCHING on manual retry).

## Locks (`src/core/locks.js`)
```js
export class LockManager {
  constructor(store, { ttlMs = 30000 })
  acquire(key, { ownerId }) -> token | null   // atomic via store.tx on `locks` table; expired rows are stealable
  release(key, token) -> boolean
  withLock(key, fn, { ownerId }) -> result    // LOCK_BUSY EngineError if not acquired; always releases
}
```

## Rate limiter (`src/core/rate-limiter.js`)
```js
export class TelegramRateLimiter {
  constructor({ globalPerSecond = 20, perAccountPerMethodMinIntervalMs = 1200, maxQueue = 10000 })
  async run({ account, method, priority = 3 }, fn) -> result
  // token-bucket per (account, method) + global cap; P0 jobs jump the queue.
  // If fn throws EngineError(FLOOD_WAIT) with extra.seconds, the limiter sets a global cooldown
  // for that (account, method) and RE-THROWS — the caller's retry manager decides backoff.
  stats() -> { queued, activePerMethod }
}
```
Priorities: `export const P = { P0: 0, P1: 1, P2: 2, P3: 3 }`

## Retry manager (`src/core/retry-manager.js`)
```js
export function classifyError(err) -> { kind: 'temporary'|'permanent', code }
// temporary: FLOOD_WAIT, RATE_LIMIT, TIMEOUT, NETWORK_ERROR, LOCK_BUSY, SESSION_ERROR
// permanent: ALREADY_UPGRADED, INVALID_SAVED_GIFT, AUTH_ERROR, PRICE_LIMIT_EXCEEDED, UPGRADE_UNAVAILABLE, VERIFICATION_FAILED, CONFIG_ERROR
export class RetryManager {
  constructor({ maxRetries = 5, baseMs = 250, maxMs = 15000 })
  async run(fn, { onRetry, label }) -> result   // exp backoff + jitter; FLOOD_WAIT uses err.extra.seconds
  // permanent -> throw immediately; maxRetries exceeded -> throw last error
}
```

## Metrics (`src/core/metrics.js`)
```js
export class Metrics {
  counter(name, labels?, inc = 1); gauge(name, value, labels?); observe(name, value, labels?) // histogram buckets
  snapshot() -> object; renderText() -> string
  // canonical names used across the engine:
  // collections_monitored, active_targets, hot_targets, queue_latency_ms, api_latency_ms,
  // detection_latency_ms, verification_latency_ms, execution_latency_ms, total_latency_ms,
  // upgrades_success, upgrades_failed, rate_limit_events, payment_failures, flood_wait_events
}
export function withTimer(metrics, name, labels, fn) // observes duration ms, returns fn result
```

## Target manager (`src/engine/target-manager.js`)
```js
export class TargetManager {
  constructor(store)
  create({ user_id, collection_id, gift_id, target_number, auto_upgrade = false, max_upgrade_stars = null, priority = 3 }) -> row  // status = WATCHING; target_number validated: integer >= 1
  get(id); listByUser(userId); listActive(); listByStatus(status)
  setAutoUpgrade(id, { auto_upgrade, max_upgrade_stars })
  applyTransition(id, to, { reason, details }) -> row  // uses core/state-machine, persists target_events + audit_logs
  delete(id)
}
```

## Target index (`src/engine/target-index.js`)
```js
export class TargetIndex {  // in-memory, O(1) lookups, rebuilt from store on restart
  add(row); remove(id); replaceAll(rows); get(id)
  byCollection(collectionId); byGiftId(giftId); byNumber(collectionId, number)
  hot(); active(); byUser(userId); stats() -> { total, active, hot }
  markHot(id); unmarkHot(id)
}
```

## Collection state cache (`src/engine/collection-state.js`)
```js
export class CollectionStateCache {
  constructor({ ttlMs = 60000 })
  get(collectionId) -> state | null   // null if expired
  set(collectionId, state)             // {collection_id,total_supply,upgraded_count,remaining,next_expected_number,last_update,source,version}
  computeNextExpected(totalSupply, upgradedCount) -> min(upgradedCount + 1, totalSupply)
  stale(collectionId) -> boolean; all() -> states
  persist(store) / load(store)         // collection_state table
}
```

## Target scheduler (`src/engine/target-scheduler.js`)
```js
export class TargetScheduler {  // shared worker pool; one task per COLLECTION, never per user
  constructor({ concurrency = 8 })
  schedulePoll({ key, priority = 3, intervalMs, fn })    // adaptive: priority P1/P2 shorten interval
  setPriority(key, priority)
  cancel(key); runOnce({ key, priority = 3, label }, fn) // one-off job, P0 preempts queue
  stats() -> { tasks, queued, running }
}
```

## Collection monitor (`src/engine/collection-monitor.js`)
```js
export class CollectionMonitor {
  constructor({ gifts, cache, scheduler, onUpdate, logger, metrics })
  track(collectionId)          // idempotent; creates single shared poll task
  untrack(collectionId)         // only cancels when no active targets remain for that collection
  refresh(collectionId) -> state // one fetch, cache.set, emit onUpdate(state); updates metrics
  trackedCount()
}
// onUpdate callback: async (state) => void  — consumed by HotTargetEngine
```

## Hot target engine (`src/engine/hot-target-engine.js`)
```js
export class HotTargetEngine {
  constructor({ store, targets, index, monitor, cache, sessions, savedGifts, executor,
                scheduler, locks, limiter, notifier, metrics, logger })
  evaluate(target, state) -> 0|1|2|3
  // P0: state already allows the upgrade (verified available); P1: targetNumber === next_expected_number;
  // P2: |next_expected - target_number| <= distance (default 3); P3: otherwise
  async onCollectionUpdate(state)   // re-evaluates that collection's targets; WATCHING→PREDICTED→HOT_TARGET; pre-stages HOT targets
  async preStage(target)           // section 7: load user + session, resolve saved gift for the target number,
                                    // prepare InputSavedStarGift payload, check auth + max price limit; leaves
                                    // everything ready so the actual upgrade does only the final API calls
  async handleHot(target)           // VERIFYING -> verify via Telegram -> UPGRADE_READY -> execute -> CONFIRMING -> COMPLETED
                                    // guarded by locks.withLock(`target:${id}`), idempotent via upgrade_jobs.idempotency_key
  detect(target, state, ts)         // records detection_latency_ms
}
```

## MTProto client (`src/telegram/mtproto-client.js`)
```js
export function encryptSession(plain, key) / decryptSession(enc, key) // AES-256-GCM, node:crypto
export class GramJsTransport {  // dynamic import('telegram'); StringSession; client.invoke(method, params)
  constructor({ apiId, apiHash, sessionPlain, onAuthError }) ; async connect(); async invoke(method, params); async disconnect()
}
export class MtprotoClient { // wraps transport; TEST_MODE/injected fake transport supported
  constructor({ apiId, apiHash, sessionEncrypted, encryptionKey, transport }) 
  async connect(); async invoke(method, params); async disconnect()
}
```
Methods invoked (names per current Telegram TL schema, no invented params):
`payments.getSavedStarGifts`, `payments.getStarGiftUpgradePreview`, `payments.getStarGiftUpgradeAttributes`,
`payments.getPaymentForm`, `payments.upgradeStarGift`, constructors `inputInvoiceStarGiftUpgrade`, `InputSavedStarGift`.
Schema is subject to Telegram layers — the transport isolates schema drift; docs/TELEGRAM_API.md explains verification against the current layer.

## Telegram gifts (`src/telegram/telegram-gifts.js`)
```js
export class TelegramGiftsClient {
  constructor({ client, limiter, store, source = 'mtproto', gifttrackerUrl })
  async discoverCollections() -> rows  // payments.getStarGifts (dynamic discovery — new collections appear automatically)
  async getCollectionState(collectionId) -> state  // {total_supply, upgraded_count, remaining, next_expected_number, last_update, source, version}
  syncCollections(store)               // upserts gift_collections + gifts tables
  // source='gifttracker': reads GiftTracker docs/gifts.json (existing project, read-only integration)
}
```

## Saved gifts (`src/telegram/saved-gifts.js`)
```js
export class SavedGiftsClient {
  constructor({ client, limiter })
  async getSavedStarGifts({ userSession }) -> [{gift_id, gift_num, msg_id, saved_id, slug, can_upgrade, upgraded, prepaid_upgrade, upgrade_stars, collection_id}]
  findForTarget(saved, { gift_id, target_number }) -> match | null   // gift_num === target_number
}
```

## Upgrade executor (`src/telegram/upgrade-executor.js`)
```js
export class UpgradeExecutor {
  constructor({ savedGifts, payments, locks, limiter, retry, metrics, logger })
  async verify({ userSession, target }) -> { ok, reason, canUpgrade, price, savedGift }
  // section 8: gift exists, belongs to user, gift_num === target.target_number, !upgraded,
  // can_upgrade === true, price <= target.max_upgrade_stars (when auto_upgrade)
  async execute({ userSession, target, savedGift, idempotencyKey }) -> { status, details, latency }
  // prepaid_upgrade -> payments.upgradeStarGift(InputSavedStarGift) via PaymentExecutor
  // paid upgrade -> inputInvoiceStarGiftUpgrade flow; PRICE_LIMIT_EXCEEDED if price > max (no Stars spent)
}
```

## Payment executor (`src/telegram/payment-executor.js`)
```js
export class PaymentExecutor {
  constructor({ client, limiter, retry, metrics })
  async getUpgradePreview({ userSession, savedGift })
  async upgradePrepaid({ userSession, savedGift })          // payments.upgradeStarGift
  async beginPaidUpgrade({ userSession, target, savedGift }) // inputInvoiceStarGiftUpgrade -> payments.getPaymentForm -> official flow
  // NEVER emulates UI, never clicks browser buttons, never bypasses Telegram.
}
```

## Sessions (`src/telegram/user-sessions.js`)
```js
export class UserSessionManager {  // store-backed; sessions encrypted at rest
  constructor({ store, encryptionKey })
  save({ user_id, session_encrypted, dc_id }); get(userId) -> row | null; remove(userId)
  // never accepts SMS codes / 2FA passwords / login codes via chat; only finished session strings
  // through the official Telegram authorization mechanism run by the user.
}
```

## Notifications (`src/services/notifications.js`)
```js
export class Notifier {
  constructor({ botToken, api = 'https://api.telegram.org', store })
  async targetActivated({ chatId, collectionTitle, targetNumber, current, expected })
  async upgradeCompleted({ chatId, collectionTitle, targetNumber, slug, collectible })
  async priceLimitExceeded({ chatId, collectionTitle, current, max })
  async send(chatId, text)  // persists to notifications table; non-blocking on failure
}
```

## Audit (`src/services/audit.js`)
```js
export function audit(store, { actor_type, actor_id, action, entity_type, entity_id, details })
```

## Mini App auth (`src/services/miniapp-auth.js`)
```js
export function validateInitData(initData, botToken) -> { ok, user, authDate }
// official Telegram HMAC-SHA256 initData validation (web_app data check)
```

## Composition root (`src/index.js`)
```js
export async function createEngine({ config, store, transport }) -> engine
// engine: { start(), stop(), store, targets, index, monitor, cache, scheduler, hot, metrics, api }
// - builds all modules, registers collections from TelegramGiftsClient.syncCollections (dynamic),
// - starts one shared poll per tracked collection,
// - RESTART RECOVERY: index.replaceAll(active targets from store), hot targets re-enqueued,
//   pending upgrade_jobs resumed, collection_state cache reloaded, locks expired rows purged.
// main(): node src/index.js — runs engine + api/server.js; graceful SIGINT/SIGTERM shutdown.
```

## API server (`api/server.js`)
Zero-dep `node:http` server. Endpoints (JSON):
- `GET /api/health` — metrics snapshot
- `GET /api/collections`
- `GET /api/targets` (Mini App initData auth) | `POST /api/targets` body {collection_id, gift_id, target_number}
- `POST /api/targets/:id/auto-upgrade` body {auto_upgrade, max_upgrade_stars}
- `DELETE /api/targets/:id`
- `GET /api/my-gifts` (requires linked MTProto session)
- `GET /api/history` (target_events)
- `GET /api/state` (collection states for target cards)
All writes require validated initData. CORS: same-origin / configured origin only. **No secrets in frontend.**

## Bot (`bot/bot.js`)
Long-polling Bot API (fetch): `/start` (welcome + Mini App web_app button), `/targets`, `/mygifts`, `/settings`. Delegates logic to `createEngine`'s store; talks to the same engine instance or its own lightweight store connection.

## Mini App (`miniapp/`)
Vanilla HTML/JS/CSS, deployable to GitHub Pages. Tabs: MY GIFTS / TARGETS / AUTO UPGRADE / HISTORY / SETTINGS.
Target Card per section 23; HOT TARGET banner per section 24 (🔥 HOT TARGET → ⚡ UPGRADE READY → ✅ UPGRADE COMPLETED).
Calls the protected backend API with `Telegram.WebApp.initData`. Zero secrets in the bundle.
