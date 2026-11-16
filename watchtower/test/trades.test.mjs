import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as S from '../../web/js/secp256k1.js';
import { sha256 } from '../../web/js/sha256.js';
import { utf8 } from '../../web/js/bytes.js';
import { acceptBy, signedClaimFor, status, tradesOf } from '../src/trades.mjs';
import * as F from './fixture.mjs';

test('listings of the page\'s kind only, copies marked', () => {
  const trades = tradesOf([
    F.listed(1), F.listed(2, { chain: 'BTC' }), F.listed(3, { coin: sha256(utf8('another coin')) }), F.listed(4),
    F.listed(5, { key: S.publicKey(sha256(utf8('another seller'))) }),
  ], F.coin);
  assert.deepEqual([...trades.keys()], [1, 4, 5]);
  assert.equal(trades.get(1).copyOf, null);
  assert.equal(trades.get(4).copyOf, 1, 'the same Litecoin key as #1');
  assert.equal(trades.get(5).copyOf, null);
});

test('a trade\'s steps and status', () => {
  const evs = [F.listed(1), F.taken(1), F.accepted(1), F.claimed(1)];
  for (let n = 1; n <= evs.length; n++) {
    const t = tradesOf(evs.slice(0, n), F.coin).get(1);
    assert.equal(status(t, { locked: n === 2 }), ['open', 'locked', 'accepted', 'swapped'][n - 1]);
  }
  assert.equal(status(tradesOf([F.listed(1), F.withdrawn(1)], F.coin).get(1)), 'withdrawn');
  assert.equal(status(tradesOf([F.listed(1), F.taken(1), F.accepted(1), F.refunded(1)], F.coin).get(1)), 'refunded');
  const t = tradesOf([F.listed(1), F.taken(1)], F.coin).get(1);
  assert.equal(acceptBy(t, t.takes[0]), F.T1 - F.WINDOW - 21_600);
});

test('the signed claim: only the listing key\'s, only for the accepted lock', () => {
  const outOf = (lock) => (lock.key === `${F.LOCK_TXID}:1` ? F.lockOut(1) : undefined);
  const forged = F.signedClaimData(1, { key: sha256(utf8('a forger')) });
  const elsewhere = F.signedClaimData(1, { vout: 2 });
  const real = F.signedClaimData(1);
  const t = tradesOf([F.listed(1), F.taken(1), F.released(1, forged), F.released(1, elsewhere), F.released(1, real), F.accepted(1)], F.coin).get(1);
  assert.equal(t.signedClaims.length, 3);
  const found = signedClaimFor(t, F.program, F.NET, outOf);
  assert.ok(found, 'the real one is found past a forged one and one for another output');
  assert.equal(Buffer.from(found.claim.signature).toString('hex'), Buffer.from(real.subarray(real.length - found.claim.signature.length)).toString('hex'));
  const noAccept = tradesOf([F.listed(1), F.taken(1), F.released(1, real)], F.coin).get(1);
  assert.equal(signedClaimFor(noAccept, F.program, F.NET, outOf), null, 'no accept, no claim');
  assert.equal(signedClaimFor(t, F.program, F.NET, () => F.lockOut(1, { value: F.VALUE + 1 })), null, 'not for another value');
  assert.equal(signedClaimFor(t, F.program, F.NET, () => undefined), null, 'not before the output is read');
});
