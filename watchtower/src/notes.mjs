// What the watchtower tells people: the feed message of each listing, and the
// reminders due to those watching one, as a seller or as a buyer. Pure: from a
// trade, what Litecoin showed of its locks, and the time. Every reminder has a
// key, so that each goes out once to each watcher. They remind; the pages do
// the work.
import { hex } from '../../web/js/bytes.js';
import { formatAmount, rate } from '../../web/js/swap.js';
import { acceptBy, acceptedLocks, closed, FIRST_CLAIM_BEFORE, lockOf, outKey, pays, status } from './trades.mjs';

const HOUR = 3600;

/** A time in Discord's markup, shown in each reader's own time zone, and how long from now. */
export const when = (t) => `<t:${t}:f> (<t:${t}:R>)`;
const short = (bytes) => { const h = hex(bytes); return `${h.slice(0, 6)}…${h.slice(-4)}`; };

export function amounts(trade, coin) {
  const dlr = `${formatAmount(trade.listed.amount, coin.decimals)} ${coin.symbol}`;
  const ltc = `${formatAmount(BigInt(trade.listed.want), 8)} LTC`;
  return { dlr, ltc };
}

const STATUS = {
  open: 'Open',
  locked: 'A buyer locked LTC: waiting for the seller to accept',
  accepted: 'Accepted: waiting for the buyer to claim',
  swapped: 'Swapped',
  withdrawn: 'Withdrawn',
  refunded: 'Not claimed in time: the DLR went back to the seller',
};

/**
 * The feed message of a listing: an embed with what it offers, its rate,
 * window and status, and buttons to watch it while it is not over. `locked`
 * says whether Litecoin showed a lock paying it.
 */
export function feedMessage(trade, { coin, usd, pageUrl, locked }) {
  const { dlr, ltc } = amounts(trade, coin);
  const l = trade.listed;
  const perLtc = rate(BigInt(l.want), 8, l.amount, coin.decimals, 6);
  const lines = [
    `**Rate:** ${perLtc} ${coin.symbol} per LTC${usd ? ` · about $${(usd * Number(l.want) / 1e8).toFixed(2)} for the lot` : ''}`,
    `**Lock window:** ${l.window / HOUR} h once accepted`,
  ];
  if (l.taker && !l.taker.every((b) => b === 0)) lines.push(`**Only for:** \`${short(l.taker)}\``);
  if (trade.copyOf != null) lines.push(`**Careful:** this listing names the Litecoin key of #${trade.copyOf}. Anyone can list with a key: the page shows whose it is.`);
  const st = status(trade, { locked });
  lines.push(`**Status:** ${STATUS[st]}`);
  const url = `${pageUrl}#/l/${trade.id}`;
  const buttons = [{ type: 2, style: 5, label: 'Open', url }];
  if (!closed(trade)) {
    buttons.unshift(
      { type: 2, style: 1, label: 'Remind me: seller', custom_id: `watch:${trade.id}:seller` },
      { type: 2, style: 2, label: 'Remind me: buyer', custom_id: `watch:${trade.id}:buyer` },
    );
  }
  return {
    embeds: [{ title: `#${trade.id} · ${dlr} for ${ltc}`, url, description: lines.join('\n'), color: closed(trade) ? 0x8a8f98 : 0x2f7d6b }],
    components: [{ type: 1, components: buttons }],
  };
}

/**
 * The reminders due now for one watcher of a trade, as `{ key, text }`.
 * `view` is what was read: `outOf(lock)` (the lock's output this round, or
 * undefined), `claim` (the watchtower's record of the seller's claim it sent,
 * if any), `ltcTip` (`{ mtp }`), `program`, `net`, `coin`, `tconfs`, `now`.
 */
export function notesFor(trade, role, view) {
  const { now, coin } = view;
  const { dlr, ltc } = amounts(trade, coin);
  const id = `#${trade.id}`;
  const notes = [];
  const add = (key, text) => notes.push({ key, text });
  const l = trade.listed;
  const acc = trade.accepted;
  const paying = trade.takes
    .map((take) => ({ take, lock: lockOf(trade, take, view.program, view.net) }))
    .filter(({ lock }) => pays(lock, view.outOf(lock), l.want));

  if (role === 'seller') {
    if (!acc && !trade.withdrawn) {
      for (const { take, lock } of paying) {
        const by = acceptBy(trade, take);
        if (by <= now) continue;
        add(`locked:${lock.key}`, `A buyer locked ${ltc} for your listing ${id}. Open your page to check it and accept, by ${when(by)}.`);
        if (by - now <= 2 * HOUR) add(`accept-soon:${lock.key}`, `Listing ${id}: the time to accept the buyer's lock ends ${when(by)}. Open your page to accept it.`);
      }
    }
    if (trade.claimed && acc) {
      const sent = view.claim;
      const outs = acceptedLocks(trade, view.program, view.net).map(({ lock }) => view.outOf(lock)).filter(Boolean);
      const spent = outs.find((o) => o.spent);
      if (sent) add('claimed', `The buyer claimed the ${dlr} on listing ${id}, which made the secret public. Your signed claim of the ${ltc} was sent to your address: \`${sent.txid}\`.`);
      else if (!spent) add('claimed', `The buyer claimed the ${dlr} on listing ${id}. The watchtower found no signed claim of yours on Ting: open your page before ${when(acc.t1)} to claim your ${ltc}.`);
      if (spent?.spenderConfirmed) {
        add('ltc-done', sent && spent.spender === sent.txid
          ? `Done: your claim of the ${ltc} on listing ${id} is in a Litecoin block.`
          : `Listing ${id}: the Litecoin lock was spent in a block, by \`${spent.spender}\`. Your page shows whether that was your claim.`);
      } else if (!spent && acc.t1 - now <= 6 * HOUR && acc.t1 > now) {
        add('ltc-late', `Listing ${id}: your ${ltc} is still not claimed, and the buyer can refund it after ${when(acc.t1)}. Open your page now.`);
      }
    }
    if (trade.refunded) add('refunded', `The buyer did not claim in time on listing ${id}: the ${dlr} went back to your account.`);
  }

  if (role === 'buyer') {
    if (acc && !trade.claimed && !trade.refunded) {
      const cutoff = acc.deadline - FIRST_CLAIM_BEFORE;
      add('accepted', `The seller accepted a lock on listing ${id}, for the account \`${short(acc.taker)}\`. If it is yours, your page claims the ${dlr} by itself once the accept is ${view.tconfs} Ting blocks deep: open it before ${when(cutoff)}.`);
      if (cutoff - now <= 4 * HOUR && cutoff > now) add('claim-soon', `Listing ${id}: the ${dlr} are not claimed yet. Open your page before ${when(cutoff)}: after that it no longer claims, and your LTC comes back after your lock ends.`);
    }
    if (trade.claimed) add('claimed', `Claimed on listing ${id}: ${formatAmount(trade.claimed.paid, coin.decimals)} ${coin.symbol} went to \`${short(trade.claimed.taker)}\`.`);
    if (trade.refunded && acc) add('refunded', `Listing ${id} was not claimed before its deadline, so the ${dlr} went back to the seller. Your LTC comes back after ${when(acc.t1)}: open your page then to refund it.`);
    if (trade.withdrawn) add('withdrawn', `The seller withdrew listing ${id}. If you locked LTC for it, open your page: it takes your LTC back, at once if the seller's page released it, else after your lock ends.`);
    if (acc || trade.withdrawn) {
      const mtp = view.ltcTip?.mtp ?? 0;
      for (const { take, lock } of paying) {
        if (acc && take.taker && hex(take.hash) === hex(acc.hash)) continue;
        if (mtp > take.t1) add(`refundable:${lock.key}`, `A lock of ${ltc} for listing ${id} was not accepted and has ended: if it is yours, open your page to refund it.`);
      }
    }
  }
  return notes;
}

export { outKey };
