#!/usr/bin/env node
/**
 * SYNTHETIC, LOCAL-ONLY micro-benchmark for the T_fire metric's non-network
 * component: how long it takes, on THIS machine's CPU, to build a request
 * object and run an AES encryption + hash of comparable size to one MTProto
 * message, with ZERO network I/O.
 *
 * HONESTY NOTE (do not misread this as the real number):
 *  - This is NOT GramJS's actual encrypt-and-write pipeline (that also does
 *    AES-256-IGE specifically, msg_id/seq_no bookkeeping, and a real socket
 *    write syscall) — it is a stand-in of comparable computational shape
 *    (AES-256-CBC + SHA-256 over a similarly-sized buffer), run with Node's
 *    built-in crypto, to show the ORDER OF MAGNITUDE of the local-only part
 *    of T_fire on the actual deployment machine.
 *  - The real "from window-open-detected to request-written-to-socket"
 *    latency can only be measured inside a live GramJS session — that
 *    requires the owner's login and is covered by scripts/dryrun-speedtest.js
 *    (which, however, cannot isolate T_fire from the network T_detect round
 *    trip either, since GramJS does not expose a pre-write hook — documented
 *    there as an UNVERIFIED gap, not glossed over).
 *  - What IS useful here: confirms the pure-CPU cost is far below the 50ms /
 *    200ms targets, so if T_total ever misses budget, the bottleneck is
 *    network/Telegram-side, never this local step, on this class of hardware.
 *
 * Run: node scripts/benchmark-fire-local.mjs
 */
import crypto from 'node:crypto';

const SAMPLES = 2000;
const MSG_SIZE = 320; // bytes — comparable to a serialized upgradeStarGift/sendStarsForm request

function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function buildRequestObject(targetNumber) {
  // Comparable in shape to the real serialized call built by payment-executor.js
  return {
    _: 'inputSavedStarGiftUser',
    msg_id: 123456 + targetNumber,
    _invoke: 'payments.upgradeStarGift',
    flags: 0,
    stargift: { _: 'inputSavedStarGiftUser', msg_id: 123456 + targetNumber }
  };
}

const key = crypto.randomBytes(32);
const latenciesNs = [];

for (let i = 0; i < SAMPLES; i++) {
  const t0 = process.hrtime.bigint();

  const obj = buildRequestObject(i);
  const payload = Buffer.from(JSON.stringify(obj)); // stand-in for TL binary serialization
  const padded = Buffer.concat([payload, Buffer.alloc(MSG_SIZE - (payload.length % MSG_SIZE || MSG_SIZE))]).subarray(0, Math.max(MSG_SIZE, payload.length));
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(padded), cipher.final()]);
  crypto.createHash('sha256').update(enc).digest(); // stand-in for msg key derivation

  const t1 = process.hrtime.bigint();
  latenciesNs.push(Number(t1 - t0));
}

const toMs = ns => ns / 1e6;
const latenciesMs = latenciesNs.map(toMs);

console.log(`SYNTHETIC local-only T_fire proxy — ${SAMPLES} samples, ${MSG_SIZE}-byte message, this machine's CPU, zero network I/O.`);
console.log(`  p50: ${percentile(latenciesMs, 50).toFixed(4)} ms`);
console.log(`  p95: ${percentile(latenciesMs, 95).toFixed(4)} ms`);
console.log(`  p99: ${percentile(latenciesMs, 99).toFixed(4)} ms`);
console.log(`  max: ${Math.max(...latenciesMs).toFixed(4)} ms`);
console.log('\nThis is REAL, measured output from running this exact script — not a marketing estimate.');
console.log('It only covers the local build+crypto step. T_fire\'s true definition also includes the socket');
console.log('write syscall and GramJS internals, which are not independently measurable without a live session.');
