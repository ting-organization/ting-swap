import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as H from '../../web/js/htlc.js';
import * as L from '../../web/js/ltc.js';
import { REFUND_MARGIN, RESEND_AFTER, sendClaims, sendRefunds } from '../src/act.mjs';
import { empty } from '../src/state.mjs';
import { tradesOf } from '../src/trades.mjs';
import * as F from './fixture.mjs';

const quiet = () => {};

function explorer() {
  const sent = [];
  const known = new Set();
  return {
    sent, known,
    broadcast: async (txHex) => { sent.push(txHex); known.add(L.txid(L.parseTx(txHex))); return null; },
    txStatus: async (txid) => ({ found: known.has(txid), confirmed: false }),
  };
}

test('the seller\'s signed claim goes out once the buyer\'s claim is on Ting, and only then', async () => {
  let out = F.lockOut(1);
  const outOf = () => out;
  const litecoin = explorer();
  const state = empty();
  const base = [F.listed(1), F.taken(1), F.released(1, F.signedClaimData(1)), F.accepted(1)];
  const run = (evs, now, dryRun = false) => sendClaims({ trades: tradesOf(evs, F.coin), program: F.program, net: F.NET, outOf, litecoin, state, now, dryRun, log: quiet });

  await run(base, 1000);
  assert.equal(litecoin.sent.length, 0, 'no claim on Ting: nothing');

  const evs = [...base, F.claimed(1)];
  await run(evs, 1000, true);
  assert.equal(litecoin.sent.length, 0, 'a dry run sends nothing');

  const done = await run(evs, 2000);
  const expected = L.claimTx({ txid: F.LOCK_TXID, vout: 1, value: F.VALUE, htlc: F.htlcOf(1), secret: F.secret, key: F.sellerKey, to: F.payout, feeRate: 10, network: F.NET });
  assert.deepEqual(litecoin.sent, [expected.hex], 'the very claim the seller\'s key makes, to the seller\'s address');
  assert.equal(done[0].txid, expected.txid);
  assert.equal(state.claims[`${F.LOCK_TXID}:1`].txid, expected.txid);

  await run(evs, 2000 + RESEND_AFTER + 1);
  assert.equal(litecoin.sent.length, 1, 'the explorer knows it: not sent again');
  litecoin.known.clear();
  await run(evs, 2000 + RESEND_AFTER - 1);
  assert.equal(litecoin.sent.length, 1, 'lost, but too soon to send again');
  await run(evs, 2000 + 2 * RESEND_AFTER + 2);
  assert.equal(litecoin.sent.length, 2, 'lost by the explorer: sent again');

  litecoin.known.clear();
  out = F.lockOut(1, { spent: true, spender: expected.txid, spenderConfirmed: true });
  await run(evs, 9999);
  assert.equal(litecoin.sent.length, 2, 'spent: done with');
  assert.equal(state.claims[`${F.LOCK_TXID}:1`].spent.by, expected.txid);
});

test('no claim from a forged signature', async () => {
  const litecoin = explorer();
  const state = empty();
  const forged = F.signedClaimData(1, { key: F.buyerKey });
  const trades = tradesOf([F.listed(1), F.taken(1), F.released(1, forged), F.accepted(1), F.claimed(1)], F.coin);
  await sendClaims({ trades, program: F.program, net: F.NET, outOf: () => F.lockOut(1), litecoin, state, now: 1, dryRun: false, log: quiet });
  assert.equal(litecoin.sent.length, 0);
});

test('no claim when two outputs at the lock address match the accept, and the right one when one does', async () => {
  const litecoin = explorer();
  const state = empty();
  const other = 'd3'.repeat(32);
  // The seller's page signed a claim at each Accept click; the other output's came first.
  const evs = [F.listed(1), F.taken(1, { txid: other, vout: 0 }), F.taken(1), F.released(1, F.signedClaimData(1, { txid: other, vout: 0 })), F.released(1, F.signedClaimData(1)), F.accepted(1), F.claimed(1)];
  const run = (outOf) => sendClaims({ trades: tradesOf(evs, F.coin), program: F.program, net: F.NET, outOf, litecoin, state, now: 1, dryRun: false, log: quiet });
  await run(() => F.lockOut(1));
  assert.equal(litecoin.sent.length, 0, 'both pay: the watchtower cannot tell which was accepted');
  await run((lock) => (lock.txid === other ? undefined : F.lockOut(1)));
  assert.equal(litecoin.sent.length, 0, 'one not read yet: nothing');
  await run((lock) => (lock.txid === other ? { missing: true } : F.lockOut(1)));
  assert.equal(litecoin.sent.length, 1);
  assert.equal(L.parseTx(litecoin.sent[0]).inputs[0].txid, F.LOCK_TXID, 'the claim of the one that pays');
});

test('the refund on Ting: past the deadline by the clock and by the tip, with the lock still there', async () => {
  const submitted = [];
  let lock = { id: 1 };
  let txState = 'missing';
  const ting = {
    tip: { time: F.DEADLINE - 10 },
    lock: async () => lock,
    sendOwn: async (input) => { submitted.push(input); return 'ab'.repeat(32); },
    txState: async () => txState,
  };
  const state = empty();
  const base = [F.listed(1), F.taken(1), F.accepted(1)];
  const run = (evs, now) => sendRefunds({ trades: tradesOf(evs, F.coin), ting, state, now, dryRun: false, log: quiet });

  await run(base, F.DEADLINE + REFUND_MARGIN + 1);
  assert.equal(submitted.length, 0, 'Ting\'s tip is not past the deadline yet');
  ting.tip.time = F.DEADLINE + 1;
  await run(base, F.DEADLINE + REFUND_MARGIN);
  assert.equal(submitted.length, 0, 'the clock is not past the deadline and the margin');
  await run([...base, F.claimed(1)], F.DEADLINE + REFUND_MARGIN + 1);
  assert.equal(submitted.length, 0, 'claimed: no refund');

  await run(base, F.DEADLINE + REFUND_MARGIN + 1);
  assert.equal(submitted.length, 1);
  assert.equal(Buffer.from(submitted[0]).toString('hex'), Buffer.from(H.refundInput(1)).toString('hex'), 'the program\'s own refund input');

  txState = 'pending';
  await run(base, F.DEADLINE + REFUND_MARGIN + RESEND_AFTER + 2);
  assert.equal(submitted.length, 1, 'pending: not sent again');
  txState = 'missing';
  await run(base, F.DEADLINE + REFUND_MARGIN + 3 * RESEND_AFTER + 3);
  assert.equal(submitted.length, 2, 'lost by the node: sent again');
  lock = null;
  await run(base, F.DEADLINE + REFUND_MARGIN + 5 * RESEND_AFTER + 5);
  assert.equal(submitted.length, 2, 'no lock record: nothing to refund');
  await run([...base, F.refunded(1)], F.DEADLINE + REFUND_MARGIN + 9 * RESEND_AFTER);
  assert.equal(submitted.length, 2, 'refunded: done with');
});
