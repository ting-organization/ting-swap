import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { AFTER_T1, due, FAILED_AGAIN, MISSING_AGAIN, READS, readsDue, SLOW_AGAIN } from '../src/reads.mjs';
import { claimOf, lockOf, tradesOf } from '../src/trades.mjs';
import * as F from './fixture.mjs';

const NOW = 1_900_000_000;
const lock1 = () => lockOf(tradesOf([F.listed(1), F.taken(1)], F.coin).get(1), tradesOf([F.listed(1), F.taken(1)], F.coin).get(1).takes[0], F.program, F.NET);

test('when an output is read again', () => {
  const lock = lock1();
  const at = (out, ago) => ({ out, at: NOW - ago });
  assert.deepEqual(due(lock, undefined, { now: NOW }), { rank: 1, at: 0 }, 'never read: at once');
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
