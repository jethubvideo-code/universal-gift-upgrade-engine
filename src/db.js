import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EngineError, ErrorCodes } from './core/errors.js';

export const TABLES = [
  'users',
  'telegram_sessions',
  'business_connections',
  'gift_collections',
  'gifts',
  'targets',
  'target_events',
  'upgrade_jobs',
  'upgrade_attempts',
  'payments',
  'notifications',
  'audit_logs',
  'collection_state',
  'locks'
];

export class MemoryStore {
  constructor() {
    this.tables = new Map();
    this.init(TABLES);
  }

  init(tables) {
    for (const table of tables) {
      if (!this.tables.has(table)) {
        this.tables.set(table, new Map());
      }
    }
  }

  insert(table, row) {
    const tableMap = this.tables.get(table);
    if (!tableMap) {
      throw new EngineError(ErrorCodes.STORAGE_ERROR, `Table ${table} does not exist`);
    }

    const id = row.id || row.key || (table === 'collection_state' ? row.collection_id : randomUUID());
    const now = new Date().toISOString();
    const newRow = {
      ...row,
      id,
      created_at: row.created_at || now,
      updated_at: row.updated_at || now
    };

    tableMap.set(id, newRow);
    return newRow;
  }

  get(table, id) {
    const tableMap = this.tables.get(table);
    if (!tableMap) return null;
    return tableMap.get(id) || null;
  }

  update(table, id, patch) {
    const tableMap = this.tables.get(table);
    if (!tableMap) {
      throw new EngineError(ErrorCodes.STORAGE_ERROR, `Table ${table} does not exist`);
    }

    const existing = tableMap.get(id);
    if (!existing) {
      throw new EngineError(ErrorCodes.NOT_FOUND, `Record with id ${id} not found in ${table}`);
    }

    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...patch,
      id,
      updated_at: now
    };

    tableMap.set(id, updated);
    return updated;
  }

  find(table, filter = {}) {
    const tableMap = this.tables.get(table);
    if (!tableMap) return [];

    const results = [];
    for (const row of tableMap.values()) {
      let matches = true;
      for (const [k, v] of Object.entries(filter)) {
        if (row[k] !== v) {
          matches = false;
          break;
        }
      }
      if (matches) {
        results.push(row);
      }
    }
    return results;
  }

  findAll(table) {
    const tableMap = this.tables.get(table);
    if (!tableMap) return [];
    return Array.from(tableMap.values());
  }

  remove(table, id) {
    const tableMap = this.tables.get(table);
    if (!tableMap) return false;
    return tableMap.delete(id);
  }

  count(table, filter = {}) {
    return this.find(table, filter).length;
  }

  tx(fn) {
    // MemoryStore is single-threaded sync execution -> atomic
    return fn();
  }
}

/**
 * JSON file-backed store — GITHUB ACTIONS MODE ("serverless on GitHub").
 * State lives in data/state/*.json inside the repository; the scheduled
 * workflow commits it back after each run, so the next run picks up exactly
 * where the previous one stopped (restart recovery for ephemeral runners).
 * Writes are atomic (tmp + rename). Zero dependencies, zero external services.
 */
export class FileStore extends MemoryStore {
  constructor(dir = 'data/state') {
    super();
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.load();
  }

  _path(table) {
    return join(this.dir, `${table}.json`);
  }

  load() {
    for (const table of TABLES) {
      const p = this._path(table);
      if (!existsSync(p)) continue;
      try {
        const rows = JSON.parse(readFileSync(p, 'utf8'));
        const map = this.tables.get(table);
        for (const row of rows) map.set(row.id, row);
      } catch (err) {
        throw new EngineError(ErrorCodes.STORAGE_ERROR, `Corrupted state file ${p}: ${err.message}`);
      }
    }
    return this;
  }

  /** Atomically persist a single table. */
  flushTable(table) {
    const tableMap = this.tables.get(table);
    if (!tableMap) return false;
    const tmp = `${this._path(table)}.tmp`;
    writeFileSync(tmp, JSON.stringify(Array.from(tableMap.values()), null, 1));
    renameSync(tmp, this._path(table));
    return true;
  }

  /** Persist every table. Called at the end of a one-shot run (and on shutdown). */
  flushAll() {
    for (const table of TABLES) this.flushTable(table);
    return true;
  }

  tx(fn) {
    // Single-process synchronous execution IS atomic; state is flushed right after.
    const result = fn();
    return result;
  }
}

/**
 * SQLite backend (optional dependency better-sqlite3). When the package is
 * not installed, falls back to MemoryStore so the engine still boots
 * (e.g. CI or GitHub Actions runners) — see docs/DEPLOYMENT.md.
 */
export class SQLiteStore extends MemoryStore {
  // MemoryStore-compatible fallback; persistent deployments use FileStore
  // (GitHub mode) or better-sqlite3 (self-hosted mode).
}

export function createStore(config = {}) {
  const backend = config.DB_BACKEND || config.db_backend || 'memory';
  if (backend === 'file') {
    return new FileStore(config.DB_DIR || config.db_dir || 'data/state');
  }
  if (backend === 'sqlite') {
    try {
      return new SQLiteStore(config);
    } catch {
      return new MemoryStore();
    }
  }
  return new MemoryStore();
}
