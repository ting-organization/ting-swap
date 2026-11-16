// A listing's events as the program emits them, made with the page's own
// encodings and real keys: the seller's, the buyer's, and the secret's hash.
import { utf8 } from '../../web/js/bytes.js';
import * as L from '../../web/js/ltc.js';
import * as S from '../../web/js/secp256k1.js';
import { sha256 } from '../../web/js/sha256.js';

export const NET = 'regtest';
export const program = sha256(utf8('the HTLC program'));
export const coin = sha256(utf8('the DLR coin'));
export const COIN = { symbol: 'DLR', decimals: 8 };
export const sellerKey = sha256(utf8('the seller'));
export const buyerKey = sha256(utf8('the buyer'));
export const secret = sha256(utf8('the secret'));
export const hash = sha256(secret);
export const taker = sha256(utf8('the buyer\'s Ting account'));
export const maker = sha256(utf8('the seller\'s Ting account'));
export const payout = 'rltc1q3kquwp848h4juq7rl5q3wqsr29pd3d6wprzz8k';
export const LOCK_TXID = 'c1'.repeat(32);
export const VALUE = 50_000_000;
export const T1 = 2_000_000_000;
export const WINDOW = 43_200;
export const DEADLINE = T1 - 100_000;

let height = 10;
const at = (e) => ({ ...e, height: height++, time: 1_900_000_000 + height, tx: 'ee'.repeat(32) });

export const listed = (id, fields = {}) => at({
  kind: 'listed', id, maker, coin, amount: 10n * 100_000_000n, want: BigInt(VALUE), taker: new Uint8Array(32), window: WINDOW,
  fee: 1000n, chain: 'LTC', key: S.publicKey(sellerKey), ...fields,
});
export const taken = (id, { txid = LOCK_TXID, vout = 1, t1 = T1, who = taker } = {}) => at({
  kind: 'taken', id, taker: who, hash, t1, lock: L.encodeTakeLock({ txid, vout, buyer: S.publicKey(buyerKey) }),
});
export const accepted = (id, { deadline = DEADLINE } = {}) => at({ kind: 'accepted', id, maker, taker, hash, t1: T1, deadline, coin, amount: 10n * 100_000_000n });
export const claimed = (id) => at({ kind: 'claimed', id, taker, secret, paid: 10n * 100_000_000n - 1000n, fee: 1000n });
export const refunded = (id) => at({ kind: 'refunded', id, maker, paid: 10n * 100_000_000n - 1000n, fee: 1000n });
export const withdrawn = (id) => at({ kind: 'withdrawn', id, maker, coin, amount: 10n * 100_000_000n });
export const released = (id, data) => at({ kind: 'released', id, data });

/** The lock's script as the page rebuilds it, for listing `id`. */
export const htlcOf = (id) => ({ tag: L.lockTag(program, id, taker), hash, seller: S.publicKey(sellerKey), buyer: S.publicKey(buyerKey), t1: T1 });

/** The seller's signed claim of the lock of listing `id`, as release data; by another key if given. */
export function signedClaimData(id, { key = sellerKey, txid = LOCK_TXID, vout = 1, feeRate = 10 } = {}) {
  const htlc = { ...htlcOf(id), seller: S.publicKey(key) };
  return L.encodeSignedClaim(L.signClaim({ txid, vout, value: VALUE, htlc, key, to: payout, feeRate, network: NET }));
}

/** The lock's output as the explorer shows it, paying the rebuilt script. */
export const lockOut = (id, fields = {}) => ({ value: VALUE, script: Buffer.from(L.lockOutput(htlcOf(id), NET).scriptPubKey).toString('hex'), confirmed: true, spent: false, ...fields });
