#!/usr/bin/env node
/**
 * GUIDED MTProto login — the bot walks the owner through it in their own
 * Telegram chat with the bot. The owner answers 2-3 messages (phone number,
 * login code, 2FA password if set); nothing is typed into the Actions log
 * or this chat with the agent.
 *
 * Flow: this script (running in the mtproto-login-guided workflow) sends
 * prompts via the bot, reads replies via getUpdates (ONLY from the owner's
 * chat id, fail-closed), and feeds them to the GramJS auth flow. The final
 * session string is encrypted (AES-256-GCM, SESSION_ENCRYPTION_KEY) into
 * data/state/telegram_sessions.json — never printed.
 *
 * Env: BOT_TOKEN, TG_API_ID, TG_API_HASH, SESSION_ENCRYPTION_KEY,
 *      OWNER_CHAT_ID (the owner's Telegram user id).
 */
import { createStore } from '../src/db.js';
import { loadConfig } from '../src/core/config.js';
import { UserSessionManager } from '../src/telegram/user-sessions.js';

const OWNER = String(process.env.OWNER_CHAT_ID || '').trim();

async function main() {
  const config = loadConfig();
  for (const key of ['TG_API_ID', 'TG_API_HASH', 'SESSION_ENCRYPTION_KEY', 'BOT_TOKEN']) {
    if (!config[key]) {
      console.error(`Missing ${key} — set it as a repository secret first.`);
      process.exit(1);
    }
  }
  if (!OWNER) {
    console.error('Missing OWNER_CHAT_ID env.');
    process.exit(1);
  }

  // --- Bot API helpers (prompts + reading the owner's replies) ---
  const bot = async (method, params = {}) => {
    const res = await fetch(`https://api.telegram.org/bot${config.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(30_000),
    });
    return res.json().catch(() => ({}));
  };
  const botSay = (text) => bot('sendMessage', { chat_id: OWNER, text });

  let offset = null; // null = not yet initialized
  async function askOwner(prompt, { timeoutMs = 10 * 60_000, clean = null } = {}) {
    await botSay(prompt);
    const deadline = Date.now() + timeoutMs;
    if (offset === null) {
      // Drain pending updates first: never treat old messages as answers.
      const cur = await bot('getUpdates', { timeout: 0, limit: 100 });
      const ups = (cur && cur.result) || [];
      offset = ups.length ? Math.max(...ups.map((u) => u.update_id)) + 1 : 0;
    }
    while (Date.now() < deadline) {
      const r = await bot('getUpdates', {
        offset, timeout: 25, limit: 10, allowed_updates: ['message'],
      });
      const ups = (r && r.result) || [];
      for (const u of ups) {
        offset = u.update_id + 1;
        const msg = u.message;
        // Fail-closed: only the owner's own chat, text messages only.
        if (msg && String(msg.chat.id) === OWNER && msg.text) {
          const text = msg.text.trim();
          if (clean) {
            const cleaned = clean(text);
            if (cleaned) return cleaned;
            await botSay('Не понял это сообщение — пришли ещё раз, пожалуйста.');
          } else {
            return text;
          }
        }
      }
    }
    return null;
  }

  // --- GramJS MTProto client ---
  const telegram = await import('telegram');
  const { TelegramClient } = telegram;
  const { StringSession } = telegram.StringSession
    ? telegram
    : await import('telegram/sessions/index.js');

  const client = new TelegramClient(new StringSession(''), config.TG_API_ID, config.TG_API_HASH, {
    connectionRetries: 5,
    deviceModel: 'Universal Gift Upgrade Engine',
    systemVersion: 'Linux 6.1',
    appVersion: '5.5.0',
    langCode: 'en',
    systemLangCode: 'en',
  });

  console.log('Guided MTProto login started; waiting for the owner in the bot chat.');

  await client.start({
    phoneNumber: async () => {
      const t = await askOwner(
        '🔑 ШАГ 1: пришли сюда свой номер телефона в международном формате.\n\nНапример: +998901234567',
        { clean: (s) => (/^\+?\d{9,15}$/.test(s.replace(/[\s()-]/g, '')) ? s.replace(/[\s()-]/g, '') : null) }
      );
      if (!t) throw new Error('owner did not send the phone number in time');
      return t;
    },
    phoneCode: async () => {
      const t = await askOwner(
        '📩 ШАГ 2: Telegram прислал тебе код входа (сообщение от Telegram, либо SMS).\n\nПросто пришли его сюда цифрами.',
        { clean: (s) => (/\d{4,8}/.test(s.replace(/\D/g, '')) ? s.replace(/\D/g, '') : null) }
      );
      if (!t) throw new Error('owner did not send the login code in time');
      return t;
    },
    password: async () => {
      const t = await askOwner(
        '🔒 ШАГ 3: у твоего аккаунта включён двухфакторный пароль.\n\nПришли его сюда. После входа удали это сообщение из чата (и лучше смени пароль).',
        { timeoutMs: 12 * 60_000 }
      );
      if (!t) throw new Error('owner did not send the 2FA password in time');
      return t;
    },
    onError: (err) => console.error('Login error:', String(err.message || err).slice(0, 120)),
  });

  const sessionString = client.session.save();
  const dcId = client.session.dcId ?? null;
  const me = await client.getMe();
  const userId = String(me.id);

  const store = createStore(config);
  const sessions = new UserSessionManager({ store, encryptionKey: config.SESSION_ENCRYPTION_KEY });
  sessions.save({ user_id: userId, session_plain: sessionString, dc_id: dcId });
  if (store.flushAll) store.flushAll();
  await client.disconnect();

  console.log('LOGIN_COMPLETE | user:', userId, '| dc:', dcId); // no session string in the log
  await botSay(
    '✅ Готово! Вход выполнен, сессия зашифрована и сохранена.\n\n' +
    'Теперь удали сообщения с кодом и паролем из этого чата (удержи сообщение → Удалить).\n' +
    'Остальное настрою я.'
  );
  process.exit(0);
}

main().catch(async (err) => {
  console.error('Fatal:', String(err.message || err).slice(0, 200));
  try {
    const res = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN || ''}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: OWNER, text: '⚠️ Вход не получился: ' + String(err.message || err).slice(0, 80) + '\nНапиши моему агенту — он перезапустит.' }),
    });
  } catch {}
  process.exit(1);
});
