#!/usr/bin/env node
/**
 * ONE-TIME MTProto login via QR code — run inside the mtproto-login workflow.
 *
 * The owner opens the workflow run log, scans the NEWEST QR code with their
 * Telegram app (Settings → Devices → Link Desktop Device), and the session
 * is created. NO login code and NO 2FA password ever pass through chat or
 * workflow inputs. If the account has 2FA enabled, this script exits with
 * code 2 (QR flow cannot supply the cloud password) — in that case run
 * scripts/login-mtproto.js on the server console instead.
 *
 * After success the session string is encrypted (AES-256-GCM with
 * SESSION_ENCRYPTION_KEY) into data/state/telegram_sessions.json — the
 * workflow commits that file; it never appears in the log.
 *
 * Env: TG_API_ID, TG_API_HASH, SESSION_ENCRYPTION_KEY (repo secrets).
 */
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { createStore } from '../src/db.js';
import { loadConfig } from '../src/core/config.js';
import { UserSessionManager } from '../src/telegram/user-sessions.js';
import qrcode from 'qrcode-terminal';

async function main() {
  const config = loadConfig();
  for (const key of ['TG_API_ID', 'TG_API_HASH', 'SESSION_ENCRYPTION_KEY']) {
    if (!config[key]) {
      console.error(`Missing ${key} — set it as a repository secret first.`);
      process.exit(1);
    }
  }

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

  let qrCount = 0;
  console.log('=== MTProto QR LOGIN =============================================');
  console.log('Открой ЛОГ этого прогона и сканируй НИЖНИЙ (самый свежий) QR-код');
  console.log('из Telegram: Настройки → Устройства → Подключить устройство.');
  console.log('QR обновляется — если не сканируется, возьми последний.');
  console.log('==================================================================');

  await client.start({
    qrCode: async ({ token, expires }) => {
      qrCount++;
      const url = `tg://login?token=${Buffer.from(token).toString('base64url')}`;
      console.log(`\n--- QR #${qrCount} (действителен ~25с, до ${new Date(expires * 1000).toISOString()}) ---`);
      qrcode.generate(url, { small: true });
    },
    password: async () => {
      console.log('\n2FA_REQUIRED: у аккаунта включён облачный пароль — QR-логин не может');
      console.log('его запросить безопасно. Запусти scripts/login-mtproto.js в консоли сервера.');
      process.exit(2);
    },
    onError: (err) => console.error('Login error:', err.message || err),
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

  console.log('\n=== LOGIN COMPLETE ===============================================');
  console.log(`  Telegram user id: ${userId}`);
  console.log(`  Data center (DC): ${dcId ?? 'unknown'}`);
  console.log('  Session: зашифрована (AES-256-GCM) в data/state/telegram_sessions.json');
  console.log('  (коммит сделает воркфлоу; строка сессии НЕ попадает в лог)');
  console.log('==================================================================');
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
