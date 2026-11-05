#!/usr/bin/env node
// Deploys the swap program: builds the deployment transaction and shows what
// it will create. Nothing is sent without --submit. A deployment is permanent,
// and the program can never change: a swap with other code is another
// deployment, with another ContractId.
//
//   node scripts/deploy.mjs                 shows the production deployment
//   node scripts/deploy.mjs --submit        sends it, and waits for a block
//
//   --node URL         https://node1.ting-node.com
import { hex } from '../web/js/bytes.js';
import { CODE_HASHES } from '../web/js/config.js';
import { deployedId, encodeDeploy, H } from '../web/js/ting.js';
import { Chain, DEPLOY_BUDGET, read, SWAP_INPUT } from './chain.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const submit = args.includes('--submit');

const chain = await Chain.open(option('node', 'https://node1.ting-node.com'));
const code = read('swap.wasm');
const codeHash = hex(H('code', code));
if (codeHash !== CODE_HASHES.swap) throw new Error('swap.wasm is not the program web/js/config.js expects: rebuild, or update CODE_HASHES');
const tx = encodeDeploy(code, SWAP_INPUT, DEPLOY_BUDGET);
const id = deployedId(chain.chain, tx);

console.log(`Network     ${chain.chainHex}
Program     swap.wasm, ${code.length} bytes, CodeHash ${codeHash}
Input       01, the version
Transaction ${tx.length} bytes
ContractId  ${hex(id)}`);

if (await chain.node.contract(id).catch(() => null)) {
  console.log('\nThis deployment is already on the chain.');
} else if (!submit) {
  console.log('\nNot sent. Run again with --submit to deploy it, for good.');
} else {
  // Production blocks come minutes apart.
  const r = await chain.submit(tx, 1800);
  if (r.status !== 0) throw new Error(`deployment failed: ${r.status_name} ${r.reason}`);
  console.log(`\nDeployed in block ${r.height}.`);
}
console.log(`\nFor the page, in web/js/config.js under this network: swap: '${hex(id)}',`);
