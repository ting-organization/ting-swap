// The HTLC program's records, calls, inputs and events (HTLC.md): listings on
// Ting for an amount on another chain, the locks an accept makes, and the
// claims and refunds that end them.
import { concat, framed, Reader, u128, u64, Writer } from './bytes.js';
import { encodeCall, H } from './ting.js';
import { head } from './tcr.js';

/** The program's templates (TCR-1), by operation, as HTLC.md has them. */
export const TEMPLATES = {
  offer: "offer(chain:enum(LTC|BTC),whole:u64,d1:u8,d2:u8,d3:u8,d4:u8,d5:u8,d6:u8,d7:u8,d8:u8,key:bytes,window:duration,fee:amount): Sell {payment} for {whole}.{d1}{d2}{d3}{d4}{d5}{d6}{d7}{d8} {chain}, paid to your {chain} key ({key}). Once a buyer's lock is accepted, the coins are held for them for {window}. The buyer's claim, or a refund, pays a network fee of {fee} out of these coins",
  offer_to: "offer_to(taker:account,chain:enum(LTC|BTC),whole:u64,d1:u8,d2:u8,d3:u8,d4:u8,d5:u8,d6:u8,d7:u8,d8:u8,key:bytes,window:duration,fee:amount): Sell {payment} to {taker} only, for {whole}.{d1}{d2}{d3}{d4}{d5}{d6}{d7}{d8} {chain}, paid to your {chain} key ({key}). Once their lock is accepted, the coins are held for them for {window}. Their claim, or a refund, pays a network fee of {fee} out of these coins",
  accept: 'accept(listing:u64,taker:account,hash:bytes32,until:time,give:amount): Accept a lock for listing {listing}: hold {give} for {taker} until they reveal the secret of {hash}, before their lock ends {until}',
  withdraw: 'withdraw(listing:u64,back:amount): Withdraw listing {listing} and get back {back}',
};

/** The chains an offer may name, by the index of its `chain` enum. Each counts its coin in hundred-millionths. */
export const CHAINS = ['LTC', 'BTC'];
/** Base units in one coin of the other chain. */
export const UNITS = 100_000_000n;

/** The least time between the deadline on Ting and the lock's end on the other chain. */
export const GAP = 21_600;
/** The least window: well above the 2 hours Ting's nodes let a block's stamp run ahead (HTLC.md, the claims). */
export const MIN_WINDOW = 21_600;
export const MAX_WINDOW = 604_800;

const ZERO = new Uint8Array(32);
export const isZero = (bytes) => bytes.every((b) => b === 0);

// ---- Records ---------------------------------------------------------------

export const CONFIG_KEY = new Uint8Array(32);

function keyOf(kind, id) {
  const key = new Uint8Array(32);
  key[0] = kind;
  if (id != null) key.set(u64(id), 1);
  return key;
}

export const listingKey = (id) => keyOf(1, id);
export const COUNT_KEY = keyOf(2);
export const lockKey = (id) => keyOf(3, id);

export const decodeCount = (bytes) => (bytes ? Number(new Reader(bytes).u64()) : 0);

/** An open listing's record, or null when absent. */
export function decodeListing(id, bytes) {
  if (!bytes) return null;
  const r = new Reader(bytes);
  const listing = {
    id, maker: r.id(), coin: r.id(), amount: r.u128(), want: r.u64(), taker: r.id(), window: Number(r.u64()),
    fee: r.u128(), listedAt: Number(r.u64()), chain: new TextDecoder().decode(r.bytes()), key: r.bytes(),
  };
  r.end();
  return listing;
}

/** A lock's record, or null when absent. */
export function decodeLock(id, bytes) {
  if (!bytes) return null;
  const r = new Reader(bytes);
  const lock = {
    id, maker: r.id(), coin: r.id(), amount: r.u128(), taker: r.id(), hash: r.id(), t1: Number(r.u64()),
    deadline: Number(r.u64()), fee: r.u128(),
  };
  r.end();
  return lock;
}

// ---- Signed calls (TCR-1) --------------------------------------------------

const call = (name, values) => ({ template: TEMPLATES[name], values, head: head(TEMPLATES[name], values) });

/**
 * An offer: whatever the payment puts in the program, for `want` base units
 * of `chain`, paid to the seller's `key` there; held `window` seconds once
 * accepted, a claim or refund paying a fee of up to `fee` of `coin`. With a
 * `taker`, only that account may take it.
 */
export function offerCall({ taker, chain, want, key, window, coin, fee }) {
  const index = CHAINS.indexOf(chain);
  if (index < 0) throw new Error(`the program takes no chain ${chain}`);
  // The amount as the wallet shows it: whole coins, a dot, and eight digits.
  const units = BigInt(want);
  const digits = (units % UNITS).toString().padStart(8, '0');
  const rest = new Writer().u8(index).put(u64(units / UNITS)).put(Uint8Array.from(digits, Number))
    .bytes(key).put(u64(window)).put(coin).put(u128(fee)).finish();
  return taker && !isZero(taker) ? call('offer_to', concat(taker, rest)) : call('offer', rest);
}

/** Accepts a take: holds the listing's coins for `taker` under `hash`, whose lock elsewhere ends at `t1`. */
export const acceptCall = (listing, { taker, hash, t1 }) =>
  call('accept', concat(u64(listing.id), taker, hash, u64(t1), listing.coin, u128(listing.amount)));

/** Withdraws an open listing, its coins back to its maker. */
export const withdrawCall = (listing) => call('withdraw', concat(u64(listing.id), listing.coin, u128(listing.amount)));

// ---- The program's own inputs: anyone may send them --------------------------

export const TAKE = H('app/htlc-v1/take');
export const CLAIM = H('app/htlc-v1/claim');
export const REFUND = H('app/htlc-v1/refund');
export const RELEASE = H('app/htlc-v1/release');

/** What a call of the program's own may spend, in C, S, D and G. */
export const BUDGET = [30_000_000, 512, 1_048_576, 1_048_576];

export const takeInput = ({ id, taker, hash, t1, lock }) => concat(TAKE, u64(id), taker, hash, u64(t1), framed(lock));
export const claimInput = (id, secret) => concat(CLAIM, u64(id), secret);
export const refundInput = (id) => concat(REFUND, u64(id));
export const releaseInput = (id, data) => concat(RELEASE, u64(id), framed(data));

/** A transaction that calls the program with one of its own inputs: no signature, no fee of its own. */
export const ownCall = (program, input) => encodeCall(program, input, BUDGET);

/** The listing, lock or count queries, safe read-only. */
export const listingQuery = (id) => concat(Uint8Array.of(8), u64(id));
export const lockQuery = (id) => concat(Uint8Array.of(0x0a), u64(id));

// ---- Events ----------------------------------------------------------------

/** Every event of the program's own starts with this topic. */
export const TOPIC = H('app/htlc-v1/event');
const KINDS = { 1: 'listed', 2: 'taken', 3: 'accepted', 4: 'claimed', 5: 'refunded', 6: 'withdrawn', 7: 'released' };

/** One event of the program's own, read after its topic. */
export function decodeEvent(r) {
  const kind = KINDS[r.u8()];
  if (!kind) throw new Error('an event of an unknown kind');
  const id = Number(r.u64());
  const e = { kind, id };
  switch (kind) {
    case 'listed':
      Object.assign(e, {
        maker: r.id(), coin: r.id(), amount: r.u128(), want: r.u64(), taker: r.id(), window: Number(r.u64()),
        fee: r.u128(), chain: new TextDecoder().decode(r.bytes()), key: r.bytes(),
      });
      break;
    case 'taken':
      Object.assign(e, { taker: r.id(), hash: r.id(), t1: Number(r.u64()), lock: r.bytes() });
      break;
    case 'accepted':
      Object.assign(e, {
        maker: r.id(), taker: r.id(), hash: r.id(), t1: Number(r.u64()), deadline: Number(r.u64()), coin: r.id(),
        amount: r.u128(),
      });
      break;
    case 'claimed':
      Object.assign(e, { taker: r.id(), secret: r.id(), paid: r.u128(), fee: r.u128() });
      break;
    case 'refunded':
      Object.assign(e, { maker: r.id(), paid: r.u128(), fee: r.u128() });
      break;
    case 'withdrawn':
      Object.assign(e, { maker: r.id(), coin: r.id(), amount: r.u128() });
      break;
    case 'released':
      e.data = r.bytes();
      break;
  }
  r.end();
  return e;
}

export { ZERO };
