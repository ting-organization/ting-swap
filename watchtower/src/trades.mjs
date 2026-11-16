// What the watchtower knows of each listing, from the HTLC program's events
// alone (HTLC.md), the way the page's tradeOf reads them: no state of its own.
import { equal, hex } from '../../web/js/bytes.js';
import * as H from '../../web/js/htlc.js';
import * as L from '../../web/js/ltc.js';
import { isPublicKey } from '../../web/js/secp256k1.js';

/** Ting's nodes admit a block stamped up to 2 hours ahead; the buyer's page sends a first claim only this long before the deadline. */
export const FIRST_CLAIM_BEFORE = 7_200 + 1_800;

const lockOfTake = (take) => {
  try {
    return L.decodeTakeLock(take.lock);
  } catch {
    return null;
  }
};

/** Whether a listing is one the page trades: Litecoin, for the DLR coin. */
export const forThisPage = (listed, coin) => listed.chain === 'LTC' && equal(listed.coin, coin) && listed.key.length === 33 && isPublicKey(listed.key);

/**
 * Each listing of the page's kind, by id, from the program's events oldest
 * first: its offer, takes (with their lock bytes read), accept, claim, refund
 * or withdrawal, release data (releases and signed claims), and, for a
 * listing whose Litecoin key an earlier listing named, that listing's id.
 */
export function tradesOf(events, coin) {
  const byId = new Map();
  for (const e of events) {
    if (!byId.has(e.id)) byId.set(e.id, []);
    byId.get(e.id).push(e);
  }
  const keys = new Map();
  const trades = new Map();
  for (const [id, evs] of [...byId].sort((a, b) => a[0] - b[0])) {
    const listed = evs.find((e) => e.kind === 'listed');
    if (!listed || !forThisPage(listed, coin)) continue;
    const key = hex(listed.key);
    const copyOf = keys.get(key) ?? null;
    if (copyOf == null) keys.set(key, id);
    const signedClaims = [];
    for (const e of evs.filter((x) => x.kind === 'released')) {
      try {
        signedClaims.push({ ...e, claim: L.decodeSignedClaim(e.data) });
      } catch { /* a release, or not release data of the page's */ }
    }
    trades.set(id, {
      id, listed, copyOf,
      takes: evs.filter((e) => e.kind === 'taken').map((e, index) => ({ ...e, index, lockOf: lockOfTake(e) })).filter((t) => t.lockOf),
      accepted: evs.find((e) => e.kind === 'accepted') ?? null,
      claimed: evs.find((e) => e.kind === 'claimed') ?? null,
      refunded: evs.find((e) => e.kind === 'refunded') ?? null,
      withdrawn: evs.find((e) => e.kind === 'withdrawn') ?? null,
      signedClaims,
    });
  }
  return trades;
}

export const matchesAccept = (take, acc) => Boolean(acc) && equal(take.taker, acc.taker) && equal(take.hash, acc.hash) && take.t1 === acc.t1;

export const outKey = (o) => `${o.txid}:${o.vout}`;

/** A take's lock: its script rebuilt from the take and the listing, its output script, address and outpoint; null for a take that names none. */
export function lockOf(trade, take, program, net) {
  try {
    const htlc = { tag: L.lockTag(program, trade.id, take.taker), hash: take.hash, seller: trade.listed.key, buyer: take.lockOf.buyer, t1: take.t1 };
    return { htlc, ...L.lockOutput(htlc, net), txid: take.lockOf.txid, vout: take.lockOf.vout, key: outKey(take.lockOf) };
  } catch {
    return null;
  }
}

/** Whether an output as the explorer has it is the lock, paying its script at least `want`. */
export const pays = (lock, out, want) => Boolean(lock && out && !out.missing && out.script === hex(lock.scriptPubKey) && BigInt(out.value) >= BigInt(want));

/** When the seller can accept a take no longer: the program wants `t1 ≥ now + window + GAP`. */
export const acceptBy = (trade, take) => take.t1 - trade.listed.window - H.GAP;

/** Where a listing stands, as the feed shows it. */
export function status(trade, { locked = false } = {}) {
  if (trade.claimed) return 'swapped';
  if (trade.refunded) return 'refunded';
  if (trade.withdrawn) return 'withdrawn';
  if (trade.accepted) return 'accepted';
  return locked ? 'locked' : 'open';
}

export const closed = (trade) => Boolean(trade.claimed || trade.refunded || trade.withdrawn);

/**
 * The seller's signed claim for the accepted lock: the first posted whose
 * outpoint is a take matching the accept and whose signature verifies against
 * the listing's key, the rebuilt script and the output's value as Litecoin has
 * it (`outOf(lock)`). `{ take, lock, out, claim }`, or null.
 */
export function signedClaimFor(trade, program, net, outOf) {
  if (!trade.accepted) return null;
  for (const s of trade.signedClaims) {
    const take = trade.takes.find((t) => matchesAccept(t, trade.accepted) && t.lockOf.txid === s.claim.txid && t.lockOf.vout === s.claim.vout);
    const lock = take && lockOf(trade, take, program, net);
    const out = lock && outOf(lock);
    if (!out || out.missing || out.script !== hex(lock.scriptPubKey)) continue;
    let ok = false;
    try {
      ok = L.verifyClaimSignature({ txid: lock.txid, vout: lock.vout, value: out.value, htlc: lock.htlc, out: s.claim.out, signature: s.claim.signature });
    } catch { /* not a signature */ }
    if (ok) return { take, lock, out, claim: s.claim };
  }
  return null;
}

/** The takes matching the accept, each with its lock: what the accept may be for. */
export function acceptedLocks(trade, program, net) {
  if (!trade.accepted) return [];
  return trade.takes.filter((t) => matchesAccept(t, trade.accepted)).map((t) => ({ take: t, lock: lockOf(trade, t, program, net) })).filter((x) => x.lock);
}
