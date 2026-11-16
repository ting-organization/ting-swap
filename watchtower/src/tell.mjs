// What the watchtower tells Discord: the feed messages, and the reminders to
// those who watch a listing. Only what Discord really took counts as done:
// a dry run, or a run with no token, prints each change once and keeps
// nothing, so that the run after it posts and sends everything.
import { gone } from './discord.mjs';
import { feedMessage, notesFor } from './notes.mjs';
import * as S from './state.mjs';
import { closed } from './trades.mjs';

/**
 * Posts a feed message for every listing not over when first seen and
 * wanting at least `feedMin` litoshi, and edits each as it moves on; one a
 * moderator deleted is posted anew. The USD estimate is LTC's price when it
 * was posted, so that a price change alone edits nothing. `printed` remembers,
 * for this run only, what was printed when not live.
 */
export async function updateFeed({ trades, state, discord, printed, coin, usd, pageUrl, feedMin, channel, lockedNow, log }) {
  if (discord.live && !channel) return;
  for (const trade of trades.values()) {
    const kept = state.feed[trade.id];
    if (!kept && (closed(trade) || BigInt(trade.listed.want) < feedMin)) continue;
    const price = kept ? kept.usd ?? null : usd;
    const message = feedMessage(trade, { coin, usd: price, pageUrl, locked: lockedNow(trade) });
    const text = JSON.stringify(message);
    if (!discord.live) {
      if (printed.get(trade.id) !== text) await discord.post(message);
      printed.set(trade.id, text);
      continue;
    }
    if (kept?.text === text) continue;
    try {
      if (kept) {
        try {
          await discord.edit(kept.message, message);
          state.feed[trade.id] = { ...kept, text };
          continue;
        } catch (e) {
          if (!gone(e)) throw e;
          log(`#${trade.id}: its feed message is gone: posting it anew`);
        }
      }
      state.feed[trade.id] = { message: await discord.post(message), text, usd: price };
    } catch (e) {
      log(`#${trade.id}: the feed message did not go out: ${e.message}`);
    }
  }
}

/**
 * Sends each watcher the reminders due to them that they did not get yet:
 * one Discord really sent is kept as sent, one only printed is remembered for
 * this run in `printed`, and one to a user who takes no direct messages is
 * kept as refused.
 */
export async function sendNotes({ trades, state, discord, printed, viewOf, now, log }) {
  for (const idText of Object.keys(state.watch)) {
    const id = Number(idText);
    const trade = trades.get(id);
    if (!trade) continue;
    for (const [user, role] of S.watchersOf(state, id)) {
      for (const note of notesFor(trade, role, viewOf(trade))) {
        const key = S.sentKey(user, id, note.key);
        if (state.sent[key] || printed.has(key)) continue;
        try {
          if (await discord.dm(user, note.text)) state.sent[key] = now;
          else printed.add(key);
        } catch (e) {
          log(`#${id}: no direct message to ${user}: ${e.message}`);
          if (e.code === 50007) state.sent[key] = -now;
        }
      }
    }
  }
}

/**
 * The first direct message to a new watcher: where the listing stands, and
 * the reminders due now, which then count as sent. Whether the watcher can be
 * kept: one Discord could not message cannot; when not live, only a dry run
 * plays along.
 */
export async function welcome({ trade, user, role, state, discord, viewOf, pageUrl, now, dryRun, log }) {
  const id = trade.id;
  const due = notesFor(trade, role, viewOf(trade)).filter((n) => !state.sent[S.sentKey(user, id, n.key)]);
  const text = [`You are watching listing #${id} as its ${role}. ${pageUrl}#/l/${id}`, ...due.map((n) => n.text)].join('\n\n');
  let sent;
  try {
    sent = await discord.dm(user, text);
  } catch (e) {
    log(`#${id}: no welcome message to ${user}: ${e.message}`);
    return false;
  }
  if (!sent) return dryRun;
  for (const n of due) state.sent[S.sentKey(user, id, n.key)] = now;
  return true;
}
