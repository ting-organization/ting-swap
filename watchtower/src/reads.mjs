// Which Litecoin outputs the watchtower reads each round, by the page's own
// rules (HTLC.md, "Reading"). Takes, copies of takes and listings cost nothing
// or little to post, so nothing posted can make it read more than READS
// outputs a round, and an output is read again only when something could have
// changed that the watchtower needs.
import { hex } from '../../web/js/bytes.js';
import { acceptedLocks, closed, lockOf } from './trades.mjs';

/** Outputs read a round at most, two requests each. */
export const READS = 12;
/** An output Litecoin did not have is read again after this long; one whose read failed, after FAILED_AGAIN. */
export const MISSING_AGAIN = 300;
export const FAILED_AGAIN = 60;
/** A paying, unspent lock that only the feed and the reminders need is read again after this long. */
export const SLOW_AGAIN = 600;
/** An accepted lock is followed no longer than this past its T1. */
export const AFTER_T1 = 86_400;

/**
 * Whether a lock's output is due, and how urgently (lower first), or null:
 * one never read, at once; one Litecoin did not have, after MISSING_AGAIN;
 * one that pays another script, or is spent in a block, never again; one whose
 * read failed, after FAILED_AGAIN; an `urgent` one every round; any other
 * after SLOW_AGAIN. An `accepted` listing's lock goes before an open
 * listing's take, which is free to post and feeds only the feed and the
 * seller's "a buyer locked" reminder. `kept` is `{ out, at }` as last read.
 */
export function due(lock, kept, { now, failedAt = 0, urgent = false, accepted = false }) {
  if (now - failedAt < FAILED_AGAIN) return null;
  if (!kept) return { rank: urgent ? 0 : accepted ? 1 : 2, at: 0 };
  const o = kept.out;
  const again = accepted ? 3 : 4;
  if (o.missing) return now - kept.at >= MISSING_AGAIN ? { rank: again, at: kept.at } : null;
  if (o.script !== hex(lock.scriptPubKey) || (o.spent && o.spenderConfirmed)) return null;
  if (urgent) return { rank: 0, at: kept.at };
  return now - kept.at >= SLOW_AGAIN ? { rank: again, at: kept.at } : null;
}

/**
 * The locks to read this round, at most READS, most urgent first, then those
 * read longest ago:
 * - the locks an accept may be for, until AFTER_T1 past T1, one never seen
 *   not after T1. For a claimed listing: every round the one its verifying
 *   signed claim spends, until a spend of it is in a block, and at once those
 *   never read, since the claim waits for all of them (acceptedLockOf). For
 *   the rest, slowly: only the feed and the reminders need them.
 * - the takes' locks of open listings, the same way, after all of those.
 * `outs` maps an outpoint to `{ out, at }`, `failed` to when its read failed;
 * `claimOf(trade)` is trades.mjs's claimOf on the outputs read.
 */
export function readsDue({ trades, program, net, outs, failed, now, claimOf }) {
  const wanted = [];
  const add = (lock, flags) => {
    const d = lock && due(lock, outs.get(lock.key), { now, failedAt: failed.get(lock.key), ...flags });
    if (d) wanted.push({ lock, ...d });
  };
  for (const trade of trades.values()) {
    if (trade.accepted) {
      if (trade.refunded || now > trade.accepted.t1 + AFTER_T1) continue;
      const r = trade.claimed ? claimOf(trade) : null;
      for (const { lock } of acceptedLocks(trade, program, net)) {
        if (outs.get(lock.key)?.out.missing && now > trade.accepted.t1) continue;
        const spends = r?.state === 'one' && r.claim && r.lock.key === lock.key;
        add(lock, { accepted: true, urgent: Boolean(spends || (trade.claimed && !outs.has(lock.key))) });
      }
    } else if (!closed(trade)) {
      for (const take of trade.takes) add(lockOf(trade, take, program, net), {});
    }
  }
  const seen = new Set();
  return wanted
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .filter((w) => !seen.has(w.lock.key) && seen.add(w.lock.key))
    .slice(0, READS)
    .map((w) => w.lock);
}

/**
 * The outpoints whose reads are still of use: the takes' locks of open
 * listings, of accepted ones until AFTER_T1 past T1, and of withdrawn ones
 * until AFTER_T1 past each take's T1 (the buyer's "refund it" reminder). Every
 * other read is dropped before the state is saved, so that takes posted for
 * nothing do not keep it growing.
 */
export function outsInUse({ trades, program, net, now }) {
  const keep = new Set();
  for (const trade of trades.values()) {
    if (trade.refunded) continue;
    if (trade.accepted && now > trade.accepted.t1 + AFTER_T1) continue;
    const ended = trade.withdrawn && !trade.accepted;
    for (const take of trade.takes) {
      if (ended && now > take.t1 + AFTER_T1) continue;
      const lock = lockOf(trade, take, program, net);
      if (lock) keep.add(lock.key);
    }
  }
  return keep;
}
