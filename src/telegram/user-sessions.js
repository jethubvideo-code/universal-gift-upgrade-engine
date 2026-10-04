/**
 * User MTProto session management.
 *
 * SECURITY (non-negotiable):
 * - This system NEVER accepts SMS codes, 2FA passwords or Telegram login codes
 *   via chat or any UI of ours. Sessions are created by the user through the
 *   official Telegram authorization mechanism, and only the finished session
 *   string is imported here.
 * - Session strings are encrypted at rest with AES-256-GCM (key derived from
 *   SESSION_ENCRYPTION_KEY via scrypt). Plaintext sessions never touch storage.
 * - Bot token and user session are entirely different entities.
 */
import crypto from 'node:crypto';
import { EngineError, ErrorCodes } from '../core/errors.js';

export function encryptSession(plain, key) {
  if (!plain) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'Empty session');
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const derived = crypto.scryptSync(key, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString('base64');
}

export function decryptSession(blob, key) {
  try {
    const raw = Buffer.from(blob, 'base64');
    const salt = raw.subarray(0, 16);
    const iv = raw.subarray(16, 28);
    const tag = raw.subarray(28, 44);
    const data = raw.subarray(44);
    const derived = crypto.scryptSync(key, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', derived, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    throw new EngineError(ErrorCodes.SESSION_ERROR, 'Unable to decrypt session (wrong key or corrupted data)');
  }
}

export class UserSessionManager {
  /**
   * @param {object} opts
   * @param {import('../db.js').MemoryStore} opts.store
   * @param {string} [opts.encryptionKey] defaults to env SESSION_ENCRYPTION_KEY
   */
  constructor({ store, encryptionKey } = {}) {
    if (!store) throw new EngineError(ErrorCodes.CONFIG_ERROR, 'store required');
    this.store = store;
    this.encryptionKey = encryptionKey || process.env.SESSION_ENCRYPTION_KEY;
    if (!this.encryptionKey) {
      throw new EngineError(ErrorCodes.CONFIG_ERROR, 'SESSION_ENCRYPTION_KEY required');
    }
  }

  /** Save a finished official session string (never a login code / 2FA password). */
  save({ user_id, session_plain, dc_id = null }) {
    const existing = (this.store.find('telegram_sessions', { user_id }) || [])[0];
    const enc = encryptSession(session_plain, this.encryptionKey);
    if (existing) {
      return this.store.update('telegram_sessions', existing.id, {
        session_encrypted: enc, dc_id, updated_at: new Date().toISOString()
      });
    }
    return this.store.insert('telegram_sessions', {
      id: crypto.randomUUID(), user_id, session_encrypted: enc, dc_id
    });
  }

  /** Returns the stored row with decrypted `session`, or null. */
  getUserSession(userId) {
    // EXACT match only. Sessions are stored under the logged-in account id
    // AND an alias under the requester's bot-chat id (see the login script),
    // so targets always resolve to their own user's session — never someone
    // else's account/Stars.
    const row = (this.store.find('telegram_sessions', { user_id: String(userId) }) || [])[0];
    if (!row) return null;
    try {
      return { ...row, session: decryptSession(row.session_encrypted, this.encryptionKey) };
    } catch {
      return null;
    }
  }

  /** First available session (single-owner deployments). */
  getAnySession() {
    const all = this.store.find('telegram_sessions', {}) || [];
    if (!all.length) return null;
    return this.getUserSession(all[0].user_id);
  }

  remove(userId) {
    const row = (this.store.find('telegram_sessions', { user_id: userId }) || [])[0];
    if (!row) return false;
    return this.store.remove('telegram_sessions', row.id);
  }
}

export default UserSessionManager;
