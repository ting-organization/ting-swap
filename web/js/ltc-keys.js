// What the Litecoin page keeps in this browser (HTLC.md, "The page"): one
// random 32-byte seed, from which every secret and Litecoin key of every trade
// derives, its backup code, and the trades this browser takes part in. Nothing
// here leaves the browser; a secret leaves it only inside a claim.
import { concat, hex, u32, unhex, utf8 } from './bytes.js';
import { decodeBech32, encodeBech32 } from './ltc.js';
import { hmacSha256, N, publicKey, toBig } from './secp256k1.js';
import { sha256 } from './sha256.js';

const SEED = 'ting-swap/ltc/seed';
const NEXT = 'ting-swap/ltc/next';
const SAVED = 'ting-swap/ltc/backed-up';
const TRADES = 'ting-swap/ltc/trades/';

/** The backup code's prefix: a bech32 string of the seed, so that a mistyped code is caught. */
export const CODE_PREFIX = 'tingswap';

/** How many counters in a row a restore reads past the last one in use. */
export const GAP_LIMIT = 20;

// ---- Storage ---------------------------------------------------------------

/** Whether this browser lets the page keep anything: a private window or a blocked site may not. */
export function canStore() {
  try {
    const probe = 'ting-swap/ltc/probe';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function read(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text == null ? fallback : JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Writes or throws: a key the page cannot keep must not be used. */
function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

// ---- The seed ----------------------------------------------------------------

/** This browser's seed, or null when it has none yet. */
export function seed() {
  const text = read(SEED, null);
  return typeof text === 'string' && /^[0-9a-f]{64}$/.test(text) ? unhex(text) : null;
}

/** Makes this browser's seed, once: 32 random bytes. Throws when the browser cannot keep it. */
export function makeSeed() {
  const have = seed();
  if (have) return have;
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  write(SEED, hex(fresh));
  write(NEXT, 0);
  write(SAVED, false);
  if (!seed()) throw new Error('this browser did not keep the key');
  return fresh;
}

/** Puts a restored seed in place of this browser's, the counter after `next`. */
export function restoreSeed(bytes, next) {
  write(SEED, hex(bytes));
  write(NEXT, next);
  write(SAVED, true);
}

/** Whether the user said they wrote the backup code down. */
export const backedUp = () => read(SAVED, false) === true;
export const markBackedUp = () => write(SAVED, true);

// ---- Derivation ----------------------------------------------------------------

/** Secret n: `HMAC-SHA256(seed, "htlc-v1/secret" ‖ u32 n)`. */
export const secretAt = (s, n) => hmacSha256(s, concat(utf8('htlc-v1/secret'), u32(n)));

/**
 * Key n: `HMAC-SHA256(seed, "htlc-v1/key" ‖ u32 n)` read as a big-endian
 * number, or null when that number is 0 or at least the group's order N: a
 * counter without a key is skipped, for its secret too.
 */
export function keyAt(s, n) {
  const k = hmacSha256(s, concat(utf8('htlc-v1/key'), u32(n)));
  const v = toBig(k);
  return v === 0n || v >= N ? null : k;
}

/** What a restore looks for of counter n: the key's public key, and the secret's hash. Null for a skipped counter. */
export function marksAt(s, n) {
  const key = keyAt(s, n);
  if (!key) return null;
  return { n, pub: publicKey(key), hash: sha256(secretAt(s, n)) };
}

/** Counters handed out lately, with the tab that took each: what a second tab checks against. */
const RESERVED = 'ting-swap/ltc/reserved';
const TAB = Math.random().toString(36).slice(2);

/** Every counter a trade of this browser holds, on any program. */
function countersInUse() {
  const used = new Set();
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(TRADES)) continue;
    const list = read(key, []);
    if (Array.isArray(list)) for (const t of list) if (Number.isInteger(t?.n)) used.add(t.n);
  }
  return used;
}

/**
 * The next counter from NEXT that has a key and that `used(n)` does not
 * call taken, nor a trade of this browser holds; NEXT is moved past it and
 * the counter noted as this tab's before it is handed out.
 */
function reserve(s, used) {
  const held = countersInUse();
  for (const r of read(RESERVED, [])) if (Number.isInteger(r?.n)) held.add(r.n);
  let n = Number(read(NEXT, 0)) || 0;
  for (let tries = 0; !keyAt(s, n) || held.has(n) || used(n); n++) {
    if (++tries > 10_000) throw new Error('no free counter found');
  }
  write(NEXT, n + 1);
  const list = read(RESERVED, []).filter((r) => r && Date.now() - r.at < 86_400_000).slice(-49);
  write(RESERVED, [...list, { n, tab: TAB, at: Date.now() }]);
  if (Number(read(NEXT, 0)) !== n + 1) throw new Error('this browser did not keep the counter');
  return n;
}

/**
 * Takes the next counter for a new trade, skipping any without a key, any a
 * trade of this browser holds, and any `used(n)` says the chain already shows
 * (a listing with its key, a take with its secret's hash: a backup code used in
 * two browsers, or a restore that could not see a lock). The counter after it
 * is kept before it is handed out, under a lock across this browser's tabs
 * where the browser has Web Locks; where it has not, the page waits a moment
 * and takes another if a second tab took the same one. A counter is never
 * used twice.
 */
export async function takeCounter(used = () => false) {
  const s = seed();
  if (!s) throw new Error('no seed yet');
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request('ting-swap/ltc/counter', () => reserve(s, used));
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const n = reserve(s, used);
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 120));
    const takers = read(RESERVED, []).filter((r) => r?.n === n);
    if (takers.length === 1 && takers[0].tab === TAB) return n;
  }
  throw new Error('another tab of this page keeps taking the same keys: close it, and try again');
}

export const nextCounter = () => Number(read(NEXT, 0)) || 0;

// ---- The backup code ---------------------------------------------------------

function regroup(data, from, to) {
  let acc = 0, bits = 0;
  const out = [];
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & ((1 << to) - 1));
    }
    acc &= (1 << bits) - 1;
  }
  return { out, bits, rest: acc };
}

/** The seed as its backup code: `tingswap1…`, bech32, 67 characters. */
export function backupCode(bytes) {
  const { out, bits, rest } = regroup(bytes, 8, 5);
  if (bits) out.push((rest << (5 - bits)) & 31);
  return encodeBech32(CODE_PREFIX, out);
}

/** The code split in groups of four after its prefix, to read and write down. */
export function groupedCode(code) {
  const body = code.slice(CODE_PREFIX.length + 1);
  return `${CODE_PREFIX}1 ${body.match(/.{1,4}/g).join(' ')}`;
}

/** The seed of a backup code, spaces and dashes ignored; throws saying what is wrong. */
export function readBackupCode(text) {
  const clean = String(text ?? '').replace(/[\s-]+/g, '').toLowerCase();
  if (!clean) throw new Error('paste the code first');
  if (!clean.startsWith(`${CODE_PREFIX}1`)) throw new Error(`a backup code starts with ${CODE_PREFIX}1`);
  let decoded;
  try {
    decoded = decodeBech32(clean);
  } catch (e) {
    throw new Error(/checksum/.test(e.message) ? 'a character is wrong or missing: check the code again' : `it is not a backup code: ${e.message}`);
  }
  if (decoded.hrp !== CODE_PREFIX || decoded.variant !== 'bech32' || decoded.data.length !== 52) throw new Error('it is not a backup code of this page');
  const { out, bits, rest } = regroup(decoded.data, 5, 8);
  if (out.length !== 32 || bits !== 4 || rest !== 0) throw new Error('it is not a backup code of this page');
  return Uint8Array.from(out);
}

// ---- Trades ----------------------------------------------------------------

/**
 * This browser's trades on one program, by listing and role. A trade is
 * `{ n, role: 'seller' | 'buyer', listing, created, … }`: the seller's
 * offer terms and payout address, or the buyer's receiving account, refund
 * address, T1 and lock; secrets and keys are never stored, only `n`.
 */
export function trades(program) {
  const list = read(TRADES + hex(program), []);
  return Array.isArray(list) ? list.filter((t) => t && Number.isInteger(t.n) && (t.role === 'seller' || t.role === 'buyer')) : [];
}

/** Keeps a trade, replacing the one with its counter; throws when the browser cannot keep it. */
export function saveTrade(program, trade) {
  const list = trades(program).filter((t) => t.n !== trade.n);
  list.push({ ...trade, updated: Date.now() });
  write(TRADES + hex(program), list);
  return trade;
}

/** Keeps new fields of a trade over what is stored of it now, so that two updates never undo each other. */
export function updateTrade(program, trade, fields) {
  const stored = trades(program).find((t) => t.n === trade.n) ?? trade;
  Object.assign(trade, fields);
  return saveTrade(program, { ...stored, ...fields });
}

export function dropTrade(program, n) {
  write(TRADES + hex(program), trades(program).filter((t) => t.n !== n));
}

/** Forgets every trade of every program: when another seed takes this one's place, its counters mean other keys. */
export function dropAllTrades() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith(TRADES)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}
