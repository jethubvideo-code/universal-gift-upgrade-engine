# Universal Gift Upgrade Engine

**Production-ready система автоматического отслеживания и upgrade Telegram Gift Collections.**
Работает со **ВСЕМИ** поддерживаемыми коллекциями подарков — 120+, 300+, 1000+ и любым будущим количеством. Пользователь выбирает **любую** коллекцию и **любой** номер (`#1`, `#777`, `#4444`, `#7777`, `#10000`, `#N` — это просто примеры, в коде нет ни одного захардкоженного подарка или номера).

> ⚠️ Никаких специальных исключений для конкретных коллекций или номеров. Один и тот же универсальный Target Engine обрабатывает всё.

---

## Как это работает

```
GLOBAL COLLECTION MONITOR      ← один poll на коллекцию, независимо от числа пользователей
        ↓
COLLECTION STATE CACHE         ← TTL-кэш: total_supply / upgraded_count / next_expected_number
        ↓
TARGET INDEX                   ← мгновенный поиск: byCollection / byGiftId / byNumber / hotTargets
        ↓
HOT TARGET QUEUE (P0–P3)      ← приоритетная очередь
        ↓
USER TARGETS                   → VERIFYING → UPGRADE_READY → UPGRADING → COMPLETED
```

1. Пользователь создаёт Target: коллекция + номер подарка.
2. Монитор вычисляет `next_expected_number` (это **прогноз**, не подтверждение).
3. Когда номер совпадает — Target переходит в `HOT_TARGET`, всё заранее подготовлено (сессия, saved gift, лимит цены, payload).
4. **Фактическое состояние подтверждается только через официальный Telegram API** (`can_upgrade`, владение, `gift_num`, цена).
5. Upgrade выполняется через официальные методы Telegram (`payments.upgradeStarGift` / `inputInvoiceStarGiftUpgrade` flow) с соблюдением rate limits, locks и идемпотентности.

`t.me/nft` используется **только** для публичной информации/прогноза — никогда как API выполнения.

## Ключевые свойства

| Свойство | Реализация |
|---|---|
| Универсальность | Динамическое обнаружение коллекций (`payments.getStarGifts`), любое `#N` |
| Масштаб | Shared worker pool, один poll на коллекцию, адаптивный polling, batching |
| Скорость | Priority queue P0–P3, pre-staging HOT targets, persistent connections, connection reuse, async I/O |
| Надёжность | Idempotent upgrades, atomic locks, restart recovery (targets/hot jobs/locks/state), retry с backoff |
| Telegram limits | Централизованный `TelegramRateLimiter` (per-method / per-account / global), FLOOD_WAIT-обработка |
| Безопасность | Сессии AES-256-GCM, никаких SMS/2FA-кодов в чате, initData-валидация, audit log, секреты только в env/GitHub Secrets |
| Честность | Counter = prediction. Source of truth = фактическое состояние Telegram |

## Структура

```
src/core/         state-machine, locks, rate-limiter, retry-manager, metrics, config, logger
src/engine/       target-manager, target-index, target-scheduler, hot-target-engine,
                  collection-monitor, collection-state
src/telegram/     mtproto-client, telegram-gifts, saved-gifts, upgrade-executor,
                  payment-executor, user-sessions
src/services/     notifications, audit, miniapp-auth
src/db.js         Store (memory / sqlite), schema в db/schema.sql
src/index.js      composition root + restart recovery
api/server.js     защищённый backend для Mini App
bot/bot.js        Telegram-бот (long polling)
miniapp/          Mini App UI (GitHub Pages-ready, без секретов)
test/             TEST MODE симулятор + модульные тесты (node:test)
test/perf/        нагрузочные тесты: 1000+ / 10 000+ targets
```

Подробности: [docs/INTERFACES.md](docs/INTERFACES.md) · [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/TELEGRAM_API.md](docs/TELEGRAM_API.md) · [docs/SECURITY.md](docs/SECURITY.md) · [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) · [docs/TEST_PLAN.md](docs/TEST_PLAN.md)

## Быстрый старт

```bash
cp .env.example .env   # заполнить BOT_TOKEN, TG_API_ID, TG_API_HASH, SESSION_ENCRYPTION_KEY
npm test               # TEST MODE: полный flow без реальных Stars
node src/index.js      # production worker + API
node bot/bot.js        # бот
```

## TEST MODE

`TEST_MODE=true` (и все тесты в `test/`) прогоняют полный цикл на симуляторе:
120 коллекций, счётчик `7775 → 7776 → 7777`, Target `#7777`, полный путь состояний
`WATCHING → PREDICTED → HOT_TARGET → VERIFYING → UPGRADE_READY → UPGRADING → CONFIRMING → COMPLETED`,
плюс проверки race conditions, locks, rate limits, очередей и recovery после рестарта.
Реальных списаний Stars нет и не может быть.

## Важно

- Реальный upgrade требует **пользовательской MTProto-сессии**, полученной через официальный механизм авторизации Telegram. Система никогда не запрашивает SMS-коды, 2FA-пароли или коды входа в чате.
- Точные имена TL-конструкторов и параметров перед боевым запуском сверяются с текущим слоем Telegram (см. `docs/TELEGRAM_API.md`) — транспорт изолирует изменения схемы.
- Latency-critical worker должен работать как постоянный процесс (VPS/Docker), а не в GitHub Actions. Actions — только CI, деплой, health-checks, бэкапы.
