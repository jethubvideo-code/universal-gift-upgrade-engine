---
title: Фаза 0.2 — Проверка Telegram API (API_VERIFICATION.md)
---

# Проверка Telegram API

> **Обновление (2026-10-04)**: владелец выбрал **Вариант B (Bot API Business)**.
> Методы Варианта B проверены по живой официальной документации
> (core.telegram.org/bots/api, Bot API 10.3 от 2026-08-24) — см. таблицу
> VERIFIED ниже. MTProto-методы (Вариант A) остаются в коде как legacy-путь,
> но НЕ используются и помечены UNVERIFIED.

## Вариант B — Bot API Business (АКТИВНЫЙ) — VERIFIED 2026-10-04

Проверено по официальному справочнику Bot API (Bot API 10.3):

| Нужно | Метод Bot API | Ключевые поля | Статус |
|---|---|---|---|
| Инфо о подключении | `getBusinessConnection(business_connection_id)` | `BusinessConnection { rights: BusinessBotRights, ... }` | **VERIFIED** |
| Права бота | объект `BusinessBotRights` | `can_view_gifts_and_stars`, `can_transfer_and_upgrade_gifts`, `can_transfer_stars`, `can_convert_gifts_to_stars` | **VERIFIED** |
| Подарки бизнес-аккаунта | `getBusinessAccountGifts(business_connection_id, exclude_*, offset?, limit?)` → `OwnedGifts { gifts[], next_offset }` | требует право `can_view_gifts_and_stars` | **VERIFIED** |
| Объект подарка | `OwnedGiftRegular` | `owned_gift_id`, `can_be_upgraded`, `prepaid_upgrade_star_count`, **`unique_gift_number`** («номер, зарезервированный за этим подарком при апгрейде»), `is_saved`, `was_refunded` | **VERIFIED** |
| Цена апгрейда | `Gift.upgrade_star_count` | в объекте `Gift` | **VERIFIED** |
| Баланс Stars | `getBusinessAccountStarBalance(business_connection_id)` → `StarAmount` | требует `can_view_gifts_and_stars` | **VERIFIED** |
| Исполнение апгрейда | `upgradeGift(business_connection_id, owned_gift_id, keep_original_details?, star_count?)` → True | требует `can_transfer_and_upgrade_gifts`; при платном апгрейде ещё `can_transfer_stars`; `star_count=0` если `prepaid_upgrade_star_count > 0`, иначе `gift.upgrade_star_count` | **VERIFIED** |
| Ошибки | HTTP 429 + `parameters.retry_after` | | **VERIFIED** (общая форма Bot API) |

**UNVERIFIED (поведение в рантайме, проверяется первым dry-run):**
появляется ли `unique_gift_number` у всех апгрейджельных подарков. Код
предполагает худшее: если поля нет — верификация FAILS CLOSED
(GIFT_NOT_FOUND), апгрейд не выполняется (см. `test/botapi-business.test.js`).

**Ключевой факт для 7.5**: `unique_gift_number` — номер, зарезервированный
за конкретным подарком ДО апгрейда. Это даёт ПРЯМУЮ проверку таргета:
`owned_gift.unique_gift_number === target.target_number`. Вывод 0.3(a)
уточняется: если номера резервируются заранее, то «последовательная
нумерация в момент апгрейда» — не единственный механизм; движок работает
в обоих случаях, потому что матчинг идёт по фактическому полю, а не по
допущению.

---

## Вариант A — MTProto (LEGACY, не используется)

Честно: у меня нет возможности выполнить живой `payments.getStarGifts` или
`payments.upgradeStarGift` против реального Telegram в этой сессии (нет
активной пользовательской MTProto-сессии, и правило спеки запрещает заводить
её через чат бота/SMS/2FA). Поэтому таблица ниже основана на (а) публичной
документации Telegram (`core.telegram.org/api`, `core.telegram.org/schema`,
библиотека GramJS/TDLib, которые отражают актуальный API Layer) и (б) на том,
что уже было задокументировано в этом проекте в предыдущих ответах этой же
сессии. Статус **UNVERIFIED** означает: название метода/поля правдоподобно и
взято из документации, но НЕ подтверждено живым вызовом в этой сессии —
обязательно перепроверить при первом реальном dry-run (Фаза 4/5).

| Нужно | Метод / объект | Ключевые поля | Статус | Заметки |
|---|---|---|---|---|
| Список коллекций и метаданные | `payments.getStarGifts` | `gifts[]`: `id`, `sticker`, `stars`, `availability_remains`, `availability_total`, `upgrade_stars` | UNVERIFIED | Актуальный layer может называть поля иначе для апгрейд-коллекций (`StarGiftAttribute*` для моделей/узоров/фонов/редкости) |
| total_supply / upgradedCount | нет единого официального метода «счётчик апгрейдов коллекции» | — | UNVERIFIED | В spec это явно помечено как открытый вопрос (0.3b). Публичный `t.me/nft/<slug>-<n>` (как в gifttracker-bot) — не официальный API, только prediction source. Официальный путь — вероятно агрегация через `payments.getStarGiftUpgradePreview` на пробных номерах или наблюдение `availability_remains` коллекции-прародителя, если Telegram это раскрывает по апгрейд-коллекциям отдельно. **Это открытый вопрос для owner/проверки, не для меня — см. 0.3 ниже.** |
| Saved Gifts пользователя | `payments.getSavedStarGifts` | `gift_id`, `gift_num` (= `num`), `msg_id`, `saved_id`, `slug`, `can_upgrade`, `upgraded`, `prepaid_upgrade`, `upgrade_stars` | UNVERIFIED | Поля названы по текущей практике GramJS 2.26.x (`optionalDependencies` в package.json); нужна проверка на актуальном layer |
| Upgrade preview | `payments.getStarGiftUpgradePreview` | `attributes` (sample) | UNVERIFIED | — |
| Upgrade attributes | `payments.getStarGiftUpgradeAttributes` | `model`, `pattern`, `backdrop`, `rarity_per_mille` | UNVERIFIED | — |
| Платёжная форма (не-prepaid) | `payments.getPaymentForm` + `inputInvoiceStarGiftUpgrade` | `invoice`, `total_amount` (Stars) | UNVERIFIED | Метод фактической отправки платежа Stars после формы — вероятно `payments.sendStarsForm` — **UNVERIFIED, нужно подтвердить точное имя** |
| Исполнение апгрейда (prepaid) | `payments.upgradeStarGift` + `InputSavedStarGift` | `keep_original_details` (опционально) | UNVERIFIED | `InputSavedStarGift` конструктор требует `peer` + `msg_id` ИЛИ `saved_id` — выяснить, какой вариант актуален |
| Bot API альтернатива (Вариант B) | `upgradeGift` (Bot API) | `business_connection_id`, `owned_gift_id`, `star_count` | UNVERIFIED | Требует Business-права `can_transfer_and_upgrade_gifts` (+`can_transfer_stars` для платного апгрейда); нужно подтвердить минимальную версию Bot API, где метод появился |
| Коды ошибок | `FLOOD_WAIT_X`, `AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, `STARGIFT_*` | — | UNVERIFIED (общая форма подтверждена, точный список `STARGIFT_*` кодов — нет) | Обобщённая классификация в `src/core/retry-manager.js` (temporary/permanent) написана на основе общих паттернов MTProto, не точного списка этого API |

## 0.3 — Проверка критических предпосылок

| # | Предпосылка | Статус | Если неверно |
|---|---|---|---|
| (a) | Номер присваивается последовательно в момент апгрейда | **НЕ подтверждено независимо** мной в этой сессии; это ПРЕДПОЛОЖЕНИЕ, на котором стоит вся prediction-логика (`nextExpectedNumber = upgradedCount + 1`). gifttracker-bot ведёт себя так, как будто это верно (растущий счётчик `issued`), что является практическим косвенным подтверждением за ~несколько месяцев работы, но не официальной гарантией Telegram | Если неверно — prediction (`d`, ETA, HOT_TARGET) теряет смысл как «подготовка заранее»; система всё равно безопасна, потому что исполнение требует 7.5-проверки, а не доверяет счётчику |
| (b) | Есть авторитетный и достаточно свежий источник `upgradedCount` | **Открытый вопрос.** Единственный найденный источник — публичный HTML `t.me/nft/<slug>-<n>` (не API, scraping). Официального API-счётчика апгрейдов коллекции в проверенной документации не нашёл | Решение по умолчанию (безопасное): использовать gifttracker-bot/t.me как ТОЛЬКО prediction-сигнал (уже так сделано), 7.5-проверка перед апгрейдом всегда идёт по официальному API на уровне конкретного Saved Gift пользователя, не по коллекционному счётчику |
| (c) | Можно получать для 120+ коллекций в рамках rate limits | Да, подтверждено практикой gifttracker-bot (121 коллекция, свип каждые ~20-30 мин через HTML, без официальных лимитов, т.к. не MTProto-вызов) | — |
| (d) | Какие поля подарка доступны до/после апгрейда | Частично подтверждено по практике GramJS: до — `gift_id/can_upgrade/prepaid_upgrade/upgrade_stars`; после — `num/slug/model/backdrop/pattern`. Точный список — UNVERIFIED | — |

**Вывод 0.3**: пункт (b) — реальный пробел. Официального источника
`upgradedCount` на уровне коллекции (как единого числа) я не нашёл в
документации. Это не блокирует архитектуру (counter остаётся prediction-only
по правилу 3.2), но означает, что скорость/точность HOT_TARGET детекции
зависит от внешнего паблик-сигнала (t.me HTML или gifttracker.
docs/gifts.json), а не от официального API — то есть реального SLA на
«задержку обнаружения» (detection latency) Telegram нам не даёт, только то,
что мы сами измеряем против внешнего сигнала.
