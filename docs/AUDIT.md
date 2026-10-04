---
title: Фаза 0 — Аудит (AUDIT.md)
---

# Фаза 0.1 — Аудит

## Важная коррекция по месту работы

Исходный документ-спека говорит «работай внутри существующего репозитория
GiftTracker-bot, отдельный демо-проект не создавай». Владелец явно
переопределил это: **работать в НОВОМ репозитории**
`jethubvideo-code/universal-gift-upgrade-engine`. `gifttracker-bot` в этом
проекте используется только как **внешний публичный источник сигнала**
(read-only, HTTPS, без push) — т.е. он не ломается и не трогается никакими
коммитами данного проекта. Это соответствует правилу раздела 3.2 («t.me/nft и
публичные данные — только для мониторинга и прогноза») в более широком
смысле: весь существующий репозиторий воспринимается как такой публичный
сигнал.

## Что уже аудировано в gifttracker-bot (внешний источник, read-only)

Склонирован `jethubvideo-code/gifttracker-bot` (13669 коммитов, публичный
репозиторий) только для чтения, ничего не изменено и не закоммичено туда.

- **Архитектура**: 100% на GitHub Actions, без сервера. `full-job.js`
  (963 строки) работает в режиме «эстафеты»: при `FORCE=chain` или
  `EVENT_NAME=schedule` крутится до 30 минут (`BUDGET_MS=1_800_000`), затем
  сам себя передиспатчит через `POST .../actions/workflows/full-monitor.yml/dispatches`
  (или `gh workflow run ... -f force=chain`) — непрерывная цепочка
  прогонов, имитирующая 24/7 без постоянного процесса.
- **Источник счётчиков**: HTML-страницы `https://t.me/nft/<slug>-<n>`
  (публичные, без официального API, без ключей). Бинарный поиск определяет
  текущий «issued» (апгрейженный) номер коллекции по наличию/отсутствию
  страницы `-<n>`. Это подтверждает правило спеки: публичный счётчик — ТОЛЬКО
  прогноз, не источник правды.
- **Каталог**: `gift-monitor/collections.json` — 121 запись (120+,
  соответствует спеке). Состояние каждой коллекции в
  `data/state-full.json`: `{ total, issued, lastSweepTs, prevSweepTs,
  lastSentNum, seen[] }`.
- **Бот**: `gift-monitor/actions/bot.js` — poll-бот живёт внутри
  `full-job.js` (вызывается каждый свип), подписчики — зашифрованный файл
  `data/subscribers.enc` (AES, ключ `CRYPT_KEY` из Actions vars). Только
  Bot API (`getUpdates`/`sendMessage`), **никакой MTProto user-сессии не
  существует** в этом проекте — апгрейды реально НЕ выполняются, только
  обнаруживаются и анонсируются подписчикам бесплатно для всех
  (владелец зафиксировал это как неприкосновенное правило в своём проекте —
  никак не ограничивает наш отдельный Target Engine).
- **Фронтенд**: `docs/index.html` — SPA без сборки, читает `docs/*.json`,
  обновление раз в ~20с, PWA (`sw.js`). Это другой продукт (публичная лента
  апгрейдов), не Mini App для управления целями.
- **Данные для нашего Target Engine**: мы используем
  `docs/gifts.json` этого репозитория (поле актуальных floor-цен и
  коллекций) как `GIFTTRACKER_DATA_URL` — HTTPS GET, снапшот раз в цикл,
  без авторизации записи.
- **Секреты**: сканирован working tree и вся git-история (`git log --all -p`)
  по паттернам bot-token/ghp_/private key — **чисто**. (Это сторонний
  репозиторий; не наша зона ответственности, но стоило проверить раз мы его
  читаем.)

## Текущее состояние НАШЕГО проекта (universal-gift-upgrade-engine)

Уже реализовано в этой сессии, до появления формальной спеки — ревизовано
под её требования:

| Область | Файл(ы) | Статус |
|---|---|---|
| Домен / state machine | `src/core/state-machine.js` | 13 состояний спеки реализованы (WATCHING…FAILED); **MISSED и CANCELLED из спеки ещё не добавлены** — делаю в Фазе 1 |
| Хранилище | `src/db.js` (MemoryStore / FileStore) | FileStore = `data/state/*.json`, коммитится обратно воркфлоу (GitHub-only mode) |
| Target CRUD | `src/engine/target-manager.js` | есть; `saved_gift_ref`, `consent_at/version`, `priority`, `result_number/slug/spent_stars` из 7.1 — **ещё не все поля**, добавляю в Фазе 1 |
| Индекс целей | `src/engine/target-index.js` | byCollection/byGiftId/byNumber/byUser/hot — реализовано и нагрузочно протестировано (10k целей) |
| Монитор коллекций | `src/engine/collection-monitor.js`, `collection-state.js` | адаптивный интервал, TTL кэш — есть; discovery из gifttracker снапшота — есть |
| Приоритеты/планировщик | `src/engine/target-scheduler.js`, `hot-target-engine.js` | P0–P3 реализованы, прогрев (preStage) есть |
| Rate limiter | `src/core/rate-limiter.js` | per-method pacing, FLOOD_WAIT cooldown, приоритетная очередь — протестировано |
| Retry | `src/core/retry-manager.js` | классификация temporary/permanent, backoff — протестировано |
| Locks | `src/core/locks.js` | TTL, fencing-токен, withLock — протестировано, race на 50/200 воркеров зелёный |
| Telegram-интеграция | `src/telegram/mtproto-client.js`, `upgrade-executor.js`, `payment-executor.js`, `saved-gifts.js`, `telegram-gifts.js`, `user-sessions.js` | **каркас готов, реализация — Вариант A (пользовательская MTProto-сессия, GramJS), но НИ ОДНОГО реального вызова не было протестировано против живого Telegram** — только TEST MODE (симулятор) |
| Бот-команды | `bot/bot.js` | `/add`, `/auto`, `/manual`, `/del`, `/state`, `/targets` — универсальные, без хардкода номеров/коллекций |
| Mini App | `miniapp/` | статика на GitHub Pages, читает публичный снапшот, без секретов |
| Тесты | `test/` (49 unit+simulator) + `test/perf/` (6 perf) | **55/55 зелёных** на момент этого аудита |

## Критический пробел, требующий решения 0.4 ПЕРЕД Фазой 5

Весь код исполнения апгрейда (`upgrade-executor.js`, `payment-executor.js`,
`mtproto-client.js`) уже написан под **Вариант A** (пользовательская
MTProto-сессия через GramJS), потому что это было единственное разумное
предположение до того, как появилась формальная спека с явным требованием
остановиться на 0.4. Код НЕ исполнялся против реального Telegram ни разу —
только `TEST MODE`. Ничего не потеряно, если решение будет другим (Вариант
B, Bot API Business): адаптерный слой (`MtprotoClient` / `TelegramClient`
interface) изолирует это так, что замена не трогает `target-engine/`.

См. `docs/API_VERIFICATION.md` и раздел «0.4» в чате — там сравнение и
рекомендация.
