/**
 * Telegram bot — Universal Gift Upgrade Engine control interface.
 *
 * Runs in two modes:
 *  - self-hosted: `node bot/bot.js` — continuous long polling (24/7 with the worker)
 *  - GitHub Actions mode: `BOT_POLL_SECONDS=40 node bot/bot.js` — one short
 *    polling cycle per scheduled workflow run (the runner only lives a few
 *    minutes; state persists in data/state/*.json committed by the workflow)
 *
 * Commands:
 *   /start                 — welcome + Mini App button
 *   /collections           — list discovered collections (dynamic)
 *   /add <collection> <#N> — create a Target for ANY collection and ANY number
 *   /targets               — your targets with status
 *   /auto <target_id> <max_stars> — enable AUTO UPGRADE with a price limit
 *   /manual <target_id>    — disable AUTO UPGRADE
 *   /del <target_id>        — delete a target
 *   /state <collection>    — collection counter state (prediction!)
 *   /linkbusiness          — how to link the bot to Telegram Business (Variant B)
 *
 * Variant B (owner decision, Phase 0.4): upgrades execute through a Bot API
 * BUSINESS CONNECTION (no user MTProto session). The `business_connection`
 * bot update is captured here and stored by BusinessConnectionManager.
 */
import { createStore, TABLES } from '../src/db.js';
import { loadConfig } from '../src/core/config.js';
import { createLogger } from '../src/core/logger.js';
import { TargetManager } from '../src/engine/target-manager.js';
import { BusinessConnectionManager } from '../src/telegram/botapi-business.js';

const logger = createLogger('bot');
const config = loadConfig();
const store = createStore(config);
const targets = new TargetManager(store);
const businessConnections = new BusinessConnectionManager({ store });

const API = 'https://api.telegram.org';
let offset = 0;

async function api(method, body) {
  const res = await fetch(`${API}/bot${config.BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

const esc = t => String(t).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');

async function handle(update) {
  // Variant B: business connection linked/updated in Telegram Business settings.
  if (update.business_connection) {
    const bc = update.business_connection;
    businessConnections.saveFromUpdate(bc);
    if (store.flushAll) store.flushAll();
    const rights = bc.rights || {};
    const ok = rights.can_view_gifts_and_stars === true && rights.can_transfer_and_upgrade_gifts === true;
    try {
      await api('sendMessage', {
        chat_id: bc.user_chat_id ?? bc.user.id,
        text: ok
          ? '🔗 Business connection saved. Targets with AUTO UPGRADE will now execute through your business account. Rights can be revoked anytime in Telegram Business → Bots.'
          : '🔗 Business connection saved, but the bot lacks the required rights (View gifts and stars / Transfer and upgrade gifts). Grant them in Telegram Business → Bots.'
      });
    } catch { /* user chat may be unavailable — state is saved regardless */ }
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = msg.text.trim();

  // ensure user row (for notifications)
  if (!store.find('users', { telegram_id: userId }).length) {
    store.insert('users', {
      id: userId, telegram_id: userId,
      username: msg.from.username || '', chat_id: String(chatId)
    });
  }

  if (text === '/start') {
    const kb = config.MINIAPP_URL ? {
      inline_keyboard: [[{ text: '🎁 Open Mini App', web_app: { url: config.MINIAPP_URL } }]]
    } : undefined;
    await api('sendMessage', {
      chat_id: chatId,
      text:
        '🎁 *Universal Gift Upgrade Engine*\n\n' +
        'Track ANY gift collection and ANY number \\(#1, #777, #7777, #10000, #N\\).\n\n' +
        'Commands:\n' +
        '/collections — discovered collections\n' +
        '/add <collection> <number> — create a target\n' +
        '/targets — your targets\n' +
        '/auto <id> <max_stars> — enable AUTO UPGRADE\n' +
        '/state <collection> — counters \\(prediction\\)\n' +
        '/linkbusiness — connect Telegram Business \\(enables AUTO UPGRADE\\)',
      parse_mode: 'MarkdownV2',
      ...(kb ? { reply_markup: kb } : {})
    });
    return;
  }

  if (text === '/linkbusiness') {
    await api('sendMessage', {
      chat_id: chatId,
      text:
        '🔗 *To enable AUTO UPGRADE through your business account (no login, no SMS):\n\n' +
        '1\. Open Settings → *Telegram Business* → *Bots*\n' +
        '2\. Add this bot and enable the rights:\n' +
        '   • View gifts and Stars\n' +
        '   • Transfer and upgrade gifts\n' +
        '   • Transfer Stars \(only for paid upgrades\)\n' +
        '3\. The bot receives the connection automatically — no codes to send\n\n' +
        'Rights are revocable anytime in the same place\. The bot never sees your password, phone number or login codes\.',
      parse_mode: 'MarkdownV2'
    });
    return;
  }

  if (text === '/collections') {
    const cols = store.findAll('gift_collections').slice(0, 60);
    const body = cols.length
      ? cols.map(c => `• ${esc(c.title || c.slug || c.collection_id)} — supply ${c.total_supply ?? '?'}`).join('\n')
      : 'Collections will appear after the first monitoring cycle.';
    await api('sendMessage', { chat_id: chatId, text: `*Collections discovered:* (${store.count('gift_collections')})\n${body}`, parse_mode: 'Markdown' });
    return;
  }

  const add = /^\/add\s+(\S+)\s+(\d+)$/.exec(text);
  if (add) {
    const row = targets.create({
      user_id: userId,
      collection_id: add[1],
      gift_id: add[1],
      target_number: Number(add[2])   // ANY number — no special cases
    });
    if (store.flushAll) store.flushAll();
    await api('sendMessage', {
      chat_id: chatId,
      text: `✅ Target created: ${esc(add[1])} #${add[2]}\nStatus: WATCHING\nUse /auto ${row.id} <max_stars> to enable AUTO UPGRADE.`,
      parse_mode: 'Markdown'
    });
    return;
  }

  if (text === '/targets') {
    const rows = targets.listByUser(userId);
    if (!rows.length) return api('sendMessage', { chat_id: chatId, text: 'No targets yet. Use /add <collection> <number>' });
    const state = Object.fromEntries(store.findAll('collection_state').map(s => [s.collection_id, s]));
    const body = rows.map(t => {
      const st = state[t.collection_id];
      return `• \`${t.id.slice(0, 8)}\` ${esc(t.collection_id)} *#${t.target_number}*\n` +
        `  Supply: ${st?.total_supply ?? '?'} | Upgraded: ${st?.upgraded_count ?? '?'} | Next: #${st?.next_expected_number ?? '?'}\n` +
        `  Status: *${t.status}* | Auto: ${t.auto_upgrade ? `ON (max ${t.max_upgrade_stars}⭐)` : 'OFF'}`;
    }).join('\n');
    await api('sendMessage', { chat_id: chatId, text: `*Your targets:*\n${body}`, parse_mode: 'Markdown' });
    return;
  }

  const auto = /^\/auto\s+([\w-]+)\s+(\d+)$/.exec(text);
  if (auto) {
    const t = targets.get(auto[1]);
    if (!t || t.user_id !== userId) return api('sendMessage', { chat_id: chatId, text: 'Target not found.' });
    targets.setAutoUpgrade(auto[1], { auto_upgrade: true, max_upgrade_stars: Number(auto[2]) });
    if (store.flushAll) store.flushAll();
    return api('sendMessage', { chat_id: chatId, text: `⚡ AUTO UPGRADE ON for ${esc(t.collection_id)} #${t.target_number} — max ${auto[2]}⭐\nNo payment will ever exceed your limit.` });
  }

  const manual = /^\/manual\s+([\w-]+)$/.exec(text);
  if (manual) {
    const t = targets.get(manual[1]);
    if (!t || t.user_id !== userId) return api('sendMessage', { chat_id: chatId, text: 'Target not found.' });
    targets.setAutoUpgrade(manual[1], { auto_upgrade: false, max_upgrade_stars: t.max_upgrade_stars });
    if (store.flushAll) store.flushAll();
    return api('sendMessage', { chat_id: chatId, text: `AUTO UPGRADE OFF — you will only be notified.` });
  }

  const del = /^\/del\s+([\w-]+)$/.exec(text);
  if (del) {
    const t = targets.get(del[1]);
    if (!t || t.user_id !== userId) return api('sendMessage', { chat_id: chatId, text: 'Target not found.' });
    targets.delete(del[1]);
    if (store.flushAll) store.flushAll();
    return api('sendMessage', { chat_id: chatId, text: `Target deleted.` });
  }

  const stateCmd = /^\/state\s+(\S+)$/.exec(text);
  if (stateCmd) {
    const s = store.findAll('collection_state').find(x => x.collection_id === stateCmd[1]);
    if (!s) return api('sendMessage', { chat_id: chatId, text: 'No state yet for that collection (it must have an active target).' });
    return api('sendMessage', {
      chat_id: chatId,
      text:
        `*${esc(s.collection_id)}*\n` +
        `Supply: ${s.total_supply}\nUpgraded: ${s.upgraded_count}\nRemaining: ${s.remaining}\n` +
        `Next expected: *#${s.next_expected_number}*\n\n_Counters are a prediction — actual Telegram state is verified before any upgrade._`,
      parse_mode: 'Markdown'
    });
  }
}

async function main() {
  if (!config.BOT_TOKEN) {
    logger.error('BOT_TOKEN missing — set it in environment / GitHub Secrets');
    process.exit(1);
  }
  const pollSeconds = Number(process.env.BOT_POLL_SECONDS || 0);
  const deadline = pollSeconds > 0 ? Date.now() + pollSeconds * 1000 : Infinity;
  logger.info('Bot started', { mode: pollSeconds > 0 ? 'one-shot' : 'persistent', pollSeconds });

  while (Date.now() < deadline) {
    let res;
    try {
      res = await fetch(`${API}/bot${config.BOT_TOKEN}/getUpdates?timeout=25&offset=${offset}`, { method: 'GET' });
      const data = await res.json();
      if (!data.ok) throw new Error(JSON.stringify(data).slice(0, 200));
      for (const u of data.result) {
        offset = Math.max(offset, u.update_id + 1);
        await handle(u).catch(err => logger.error('Handler error', { error: err.message }));
      }
      if (pollSeconds > 0 && data.result.length === 0) break; // short cycle done
    } catch (err) {
      logger.error('Polling error', { error: err.message });
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (store.flushAll) store.flushAll();
  logger.info('Bot cycle finished');
  process.exit(0);
}

main().catch(err => { logger.error('Fatal', { error: err.message }); process.exit(1); });
