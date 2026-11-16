// The only two things the watchtower sends (HTLC.md, "The watchtower"). It
// holds no key: what it sends anyone may send.
//
// - The seller's signed claim, finished with the secret the buyer's claim on
//   Ting made public: it pays only the seller's address.
// - The refund on Ting of a listing whose deadline passed with no claim: the
//   program sends the coins back to the maker, whoever sends it.
import * as H from '../../web/js/htlc.js';
import * as L from '../../web/js/ltc.js';
import { claimOf, outKey } from './trades.mjs';

/** A transaction sent that the explorer or the node does not know is sent again after this many seconds. */
export const RESEND_AFTER = 120;
/** How long past a deadline, by the clock and by Ting's tip, before the watchtower sends a refund: it never helps a block stamped ahead of time. */
export const REFUND_MARGIN = 120;

/**
 * Finishes and sends the seller's signed claim of every accepted lock whose
 * buyer claimed on Ting, and sends it again while the explorer does not know
 * it, until the lock is spent. Only when Litecoin shows which lock the accept
 * was for (claimOf's `one`): with two paying outputs at the lock address, the
 * pages decide. `outOf(lock)` is the lock's output as last read. Returns what
 * it did, for the log and the notes.
 */
export async function sendClaims({ trades, program, net, outOf, litecoin, state, now, dryRun, log }) {
  const done = [];
  for (const trade of trades.values()) {
    if (!trade.claimed || trade.refunded) continue;
    const r = claimOf(trade, program, net, outOf);
    if (r.state !== 'one') continue;
    const { lock, out, claim } = r;
    const key = outKey(lock);
    const kept = state.claims[key];
    if (out.spent) {
      if (kept) kept.spent = { by: out.spender, confirmed: out.spenderConfirmed, at: kept.spent?.at ?? now };
      continue;
    }
    if (!claim) continue;
    let tx;
    try {
      tx = L.finishClaim({ txid: lock.txid, vout: lock.vout, value: out.value, htlc: lock.htlc, out: claim.out, signature: claim.signature, secret: trade.claimed.secret });
    } catch (e) {
      log(`#${trade.id}: the signed claim cannot be finished: ${e.message}`);
      continue;
    }
    if (kept?.txid === tx.txid) {
      if (now - kept.at < RESEND_AFTER) continue;
      const s = await litecoin.txStatus(tx.txid).catch(() => null);
      if (!s || s.found) continue;
    }
    if (dryRun) {
      log(`#${trade.id}: would send the seller's signed claim ${tx.txid} (${tx.fee} litoshi fee)`);
    } else {
      try {
        await litecoin.broadcast(tx.hex);
        log(`#${trade.id}: sent the seller's signed claim ${tx.txid}`);
      } catch (e) {
        log(`#${trade.id}: Litecoin ${e.refused ? 'refused' : 'did not take'} the signed claim ${tx.txid}: ${e.message}`);
        if (kept?.txid === tx.txid) kept.at = now;
        else state.claims[key] = { txid: tx.txid, listing: trade.id, at: now, first: now, error: e.message };
        continue;
      }
    }
    state.claims[key] = { txid: tx.txid, listing: trade.id, at: now, first: kept?.first ?? now, fee: tx.fee, value: claim.out.value };
    done.push({ kind: 'claim-sent', id: trade.id, txid: tx.txid });
  }
  return done;
}

/**
 * Sends the refund of every accepted listing whose deadline has passed, by
 * the clock and by Ting's tip, with no claim and its lock record still there;
 * again if the node lost it or it failed, every RESEND_AFTER at most.
 */
export async function sendRefunds({ trades, ting, state, now, dryRun, log }) {
  const done = [];
  for (const trade of trades.values()) {
    const acc = trade.accepted;
    if (!acc || trade.claimed || trade.refunded) continue;
    if (now <= acc.deadline + REFUND_MARGIN || !(ting.tip?.time > acc.deadline)) continue;
    const kept = state.refunds[trade.id];
    if (kept && now - kept.at < RESEND_AFTER) continue;
    if (kept?.tx) {
      const s = await ting.txState(kept.tx).catch(() => null);
      if (s === 'pending' || s === 'done' || s === null) {
        kept.at = now;
        continue;
      }
    }
    const lock = await ting.lock(trade.id).catch(() => null);
    if (!lock) continue;
    if (dryRun) {
      log(`#${trade.id}: would send the refund on Ting`);
      state.refunds[trade.id] = { tx: null, at: now };
      continue;
    }
    try {
      const tx = await ting.sendOwn(H.refundInput(trade.id));
      state.refunds[trade.id] = { tx, at: now };
      log(`#${trade.id}: sent the refund on Ting: ${tx}`);
      done.push({ kind: 'refund-sent', id: trade.id, tx });
    } catch (e) {
      state.refunds[trade.id] = { tx: null, at: now, error: e.message };
      log(`#${trade.id}: the node did not take the refund: ${e.message}`);
    }
  }
  return done;
}
