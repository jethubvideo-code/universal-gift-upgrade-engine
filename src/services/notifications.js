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

  async send(chatId, text, kind = 'GENERAL', payload = {}) {
    if (this.store) {
      this.store.insert('notifications', {
        id: randomUUID(),
        user_id: chatId,
        chat_id: String(chatId),
        kind,
        payload_json: JSON.stringify(payload),
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
