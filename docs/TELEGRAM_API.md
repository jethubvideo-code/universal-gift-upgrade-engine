# Telegram API usage

## Methods / constructors used by the engine

| Method | Purpose |
|---|---|
| `payments.getStarGifts` | dynamic discovery of ALL gift collections + counters |
| `payments.getSavedStarGifts` | the user's concrete saved gift instances |
| `payments.getStarGiftUpgradePreview` | preview of upgrade attributes |
| `payments.getStarGiftUpgradeAttributes` | upgrade attributes |
| `payments.upgradeStarGift` (`InputSavedStarGift`) | prepaid upgrade execution |
| `inputInvoiceStarGiftUpgrade` → `payments.getPaymentForm` | paid upgrade flow |

Bot API: `getUpdates`, `sendMessage`, `sendPhoto` (notifications and commands only).

## ⚠️ TL schema validation — REQUIRED before production

The MTProto layer changes with every Telegram release. **The exact TL constructor
names and parameter shapes above must be re-validated against the CURRENT
layer before any production execution** (real Stars, real upgrades):

- Schema: https://core.telegram.org/schema
- API docs: https://core.telegram.org/api
- Payments/gifts reference: https://core.telegram.org/api/payments

The transport (`src/telegram/mtproto-client.js`) isolates schema drift: normalizers
accept both snake_case and camelCase responses, and every Telegram call goes
through `MtprotoClient.invoke(method, params)`. If Telegram renames a constructor
in a new layer, only the transport and the method table need updating — the
engine, state machine, and tests are untouched. No parameters are invented:
if a required parameter is not confirmed by the current schema, the call fails
loudly instead of guessing.

## Verification rules (counter ≠ truth)

`t.me/nft` and collection counters are used ONLY for public information and
prediction. They are never an execution or verification API. Before any upgrade
the engine re-verifies through official API:

1. the concrete gift exists (saved gifts of the user);
2. it belongs to the user;
3. `gift_num === target_number`;
4. not upgraded yet;
5. `can_upgrade === true` per actual Telegram state;
6. price ≤ user's maximum (auto upgrade only).

If any check fails: `FAILED`, `UNAVAILABLE`, or `PRICE_LIMIT_EXCEEDED` — no Stars spent.

## Rate limits and errors

- Central `TelegramRateLimiter`: global RPS cap, per-account per-method pacing, P0–P3 priority preemption, FLOOD_WAIT cooldown per (account, method).
- `FLOOD_WAIT_*` → cooldown of the reported duration, job retried on the next cycle (max 3 attempts, then FAILED).
- `AUTH_KEY_UNREGISTERED` / session revoked → `AUTH_ERROR` (permanent), user notified to re-link the official session.
- Never: parallel hammering, unbounded retries, bypassing flood waits, or any UI emulation of Telegram.
