// What a claim costs now, as Ting ID works out its fees (ting-id-web,
// web/js/chain/fees.js): what recent paying transactions paid for a whole
// block's worth of room, at the median, times the share of a block a claim
// takes. Read from the newest blocks only when needed, and kept for ten
// minutes, in this browser too.
import { equal, Reader, unhex } from './bytes.js';
import { H } from './ting.js';

const PAYMENT = H('app/event/producer-payment-v1');
const TRANSFER = H('app/coin-v1/event/transfer');
const ZERO = new Uint8Array(32);
/** Blocks read back at most: two requests. */
const LOOK_BACK = 200;
const SAMPLES = 50;
const KEEP_MS = 600_000;
const STORE = 'ting-swap/fees';

/**
 * What a claim of the HTLC program uses, in C, S, D, G: 2,741,236 C, 19 S,
 * 824 D and 76 G measured on Ting's reference VM, with a little room. A
 * refund uses about the same.
 */
export const CLAIM_USE = [2_800_000, 20, 900, 100];

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || '{}');
  } catch {
    return {};
  }
}

function keep(cache) {
  try {
    localStorage.setItem(STORE, JSON.stringify(cache));
  } catch {
    // kept for this visit only
  }
}

const shareOf = (used, limits) => Math.max(...used.map((u, i) => Number(u) / Number(limits[i] || 1)));

/** `v` to two significant digits, as Ting ID rounds a fee. */
export function twoDigits(v) {
  if (v < 100n) return v;
  const unit = 10n ** BigInt(v.toString().length - 2);
  return ((v + unit / 2n) / unit) * unit;
}

/**
 * The fee of a claim paid in `coin` now, in its smallest units: 0 when no
 * recent transaction paid in it, as on a development chain whose miner has
 * no payout account.
 */
export async function claimFee(node, coin) {
  const cache = load();
  const hit = cache[coin];
  if (hit && Date.now() - hit.at < KEEP_MS) return BigInt(hit.fee);
  const coinHex = typeof coin === 'string' ? coin : [...coin].map((b) => b.toString(16).padStart(2, '0')).join('');
  const height = (await node.status()).height;
  const rates = [];
  let limits = null;
  let to = height;
  while (to > 0 && height - to < LOOK_BACK && rates.length < SAMPLES) {
    const from = Math.max(1, to - 99);
    const page = await node.request(`/v1/blocks?from=${from}&limit=${to - from + 1}`);
    for (const block of [...page.items].reverse()) {
      if (!block.limits) continue;
      limits ??= block.limits;
      for (const receipt of block.receipts ?? []) {
        if (receipt.status !== 0) continue;
        let paid = 0n;
        let issues = false;
        for (const e of receipt.events ?? []) {
          if (e.contract !== coinHex) continue;
          const payload = unhex(e.payload_hex);
          if (equal(payload.subarray(0, 32), PAYMENT)) paid += new Reader(payload.subarray(64)).u128();
          else if (equal(payload.subarray(0, 32), TRANSFER) && equal(payload.subarray(32, 64), ZERO)) issues = true;
        }
        // A block reward's claim issues coins and pays nothing: not a fee.
        if (!paid || issues) continue;
        const share = shareOf(receipt.used, block.limits);
        if (share > 0) rates.push(Number(paid) / share);
        if (rates.length >= SAMPLES) break;
      }
      if (rates.length >= SAMPLES) break;
    }
    to = from - 1;
  }
  let fee = 0n;
  if (rates.length && limits) {
    rates.sort((a, b) => a - b);
    const median = rates[Math.floor(rates.length / 2)];
    fee = twoDigits(BigInt(Math.max(1, Math.ceil(median * shareOf(CLAIM_USE, limits)))));
  }
  cache[coinHex] = { fee: fee.toString(), at: Date.now() };
  keep(cache);
  return fee;
}
