import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { feedMessage, notesFor } from '../src/notes.mjs';
import { acceptBy, claimOf, FIRST_CLAIM_BEFORE, tradesOf } from '../src/trades.mjs';
import * as F from './fixture.mjs';

const view = (fields = {}) => {
  const v = { now: 1_900_000_100, coin: F.COIN, program: F.program, net: F.NET, tconfs: 30, ltcTip: { mtp: 0 }, outOf: () => F.lockOut(1), claim: null, ...fields };
  return { claimOf: (t) => claimOf(t, F.program, F.NET, v.outOf), ...v };
};
const keys = (notes) => notes.map((n) => n.key);
const trade = (...evs) => tradesOf([F.listed(1), ...evs], F.coin).get(1);

test('the seller: a lock that pays, then the time to accept running out', () => {
  const t = trade(F.taken(1));
  const lockKey = `${F.LOCK_TXID}:1`;
  assert.deepEqual(keys(notesFor(t, 'seller', view({ outOf: () => undefined }))), [], 'a take whose output is not read yet: nothing');
  assert.deepEqual(keys(notesFor(t, 'seller', view({ outOf: () => F.lockOut(1, { value: F.VALUE - 1 }) }))), [], 'a lock paying less than wanted: nothing');
  assert.deepEqual(keys(notesFor(t, 'seller', view({ outOf: () => F.lockOut(1, { script: '0014' + '00'.repeat(20) }) }))), [], 'an output paying another script: nothing');
  const notes = notesFor(t, 'seller', view());
  assert.deepEqual(keys(notes), [`locked:${lockKey}`]);
  assert.match(notes[0].text, /locked 0\.5 LTC for your listing #1.*accept, by <t:\d+:f>/);
  const by = acceptBy(t, t.takes[0]);
  assert.deepEqual(keys(notesFor(t, 'seller', view({ now: by - 3600 }))), [`locked:${lockKey}`, `accept-soon:${lockKey}`]);
  assert.deepEqual(keys(notesFor(t, 'seller', view({ now: by + 1 }))), [], 'too late to accept: nothing');
  assert.deepEqual(keys(notesFor(trade(F.taken(1), F.accepted(1)), 'seller', view())), [], 'accepted: no more lock notes');
});

test('the seller after the buyer\'s claim: sent, or open the page, then done', () => {
  const t = trade(F.taken(1), F.accepted(1), F.claimed(1));
  const missing = notesFor(t, 'seller', view());
  assert.deepEqual(keys(missing), ['claim-missing']);
  assert.match(missing[0].text, /no signed claim of yours on Ting for the accepted lock: open your page before/);
  assert.deepEqual(keys(notesFor(t, 'seller', view({ outOf: () => undefined }))), [], 'the explorer could not be read: nothing said yet');
  assert.deepEqual(keys(notesFor(t, 'seller', view({ claim: { txid: 'ab'.repeat(32), error: 'refused' } }))), ['claim-missing'], 'a send that failed is no send');
  const signed = trade(F.taken(1), F.released(1, F.signedClaimData(1)), F.accepted(1), F.claimed(1));
  assert.deepEqual(keys(notesFor(signed, 'seller', view({ claim: { txid: 'ab'.repeat(32), error: 'refused' } }))), [], 'a signed claim on Ting but not sent yet: nothing said yet');
  const sent = notesFor(signed, 'seller', view({ claim: { txid: 'ab'.repeat(32) } }));
  assert.deepEqual(keys(sent), ['claim-sent']);
  assert.match(sent[0].text, /Your signed claim of the 0\.5 LTC was sent to your address/);
  const late = notesFor(t, 'seller', view({ now: F.T1 - 3600 }));
  assert.deepEqual(keys(late), ['claim-missing', 'ltc-late']);
  const done = notesFor(signed, 'seller', view({ claim: { txid: 'ab'.repeat(32) }, outOf: () => F.lockOut(1, { spent: true, spender: 'ab'.repeat(32), spenderConfirmed: true }) }));
  assert.deepEqual(keys(done), ['claim-sent', 'ltc-done']);
  assert.match(done[1].text, /Done: your signed claim of the 0\.5 LTC on listing #1 is in a Litecoin block/);
  const other = notesFor(t, 'seller', view({ outOf: () => F.lockOut(1, { spent: true, spender: 'cd'.repeat(32), spenderConfirmed: true }) }));
  assert.deepEqual(keys(other), ['ltc-done']);
  assert.match(other[0].text, /spent in a block, by `cdcd/);
  const many = trade(F.taken(1), F.taken(1, { txid: 'd3'.repeat(32), vout: 0 }), F.accepted(1), F.claimed(1));
  assert.deepEqual(keys(notesFor(many, 'seller', view())), ['claim-many'], 'two outputs match: open your page');
  assert.deepEqual(keys(notesFor(trade(F.taken(1), F.accepted(1), F.refunded(1)), 'seller', view())), ['refunded']);
});

test('the buyer: accepted, the claim cut-off, then claimed or refunded', () => {
  const t = trade(F.taken(1), F.accepted(1));
  const notes = notesFor(t, 'buyer', view());
  assert.deepEqual(keys(notes), ['accepted']);
  assert.match(notes[0].text, /once the accept is 30 Ting blocks deep: open it before <t:\d+:f>/);
  const cutoff = F.DEADLINE - FIRST_CLAIM_BEFORE;
  assert.deepEqual(keys(notesFor(t, 'buyer', view({ now: cutoff - 3600 }))), ['accepted', 'claim-soon']);
  assert.deepEqual(keys(notesFor(trade(F.taken(1), F.accepted(1), F.claimed(1)), 'buyer', view())), ['claimed']);
  assert.deepEqual(keys(notesFor(trade(F.taken(1), F.accepted(1), F.refunded(1)), 'buyer', view())), ['refunded']);
});

test('the buyer of a lock not accepted: withdrawn, and refundable after T1', () => {
  const other = F.taken(1, { txid: 'd2'.repeat(32), t1: F.T1 + 50 });
  other.hash = new Uint8Array(32).fill(5);
  const t = trade(F.taken(1), other, F.accepted(1));
  const out = (lock) => (lock.txid === 'd2'.repeat(32) ? { ...F.lockOut(1), script: Buffer.from(lock.scriptPubKey).toString('hex') } : F.lockOut(1));
  assert.ok(!keys(notesFor(t, 'buyer', view({ outOf: out }))).some((k) => k.startsWith('refundable')), 'before T1: nothing');
  const after = keys(notesFor(t, 'buyer', view({ outOf: out, ltcTip: { mtp: F.T1 + 51 } })));
  assert.ok(after.includes(`refundable:${'d2'.repeat(32)}:1`), 'the other lock, after its T1');
  assert.ok(!after.includes(`refundable:${F.LOCK_TXID}:1`), 'never the accepted one');
  assert.deepEqual(keys(notesFor(trade(F.taken(1), F.withdrawn(1)), 'buyer', view())), ['withdrawn']);
});

test('the feed message: one line of what it offers, a copy warned of, no buttons once over', () => {
  const open = feedMessage(trade(), { coin: F.COIN, usd: 44, pageUrl: 'https://example.test/swap/', locked: false });
  assert.equal(open.embeds[0].title, '#1 · Buy 10 DLR for 0.5 LTC');
  assert.equal(open.embeds[0].url, 'https://example.test/swap/#/l/1');
  assert.equal(open.embeds[0].description, '20 DLR/LTC · ≈ $2.20/DLR · $22.00 total · 12 h to claim · 🟢 Open');
  assert.equal(open.embeds[0].color, 0x639922);
  assert.deepEqual(open.components[0].components.map((b) => b.custom_id ?? b.url), ['watch:1:buyer', 'watch:1:seller', 'https://example.test/swap/#/l/1']);
  assert.deepEqual(open.components[0].components.map((b) => b.style), [1, 2, 5], 'the buyer\'s button stands out');
  const locked = feedMessage(trade(F.taken(1)), { coin: F.COIN, usd: null, pageUrl: 'x/', locked: true });
  assert.equal(locked.embeds[0].description, '20 DLR/LTC · 12 h to claim · 🟠 Buyer locked LTC', 'no price: no dollars');
  assert.equal(locked.embeds[0].color, 0xba7517);
  assert.match(feedMessage(trade(F.taken(1), F.accepted(1)), { coin: F.COIN, usd: null, pageUrl: 'x/', locked: true }).embeds[0].description, /🔵 Accepted$/);
  const swapped = feedMessage(trade(F.taken(1), F.accepted(1), F.claimed(1)), { coin: F.COIN, usd: null, pageUrl: 'x/', locked: true });
  assert.deepEqual(swapped.components[0].components.map((b) => b.label), ['Trade on Ting Swap']);
  assert.match(swapped.embeds[0].description, /⚪ Swapped$/);
  assert.equal(swapped.embeds[0].color, 0x888780);
  const copy = tradesOf([F.listed(1), F.listed(2)], F.coin).get(2);
  assert.match(feedMessage(copy, { coin: F.COIN, usd: null, pageUrl: 'x/', locked: false }).embeds[0].description, /\n\*\*Careful:\*\* this listing names the Litecoin key of #1/);
});

test('the feed message\'s numbers: the rate to four digits, dollars per DLR to three however small', () => {
  const big = tradesOf([F.listed(1, { amount: 209_000n * 100_000_000n, want: 600_000_000n })], F.coin).get(1);
  assert.equal(feedMessage(big, { coin: F.COIN, usd: 44, pageUrl: 'x/', locked: false }).embeds[0].description, '34,833 DLR/LTC · ≈ $0.00126/DLR · $264.00 total · 12 h to claim · 🟢 Open');
  const even = tradesOf([F.listed(1, { amount: 10_000n * 100_000_000n, want: 200_000_000n })], F.coin).get(1);
  assert.match(feedMessage(even, { coin: F.COIN, usd: 44, pageUrl: 'x/', locked: false }).embeds[0].description, /^5,000 DLR\/LTC · ≈ \$0\.00880\/DLR · \$88\.00 total/);
});
