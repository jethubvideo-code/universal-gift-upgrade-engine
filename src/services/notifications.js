import { randomUUID } from 'node:crypto';

export class Notifier {
  constructor({ botToken, api = 'https://api.telegram.org', store } = {}) {
    this.botToken = botToken;
    this.api = api;
    this.store = store;
  }

  async targetActivated({ chatId, collectionTitle, targetNumber, current, expected }) {
    const text = `🎯 HOT TARGET ACTIVATED!\nCollection: ${collectionTitle}\nTarget #${targetNumber}\nExpected: #${expected}`;
    return this.send(chatId, text, 'TARGET_ACTIVATED', { collectionTitle, targetNumber, current, expected });
  }

  async upgradeCompleted({ chatId, collectionTitle, targetNumber, slug, collectible }) {
    const text = `🎉 UPGRADE COMPLETED!\nCollection: ${collectionTitle}\nTarget #${targetNumber}`;
    return this.send(chatId, text, 'UPGRADE_COMPLETED', { collectionTitle, targetNumber, slug, collectible });
  }

  async priceLimitExceeded({ chatId, collectionTitle, current, max }) {
    const text = `⚠️ PRICE LIMIT EXCEEDED!\nCollection: ${collectionTitle}\nCurrent: ${current} Stars, Max: ${max} Stars`;
    return this.send(chatId, text, 'PRICE_LIMIT_EXCEEDED', { collectionTitle, current, max });
  }

  /**
   * Engine-facing notification entry point (HotTargetEngine, business
   * scanner, bot command handlers all call this). Resolves the user's
   * chat_id from the store, renders a Russian, ACTION-ORIENTED message per
   * kind (semi-automatic mode: the engine catches the moment, the owner
   * presses the final button), dedupes repeats per dedupKey.
   */
  async notifyUser(userId, kind, payload = {}, opts = {}) {
    let chatId = userId;
    if (this.store) {
      const u = (this.store.find('users', { telegram_id: String(userId) }) || [])[0]
        || (this.store.find('users', { id: String(userId) }) || [])[0];
      if (u?.chat_id) chatId = u.chat_id;
    }
    const c = payload.target?.collection_id || payload.collection_id || '?';
    const n = payload.target?.target_number ?? payload.target_number ?? '?';
    const next = payload.next_expected ?? payload.target?.next_expected_number ?? null;
    let text;
    switch (kind) {
      case 'TARGET_HOT':
        text =
          '🔥 \u0413\u041E\u0422\u041E\u0412\u042C \u041A \u0410\u041F\u0413\u0420\u0415\u0419\u0414\u0423!\n\n' +
          `\u041A\u043E\u043B\u043B\u0435\u043A\u0446\u0438\u044F: ${c}\n` +
          `\u0422\u0432\u043E\u0439 \u043D\u043E\u043C\u0435\u0440: #${n}` +
          (next != null ? `\n\u0421\u0435\u0439\u0447\u0430\u0441 \u0432\u044B\u0434\u0430\u0435\u0442\u0441\u044F: #${next}` : '') +
          `\n\n\u0423\u041B\u0423\u0427\u0428\u0410\u0419 \u0421\u0412\u041E\u0419 \u043F\u043E\u0434\u0430\u0440\u043E\u043A \u042D\u0422\u041E\u0419 \u043A\u043E\u043B\u043B\u0435\u043A\u0446\u0438\u0438 \u041F\u0420\u042F\u041C\u041E \u0421\u0415\u0419\u0427\u0410\u0421 — \u0432\u044B\u043F\u0430\u0434\u0435\u0442 \u0442\u0432\u043E\u0439 \u043D\u043E\u043C\u0435\u0440.\n` +
          `\u0415\u0441\u043B\u0438 \u043D\u0435\u0443\u043B\u0443\u0447\u0448\u0435\u043D\u043D\u043E\u0433\u043E \u043F\u043E\u0434\u0430\u0440\u043A\u0430 \u043D\u0435\u0442 — \u043A\u0443\u043F\u0438 \u0435\u0433\u043E \u0437\u0430\u0440\u0430\u043D\u0435\u0435 (\u0441\u043C. /mygifts).`;
        break;
      case 'TARGET_APPROACHING':
        text =
          '\u23F0 \u0411\u041B\u0418\u0417\u041A\u041E!\n\n' +
          `\u041A\u043E\u043B\u043B\u0435\u043A\u0446\u0438\u044F: ${c}\n` +
          `\u0421\u0435\u0439\u0447\u0430\u0441 \u0432\u044B\u0434\u0430\u0435\u0442\u0441\u044F: #${next ?? '?'}\n` +
          `\u0422\u0432\u043E\u0439 \u0442\u0430\u0440\u0433\u0435\u0442: #${n}\n\n` +
          '\u041F\u043E\u0434\u0433\u043E\u0442\u043E\u0432\u044C \u043D\u0435\u0443\u043B\u0443\u0447\u0448\u0435\u043D\u043D\u044B\u0439 \u043F\u043E\u0434\u0430\u0440\u043E\u043A \u044D\u0442\u043E\u0439 \u043A\u043E\u043B\u043B\u0435\u043A\u0446\u0438\u0438 — \u0441\u043A\u043E\u0440\u043E \u043C\u043E\u043C\u0435\u043D\u0442.';
        break;
      case 'UPGRADE_COMPLETED':
        text = `\u2705 \u0410\u043F\u0433\u0440\u0435\u0439\u0434 \u0432\u044B\u043F\u043E\u043B\u043D\u0435\u043D: ${c} #${n}`;
        break;
      case 'OWNED_GIFT_FOUND':
        text = String(payload.text || '');
        break;
      default:
        text = JSON.stringify(payload).slice(0, 400);
    }
    return this.send(chatId, text, kind, payload, opts);
  }

  async send(chatId, text, kind = 'GENERAL', payload = {}, opts = {}) {
    if (this.store) {
      // Dedup: same kind + dedupKey inside the window -> skip entirely
      // (prevents HOT_TARGET spam on every 5-min cycle while the target
      // stays hot). The notifications row is the audit record either way.
      if (opts.dedupKey) {
        const cutoff = Date.now() - (opts.dedupMinutes ?? 30) * 60 * 1000;
        const dup = (this.store.find('notifications', { kind }) || []).find(row =>
          row.dedup_key === opts.dedupKey &&
          new Date(row.created_at).getTime() > cutoff
        );
        if (dup) return { sent: false, deduped: true };
      }
      this.store.insert('notifications', {
        id: randomUUID(),
        user_id: chatId,
        chat_id: String(chatId),
        kind,
        payload_json: JSON.stringify(payload),
        dedup_key: opts.dedupKey || null,
        status: 'PENDING',
        created_at: new Date().toISOString()
      });
    }

    if (!chatId || !this.botToken) return;

    try {
      const url = `${this.api}/bot${this.botToken}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text })
      }).catch(() => {});
    } catch {
      // non-blocking
    }
  }
}
