#!/usr/bin/env node
// A stand-in for a wallet with TCR-1, for the development chain: reads a
// `ting:call` link as a wallet must, shows the operation in the program's
// words, signs it with a P-256 key of its own, pays if the link asks, and
// submits it. The key is kept in the state file, and funded from the faucet in
// whichever test coin the link pays.
//
//   node scripts/tcr-wallet.mjs '<ting:call link>' [--state FILE] [--node URL] [--key NAME]
//
// With a payment, the payment is the approval and the call carries no witness.
// Without one, a link that names a coin gets a fee payment, a transfer of 0 to
// the program's account that carries the fee, as the approval; otherwise the
// wallet's key signs the call's digest. Its key's account has no delay.
// --key picks one of several keys kept in the state file, so that two people
// can trade: the maker with one, the taker with another.
import { readFileSync, writeFileSync } from 'node:fs';
import { hex, unhex } from '../web/js/bytes.js';
import { CODE_HASHES } from '../web/js/config.js';
import * as S from '../web/js/swap.js';
import * as tcr from '../web/js/tcr.js';
import { Chain } from './chain.mjs';
import { Key } from './keys.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const chain = await Chain.open(option('node', 'http://127.0.0.1:28451'));
const statePath = option('state', '.devchain.json');
const keyName = option('key', 'phone');
const [link] = args;

// What a wallet checks before anyone signs (TCR-1, checking): the link's own
// rules, read by readLink; the program's template list; the values; the coin.
const fields = await tcr.readLink(link);
if (fields.net !== chain.chainHex.slice(0, 8)) throw new Error('a link for another network');
const program = unhex(fields.program);
const values = fields.valueBytes;
const listed = tcr.decodeTemplateList(await chain.node.record(program, tcr.TEMPLATES_KEY));
tcr.checkListed(listed, fields.template);
const { parts } = tcr.decodeValues(fields.parsed, values);
if (fields.coin && (await chain.node.contract(unhex(fields.coin))).code_hash !== CODE_HASHES.coin) {
  throw new Error('the payment is in a contract that is not a coin');
}

const state = JSON.parse(readFileSync(statePath, 'utf8'));
state.keys ??= {};
if (!state.keys[keyName]) {
  state.keys[keyName] = (await Key.generate()).jwk;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
const signer = (await Key.fromJwk(state.keys[keyName])).signer(chain.policy);
const coins = new Map();
const coinInfo = async (id) => {
  if (!coins.has(id)) coins.set(id, S.decodeCoin(await chain.node.record(unhex(id), S.CONFIG_KEY)));
  return coins.get(id);
};
const known = new Set(Object.values(state.coins));
const shownAmount = async (coin, value) => {
  const info = await coinInfo(hex(coin));
  return `${S.formatAmount(value, info.decimals)} ${info.symbol}${known.has(hex(coin)) ? '' : ` (a coin this wallet does not know, ${hex(coin).slice(0, 8)}…)`}`;
};
const shown = async (type, v) => {
  if (type === 'amount') return shownAmount(v.coin, v.amount);
  if (v instanceof Uint8Array) return hex(v);
  return String(v);
};
const pay = fields.to ? { coin: fields.coin, to: fields.to, amount: fields.amount } : null;
const payInfo = pay && (await coinInfo(pay.coin));
const words = [];
for (const p of parts) words.push(p.payment ? `${pay.amount} ${payInfo.symbol}` : p.slot ? await shown(p.type, p.value) : p.text);
console.log(`Program    ${fields.program}`);
console.log(`Operation  ${words.join('')}`);
console.log(`Account    ${hex(signer.account)} (${keyName})`);
if (fields.from && fields.from !== hex(signer.account)) throw new Error('the link is for another account');

let payment = null;
if (pay) {
  const symbol = Object.entries(state.coins).find(([, id]) => id === pay.coin)?.[0];
  if (!symbol) throw new Error('the payment is in a coin this wallet does not hold');
  const units = S.parseAmount(pay.amount, payInfo.decimals);
  console.log(`Pays       ${pay.amount} ${payInfo.symbol} to ${pay.to}`);
  if ((await chain.funds(unhex(pay.coin), signer.account)).available < units) {
    const faucet = (await Key.fromJwk(state.faucet)).signer(chain.policy);
    await chain.transfer(faucet, unhex(pay.coin), signer.account, units * 2n);
  }
  payment = { coin: unhex(pay.coin), coinNonce: (await chain.funds(unhex(pay.coin), signer.account)).nonce, effect: S.transferEffect(unhex(pay.to), units) };
} else if (fields.coin) {
  console.log('Pays       nothing but the fee, as a fee payment');
  payment = { coin: unhex(fields.coin), coinNonce: (await chain.funds(unhex(fields.coin), signer.account)).nonce, effect: tcr.feeEffect(program) };
}

const nonce = tcr.decodeNonce(await chain.node.record(program, tcr.nonceKey(signer.account)));
const input = await tcr.signCall({
  signer, chain: chain.chain, program, nonce, head: tcr.head(fields.template, values), payment,
  validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
});
const r = await chain.call(program, input);
console.log(r.status === 0 ? `Done, in block ${r.height}` : `Failed: ${r.reason}`);
// The wallet offers the page back, never opens it by itself.
if (fields.return) console.log(`Return     ${new URL(fields.return).host}: ${fields.return}#ting-tx=${r.id}`);
process.exit(r.status === 0 ? 0 : 1);
