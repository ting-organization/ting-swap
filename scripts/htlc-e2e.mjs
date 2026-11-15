#!/usr/bin/env node
// Litecoin swaps end to end, on development chains only: the HTLC program on
// the Ting development chain (scripts/htlc-dev.mjs setup) and Litecoin on the
// regtest chain of scripts/ltc-dev.mjs, which must be serving. Every Litecoin
// transaction is checked by Litecoin Core itself, standardness rules included.
//
//   node scripts/htlc-e2e.mjs            a trade, a declined take released early
//   node scripts/htlc-e2e.mjs --refund   also a Litecoin refund after T1, which
//                                        moves the regtest clock forward for good
//
// Alice sells test DLR for LTC with a P-256 test key; Bob has LTC in the
// regtest wallet `bob` and a Ting account he never signs with.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { equal, hex, Reader, unhex } from '../web/js/bytes.js';
import * as H from '../web/js/htlc.js';
import * as L from '../web/js/ltc.js';
import { publicKey } from '../web/js/secp256k1.js';
import { sha256 } from '../web/js/sha256.js';
import { transferEffect } from '../web/js/swap.js';
import { contractAccount } from '../web/js/ting.js';
import { Chain } from './chain.mjs';
import { Key } from './keys.mjs';

const NODE = 'http://127.0.0.1:28451';
const LTC = 'http://127.0.0.1:28472';
const NET = 'regtest';
const DLR = 100_000_000n;
const state = JSON.parse(readFileSync(new URL('../.htlc-dev.json', import.meta.url), 'utf8'));
const program = unhex(state.htlc);
const coin = unhex(state.coin);
const vault = contractAccount(program);
const refund = process.argv.includes('--refund');

const chain = await Chain.open(NODE);
const now = () => Math.floor(Date.now() / 1000);
const step = (text) => console.log(`\n— ${text}`);
const ok = (text) => console.log(`  ✓ ${text}`);
const fail = (text) => { throw new Error(text); };

// ---- Litecoin regtest -------------------------------------------------------

async function ltc(path, { method = 'GET', body, json = true } = {}) {
  const r = await fetch(`${LTC}${path}`, {
    method, body: body == null ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    headers: body != null && typeof body !== 'string' ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${method} ${path}: ${r.status} ${text}`), { status: r.status, text });
  return json ? JSON.parse(text) : text;
}
const mine = (n = 1) => ltc('/dev/mine', { method: 'POST', body: { n } });
const address = async (wallet) => {
  const r = await ltc(`/dev/address/${wallet}`);
  return typeof r === 'string' ? r : r.address;
};
const broadcast = (txHex) => ltc('/api/tx', { method: 'POST', body: txHex, json: false });
const tipHeight = async () => Number(await ltc('/api/blocks/tip/height', { json: false }));
const medianTime = async () => (await ltc(`/api/block/${await ltc('/api/blocks/tip/hash', { json: false })}`)).mediantime;
const walletBalance = async (wallet) => (await ltc(`/dev/wallet/${wallet}`)).balance;

/** Pays `litoshi` from the regtest wallet `from` to `addr`; the output's txid, vout and value. */
async function payTo(from, addr, litoshi) {
  const { txid } = await ltc('/dev/pay', { method: 'POST', body: { from, to: addr, amount: (Number(litoshi) / 1e8).toFixed(8) } });
  const tx = await ltc(`/api/tx/${txid}`);
  const vout = tx.vout.findIndex((o) => o.scriptpubkey_address === addr);
  if (vout < 0) fail(`no output to ${addr} in ${txid}`);
  return { txid, vout, value: tx.vout[vout].value };
}

// ---- Ting -------------------------------------------------------------------

const record = (key) => chain.node.record(program, key);
const listingOf = async (id) => H.decodeListing(id, await record(H.listingKey(id)));
const lockOf = async (id) => H.decodeLock(id, await record(H.lockKey(id)));
const balance = async (account) => (await chain.funds(coin, account)).balance;
const own = async (input) => {
  const r = await chain.submit(H.ownCall(program, input));
  if (r.status !== 0) fail(`the program refused: ${r.reason}`);
  return r;
};

/** The program's own events from `from` on, decoded, with their heights. */
async function events(from = 1) {
  const out = [];
  for (;;) {
    const page = await chain.node.events(program, H.TOPIC, from, 100);
    for (const block of page.items) {
      for (const e of block.events) {
        const r = new Reader(unhex(e.payload_hex));
        r.take(32);
        out.push({ ...H.decodeEvent(r), height: block.height });
      }
    }
    if (!page.items.length || page.next > page.height) return out;
    from = page.next;
  }
}

async function fund(account, amount) {
  execFileSync('node', ['kit/scripts/devchain.mjs', 'fund', hex(account), String(amount)], {
    cwd: new URL('../../ting-id-web/', import.meta.url), stdio: 'ignore',
  });
}

/** Alice lists `amount` DLR for `want` litoshi, with a fresh Litecoin key; the listing and the key. */
async function list(alice, amount, want, window = 12 * 3600, taker = null) {
  const ltcKey = crypto.getRandomValues(new Uint8Array(32));
  const call = H.offerCall({ taker, chain: 'LTC', want, key: publicKey(ltcKey), window, coin, fee: amount / 1000n });
  const r = await chain.operate(alice, program, call, { coin, effect: transferEffect(vault, amount) });
  if (r.status !== 0) fail(`offer refused: ${r.reason}`);
  const id = H.decodeCount(await record(H.COUNT_KEY));
  const listing = await listingOf(id);
  if (!equal(listing.maker, alice.account) || listing.amount !== amount || listing.want !== want) fail('the listing is not what was offered');
  return { listing, ltcKey };
}

/** Bob's side of a take: his secret and key, the lock's script and address. */
function bobLock(listing, taker) {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const buyerKey = crypto.getRandomValues(new Uint8Array(32));
  const t1 = now() + listing.window + H.GAP + 18 * 3600;
  const htlc = { tag: L.lockTag(program, listing.id, taker), hash: sha256(secret), seller: listing.key, buyer: publicKey(buyerKey), t1 };
  return { secret, buyerKey, htlc, output: L.lockOutput(htlc, NET) };
}

/** What the seller's page checks before accepting a take: everything it says, against Litecoin. */
async function checkTake(listing, take, confirmations = 1) {
  const lock = L.decodeTakeLock(take.lock);
  const htlc = { tag: L.lockTag(program, listing.id, take.taker), hash: take.hash, seller: listing.key, buyer: lock.buyer, t1: take.t1 };
  const { scriptPubKey } = L.lockOutput(htlc, NET);
  const tx = await ltc(`/api/tx/${lock.txid}`);
  const out = tx.vout[lock.vout];
  if (!out || out.scriptpubkey !== hex(scriptPubKey)) fail('the take names an output that is not its lock');
  if (BigInt(out.value) < listing.want) fail('the lock holds less than the listing wants');
  const depth = tx.status.confirmed ? (await tipHeight()) - tx.status.block_height + 1 : 0;
  if (depth < confirmations) fail(`the lock has ${depth} confirmations`);
  if ((await ltc(`/api/tx/${lock.txid}/outspend/${lock.vout}`)).spent) fail('the lock is already spent');
  if (take.t1 < now() + listing.window + H.GAP + 600) fail('the lock ends too soon to accept');
  return { htlc, txid: lock.txid, vout: lock.vout, value: out.value, depth };
}

// ---- Scenarios -------------------------------------------------------------

const alice = (await Key.generate()).signer(chain.policy);
const bob = (await Key.generate()).account(chain.policy);
step('Alice gets 100 test DLR from the faucet');
await fund(alice.account, 100);
ok(`Alice ${hex(alice.account).slice(0, 10)}… holds ${Number(await balance(alice.account)) / 1e8} DLR`);
const startHeight = (await chain.node.status()).height;

step('Trade 1: Alice sells 10 DLR for 0.5 LTC');
const { listing, ltcKey } = await list(alice, 10n * DLR, 50_000_000n);
ok(`listing #${listing.id} open: 10 DLR for 0.5 LTC, window ${listing.window / 3600} h`);

const bobTrade = bobLock(listing, bob);
ok(`Bob's lock address ${bobTrade.output.address} (T1 ${new Date(bobTrade.htlc.t1 * 1000).toISOString()})`);
const paid = await payTo('bob', bobTrade.output.address, listing.want);
await mine(1);
ok(`Bob paid 0.5 LTC to it from his own wallet: ${paid.txid}:${paid.vout}, mined`);

await own(H.takeInput({ id: listing.id, taker: bob, hash: bobTrade.htlc.hash, t1: bobTrade.htlc.t1, lock: L.encodeTakeLock({ txid: paid.txid, vout: paid.vout, buyer: bobTrade.htlc.buyer }) }));
const take = (await events(startHeight)).find((e) => e.kind === 'taken' && e.id === listing.id);
ok('Bob\'s page posted the take, with no signature and no fee');

const checked = await checkTake(listing, take);
ok(`Alice's page checked the lock on Litecoin: the script, ${checked.value} litoshi, ${checked.depth} confirmation, unspent`);

const copied = { ...take, taker: (await Key.generate()).account(chain.policy) };
try { await checkTake(listing, copied); fail('a copied take with another account passed the check'); } catch (e) {
  if (!/not its lock/.test(e.message)) throw e;
  ok('a copy of the take naming another account is refused: its address holds nothing');
}

let r = await chain.operate(alice, program, H.acceptCall(listing, take));
if (r.status !== 0) fail(`accept refused: ${r.reason}`);
const lock = await lockOf(listing.id);
if (!equal(lock.taker, bob) || !equal(lock.hash, bobTrade.htlc.hash) || lock.t1 !== bobTrade.htlc.t1) fail('the lock is not what Bob locked for');
ok(`Alice accepted: 10 DLR held for Bob until ${new Date(lock.deadline * 1000).toISOString()}, ${(lock.t1 - lock.deadline) / 3600} h before his LTC lock ends`);

try { await own(H.claimInput(listing.id, crypto.getRandomValues(new Uint8Array(32)))); fail('a wrong secret claimed'); } catch (e) {
  if (!/wrong secret/.test(e.message)) throw e;
  ok('a claim with the wrong secret is refused');
}
const before = await balance(bob);
await own(H.claimInput(listing.id, bobTrade.secret));
const got = (await balance(bob)) - before;
if (got !== 10n * DLR - listing.fee) fail(`Bob got ${got}`);
ok(`Bob's page claimed with the secret: Bob got ${Number(got) / 1e8} DLR, the claim paid the listing's fee of ${Number(listing.fee) / 1e8} DLR`);

const claimed = (await events(startHeight)).find((e) => e.kind === 'claimed' && e.id === listing.id);
const aliceAddr = await address('alice');
const aliceBefore = await walletBalance('alice');
const claim = L.claimTx({ txid: paid.txid, vout: paid.vout, value: paid.value, htlc: checked.htlc, secret: claimed.secret, key: ltcKey, to: aliceAddr, feeRate: 2, network: NET });
await broadcast(claim.hex);
await mine(1);
const claimStatus = await ltc(`/api/tx/${claim.txid}/status`);
if (!claimStatus.confirmed) fail('the LTC claim did not confirm');
ok(`Alice's page read the secret on Ting and claimed the LTC: ${claim.txid} (fee ${claim.fee} litoshi, ${claim.vsize} vB), mined`);
ok(`Alice's Litecoin wallet: ${aliceBefore} → ${await walletBalance('alice')} LTC`);

step('Trade 2: a take Alice declines, released at once');
const second = await list(alice, 5n * DLR, 20_000_000n);
const bob2 = bobLock(second.listing, bob);
const paid2 = await payTo('bob', bob2.output.address, second.listing.want);
await mine(1);
await own(H.takeInput({ id: second.listing.id, taker: bob, hash: bob2.htlc.hash, t1: bob2.htlc.t1, lock: L.encodeTakeLock({ txid: paid2.txid, vout: paid2.vout, buyer: bob2.htlc.buyer }) }));
ok(`listing #${second.listing.id}: Bob locked 0.2 LTC and took it`);
const take2 = (await events(startHeight)).find((e) => e.kind === 'taken' && e.id === second.listing.id);
const checked2 = await checkTake(second.listing, take2);
const signature = L.releaseSignature({ txid: paid2.txid, vout: paid2.vout, value: paid2.value, htlc: checked2.htlc, key: second.ltcKey });
await own(H.releaseInput(second.listing.id, L.encodeRelease({ txid: paid2.txid, vout: paid2.vout, signature })));
ok('Alice\'s page signed a release and posted it on Ting');
const released = L.decodeRelease((await events(startHeight)).find((e) => e.kind === 'released' && e.id === second.listing.id).data);
if (!L.verifyReleaseSignature({ txid: paid2.txid, vout: paid2.vout, value: paid2.value, htlc: bob2.htlc, signature: released.signature })) fail('the release signature does not verify');
const bobAddr = await address('bob');
const back = L.releaseTx({ txid: paid2.txid, vout: paid2.vout, value: paid2.value, htlc: bob2.htlc, key: bob2.buyerKey, signature: released.signature, to: bobAddr, feeRate: 2, network: NET });
await broadcast(back.hex);
await mine(1);
if (!(await ltc(`/api/tx/${back.txid}/status`)).confirmed) fail('the release did not confirm');
ok(`Bob's page took his 0.2 LTC back at once, long before T1: ${back.txid}, mined`);
r = await chain.operate(alice, program, H.withdrawCall(second.listing));
if (r.status !== 0) fail(`withdraw refused: ${r.reason}`);
ok('Alice withdrew the listing and has her 5 DLR back');

if (refund) {
  step('Trade 3: a take nobody accepts, refunded on Litecoin after T1');
  const third = await list(alice, 1n * DLR, 10_000_000n);
  const bob3 = bobLock(third.listing, bob);
  const paid3 = await payTo('bob', bob3.output.address, third.listing.want);
  await mine(1);
  const spend = () => L.refundTx({ txid: paid3.txid, vout: paid3.vout, value: paid3.value, htlc: bob3.htlc, key: bob3.buyerKey, to: bobAddr, feeRate: 2, network: NET });
  try { await broadcast(spend().hex); fail('a refund before T1 was accepted'); } catch (e) {
    if (e.status !== 400) throw e;
    ok(`a refund before T1 is refused by Litecoin: ${e.text.match(/"message":"([^"]+)"/)?.[1] ?? e.text}`);
  }
  const ahead = bob3.htlc.t1 - (await medianTime()) + 60;
  await ltc('/dev/time', { method: 'POST', body: { seconds: ahead } });
  ok(`moved the regtest clock ${(ahead / 3600).toFixed(1)} h forward, past T1`);
  const done = spend();
  await broadcast(done.hex);
  await mine(1);
  if (!(await ltc(`/api/tx/${done.txid}/status`)).confirmed) fail('the refund did not confirm');
  ok(`Bob refunded his 0.1 LTC after T1: ${done.txid}, mined`);
  r = await chain.operate(alice, program, H.withdrawCall(third.listing));
  if (r.status !== 0) fail(`withdraw refused: ${r.reason}`);
}

console.log('\nAll done. The program holds', Number(await balance(vault)) / 1e8, 'DLR in open listings and locks.');
