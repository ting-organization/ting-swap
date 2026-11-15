#!/usr/bin/env node
// Litecoin swaps on development chains only: the HTLC program on the Ting
// development chain that Ting ID Web's kit runs (../ting-id-web, ports
// 28450–28452), and Litecoin on the regtest chain of scripts/ltc-dev.mjs.
//
//   node scripts/htlc-dev.mjs setup             deploys htlc.wasm and prints the page's address
//   node scripts/htlc-dev.mjs fund <account> <amount>
//                                               sends test DLR from Ting ID Web's faucet
//   node scripts/htlc-dev.mjs url               prints the page's address again
//
// The ids are kept in .htlc-dev.json.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Chain, hex, read } from './chain.mjs';

const NODE = 'http://127.0.0.1:28451';
const DEVELOPMENT = '8578787146be1ef0aacc797754001290272915e89cd9e5784fe1368e4c2131bc';
const WALLET_REPO = new URL('../../ting-id-web/', import.meta.url);
const STATE = new URL('../.htlc-dev.json', import.meta.url);
const PAGE = 'http://localhost:8770/';
const WALLET = 'http://localhost:8766/web/';
const LTC_API = 'http://127.0.0.1:28472/api';

const [command, ...rest] = process.argv.slice(2);

function walletChain() {
  const path = new URL('web/dev-chain.json', WALLET_REPO);
  if (!existsSync(path)) throw new Error('no ../ting-id-web/web/dev-chain.json: run its dev setup first (see its README)');
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pageUrl(state) {
  const q = new URLSearchParams({
    node: NODE, htlc: state.htlc, coins: state.coin, wallet: WALLET, ltc: LTC_API, ltcnet: 'regtest', confs: '1', tconfs: '3',
  });
  return `${PAGE}?${q}`;
}

async function setup() {
  const dev = walletChain();
  const chain = await Chain.open(NODE);
  if (chain.chainHex !== DEVELOPMENT || dev.chainId !== DEVELOPMENT) throw new Error(`${NODE} is not on the development chain`);
  const htlc = await chain.deploy(read('htlc.wasm'), Uint8Array.of(1));
  const state = { htlc: hex(htlc), coin: dev.coins[0] };
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  console.log(`htlc   ${state.htlc}`);
  console.log(`DLR    ${state.coin}   (Ting ID Web's test coin)`);
  console.log(`\nServe the page with: python3 scripts/serve.py 8770\nThen open:\n${pageUrl(state)}`);
}

function fund([account, amount]) {
  if (!/^[0-9a-f]{64}$/i.test(account ?? '') || !amount) throw new Error('usage: fund <account> <amount>');
  execFileSync('node', ['kit/scripts/devchain.mjs', 'fund', account, amount], { cwd: WALLET_REPO, stdio: 'inherit' });
}

if (command === 'setup') await setup();
else if (command === 'fund') fund(rest);
else if (command === 'url') console.log(pageUrl(JSON.parse(readFileSync(STATE, 'utf8'))));
else {
  console.error('usage: node scripts/htlc-dev.mjs setup | fund <account> <amount> | url');
  process.exit(1);
}
