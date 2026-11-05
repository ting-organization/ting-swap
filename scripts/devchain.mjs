#!/usr/bin/env node
// A development chain for Ting Swap, on a node made by `ting init --dev` with
// REST and CORS on, and mining:
//
//   node scripts/devchain.mjs setup   deploys policy-p256, the identity registry,
//                                     two test coins whose supply goes to a
//                                     faucet, and the swap
//   node scripts/devchain.mjs fund <account> <amount> [symbol]
//                                     sends test coins from the faucet (DLR)
//   node scripts/devchain.mjs demo    fills the market: listings from test keys,
//                                     a trade, a withdrawal, and a coin that
//                                     imitates Daler
//   node scripts/devchain.mjs e2e     runs listings through their whole life with
//                                     real signatures: the page's own P-256
//                                     wallets, call links read as a wallet reads
//                                     them, and an identity's two accounts
//
// --node URL picks the node (http://127.0.0.1:28451), --state FILE where the
// ids and the faucet's key are kept (.devchain.json).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { equal, Reader } from '../web/js/bytes.js';
import * as S from '../web/js/swap.js';
import * as tcr from '../web/js/tcr.js';
import { contractAccount } from '../web/js/ting.js';
import { Key } from './keys.mjs';
import { Chain, coinInput, hex, identity, read, SWAP_INPUT, unhex } from './chain.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const nodeUrl = option('node', 'http://127.0.0.1:28451');
const statePath = option('state', '.devchain.json');
const [command, ...rest] = args;

const DLR = 100_000_000n;
const GLD = 100n;

const chain = await Chain.open(nodeUrl);
if (chain.chainHex !== '8578787146be1ef0aacc797754001290272915e89cd9e5784fe1368e4c2131bc') {
  throw new Error(`${nodeUrl} is not on the development chain`);
}

function loadState() {
  if (!existsSync(statePath)) throw new Error(`no ${statePath}: run setup first`);
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

const pageQuery = (state) => `?node=${encodeURIComponent(nodeUrl)}&swap=${state.swap}&coins=${state.coins.DLR},${state.coins.GLD}`;

async function setup() {
  const policy = await chain.deploy(read('../ting-reference/programs/policy-p256.wasm'), new Uint8Array());
  if (!equal(policy, chain.policy)) throw new Error('policy-p256 is not where the page expects it');
  console.log(`policy-p256  ${hex(policy)}`);
  const registry = await chain.deploy(read('../ting-reference/programs/id-registry.wasm'), new Uint8Array());
  console.log(`id-registry  ${hex(registry)}`);

  const faucet = await Key.generate();
  const holder = faucet.account(chain.policy);
  const code = read('../ting-reference/programs/coin.wasm');
  const budget = [50_000_000, 66, 16_777_216, 16_777_216];
  const dlr = await chain.deploy(code, coinInput({ name: 'Daler', symbol: 'DLR', decimals: 8, holder, supply: 1_000_000n * DLR }), budget);
  console.log(`coin         ${hex(dlr)}   (Daler, DLR, 1,000,000 to the faucet)`);
  const gld = await chain.deploy(code, coinInput({ name: 'Test Gold', symbol: 'GLD', decimals: 2, holder, supply: 1_000_000n * GLD }), budget);
  console.log(`coin         ${hex(gld)}   (Test Gold, GLD, 1,000,000 to the faucet)`);
  const swap = await chain.deploy(read('swap.wasm'), SWAP_INPUT);
  console.log(`swap         ${hex(swap)}`);
  const state = { swap: hex(swap), registry: hex(registry), coins: { DLR: hex(dlr), GLD: hex(gld) }, decimals: { DLR: 8, GLD: 2 }, faucet: faucet.jwk };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(`\nOpen the page with ${pageQuery(state)}`);
}

async function fund(accountHex, amountText, symbol = 'DLR') {
  const state = loadState();
  const faucet = (await Key.fromJwk(state.faucet)).signer(chain.policy);
  const coin = state.coins[symbol];
  if (!coin) throw new Error(`no test coin ${symbol}`);
  const amount = S.parseAmount(amountText, state.decimals[symbol]);
  const r = await chain.transfer(faucet, unhex(coin), unhex(accountHex), amount);
  if (r.status !== 0) throw new Error(`transfer failed: ${r.reason}`);
  console.log(`sent ${amountText} ${symbol} to ${accountHex} in block ${r.height}`);
}

/** Listings to look at: some from test keys, one taken, one withdrawn, and one in a coin that calls itself Daler. */
async function demo() {
  const state = loadState();
  const swap = unhex(state.swap);
  const [dlr, gld] = [unhex(state.coins.DLR), unhex(state.coins.GLD)];
  const faucet = (await Key.fromJwk(state.faucet)).signer(chain.policy);
  const vault = contractAccount(swap);
  const people = [];
  for (let i = 0; i < 3; i++) {
    const signer = (await Key.generate()).signer(chain.policy);
    await chain.transfer(faucet, dlr, signer.account, 500n * DLR);
    await chain.transfer(faucet, gld, signer.account, 5000n * GLD);
    people.push(signer);
  }
  const [ann, ben, cleo] = people;
  // A coin of the reference program that names itself Daler, as anyone may.
  const fake = await chain.deploy(read('../ting-reference/programs/coin.wasm'),
    coinInput({ name: 'Daler', symbol: 'DLR', decimals: 8, holder: cleo.account, supply: 1_000_000n * DLR }),
    [50_000_000, 66, 16_777_216, 16_777_216]);
  const euro = await chain.deploy(read('../ting-reference/programs/coin.wasm'),
    coinInput({ name: 'Ting Euro', symbol: 'TEUR', decimals: 2, holder: ben.account, supply: 100_000n * 100n }),
    [50_000_000, 66, 16_777_216, 16_777_216]);
  const offer = async (who, giveCoin, give, wantCoin, want) => {
    const r = await chain.operate(who, swap, S.offerCall(wantCoin, want), { coin: giveCoin, effect: S.transferEffect(vault, give) });
    if (r.status !== 0) throw new Error(`offer: ${r.reason}`);
  };
  await offer(ann, dlr, 120n * DLR, gld, 3000n * GLD);
  await offer(ben, dlr, 25n * DLR, gld, 650n * GLD);
  await offer(cleo, gld, 900n * GLD, dlr, 35n * DLR);
  await offer(ann, gld, 250n * GLD, dlr, 9n * DLR + DLR / 2n);
  await offer(ben, euro, 1500n * 100n, dlr, 60n * DLR);
  await offer(cleo, fake, 1000n * DLR, dlr, 10n * DLR);
  await offer(ben, dlr, 3n * DLR, gld, 70n * GLD);
  const count = S.decodeCount(await chain.node.record(swap, S.COUNT_KEY));
  const listing = async (id) => S.decodeListing(id, await chain.node.record(swap, S.listingKey(id)));
  const last = await listing(count);
  let r = await chain.operate(cleo, swap, S.takeCall(last), { coin: last.wantCoin, effect: S.transferEffect(last.maker, last.want) });
  if (r.status !== 0) throw new Error(`take: ${r.reason}`);
  await offer(cleo, gld, 40n * GLD, dlr, 2n * DLR);
  const mine = await listing(count + 1);
  r = await chain.operate(cleo, swap, S.withdrawCall(mine));
  if (r.status !== 0) throw new Error(`withdraw: ${r.reason}`);
  console.log(`${count + 1} listings made, one taken, one withdrawn; a coin that calls itself Daler: ${hex(fake)}`);
  console.log(`\nOpen the page with ${pageQuery(state)}`);
}

/**
 * Listings through their whole life, signed for real: P-256 keys, an
 * identity's spending account and its savings account, which the swap refuses.
 */
async function e2e() {
  const state = loadState();
  const swap = unhex(state.swap);
  const [dlr, gld] = [unhex(state.coins.DLR), unhex(state.coins.GLD)];
  const registry = unhex(state.registry);
  const faucet = (await Key.fromJwk(state.faucet)).signer(chain.policy);
  const alice = (await Key.generate()).signer(chain.policy);
  const bob = (await Key.generate()).signer(chain.policy);
  const carolId = identity(registry, chain.policy, await Key.generate(), [0, 20]);
  const [spending, savings] = [carolId.slot(0), carolId.slot(1)];
  const vault = contractAccount(swap);
  const costs = [];
  const check = (label, r, expect = 'success') => {
    const ok = expect === 'success' ? r.status === 0 : r.status === 1 && r.reason === expect;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${r.status ? ` (reverted: ${r.reason})` : ''}`);
    if (!ok) throw new Error(`${label}: expected ${expect}, got status ${r.status} ${r.reason}`);
    if (r.status === 0) costs.push([label, r.used]);
  };
  const assert = (label, condition) => {
    console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`);
    if (!condition) throw new Error(label);
  };
  const funds = async (coin, who) => (await chain.funds(coin, who.account ?? who)).balance;
  const listing = async (id) => S.decodeListing(id, await chain.node.record(swap, S.listingKey(id)));
  const count = async () => S.decodeCount(await chain.node.record(swap, S.COUNT_KEY));

  const listed = tcr.decodeTemplateList(await chain.node.record(swap, tcr.TEMPLATES_KEY));
  assert('the swap lists its three templates, and the page’s are among them', listed.size === 3
    && Object.values(S.TEMPLATES).every((t) => listed.get(hex(tcr.templateHash(t))) === t));
  for (const t of listed.values()) tcr.parseTemplate(t);

  check('create carol’s identity: spending, and savings with a 20 s delay', await chain.call(registry, carolId.create));
  for (const [who, signer] of [['alice', alice], ['bob', bob], ['carol’s spending', spending], ['carol’s savings', savings]]) {
    check(`fund ${who} with 50 DLR`, await chain.transfer(faucet, dlr, signer.account, 50n * DLR));
    check(`fund ${who} with 500 GLD`, await chain.transfer(faucet, gld, signer.account, 500n * GLD));
  }

  // Alice lists 10 DLR for 125 GLD, through the link the page makes and a wallet reads.
  const offer = S.offerCall(gld, 125n * GLD);
  const link = await tcr.callLink({
    chainHex: chain.chainHex, program: swap, template: offer.template, values: offer.values,
    coin: dlr, to: vault, amount: S.linkAmount(10n * DLR, 8), returnTo: 'https://swap.example/',
  });
  const fields = await tcr.readLink(link);
  tcr.checkListed(listed, fields.template);
  const shown = tcr.decodeValues(fields.parsed, fields.valueBytes);
  assert('the offer’s link reads back: its template, its values and its payment', fields.coin === hex(dlr)
    && fields.to === hex(vault) && fields.amount === '10' && equal(shown.value.want.coin, gld) && shown.value.want.amount === 125n * GLD);
  const id = (await count()) + 1;
  const before = await funds(dlr, alice);
  // What a wallet does with the link: the operation from its template and values, the payment from its fields.
  const fromLink = { head: tcr.head(fields.template, fields.valueBytes) };
  assert('the link’s operation is the one the page made', equal(fromLink.head, offer.head));
  check('alice offers 10 DLR for 125 GLD, approved by her payment',
    await chain.operate(alice, swap, fromLink,
      { coin: unhex(fields.coin), effect: S.transferEffect(unhex(fields.to), S.parseAmount(fields.amount, 8)) }));
  const l1 = await listing(id);
  assert('the listing holds what she offered, and the swap her 10 DLR', l1 && equal(l1.maker, alice.account)
    && equal(l1.giveCoin, dlr) && l1.give === 10n * DLR && equal(l1.wantCoin, gld) && l1.want === 125n * GLD
    && before - (await funds(dlr, alice)) === 10n * DLR);

  check('carol’s savings cannot list: the coin refuses its bound payment',
    await chain.operate(savings, swap, S.offerCall(dlr, DLR), { coin: gld, effect: S.transferEffect(vault, GLD) }), 'payment: delayed binding');
  check('bob paying 124 GLD is refused', await chain.operate(bob, swap, S.takeCall(l1),
    { coin: gld, effect: S.transferEffect(alice.account, 124n * GLD) }), 'wrong amount');
  check('bob paying the swap instead of alice is refused', await chain.operate(bob, swap, S.takeCall(l1),
    { coin: gld, effect: S.transferEffect(vault, 125n * GLD) }), 'bad payment');
  check('bob cannot withdraw alice’s listing', await chain.operate(bob, swap, S.withdrawCall(l1)), 'not maker');
  check('carol’s savings cannot take it either', await chain.operate(savings, swap, S.takeCall(l1),
    { coin: gld, effect: S.transferEffect(alice.account, 125n * GLD) }), 'payment: delayed binding');
  const [aliceGld, bobDlr] = [await funds(gld, alice), await funds(dlr, bob)];
  check('bob takes it, paying alice 125 GLD', await chain.operate(bob, swap, S.takeCall(l1),
    { coin: gld, effect: S.transferEffect(alice.account, 125n * GLD) }));
  assert('alice has 125 GLD more, bob 10 DLR more, the listing is gone', (await funds(gld, alice)) - aliceGld === 125n * GLD
    && (await funds(dlr, bob)) - bobDlr === 10n * DLR && !(await listing(id)));
  check('a second take finds nothing', await chain.operate(spending, swap, S.takeCall(l1),
    { coin: gld, effect: S.transferEffect(alice.account, 125n * GLD) }), 'not listed');

  check('carol’s spending lists 40 GLD for 3 DLR', await chain.operate(spending, swap, S.offerCall(dlr, 3n * DLR),
    { coin: gld, effect: S.transferEffect(vault, 40n * GLD) }));
  const l2 = await listing(id + 1);
  check('her savings account, the same identity, is not the maker', await chain.operate(savings, swap, S.withdrawCall(l2)), 'not maker');
  const gldBefore = await funds(gld, spending);
  check('her spending account withdraws it, signed through the identity', await chain.operate(spending, swap, S.withdrawCall(l2)));
  assert('her 40 GLD are back', (await funds(gld, spending)) - gldBefore === 40n * GLD && !(await listing(id + 1)));

  check('alice lists 5 DLR for 1 GLD', await chain.operate(alice, swap, S.offerCall(gld, GLD), { coin: dlr, effect: S.transferEffect(vault, 5n * DLR) }));
  const l3 = await listing(id + 2);
  const dlrBefore = await funds(dlr, alice);
  check('alice withdraws it with a fee payment in DLR, one signature', await chain.operate(alice, swap, S.withdrawCall(l3),
    { coin: dlr, effect: tcr.feeEffect(swap), fee: 1000n }));
  const back = (await funds(dlr, alice)) - dlrBefore;
  assert('her 5 DLR are back, less at most the fee', back === 5n * DLR || back === 5n * DLR - 1000n);
  assert('the swap holds nothing for closed listings', (await funds(dlr, vault)) === [...(await openListings(swap))].filter((l) => equal(l.giveCoin, dlr)).reduce((n, l) => n + l.give, 0n));

  const events = [];
  for (let from = 1; ;) {
    const page = await chain.node.events(swap, S.TOPIC, from, 100);
    for (const block of page.items) {
      for (const e of block.events) {
        const r = new Reader(unhex(e.payload_hex));
        r.take(32);
        events.push(S.decodeEvent(r));
      }
    }
    if (!page.items.length || page.next > page.height) break;
    from = page.next;
  }
  const ours = events.filter((e) => e.id >= id).map((e) => `${e.kind} ${e.id}`).join(', ');
  assert(`the swap’s events tell it: ${ours}`, ours === `listed ${id}, taken ${id}, listed ${id + 1}, withdrawn ${id + 1}, listed ${id + 2}, withdrawn ${id + 2}`);
  const taken = events.find((e) => e.kind === 'taken' && e.id === id);
  assert('the trade’s event names both sides', equal(taken.maker, alice.account) && equal(taken.taker, bob.account) && taken.want === 125n * GLD);

  console.log('\nWhat each step used, with real signatures:');
  for (const [label, [c, s, d, g]] of costs) {
    console.log(`  ${label.padEnd(66)} ${c.toLocaleString().padStart(11)} C ${String(s).padStart(4)} S ${String(d).padStart(6)} D ${String(g).padStart(6)} G`);
  }
}

async function openListings(swap) {
  const count = S.decodeCount(await chain.node.record(swap, S.COUNT_KEY));
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const values = await chain.node.storage(ids.map((id) => [swap, S.listingKey(id)]));
  return ids.map((id, i) => S.decodeListing(id, values[i])).filter(Boolean);
}

if (command === 'setup') await setup();
else if (command === 'fund') await fund(...rest);
else if (command === 'demo') await demo();
else if (command === 'e2e') await e2e();
else {
  console.error('usage: node scripts/devchain.mjs setup | fund <account> <amount> [symbol] | demo | e2e  [--node URL] [--state FILE]');
  process.exit(2);
}
