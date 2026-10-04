#!/usr/bin/env node
/**
 * ONE-TIME MTProto login — run ONCE by the owner, directly in the server's
 * console (SSH / hosting web terminal). NEVER via the bot, NEVER via chat.
 *
 * Security (non-negotiable, see src/telegram/user-sessions.js header):
 *  - The phone number, the login code Telegram sends, and the 2FA password
 *    (if set) are typed HERE, into this console, and nowhere else.
 *  - Never paste the code or password into Telegram chat with the bot, into
 *    the Mini App, or send them to anyone, including this engine's AI agent.
 *  - The finished session string is encrypted (AES-256-GCM) and stored in
 *    data/state/telegram_sessions.json — never printed in full to the log.
 *
 * Usage (after `npm install`, with TG_API_ID / TG_API_HASH / SESSION_ENCRYPTION_KEY
 * set in the environment — see SETUP.md steps 1 and 4):
 *   node scripts/login-mtproto.js
 */
import readline from 'node:readline';
import crypto from 'node:crypto';
import { createStore } from '../src/db.js';
import { loadConfig } from '../src/core/config.js';
import { UserSessionManager } from '../src/telegram/user-sessions.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (!hidden) {
      rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); });
      return;
    }
    // Hide input while typing the 2FA password (best-effort; not all terminals mask).
    const stdin = process.stdin;
    process.stdout.write(question);
    let input = '';
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (char) => {
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode?.(false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        rl.close();
        resolve(input.trim());
        return;
      }
      if (char === '\u0003') { process.exit(1); }
      if (char === '\u007f') { input = input.slice(0, -1); return; }
      input += char;
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const config = loadConfig();
  if (!config.TG_API_ID || !config.TG_API_HASH) {
    console.error('Missing TG_API_ID / TG_API_HASH. Get them at https://my.telegram.org (SETUP.md step 1) and set as env vars first.');
    process.exit(1);
  }
  if (!config.SESSION_ENCRYPTION_KEY) {
    console.error('Missing SESSION_ENCRYPTION_KEY. Generate one, e.g.: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }

  let telegram;
  try {
    telegram = await import('telegram');
  } catch {
    console.error("Dependency 'telegram' (GramJS) is not installed. Run: npm install");
    process.exit(1);
  }
  const { TelegramClient } = telegram;
  const { StringSession } = telegram.StringSession ? telegram : await import('telegram/sessions/index.js');

  const session = new StringSession(''); // fresh session — this run produces a brand new one
  const client = new TelegramClient(session, config.TG_API_ID, config.TG_API_HASH, {
    connectionRetries: 5,
    deviceModel: 'Universal Gift Upgrade Engine',
    systemVersion: 'Linux 6.1',
    appVersion: '5.5.0',
    langCode: 'en',
    systemLangCode: 'en'
  });

  console.log('Universal Gift Upgrade Engine — one-time MTProto login');
  console.log('This connects as YOUR account (not the bot). Nothing you type here ever leaves this server.\n');

  await client.start({
    phoneNumber: async () => ask('Phone number (international format, e.g. +998...): '),
    phoneCode: async () => ask('Telegram sent you a login code — enter it here: '),
    password: async () => ask('2FA password (press Enter if you have none): ', { hidden: true }),
    onError: (err) => console.error('Login error:', err.message || err)
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

  console.log('\nLogin complete.');
  console.log(`  Telegram user id: ${userId}`);
  console.log(`  Data center (DC): ${dcId ?? 'unknown — check logs'}`);
  console.log('  Session saved, encrypted, to data/state/telegram_sessions.json');
  console.log('\nNext: pick a hosting region close to that DC (SETUP.md step 2), set TRANSPORT=mtproto,');
  console.log('then run:  node scripts/dryrun-speedtest.js');
}

main().catch((err) => {
  console.error('Fatal:', err.message || err);
  process.exit(1);
});
