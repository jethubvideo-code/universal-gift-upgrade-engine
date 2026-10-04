-- Universal Gift Upgrade Engine — schema
-- All identifiers are dynamic. No collection name or gift number is hardcoded anywhere.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  telegram_id TEXT UNIQUE,
  username TEXT,
  chat_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- AES-256-GCM encrypted MTProto session string. NEVER stored in plaintext.
  session_encrypted TEXT NOT NULL,
  dc_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gift_collections (
  id TEXT PRIMARY KEY,
  collection_id TEXT UNIQUE NOT NULL,   -- Telegram collection identifier (dynamic)
  title TEXT,
  slug TEXT,
  total_supply INTEGER,
  attributes_json TEXT,
  model_count INTEGER,
  pattern_count INTEGER,
  backdrop_count INTEGER,
  rarity TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gifts (
  id TEXT PRIMARY KEY,
  gift_id TEXT UNIQUE NOT NULL,         -- Telegram gift identifier (dynamic)
  collection_id TEXT NOT NULL,
  slug TEXT,
  name TEXT,
  model_json TEXT,
  pattern_json TEXT,
  backdrop_json TEXT,
  rarity TEXT,
  total_supply INTEGER,
  upgraded_count INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  gift_id TEXT NOT NULL,
  target_number INTEGER NOT NULL,      -- ANY number the user chooses: 1, 7, 777, 1111, 4444, 7777, 10000, N
  auto_upgrade INTEGER NOT NULL DEFAULT 0,
  max_upgrade_stars INTEGER,           -- user-set maximum upgrade price in Stars; NULL = manual only
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'WATCHING',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_targets_coll ON targets(collection_id, status);
CREATE INDEX IF NOT EXISTS idx_targets_num ON targets(collection_id, target_number);
CREATE INDEX IF NOT EXISTS idx_targets_user ON targets(user_id);
CREATE INDEX IF NOT EXISTS idx_targets_status ON targets(status);

CREATE TABLE IF NOT EXISTS target_events (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  reason TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_target ON target_events(target_id);

CREATE TABLE IF NOT EXISTS upgrade_jobs (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,                -- QUEUED | RUNNING | DONE | FAILED
  idempotency_key TEXT UNIQUE,         -- makes upgrade idempotent across retries/restarts
  payload_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_target ON upgrade_jobs(target_id, status);

CREATE TABLE IF NOT EXISTS upgrade_attempts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  error_code TEXT,
  error_text TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  target_id TEXT,
  stars_amount INTEGER,
  status TEXT NOT NULL,
  provider_reference TEXT,
  tx_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  chat_id TEXT,
  kind TEXT NOT NULL,                  -- TARGET_ACTIVATED | UPGRADE_COMPLETED | PRICE_LIMIT_EXCEEDED | ...
  payload_json TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_state (
  collection_id TEXT PRIMARY KEY,
  total_supply INTEGER,
  upgraded_count INTEGER,
  remaining INTEGER,
  next_expected_number INTEGER,        -- PREDICTION ONLY; actual Telegram state is source of truth
  last_update TEXT,
  source TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locks (
  key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
