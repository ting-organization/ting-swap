// The swap program's records, calls and events, the coins it trades, and the
// coin actions that pay for them (SPEC.md; Ting wiki: programs/coin).
import { concat, fromUtf8, Reader, u128, u64, Writer } from './bytes.js';
import { H } from './ting.js';
import { head } from './tcr.js';

/** The program's templates (TCR-1), by operation. */
export const TEMPLATES = {
  offer: 'offer(want:amount): Offer {payment} in exchange for {want}',
  take: 'take(listing:u64,get:amount): Take listing {listing}: pay {payment} and get {get}',
  withdraw: 'withdraw(listing:u64,back:amount): Withdraw listing {listing} and get back {back}',
};

// ---- Records ---------------------------------------------------------------

export const CONFIG_KEY = new Uint8Array(32);
export const COUNT_KEY = (() => {
  const key = new Uint8Array(32);
  key[0] = 2;
  return key;
})();

export function listingKey(id) {
  const key = new Uint8Array(32);
  key[0] = 1;
  key.set(u64(id), 1);
  return key;
}

export const decodeCount = (bytes) => (bytes ? Number(new Reader(bytes).u64()) : 0);

/** A listing's record, `maker ‖ give_coin ‖ u128 give ‖ want_coin ‖ u128 want ‖ u64 listed_at`, or null when absent. */
export function decodeListing(id, bytes) {
  if (!bytes) return null;
  const r = new Reader(bytes);
  const listing = {
    id, maker: r.id(), giveCoin: r.id(), give: r.u128(), wantCoin: r.id(), want: r.u128(), listedAt: Number(r.u64()),
  };
  r.end();
  return listing;
}

// ---- Calls -----------------------------------------------------------------

const call = (name, values) => ({ template: TEMPLATES[name], values, head: head(TEMPLATES[name], values) });

/** Offers whatever the payment puts in the swap, for `want` of `wantCoin`. */
export const offerCall = (wantCoin, want) => call('offer', concat(wantCoin, u128(want)));
/** Takes a listing, which must give `give` of `giveCoin`; the payment pays its maker. */
export const takeCall = (listing) => call('take', concat(u64(listing.id), listing.giveCoin, u128(listing.give)));
/** Withdraws a listing, its coins back to its maker. */
export const withdrawCall = (listing) => call('withdraw', concat(u64(listing.id), listing.giveCoin, u128(listing.give)));

/** The listing a take or a withdrawal names, from its values. */
export const listingOfCall = (values) => Number(new Reader(values).u64());

// ---- Events ----------------------------------------------------------------

/** Every event of the swap's own starts with this topic. */
export const TOPIC = H('app/swap-v1/event');
const KINDS = { 1: 'listed', 2: 'taken', 3: 'withdrawn' };

/** One of the swap's events, after its topic. */
export function decodeEvent(r) {
  const kind = KINDS[r.u8()];
  const id = Number(r.u64());
  if (kind === 'listed') {
    const e = { kind, id, maker: r.id(), giveCoin: r.id(), give: r.u128(), wantCoin: r.id(), want: r.u128() };
    r.end();
    return e;
  }
  if (kind === 'taken') {
    const e = { kind, id, maker: r.id(), taker: r.id(), giveCoin: r.id(), give: r.u128(), wantCoin: r.id(), want: r.u128() };
    r.end();
    return e;
  }
  if (kind === 'withdrawn') {
    const e = { kind, id, maker: r.id(), giveCoin: r.id(), give: r.u128() };
    r.end();
    return e;
  }
  throw new Error('an event this page does not know');
}

// ---- Coins -----------------------------------------------------------------

/** A coin's configuration record: its name, symbol and decimals. */
export function decodeCoin(bytes) {
  const r = new Reader(bytes);
  r.u8();
  const name = fromUtf8(r.bytes()), symbol = fromUtf8(r.bytes()), decimals = r.u8();
  return { name, symbol, decimals };
}

/** An account's record in a coin: `balance ‖ locked ‖ nonce`. */
export function decodeCoinAccount(bytes) {
  if (!bytes) return { balance: 0n, locked: 0n, nonce: 0n, available: 0n };
  const r = new Reader(bytes);
  const balance = r.u128(), locked = r.u128(), nonce = r.u64();
  return { balance, locked, nonce, available: balance - locked };
}

export const transferEffect = (to, amount) => concat(Uint8Array.of(1), to, u128(amount));

/** A plain coin transfer's action, bound to nothing: `effect ‖ fee ‖ tip ‖ not_before ‖ valid_until ‖ 00`. */
export const plainAction = (effect) => new Writer().put(effect).u128(0n).u128(0n).u64(0n).u64(0n).u8(0).finish();

// ---- Amounts ---------------------------------------------------------------

export function formatAmount(amount, decimals, maxFraction = decimals) {
  const negative = amount < 0n;
  const v = negative ? -amount : amount;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const fraction = (v % unit).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '');
  const text = whole.toLocaleString('en-US') + (fraction ? '.' + fraction : '');
  return (negative ? '−' : '') + text;
}

/** An amount as a link carries it: decimal, in the coin's units, without separators. */
export const linkAmount = (amount, decimals) => formatAmount(amount, decimals).replace(/,/g, '');

/** Base units of a decimal amount such as `12.5`, or null. */
export function parseAmount(text, decimals) {
  const m = String(text).trim().replace(/[,_\s]/g, '').match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (m[1] === '' && !m[2])) return null;
  if ((m[2] ?? '').length > decimals) return null;
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}

/**
 * How many units of the second coin one unit of the first is worth, `b / a`
 * with each amount in its coin's units, as text with `digits` significant
 * digits at most.
 */
export function rate(a, aDecimals, b, bDecimals, digits = 6) {
  if (a === 0n) return '—';
  const SCALE = 36n;
  const q = (b * 10n ** (BigInt(aDecimals) + SCALE)) / (a * 10n ** BigInt(bDecimals));
  if (q === 0n) return '0';
  const text = q.toString();
  const point = text.length - Number(SCALE);
  // Keep `digits` significant digits, but never cut the whole part.
  const keep = Math.max(digits, point);
  const sig = text.slice(0, keep).padEnd(Math.max(point, 0), '0');
  let whole, fraction;
  if (point > 0) {
    whole = sig.slice(0, point);
    fraction = sig.slice(point);
  } else {
    whole = '0';
    fraction = '0'.repeat(-point) + sig;
  }
  fraction = fraction.replace(/0+$/, '');
  return BigInt(whole).toLocaleString('en-US') + (fraction ? '.' + fraction : '');
}

/** Orders two listings of one pair by what one unit of their coin costs: `a.want / a.give` against `b.want / b.give`. */
export const byRate = (a, b) => {
  const left = a.want * b.give, right = b.want * a.give;
  return left < right ? -1 : left > right ? 1 : 0;
};
