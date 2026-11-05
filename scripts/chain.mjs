// What the scripts share: a node, its chain, deployments, plain coin transfers,
// identities, and the swap's calls, all through the web page's own modules,
// so the page's encodings and signatures are the ones exercised.
import { readFileSync } from 'node:fs';
import { concat, framed, fromUtf8, u64, unhex, utf8, Writer } from '../web/js/bytes.js';
import * as S from '../web/js/swap.js';
import * as tcr from '../web/js/tcr.js';
import { deployedId, encodeCall, encodeDeploy, H, Node, policyAccount, transactionId } from '../web/js/ting.js';

const root = new URL('..', import.meta.url);
export const read = (path) => new Uint8Array(readFileSync(new URL(path, root)));

/**
 * The canonical deployments of policy-p256 (Ting wiki: programs, canonical
 * deployment), which the test keys sign through.
 */
const POLICY_P256 = {
  '15d6549cfacd816f835c632b4c67308d1c63e642f4cbf4049368430670705107': '35d2b107de4b2a738a8190be18ccfd35d9bac45da094cfa4281a3a4b178852b3',
  '8578787146be1ef0aacc797754001290272915e89cd9e5784fe1368e4c2131bc': '34ddc75c0463fd2d1542127fbf0fe92ba41bd4fbfba4e473d3aa941e74ab3b5e',
};

/** The canonical deployment budget of the reference programs (Ting wiki: programs). */
export const DEPLOY_BUDGET = [50_000_000, 64, 16_777_216, 16_777_216];
const CALL_BUDGET = [100_000_000, 2048, 2_000_000, 1_000_000];

/** The swap's deployment input: its version. */
export const SWAP_INPUT = Uint8Array.of(1);

/** A coin's deployment input: no cap, rewards or minter, and its whole supply to `holder`. */
export function coinInput({ name, symbol, decimals, holder, supply }) {
  return new Writer().u8(1).bytes(utf8(name)).bytes(utf8(symbol)).u8(decimals)
    .u128((1n << 128n) - 1n).u128(0n).u64(0n).u128(0n).put(new Uint8Array(32))
    .u64(1).put(holder).u128(supply).finish();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An identity of the reference registry with one P-256 key, `wallet`'s, and a
 * slot for each delay; its slots as TCR-1 signers (wiki: programs/identity).
 */
export function identity(registry, policyP256, wallet, delays, salt = crypto.getRandomValues(new Uint8Array(32))) {
  const w = new Writer().u8(1).u64(1).put(policyP256).bytes(wallet.publicKey)
    .u64(0).u64(0).u64(600).u64(300).u64(delays.length);
  for (const d of delays) w.u64(d);
  const creation = w.put(salt).finish();
  const id = H('app/id-v1/id', creation);
  const slot = (n) => {
    const params = concat(id, u64(n));
    return {
      policy: registry,
      params,
      account: policyAccount(registry, params),
      witness: async (message) => concat(u64(0), framed(await wallet.sign(message))),
    };
  };
  return { id, create: concat(Uint8Array.of(1), creation), slot };
}

export class Chain {
  static async open(url) {
    const chain = new Chain();
    chain.node = new Node(url);
    const status = await chain.node.status();
    chain.chainHex = status.chain_id;
    chain.chain = unhex(status.chain_id);
    chain.policy = unhex(POLICY_P256[chain.chainHex]);
    return chain;
  }

  /**
   * Submits a transaction and returns the receipt of its next occurrence. The
   * same bytes can be included again, so the occurrences already there are
   * skipped.
   */
  async submit(tx, seconds = 120) {
    const before = await this.node.occurrences(transactionId(this.chain, tx));
    const id = await this.node.submit(tx);
    for (let i = 0; i < seconds; i++) {
      await sleep(1000);
      const answer = await this.node.transaction(id, before).catch(() => null);
      const seen = answer?.occurrences?.[0];
      if (seen) return { ...seen.receipt, id, height: seen.height, reason: reason(seen.receipt) };
    }
    throw new Error(`transaction ${id} not in a block after ${seconds} s`);
  }

  /** Deploys `code`, or finds the identical deployment already there. */
  async deploy(code, input, budget = DEPLOY_BUDGET) {
    const tx = encodeDeploy(code, input, budget);
    const id = deployedId(this.chain, tx);
    if (await this.node.contract(id).catch(() => null)) return id;
    const r = await this.submit(tx);
    if (r.status !== 0) throw new Error(`deployment failed: ${r.status_name} ${r.reason}`);
    return id;
  }

  async funds(coin, account) {
    return S.decodeCoinAccount(await this.node.record(coin, account));
  }

  /** A plain transfer from `signer`, bound to nothing. */
  async transfer(signer, coin, to, amount) {
    const { nonce } = await this.funds(coin, signer.account);
    const action = S.plainAction(S.transferEffect(to, amount));
    const message = new Writer().bytes(utf8('app/coin-v1')).put(this.chain).put(coin).put(signer.account)
      .u8(0x10).u64(nonce).put(action).finish();
    const witness = await signer.witness(message);
    const input = new Writer().u8(0x10).u8(0).put(signer.policy).bytes(signer.params).u64(nonce)
      .bytes(witness).put(action).finish();
    return this.submit(encodeCall(coin, input, CALL_BUDGET));
  }

  /**
   * An operation `signer` signs, with its nonce in `program`. With `pay`, `{
   * coin, effect, fee }`, a payment from the signer bound to it, which is the
   * approval; without, the signer's witness over its digest.
   */
  async operate(signer, program, call, pay = null) {
    const nonce = tcr.decodeNonce(await this.node.record(program, tcr.nonceKey(signer.account)));
    const payment = pay && { coin: pay.coin, coinNonce: (await this.funds(pay.coin, signer.account)).nonce, effect: pay.effect, fee: pay.fee ?? 0n };
    const input = await tcr.signCall({
      signer, chain: this.chain, program, nonce, head: call.head, payment,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    return this.call(program, input);
  }

  async call(target, input) {
    return this.submit(encodeCall(target, input, CALL_BUDGET));
  }
}

function reason(receipt) {
  try {
    return fromUtf8(unhex(receipt.result_hex));
  } catch {
    return receipt.result_hex;
  }
}

export { hex, unhex } from '../web/js/bytes.js';
