/**
 * MTProto client wrapper.
 *
 * Real transport: GramJS (optional dependency, dynamic import — zero hard deps).
 * TEST MODE injects a fake transport with the same { connect, invoke, disconnect } shape.
 *
 * All engine code talks to Telegram ONLY through MtprotoClient.invoke(method, params).
 * TL schema drift is isolated in the transport — see docs/TELEGRAM_API.md.
 */
import { EngineError, ErrorCodes } from '../core/errors.js';

/** GramJS transport over a decrypted user session string. */
export class GramJsTransport {
  constructor({ apiId, apiHash, sessionPlain, onAuthError } = {}) {
    if (!apiId || !apiHash || !sessionPlain) {
      throw new EngineError(ErrorCodes.CONFIG_ERROR,
        'TG_API_ID, TG_API_HASH and a user session are required for the real MTProto transport');
    }
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.sessionPlain = sessionPlain;
    this.onAuthError = onAuthError;
    this.client = null;
  }

  async connect() {
    let telegram;
    try {
      telegram = await import('telegram');
    } catch {
      throw new EngineError(ErrorCodes.CONFIG_ERROR,
        "Optional dependency 'telegram' (GramJS) is not installed. Run: npm install");
    }
    const StringSession = telegram.StringSession ||
      (await import('telegram/sessions/index.js')).StringSession;
    this.client = new telegram.TelegramClient(
      new StringSession(this.sessionPlain),
      this.apiId,
      this.apiHash,
      {
        connectionRetries: 5,
        // Identify as a recent official-looking client. Telegram's gift API
        // (payments.getUniqueStarGift, upgradeStarGift, ...) rejects requests
        // from clients it judges outdated with API_GIFT_RESTRICTED_UPDATE_APP
        // ("Please update the app to access the gift API") — this is a
        // server-side heuristic on the reported app identity (initConnection),
        // not a GramJS version issue (2.26.22 is the latest published release
        // as of this build — verified against the npm registry). UNVERIFIED:
        // whether these specific strings are enough to avoid the error on a
        // brand-new session — report back the exact error if it still occurs.
        deviceModel: 'Universal Gift Upgrade Engine',
        systemVersion: 'Linux 6.1',
        appVersion: '5.5.0',
        langCode: 'en',
        systemLangCode: 'en'
      }
    );
    await this.client.connect();
    return this.client;
  }

  /** DC id of the current connection — used to pick the worker's hosting region (SETUP.md step 2). */
  getDcId() {
    try {
      return this.client?.session?.dcId ?? this.client?._sender?.dcId ?? null;
    } catch {
      return null;
    }
  }

  async invoke(method, params) {
    if (!this.client) await this.connect();
    try {
      return await this.client.invoke(new this.client.Api[method](params || {}));
    } catch (err) {
      // Normalize common MTProto errors into the engine error taxonomy.
      const msg = String(err?.message || err);
      const flood = /FLOOD_WAIT_(\d+)/.exec(msg) || (err?.errorMessage === 'FLOOD_WAIT' ? [null, err.seconds || 30] : null);
      if (flood) throw new EngineError(ErrorCodes.FLOOD_WAIT, msg, { seconds: Number(flood[1] || 30) });
      if (/UNAUTHORIZED|AUTH_KEY|SESSION_REVOKED/i.test(msg)) {
        throw new EngineError(ErrorCodes.AUTH_ERROR, msg);
      }
      if (err?.code === 'ETIMEDOUT' || /TIMEOUT/i.test(msg)) {
        throw new EngineError(ErrorCodes.TIMEOUT, msg);
      }
      if (/NETWORK|ECONNRESET|ECONNREFUSED/i.test(msg)) {
        throw new EngineError(ErrorCodes.NETWORK_ERROR, msg);
      }
      throw err;
    }
  }

  async disconnect() {
    if (this.client) await this.client.disconnect();
    this.client = null;
  }
}

/**
 * Wraps a transport. `transport` may be an injected fake (TEST MODE).
 * Without a transport this client cannot call Telegram — callers degrade
 * gracefully (monitoring via gifttracker source, no real upgrades).
 */
export class MtprotoClient {
  constructor({ apiId, apiHash, sessionPlain = null, transport = null } = {}) {
    if (transport) {
      this.transport = transport;
    } else {
      this.transport = new GramJsTransport({ apiId, apiHash, sessionPlain });
    }
  }

  async connect() { return this.transport.connect(); }
  async invoke(method, params) { return this.transport.invoke(method, params); }
  async disconnect() { return this.transport.disconnect(); }
  getDcId() { return this.transport.getDcId ? this.transport.getDcId() : null; }
}

export default MtprotoClient;


/**
 * Per-user MTProto client pool (multi-user support).
 * Each user's session gets its OWN GramJS client so a shot always executes
 * on the account that owns the target — never on another user's account.
 */
export class MtprotoSessionPool {
  constructor({ apiId, apiHash, logger = null } = {}) {
    this.apiId = apiId;
    this.apiHash = apiHash;
    this.logger = logger;
    this.clients = new Map(); // user_id -> { client, connected, connecting }
  }

  /** sessionRow: { user_id, session: <plain session string> } */
  async getClient(sessionRow) {
    if (!sessionRow?.session) throw new EngineError(ErrorCodes.CONFIG_ERROR,
      'MtprotoSessionPool.getClient requires a decrypted session');
    const uid = String(sessionRow.user_id);
    let entry = this.clients.get(uid);
    if (!entry) {
      const client = new MtprotoClient({ apiId: this.apiId, apiHash: this.apiHash, sessionPlain: sessionRow.session });
      entry = { client, connected: false };
      this.clients.set(uid, entry);
    }
    if (!entry.connected) {
      if (this.logger) this.logger.debug('MTProto per-user connect', { user_id: uid });
      await entry.client.connect();
      entry.connected = true;
    }
    return entry.client;
  }

  async disconnectAll() {
    for (const entry of this.clients.values()) {
      try { await entry.client.disconnect(); } catch {}
    }
    this.clients.clear();
  }
}
