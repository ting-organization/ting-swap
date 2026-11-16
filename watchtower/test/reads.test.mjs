import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AFTER_T1, due, FAILED_AGAIN, MISSING_AGAIN, outsInUse, READS, readsDue, SLOW_AGAIN } from '../src/reads.mjs';
import { claimOf, lockOf, tradesOf } from '../src/trades.mjs';
import * as F from './fixture.mjs';

const NOW = 1_900_000_000;
const lock1 = () => lockOf(tradesOf([F.listed(1), F.taken(1)], F.coin).get(1), tradesOf([F.listed(1), F.taken(1)], F.coin).get(1).takes[0], F.program, F.NET);

test('when an output is read again', () => {
  const lock = lock1();
  const at = (out, ago) => ({ out, at: NOW - ago });
  assert.deepEqual(due(lock, undefined, { now: NOW }), { rank: 2, at: 0 }, 'never read: at once');
  assert.deepEqual(due(lock, undefined, { now: NOW, accepted: true }), { rank: 1, at: 0 }, 'an accepted listing\'s before an open listing\'s');
  assert.deepEqual(due(lock, undefined, { now: NOW, accepted: true, urgent: true }), { rank: 0, at: 0 }, 'a claimed listing\'s first');
  assert.equal(due(lock, undefined, { now: NOW, failedAt: NOW - FAILED_AGAIN + 1 }), null, 'its read just failed: not yet');
  assert.ok(due(lock, undefined, { now: NOW, failedAt: NOW - FAILED_AGAIN }), 'after FAILED_AGAIN');
  assert.equal(due(lock, at({ missing: true }, MISSING_AGAIN - 1), { now: NOW }), null, 'missing: not before MISSING_AGAIN');
  assert.ok(due(lock, at({ missing: true }, MISSING_AGAIN), { now: NOW }));
  assert.equal(due(lock, at({ ...F.lockOut(1), script: '0014' + '00'.repeat(20) }, 99_999), { now: NOW, urgent: true }), null, 'another script: never again');
  assert.equal(due(lock, at(F.lockOut(1, { spent: true, spenderConfirmed: true }), 99_999), { now: NOW, urgent: true }), null, 'spent in a block: never again');
  assert.ok(due(lock, at(F.lockOut(1, { spent: true }), 1), { now: NOW, urgent: true }), 'spent, not in a block yet: urgent still');
  assert.equal(due(lock, at(F.lockOut(1), SLOW_AGAIN - 1), { now: NOW }), null, 'paying, not urgent: slowly');
  assert.ok(due(lock, at(F.lockOut(1), SLOW_AGAIN), { now: NOW }));
  assert.equal(due(lock, at(F.lockOut(1), 1), { now: NOW, urgent: true }).rank, 0, 'urgent: every round, first');
});

test('free takes cannot make it read more, nor crowd out a claim that needs reading', () => {
  // Listing 1: claimed, with a verifying signed claim. Listing 2: open, with 40 takes naming outputs never read.
  const spam = Array.from({ length: 40 }, (_, i) => F.taken(2, { txid: (i + 16).toString(16).padStart(2, '0').repeat(32), vout: i }));
  const trades = tradesOf([F.listed(1), F.taken(1), F.released(1, F.signedClaimData(1)), F.accepted(1), F.claimed(1), F.listed(2), ...spam], F.coin);
  const outs = new Map([[`${F.LOCK_TXID}:1`, { out: F.lockOut(1), at: NOW - 1 }]]);
  const outOf = (lock) => outs.get(lock.key)?.out;
  const reads = readsDue({ trades, program: F.program, net: F.NET, outs, failed: new Map(), now: NOW, claimOf: (t) => claimOf(t, F.program, F.NET, outOf) });
  assert.equal(reads.length, READS, 'no more than READS a round');
  assert.equal(reads[0].key, `${F.LOCK_TXID}:1`, 'the claimed lock first, read again though read a second ago');
  for (const l of reads.slice(1)) outs.set(l.key, { out: { missing: true }, at: NOW });
  const next = readsDue({ trades, program: F.program, net: F.NET, outs, failed: new Map(), now: NOW + 15, claimOf: (t) => claimOf(t, F.program, F.NET, outOf) });
  assert.equal(next[0].key, `${F.LOCK_TXID}:1`);
  assert.ok(next.slice(1).every((l) => !outs.has(l.key)), 'then the takes not read yet, in turns');
});

test('a claim\'s candidates go before free takes, however old their listing', () => {
  // Listing 1, the oldest, open with 40 takes never read. Listing 2 claimed, its take and two copies naming other outputs, none read.
  const spam = Array.from({ length: 40 }, (_, i) => F.taken(1, { txid: (i + 16).toString(16).padStart(2, '0').repeat(32), vout: i }));
  const candidates = [F.taken(2, { txid: 'e1'.repeat(32) }), F.taken(2, { txid: 'e2'.repeat(32) }), F.taken(2, { txid: 'e3'.repeat(32) })];
  const claimed = tradesOf([F.listed(1), ...spam, F.listed(2), ...candidates, F.accepted(2), F.claimed(2)], F.coin);
  const reads = readsDue({ trades: claimed, program: F.program, net: F.NET, outs: new Map(), failed: new Map(), now: NOW, claimOf: () => ({ state: 'unread' }) });
  assert.deepEqual(reads.slice(0, 3).map((l) => l.txid), ['e1'.repeat(32), 'e2'.repeat(32), 'e3'.repeat(32)], 'all three candidates first');
  const accepted = tradesOf([F.listed(1), ...spam, F.listed(2), candidates[0], F.accepted(2)], F.coin);
  const first = readsDue({ trades: accepted, program: F.program, net: F.NET, outs: new Map(), failed: new Map(), now: NOW, claimOf: () => null });
  assert.equal(first[0].txid, 'e1'.repeat(32), 'an accepted listing\'s lock, not claimed yet, before open listings\' takes too');
});

test('only reads still of use are kept', () => {
  const tx = (n) => n.toString(16).padStart(2, '0').repeat(32);
  const trades = tradesOf([
    F.listed(1), F.taken(1, { txid: tx(1) }),
    F.listed(2), F.taken(2, { txid: tx(2) }), F.accepted(2),
    F.listed(3), F.taken(3, { txid: tx(3) }), F.accepted(3), F.refunded(3),
    F.listed(4), F.taken(4, { txid: tx(4) }), F.withdrawn(4),
  ], F.coin);
  const keys = (now) => [...outsInUse({ trades, program: F.program, net: F.NET, now })].map((k) => k.slice(0, 2)).sort();
  assert.deepEqual(keys(NOW), ['01', '02', '04'], 'open, accepted, and withdrawn while its take\'s T1 is near: kept; refunded: dropped');
  assert.deepEqual(keys(F.T1 + AFTER_T1 + 1), ['01'], 'long past T1: only the open listing\'s');
});

test('an accepted lock is followed until T1, and a little past it', () => {
  const trades = tradesOf([F.listed(1), F.taken(1), F.accepted(1)], F.coin);
  const read = (outs, now) => readsDue({ trades, program: F.program, net: F.NET, outs, failed: new Map(), now, claimOf: () => null }).map((l) => l.key);
  assert.deepEqual(read(new Map(), NOW), [`${F.LOCK_TXID}:1`], 'accepted, not claimed: read');
  assert.deepEqual(read(new Map([[`${F.LOCK_TXID}:1`, { out: { missing: true }, at: 0 }]]), F.T1 + 1), [], 'never seen, and T1 has passed: dropped');
  assert.deepEqual(read(new Map([[`${F.LOCK_TXID}:1`, { out: F.lockOut(1), at: 0 }]]), F.T1 + 1), [`${F.LOCK_TXID}:1`], 'seen: followed past T1');
  assert.deepEqual(read(new Map([[`${F.LOCK_TXID}:1`, { out: F.lockOut(1), at: 0 }]]), F.T1 + AFTER_T1 + 1), [], 'but not for ever');
  const refunded = tradesOf([F.listed(1), F.taken(1), F.accepted(1), F.refunded(1)], F.coin);
  assert.deepEqual(readsDue({ trades: refunded, program: F.program, net: F.NET, outs: new Map(), failed: new Map(), now: NOW, claimOf: () => null }), [], 'refunded: nothing to read');
});
