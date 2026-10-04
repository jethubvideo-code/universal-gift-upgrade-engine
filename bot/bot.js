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
import { BusinessConnectionManager, BotApiClient, BotApiBusinessBackend } from '../src/telegram/botapi-business.js';
import { UpgradeExecutor } from '../src/telegram/upgrade-executor.js';
import { scanOwnedGifts, autoActOnOwnedGifts } from '../src/engine/business-scanner.js';
import { TelegramRateLimiter } from '../src/core/rate-limiter.js';

const logger = createLogger('bot');
const config = loadConfig();
const store = createStore(config);
const targets = new TargetManager(store);
const businessConnections = new BusinessConnectionManager({ store });
const botApiClient = new BotApiClient({ botToken: config.BOT_TOKEN });
const limiter = new TelegramRateLimiter({});
const businessBackend = new BotApiBusinessBackend({ client: botApiClient, limiter, logger });
const businessExecutor = new UpgradeExecutor({
  savedGifts: businessBackend, payments: businessBackend, limiter, metrics: null, logger,
  mode: config.MODE
});
const notifier = {
  notifyUser(userId, kind, payload) {
    const u = store.find('users', { telegram_id: String(userId) })[0];
    const chatId = u?.chat_id || userId;
    const text = kind === 'OWNED_GIFT_FOUND' ? payload.text
      : kind === 'UPGRADE_COMPLETED' ? `✅ Апгрейд выполнен: ${esc(payload.target?.collection_id || '')} #${payload.target?.target_number}`
      : String(payload);
    api('sendMessage', { chat_id: chatId, text }).catch(() => {});
  }
};

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
    const missing = [];
    if (rights.can_view_gifts_and_stars !== true) missing.push('👁 Просмотр подарков и звёзд (View gifts and Stars)');
    if (rights.can_transfer_and_upgrade_gifts !== true) missing.push('⬆️ Передача и улучшение подарков (Transfer and upgrade gifts)');
    const ok = missing.length === 0;
    try {
      await api('sendMessage', {
        chat_id: bc.user_chat_id ?? bc.user.id,
        text: ok
          ? '🔗 Бизнес-подключение активно. Таргеты с АВТО-АПГРЕЙДОМ теперь будут выполняться через твой бизнес-аккаунт. Права можно отозвать в любой момент: Настройки → Telegram Business → Чат-боты.'
          : '🔗 Бизнес-подключение сохранено, но не хватает прав:\n\n' + missing.map(m => '• ' + m).join('\n') +
            '\n\nЧто сделать:\n1. Настройки → Telegram Business → Чат-боты\n2. Открой этого бота в списке\n3. Включи ОБЕ галочки выше (сейчас включена только часть)\n\nБез "Передача и улучшение подарков" апгрейд технически невозможен — бот физически не может нажать кнопку апгрейда без этого права.'
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

  if (text === '/start' || text.startsWith('/start ')) {
    // Deep link from the Mini App: /start add_<collection>_<number>[_<max_stars>]
    const payload = text.slice(7).trim();
    const dl = /^add_([A-Za-z0-9-]+)_(\d+)(?:_(\d+))?$/.exec(payload);
    if (dl) {
      // dupe protection (deep link): same user + collection + number, active
      const mineRows = targets.listByUser ? targets.listByUser(userId) : store.find('targets', { user_id: userId });
      const dupe = mineRows.find(t => t.collection_id === dl[1] && Number(t.target_number) === Number(dl[2])
        && t.status !== 'COMPLETED' && t.status !== 'FAILED' && t.status !== 'CANCELLED');
      if (dupe) {
        return api('sendMessage', {
          chat_id: chatId,
          text: `ℹ️ Этот таргет уже есть: ${esc(dl[1])} #${dl[2]} (статус ${esc(dupe.status)}).\n/auto ${dupe.id} <макс_звёзд> — включить авто-апгрейд.`,
          parse_mode: 'MarkdownV2'
        });
      }
      const row = targets.create({
        user_id: userId,
        collection_id: dl[1],
        gift_id: dl[1],
        target_number: Number(dl[2]),          // ANY number — no special cases
        max_upgrade_stars: dl[3] ? Number(dl[3]) : null
      });
      if (store.flushAll) store.flushAll();
      // smart status note: number already released → upgrade possible right now
      const g0 = store.find('gifts', { collection_id: dl[1] })[0];
      const issued0 = g0 ? Number(g0.upgraded_count || 0) : null;
      let statusLine = 'Status: WATCHING — движок следит каждый цикл';
      if (issued0 != null && Number(dl[2]) <= issued0) {
        statusLine = '⚠️ Номер уже выпущен — апгрейд возможен СРАЗУ: /login, потом /auto ' + row.id + ' <макс_звёзд>';
      }
      await api('sendMessage', {
        chat_id: chatId,
        text: `✅ Target activated: ${esc(dl[1])} #${dl[2]}` +
          (dl[3] ? ` (limit ${dl[3]} Stars)` : '') +
        `\n${statusLine}\nUse /auto ${row.id} <max_stars> to enable AUTO UPGRADE`,
        parse_mode: 'MarkdownV2'
      });
      return;
    }
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
        '/linkbusiness — connect Telegram Business \\(enables AUTO UPGRADE\\)\n' +
        '/mygifts — scan your account for un\\-upgraded gifts right now\n' +
        '/autoupgrade on <max\\_stars> — auto\\-upgrade ANY owned gift found, no number needed in advance\n' +
        '/login — подключить свой аккаунт \(полностью автоматические апгрейды с твоих Stars\)',
      parse_mode: 'MarkdownV2',
      ...(kb ? { reply_markup: kb } : {})
    });
    return;
  }

  if (text === '/help') {
    await api('sendMessage', {
      chat_id: chatId,
      text:
        '🎁 *Команды Universal Gift Upgrade Engine*\n\n' +
        '/targets — мои таргеты и статусы\n' +
        '/add <коллекция> <номер> — создать таргет\n' +
        '/auto <id> <макс_звёзд> — включить авто-апгрейд с лимитом\n' +
        '/autoupgrade on <макс_звёзд> — авто-апгрейд любого моего подарка\n' +
        '/mygifts — просканировать мои подарки сейчас\n' +
        '/state <коллекция> — счётчик и предикшн\n' +
        '/collections — все коллекции\n' +
        '/login — подключить свой аккаунт (для полного авто-апгрейда)\n' +
        '/linkbusiness — привязать Telegram Business'
    });
    return;
  }
  if (text === '/login') {
    // MULTI-USER: request a guided MTProto login. The login workflow picks
    // up the request within minutes and walks THIS user through phone +
    // code + 2FA right here in the chat.
    const pendingMine = store.find('login_requests', { user_id: userId })
      .filter(r => r.status === 'pending' || r.status === 'processing');
    if (pendingMine.length) {
      return api('sendMessage', { chat_id: chatId, text: '⏳ Твой вход уже в очереди/обработке — следи за сообщениями здесь.' });
    }
    store.insert('login_requests', {
      id: `lr-${userId}-${Date.now()}`,
      chat_id: String(chatId),
      user_id: userId,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    return api('sendMessage', {
      chat_id: chatId,
      text: '🔑 Вход запущен! В течение пары минут бот пришлёт сюда 2-3 вопроса:\n\n'
        + '1⃣ Номер телефона (международный формат)\n'
        + '2⃣ Код входа из Telegram\n'
        + '3⃣ Пароль 2FA, если он у тебя включён\n\n'
        + 'После входа апгрейды твоих таргетов будут выполняться с твоего аккаунта и твоих Stars — автоматически, как только номер станет доступен.\n\n'
        + 'Не забудь потом удалить сообщения с кодом и паролем из чата.'
    });
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
    const cid = add[1].toLowerCase();
    const num = Number(add[2]);
    // validate the collection exists
    const coll = store.find('gift_collections', { collection_id: cid })[0]
      || store.find('gifts', { collection_id: cid })[0];
    if (!coll) {
      return api('sendMessage', {
        chat_id: chatId,
        text: `🤔 Коллекция «${esc(add[1])}» не найдена.\nПосмотри точный slug в /collections или в Mini App.`,
        parse_mode: 'Markdown'
      });
    }
    // dupe protection: same user + collection + number, still active
    const dupe = (targets.listByUser ? targets.listByUser(userId) : store.find('targets', { user_id: userId }))
      .find(t => t.collection_id === cid && Number(t.target_number) === num
        && t.status !== 'COMPLETED' && t.status !== 'FAILED' && t.status !== 'CANCELLED');
    if (dupe) {
      return api('sendMessage', {
        chat_id: chatId,
        text: `ℹ️ У тебя уже есть этот таргет: ${esc(cid)} #${num} (статус ${dupe.status}).\n/auto ${dupe.id} <макс_звёзд> — включить авто-апгрейд.`,
        parse_mode: 'Markdown'
      });
    }
    const row = targets.create({
      user_id: userId,
      collection_id: cid,
      gift_id: cid,
      target_number: num   // ANY number — no special cases
    });
    if (store.flushAll) store.flushAll();
    // smart status note: number already released → upgrade possible right now
    const g = store.find('gifts', { collection_id: cid })[0];
    const issued = g ? Number(g.upgraded_count || 0) : null;
    let extra = 'Status: WATCHING — движок следит каждый цикл.';
    if (issued != null && num <= issued) {
      extra = '⚠️ Номер уже выпущен — апгрейд возможен СРАЗУ.\nПодключи аккаунт (/login), затем /auto ' + row.id + ' <макс_звёзд>.';
    }
    await api('sendMessage', {
      chat_id: chatId,
      text: `✅ Target created: ${esc(cid)} #${num}\n${extra}\nUse /auto ${row.id} <max_stars> to enable AUTO UPGRADE.`,
      parse_mode: 'Markdown'
    });
    return;
  }

  // ---- admin stats (owner only) ----
  if (text === '/stats') {
    if (userId !== '8396883978') {
      return api('sendMessage', { chat_id: chatId, text: '🔒 Команда только для владельца.' });
    }
    const allT = store.findAll('targets');
    const jobs = store.findAll('upgrade_jobs');
    const byStatus = {};
    for (const t of allT) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    const doneJobs = jobs.filter(j => j.status === 'DONE');
    const stars = doneJobs.reduce((a, j) => {
      const p = j.payload_json ? JSON.parse(j.payload_json) : {};
      return a + (Number(p.upgrade_stars || p.price || 0) || 0);
    }, 0);
    const users = store.findAll('users').length;
    const sess = store.findAll('telegram_sessions').length;
    const reqs = store.findAll('login_requests');
    const pend = reqs.filter(r => r.status === 'pending' || r.status === 'processing').length;
    await api('sendMessage', {
      chat_id: chatId,
      text: '📊 *Статистика движка*\n\n'
        + `Пользователей: ${users} (сессий MTProto: ${sess})\n`
        + `Таргетов: ${allT.length} — ${Object.entries(byStatus).map(([k, v]) => `${k}: ${v}`).join(', ') || '—'}\n`
        + `Апгрейдов выполнено: ${doneJobs.length} (списано ≈ ${stars} ★)\n`
        + `Логинов в очереди: ${pend}\n`
        + `Коллекций под наблюдением: ${store.count('gift_collections')}`,
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

  if (text === '/mygifts') {
    const bcSession = businessConnections.getUserSession(userId);
    if (!bcSession) {
      await api('sendMessage', { chat_id: chatId, text: 'Бизнес-аккаунт не подключён. См. /linkbusiness.' });
      return;
    }
    const rights = bcSession.rights || {};
    if (rights.can_view_gifts_and_stars !== true) {
      await api('sendMessage', { chat_id: chatId, text: 'Не выдано право "Просмотр подарков и звёзд". Открой Настройки → Telegram Business → Чат-боты и включи его этому боту.' });
      return;
    }
    await api('sendMessage', { chat_id: chatId, text: '🔎 Сканирую твои подарки через бизнес-подключение…' });
    try {
      const scan = await scanOwnedGifts({ backend: businessBackend, userSession: bcSession, logger });
      if (!scan.gifts.length) {
        await api('sendMessage', { chat_id: chatId, text: 'Подарков не найдено (или право "Просмотр подарков и звёзд" не выдано — см. /linkbusiness).' });
        return;
      }
      const lines = scan.gifts.map(({ gift: g, status, message }) =>
        `\u2022 ${esc(g.slug || g.gift_id || '?')} #${g.gift_num || '?'} \u2014 *${status}*` + (message ? `\n  ${esc(message)}` : ''));
      await api('sendMessage', {
        chat_id: chatId,
        text: `*Твои подарки* (${scan.total}, можно улучшить: ${scan.upgradable_count})` +
          (scan.star_balance != null ? ` \u00b7 баланс ${scan.star_balance}\u2b50` : '') + `\n\n` + lines.join('\n') +
          `\n\nЧтобы апгрейд срабатывал автоматически без ввода номера заранее: /autoupgrade on <макс_звёзд>`,
        parse_mode: 'Markdown'
      });
    } catch (err) {
      await api('sendMessage', { chat_id: chatId, text: `Сканирование не удалось: ${esc(err.message)}

Чаще всего причина — не выданы оба права в Telegram Business → Чат-боты.` });
    }
    return;
  }

  const autoAll = /^\/autoupgrade\s+(on|off)(?:\s+(\d+))?$/.exec(text);
  if (autoAll) {
    const on = autoAll[1] === 'on';
    if (on && !autoAll[2]) {
      await api('sendMessage', { chat_id: chatId, text: 'Укажи лимит звёзд: /autoupgrade on 5000' });
      return;
    }
    const existing = (store.find('business_settings', { user_id: userId }) || [])[0];
    const row = { user_id: userId, auto_upgrade_all: on, max_upgrade_stars_all: on ? Number(autoAll[2]) : null, updated_at: new Date().toISOString() };
    if (existing) store.update('business_settings', existing.id, row);
    else store.insert('business_settings', { id: `bs-${userId}`, ...row });
    if (store.flushAll) store.flushAll();
    await api('sendMessage', {
      chat_id: chatId,
      text: on
        ? `⚡ Авто-апгрейд ЛЮБОГО твоего подарка включён, лимит ${autoAll[2]}⭐ за штуку. Движок сам найдёт неулучшенные подарки через бизнес-подключение и улучшит их (режим: *${esc(config.MODE)}*).`
        : '✋ Авто-апгрейд всех подарков выключен. Будут только уведомления.',
      parse_mode: 'Markdown'
    });
    return;
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

  // Register the command menu (the "Команды" / "/" button in Telegram).
  // Idempotent: safe to re-register every poll cycle.
  try {
    await api('setMyCommands', {
      commands: [
        { command: 'targets', description: '🎯 Мои таргеты и статусы' },
        { command: 'add', description: '➕ Создать таргет: /add коллекция номер' },
        { command: 'auto', description: '⭐ Авто-апгрейд: /auto id макс_звёзд' },
        { command: 'autoupgrade', description: '🔥 Авто-апгрейд любого подарка' },
        { command: 'mygifts', description: '💎 Сканировать мои подарки' },
        { command: 'state', description: '📊 Счётчик и предикшн коллекции' },
        { command: 'collections', description: '🗂 Все 121 коллекций' },
        { command: 'login', description: '🔑 Подключить свой аккаунт' },
        { command: 'linkbusiness', description: '🔗 Привязать Telegram Business' },
        { command: 'help', description: 'ℹ️ Все команды' }
      ]
    });
  } catch (err) {
    logger.warn('setMyCommands failed (non-fatal)', { error: err.message });
  }

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

  // Business account scan: for every connected account with full rights,
  // scan owned gifts (match existing number-targets, act on wildcard
  // auto-upgrade settings, notify on everything else). Runs once per bot
  // cycle (GitHub Actions: every ~5 min via bot-poll.yml; persistent worker:
  // every loop). This is what actually answers "how does it scan my
  // account" — before this, nothing ever called getBusinessAccountGifts.
  for (const bc of businessConnections.list()) {
    if (bc.is_enabled === false) continue;
    const rights = bc.rights || {};
    if (rights.can_view_gifts_and_stars !== true) continue; // can't even read gifts
    try {
      const userSession = { session: bc.business_connection_id, rights };
      const canExecute = rights.can_transfer_and_upgrade_gifts === true;
      const report = await autoActOnOwnedGifts({
        userId: bc.user_id, backend: businessBackend, userSession, store, targets,
        executor: canExecute ? businessExecutor : null, notifier, logger
      });
      if (report.upgraded.length || report.notified.length) {
        logger.info('Business scan result', {
          user_id: bc.user_id, upgraded: report.upgraded.length, notified: report.notified.length
        });
      }
    } catch (err) {
      logger.warn('Business scan failed for user', { user_id: bc.user_id, error: err.message });
    }
  }

  if (store.flushAll) store.flushAll();
  logger.info('Bot cycle finished');
  process.exit(0);
}

main().catch(err => { logger.error('Fatal', { error: err.message }); process.exit(1); });
