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
      { connectionRetries: 3 }
    );
    await this.client.connect();
    return this.client;
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
}

export default MtprotoClient;
