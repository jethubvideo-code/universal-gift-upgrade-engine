# Telegram API usage

## Methods / constructors used by the engine

Re-verified 2026-10-04 directly against core.telegram.org (Layer 225 pages,
read live, not from memory):

| Method / constructor | Purpose | Status |
|---|---|---|
| `payments.getStarGifts` | dynamic discovery of ALL gift collections + counters | existence confirmed; exact response shape UNVERIFIED (normalizer is defensive) |
| `payments.getSavedStarGifts` | the user's concrete saved gift instances | existence + `savedStarGift` field names confirmed (`msg_id`, `saved_id`, `can_upgrade`, `upgrade_stars`, `gift_num`) |
| `payments.getUniqueStarGift(slug)` | **window detection** (section 3.B): does slug N-1/N exist? | confirmed `payments.getUniqueStarGift#a1974d72 slug:string`; error `STARGIFT_SLUG_INVALID` confirmed |
| `payments.getStarGiftUpgradePreview` / `getStarGiftUpgradeAttributes` | preview of upgrade attributes | method existence confirmed; exact parameter name UNVERIFIED (used `stargift` by analogy, not confirmed on the page itself — re-check before relying on it) |
| `payments.upgradeStarGift` | prepaid upgrade execution | confirmed `payments.upgradeStarGift#aed6e4f5 flags:# keep_original_details:flags.0?true stargift:InputSavedStarGift` — **the field is `stargift`, not `saved_gift`** (code in v1.0 had this wrong; fixed 2026-10-04) |
| `inputInvoiceStarGiftUpgrade` → `payments.getPaymentForm` → `payments.sendStarsForm` | paid upgrade flow (2 steps) | confirmed `inputInvoiceStarGiftUpgrade#4d818d5d stargift:InputSavedStarGift`; confirmed `payments.sendStarsForm#7998c914 form_id:long invoice:InputInvoice`. The `sendStarsForm` step was MISSING entirely in v1.0 — added 2026-10-04. |
| `inputSavedStarGiftUser#69279795 msg_id:int` | identifies a personally-received gift | confirmed |
| `inputSavedStarGiftChat#f101aa7f peer:InputPeer saved_id:long` | identifies a channel-owned gift | confirmed to exist, but **not wired** — the engine has no `peer` resolution for channel gifts; only personal gifts supported |

**Not confirmed / explicitly flagged**: the spec text mentions an
`availability_issued` field on the collectible gift for the upgraded count.
The current `starGift` constructor (Layer 225) only exposes
`availability_remains` / `availability_total` (remaining vs. total supply of
the REGULAR, non-upgraded gift) — nothing that directly reports "how many
have been upgraded to collectibles so far". Window detection therefore relies
exclusively on `payments.getUniqueStarGift`, never on a counter field.

Bot API: `getUpdates`, `sendMessage`, `sendPhoto` (notifications and commands only).

**Library risk**: `telegram` (GramJS) 2.26.22 is the latest version on npm,
but npm itself flags the package as **archived / no longer maintained**,
pointing to `teleproto` as the actively maintained fork. Used anyway because
it is still the latest published release and the API surface used here is
stable — worth revisiting if Telegram changes the Layer again and GramJS
does not get a compatible release.

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
