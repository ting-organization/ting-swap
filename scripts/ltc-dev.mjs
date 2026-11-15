#!/usr/bin/env node
// A local Litecoin regtest chain for testing the Litecoin side of swaps: litecoind,
// an Esplora-style HTTP API (the part of litecoinspace.org's API the page reads), and
// a dev wallet page that stands in for "your normal Litecoin wallet". Test setup only:
// regtest, everything on 127.0.0.1, nothing reaches Litecoin mainnet or testnet.
//
//   node scripts/ltc-dev.mjs start        starts litecoind; the first time writes the
//                                         config, creates the wallets alice, bob and
//                                         miner, mines past every soft fork and MWEB,
//                                         and gives bob 10 LTC
//   node scripts/ltc-dev.mjs stop
//   node scripts/ltc-dev.mjs status       height, tip time, median time past, balances
//   node scripts/ltc-dev.mjs serve        API, wallet page and dev controls, in the
//                                         foreground, on http://127.0.0.1:28472
//   node scripts/ltc-dev.mjs mine [n] [--to wallet]
//   node scripts/ltc-dev.mjs pay <address | litecoin: URI> [ltc] [--from bob]
//   node scripts/ltc-dev.mjs address <wallet>     a new bech32 receive address
//   node scripts/ltc-dev.mjs time <+seconds>      also +90m, +12h, +2d: moves the
//                                         chain's clock forward and mines until the
//                                         median time past is past it
//
// litecoind (Litecoin Core 0.21.5.8) is expected in .devltc/litecoin-0.21.5.8/bin;
// its data dir is .devltc/regtest, RPC on 127.0.0.1:28470, P2P on 127.0.0.1:28471.
// The clock offset made by `time` is kept in .devltc/regtest/dev-state.json, so the
// chain's clock keeps running from where it was moved, also after a restart.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LITECOIND = join(ROOT, '.devltc', 'litecoin-0.21.5.8', 'bin', 'litecoind');
const DATADIR = join(ROOT, '.devltc', 'regtest');
const NETDIR = join(DATADIR, 'regtest');
const CONFIG = join(DATADIR, 'litecoin.conf');
const STATE = join(DATADIR, 'dev-state.json');
const HOST = '127.0.0.1';
const RPC_PORT = 28470;
const P2P_PORT = 28471;
const HTTP_PORT = 28472;
const WALLETS = ['alice', 'bob', 'miner'];
// Regtest buries BIP34 at 500, CSV at 432, BIP66 at 1251 and BIP65 (CHECKLOCKTIMEVERIFY)
// at 1351, and MWEB activates at 432. Mining past all of them gives mainnet's rules.
const SETUP_HEIGHT = 1400;
const COIN = 100_000_000;

// ---------------------------------------------------------------------------
// litecoind

class NotRunning extends Error {}
class RpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

let rpcId = 0;
async function post(body, wallet) {
  let cookie;
  try {
    cookie = readFileSync(join(NETDIR, '.cookie'), 'utf8').trim();
  } catch {
    throw new NotRunning('litecoind is not running (node scripts/ltc-dev.mjs start)');
  }
  let res;
  try {
    res = await fetch(`http://${HOST}:${RPC_PORT}/${wallet ? `wallet/${encodeURIComponent(wallet)}` : ''}`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(cookie).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NotRunning(`litecoind is not answering on ${HOST}:${RPC_PORT} (node scripts/ltc-dev.mjs start)`);
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new RpcError(-1, `litecoind answered HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }
}

async function rpc(method, params = [], wallet) {
  const r = await post({ jsonrpc: '1.0', id: ++rpcId, method, params }, wallet);
  if (r.error) throw new RpcError(r.error.code, r.error.message);
  return r.result;
}

// Several calls in one request; each comes back as {result, error}.
async function rpcBatch(calls) {
  if (!calls.length) return [];
  const r = await post(calls.map(([method, params = []], id) => ({ jsonrpc: '1.0', id, method, params })));
  if (!Array.isArray(r)) throw new RpcError(r.error?.code ?? -1, r.error?.message ?? 'litecoind refused the batch');
  const out = [];
  for (const item of r) out[item.id] = item;
  return out;
}

function pid() {
  let p;
  try {
    p = Number(readFileSync(join(NETDIR, 'litecoind.pid'), 'utf8'));
    process.kill(p, 0);
  } catch {
    return null;
  }
  try {
    return execFileSync('ps', ['-p', String(p), '-o', 'comm='], { encoding: 'utf8' }).includes('litecoind') ? p : null;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    return { offset: 0 };
  }
}

// The chain's clock: real time plus the offset `time` has added.
async function syncClock(extra = 0) {
  const { offset = 0 } = loadState();
  await rpc('setmocktime', [offset || extra ? now() + offset + extra : 0]);
}

function writeConfig() {
  if (existsSync(CONFIG)) return;
  mkdirSync(DATADIR, { recursive: true });
  writeFileSync(CONFIG, `# Written by scripts/ltc-dev.mjs: a local Litecoin regtest node for testing.
# Everything binds to 127.0.0.1 and it makes no outside connections. Regtest keeps
# the standardness rules on by default, so non-standard transactions are refused
# as on mainnet; acceptnonstdtxn is left unset on purpose.
regtest=1
server=1
txindex=1
# The wallet's fee rate when it has no estimate, in LTC/kvB (10 litoshi/vB).
fallbackfee=0.0001

[regtest]
rpcbind=${HOST}
rpcallowip=${HOST}
rpcport=${RPC_PORT}
rpcthreads=8
rpcworkqueue=64
port=${P2P_PORT}
bind=${HOST}:${P2P_PORT}
# Without an onion bind, 0.21 also listens on 127.0.0.1:19444 for Tor, even with
# listenonion=0. Naming the P2P port keeps it to one port: this second bind is
# refused ("Unable to bind to 127.0.0.1:${P2P_PORT}") and that is harmless.
bind=${HOST}:${P2P_PORT}=onion
listen=1
listenonion=0
connect=0
dnsseed=0
discover=0
upnp=0
`);
  console.log(`wrote ${CONFIG}`);
}

async function waitForRpc(seconds = 120) {
  const started = Date.now();
  for (;;) {
    try {
      return await rpc('getblockchaininfo');
    } catch (e) {
      if (!(e instanceof NotRunning) && e.code !== -28 && !/HTTP 401/.test(e.message)) throw e;
    }
    if (Date.now() - started > 10_000 && !pid()) {
      const log = join(NETDIR, 'debug.log');
      const tail = existsSync(log) ? readFileSync(log, 'utf8').trimEnd().split('\n').slice(-15).join('\n') : '';
      throw new Error(`litecoind exited while starting. The end of ${log}:\n${tail}`);
    }
    if (Date.now() - started > seconds * 1000) throw new Error(`litecoind did not answer within ${seconds} s`);
    await sleep(250);
  }
}

async function newAddress(wallet, type = 'bech32') {
  if (!WALLETS.includes(wallet)) throw new Error(`no wallet ${wallet} (alice, bob or miner)`);
  return rpc('getnewaddress', ['', type], wallet);
}

// Mines n blocks to a new address of the wallet. Litecoin's first MWEB block (432 on
// regtest) needs a peg-in: its HogEx transaction has nothing else to spend, and
// without one the block is refused with bad-txns-vin-empty.
async function mine(n, wallet = 'miner', { clock = 0 } = {}) {
  if (!Number.isInteger(n) || n < 1 || n > 5000) throw new Error('mine 1 to 5000 blocks');
  await syncClock(clock);
  const address = await newAddress(wallet);
  const target = (await rpc('getblockcount')) + n;
  let peggedIn = false;
  for (let height = target - n; height < target; height = await rpc('getblockcount')) {
    try {
      await rpc('generatetoaddress', [Math.min(target - height, 200), address]);
    } catch (e) {
      if (peggedIn || !/bad-txns-vin-empty/.test(e.message)) throw e;
      await rpc('sendtoaddress', [await newAddress('miner', 'mweb'), 1], 'miner');
      peggedIn = true;
    }
  }
  return target;
}

async function pay(from, to, amount) {
  if (!WALLETS.includes(from)) throw new Error(`no wallet ${from} (alice, bob or miner)`);
  const uri = /^litecoin:(?:\/\/)?([^?]+)(?:\?(.*))?$/i.exec(String(to ?? '').trim());
  if (uri) {
    to = uri[1];
    amount ||= new URLSearchParams(uri[2] ?? '').get('amount');
  }
  to = String(to ?? '').trim();
  amount = String(amount ?? '').trim();
  if (!to) throw new Error('give an address');
  if (!/^\d+(\.\d{1,8})?$/.test(amount) || Number(amount) <= 0) throw new Error('give the amount in LTC, e.g. 0.5');
  await syncClock();
  return rpc('sendtoaddress', [to, amount], from);
}

async function moveTime(seconds) {
  if (!Number.isInteger(seconds) || seconds <= 0) throw new Error('time only moves forward: give +seconds, e.g. +3600 or +12h');
  const start = await rpc('getblockcount');
  const state = loadState();
  state.offset = (state.offset || 0) + seconds;
  writeFileSync(STATE, JSON.stringify(state, null, 2) + '\n');
  const clock = now() + state.offset;
  // Blocks at the new clock + 1 s until the median of the last 11 block times is past
  // it, so a lock time up to the new clock is final (a lock time must be below it).
  while ((await rpc('getblockchaininfo')).mediantime <= clock) {
    if ((await rpc('getblockcount')) - start >= 30) throw new Error('the median time past did not move; is the chain far ahead?');
    await mine(1, 'miner', { clock: 1 });
  }
  await syncClock();
  return { ...(await chainStatus()), mined: (await rpc('getblockcount')) - start };
}

async function chainStatus() {
  const info = await rpc('getblockchaininfo');
  const tip = await rpc('getblockheader', [info.bestblockhash]);
  const { offset = 0 } = loadState();
  const wallets = {};
  for (const w of WALLETS) {
    try {
      const b = (await rpc('getbalances', [], w)).mine;
      wallets[w] = { balance: b.trusted, unconfirmed: b.untrusted_pending, immature: b.immature };
    } catch {
      wallets[w] = null;
    }
  }
  return { height: info.blocks, hash: info.bestblockhash, tiptime: tip.time, mediantime: tip.mediantime, offset, clock: now() + offset, wallets };
}

async function walletInfo(name) {
  if (!WALLETS.includes(name)) throw new Error(`no wallet ${name} (alice, bob or miner)`);
  const b = (await rpc('getbalances', [], name)).mine;
  const byTx = new Map();
  for (const e of await rpc('listtransactions', ['*', 100, 0, true], name)) {
    let t = byTx.get(e.txid);
    if (!t) byTx.set(e.txid, (t = { txid: e.txid, amount: 0, fee: 0, confirmations: e.confirmations, time: e.time, category: e.category }));
    t.amount += Math.round(e.amount * COIN);
    if (e.fee) t.fee = Math.round(e.fee * COIN); // the same fee is on every entry of a send
  }
  const txs = [...byTx.values()]
    .map((t) => ({ ...t, amount: (t.amount + t.fee) / COIN, fee: -t.fee / COIN }))
    .sort((a, b) => b.time - a.time || a.confirmations - b.confirmations)
    .slice(0, 20);
  return { wallet: name, balance: b.trusted, unconfirmed: b.untrusted_pending, immature: b.immature, txs };
}

// ---------------------------------------------------------------------------
// The address index behind the API: every block (getblock verbosity 2, kept by
// height) and the mempool. Regtest is small enough to hold it all.

const ZERO = '0'.repeat(64);
const TYPES = {
  pubkey: 'p2pk',
  pubkeyhash: 'p2pkh',
  scripthash: 'p2sh',
  witness_v0_keyhash: 'v0_p2wpkh',
  witness_v0_scripthash: 'v0_p2wsh',
  witness_v1_taproot: 'v1_p2tr',
  nulldata: 'op_return',
  multisig: 'multisig',
};
const litoshi = (ltc) => Math.round(ltc * COIN);
function addressOf(spk) {
  if (!spk || spk.type === 'pubkey' || spk.type === 'multisig') return undefined;
  return spk.address ?? (spk.addresses?.length === 1 ? spk.addresses[0] : undefined);
}
// MWEB inputs and outputs (ismweb) are not part of the canonical transaction.
const canonicalIn = (tx) => tx.vin.filter((v) => !v.ismweb);
const canonicalOut = (tx) => tx.vout.filter((o) => !o.ismweb);

class Index {
  constructor() {
    this.reset();
    this.pending = null;
  }

  reset() {
    this.hashes = []; // by height
    this.tipHash = null;
    this.txs = new Map(); // txid → {tx, height, pos, blockhash, blocktime}
    this.spends = new Map(); // "txid:vout" → {txid, vin}
    this.addrs = new Map(); // address → [txid] in chain order
    this.mempool = new Map(); // txid → {tx, time, seen, ancestors, mempool: true}
    this.mempoolKey = '';
    this.seen = 0;
    this.mempoolSpends = new Map();
    this.mempoolAddrs = new Map();
  }

  sync() {
    return (this.pending ??= this.#sync().finally(() => (this.pending = null)));
  }

  // A sync that starts after now, for right after a broadcast.
  async syncFresh() {
    await this.pending?.catch(() => {});
    return this.sync();
  }

  async #sync() {
    const tip = await rpc('getbestblockhash');
    if (tip !== this.tipHash) await this.#syncBlocks();
    await this.#syncMempool();
  }

  async #syncBlocks() {
    const height = await rpc('getblockcount');
    const last = this.hashes.length - 1;
    if (last >= 0 && (last > height || (await rpc('getblockhash', [last])) !== this.hashes[last])) this.reset(); // a reorg: start over
    for (let from = this.hashes.length; from <= height; from += 100) {
      const heights = [];
      for (let h = from; h <= Math.min(height, from + 99); h++) heights.push(h);
      const hashes = (await rpcBatch(heights.map((h) => ['getblockhash', [h]]))).map(unwrap);
      const blocks = (await rpcBatch(hashes.map((hash) => ['getblock', [hash, 2]]))).map(unwrap);
      for (const block of blocks) this.#addBlock(block);
    }
    this.tipHash = this.hashes[this.hashes.length - 1];
  }

  #addBlock(block) {
    this.hashes[block.height] = block.hash;
    block.tx.forEach((tx, pos) => {
      this.txs.set(tx.txid, { tx, height: block.height, pos, blockhash: block.hash, blocktime: block.time });
      this.#link(tx, this.spends, this.addrs);
    });
  }

  #link(tx, spends, addrs) {
    const touch = (address) => {
      if (!address) return;
      const list = addrs.get(address) ?? addrs.set(address, []).get(address);
      if (list[list.length - 1] !== tx.txid) list.push(tx.txid);
    };
    canonicalIn(tx).forEach((v, i) => {
      if (v.coinbase !== undefined) return;
      spends.set(`${v.txid}:${v.vout}`, { txid: tx.txid, vin: i });
      touch(addressOf(this.output(v.txid, v.vout)?.scriptPubKey));
    });
    for (const o of canonicalOut(tx)) touch(addressOf(o.scriptPubKey));
  }

  async #syncMempool() {
    const entries = await rpc('getrawmempool', [true]);
    const ids = Object.keys(entries).sort();
    const key = ids.join();
    if (key === this.mempoolKey) return;
    for (const id of this.mempool.keys()) if (!entries[id]) this.mempool.delete(id);
    const missing = ids.filter((id) => !this.mempool.has(id));
    const fetched = await rpcBatch(missing.map((id) => ['getrawtransaction', [id, true]]));
    const seen = ++this.seen;
    missing.forEach((id, i) => {
      const tx = fetched[i].result;
      if (tx && !tx.blockhash) this.mempool.set(id, { tx, time: entries[id].time, seen, ancestors: entries[id].ancestorcount, mempool: true });
    });
    this.mempoolSpends = new Map();
    this.mempoolAddrs = new Map();
    for (const e of this.mempool.values()) this.#link(e.tx, this.mempoolSpends, this.mempoolAddrs);
    this.mempoolKey = key;
  }

  entry(txid) {
    return this.mempool.get(txid) ?? this.txs.get(txid);
  }

  output(txid, n) {
    const e = this.entry(txid);
    return e && canonicalOut(e.tx).find((o) => o.n === n);
  }

  status(e) {
    return e.mempool ? { confirmed: false } : { confirmed: true, block_height: e.height, block_hash: e.blockhash, block_time: e.blocktime };
  }

  #vout(o) {
    const spk = o.scriptPubKey ?? {};
    const r = { scriptpubkey: spk.hex ?? '', scriptpubkey_type: !spk.hex ? 'empty' : (TYPES[spk.type] ?? 'unknown') };
    const address = addressOf(spk);
    if (address) r.scriptpubkey_address = address;
    r.value = litoshi(o.value);
    return r;
  }

  // A transaction in Esplora's shape. Like Esplora, an input without witness data
  // has no witness field.
  esplora(e) {
    const { tx } = e;
    let fee = 0;
    const vin = canonicalIn(tx).map((v) => {
      if (v.coinbase !== undefined) {
        const r = { txid: ZERO, vout: 0xffffffff, prevout: null, scriptsig: v.coinbase };
        if (v.txinwitness?.length) r.witness = v.txinwitness;
        return Object.assign(r, { is_coinbase: true, sequence: v.sequence });
      }
      const prev = this.output(v.txid, v.vout);
      const r = { txid: v.txid, vout: v.vout, prevout: prev ? this.#vout(prev) : null, scriptsig: v.scriptSig?.hex ?? '' };
      if (v.txinwitness?.length) r.witness = v.txinwitness;
      fee += prev ? litoshi(prev.value) : 0;
      return Object.assign(r, { is_coinbase: false, sequence: v.sequence });
    });
    const vout = canonicalOut(tx).map((o) => this.#vout(o));
    const coinbase = vin.some((v) => v.is_coinbase);
    fee = coinbase ? 0 : Math.max(0, fee - vout.reduce((s, o) => s + o.value, 0));
    return { txid: tx.txid, version: tx.version, locktime: tx.locktime, vin, vout, size: tx.size, weight: tx.weight, fee, status: this.status(e) };
  }

  outspend(txid, vout) {
    const k = `${txid}:${vout}`;
    const c = this.spends.get(k);
    if (c) return { spent: true, txid: c.txid, vin: c.vin, status: this.status(this.txs.get(c.txid)) };
    const m = this.mempoolSpends.get(k);
    if (m) return { spent: true, txid: m.txid, vin: m.vin, status: { confirmed: false } };
    return { spent: false };
  }

  mempoolTxs(address) {
    // Newest first. Mempool times are whole seconds (and the clock stands still while
    // it is moved), so ties go by when this index first saw them, then children first.
    return (this.mempoolAddrs.get(address) ?? [])
      .map((id) => this.mempool.get(id))
      .sort((a, b) => b.time - a.time || b.seen - a.seen || b.ancestors - a.ancestors);
  }

  // Confirmed transactions, newest first, 25 at a time after lastSeen, as Esplora pages them.
  chainTxs(address, lastSeen) {
    const list = this.addrs.get(address) ?? [];
    let end = list.length;
    if (lastSeen) {
      end = list.lastIndexOf(lastSeen);
      if (end < 0) return [];
    }
    return list.slice(Math.max(0, end - 25), end).reverse().map((id) => this.txs.get(id));
  }

  utxos(address) {
    const out = [];
    const all = [...this.mempoolTxs(address), ...[...(this.addrs.get(address) ?? [])].reverse().map((id) => this.txs.get(id))];
    for (const e of all) {
      for (const o of canonicalOut(e.tx)) {
        if (addressOf(o.scriptPubKey) !== address) continue;
        const k = `${e.tx.txid}:${o.n}`;
        if (this.spends.has(k) || this.mempoolSpends.has(k)) continue;
        out.push({ txid: e.tx.txid, vout: o.n, status: this.status(e), value: litoshi(o.value) });
      }
    }
    return out;
  }
}

function unwrap(r) {
  if (r.error) throw new RpcError(r.error.code, r.error.message);
  return r.result;
}

// ---------------------------------------------------------------------------
// The HTTP server

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '600',
};
const TXID = /^[0-9a-fA-F]{64}$/;

async function serve() {
  const index = new Index();
  const validAddresses = new Map();

  async function checkAddress(address) {
    if (!validAddresses.has(address)) validAddresses.set(address, (await rpc('validateaddress', [address])).isvalid);
    if (!validAddresses.get(address)) throw new HttpError(400, 'Invalid Litecoin address');
    return address;
  }
  function checkTxid(txid) {
    if (!TXID.test(txid)) throw new HttpError(400, 'Invalid hex string');
    return txid.toLowerCase();
  }
  async function tx(txid) {
    await index.sync();
    const e = index.entry(checkTxid(txid));
    if (!e) throw new HttpError(404, 'Transaction not found');
    return e;
  }
  const wallet = (name) => {
    if (!WALLETS.includes(name)) throw new HttpError(404, `No wallet ${name}`);
    return name;
  };

  // [method, path pattern, handler(match, input) → body]; a string body is sent as
  // text, anything else as JSON.
  const routes = [
    ['GET', /^\/api\/blocks\/tip\/height$/, async () => String(await rpc('getblockcount'))],
    ['GET', /^\/api\/blocks\/tip\/hash$/, () => rpc('getbestblockhash')],
    [
      'GET',
      /^\/api\/block-height\/(\d+)$/,
      async ([, h]) => {
        try {
          return await rpc('getblockhash', [Number(h)]);
        } catch (e) {
          if (e.code === -8) throw new HttpError(404, 'Block not found');
          throw e;
        }
      },
    ],
    [
      'GET',
      /^\/api\/block\/([0-9a-fA-F]{64})$/,
      async ([, hash]) => {
        let b;
        try {
          b = await rpc('getblock', [hash.toLowerCase(), 1]);
        } catch (e) {
          if (e.code === -5) throw new HttpError(404, 'Block not found');
          throw e;
        }
        return {
          id: b.hash,
          height: b.height,
          version: b.version,
          timestamp: b.time,
          tx_count: b.nTx,
          size: b.size,
          weight: b.weight,
          merkle_root: b.merkleroot,
          previousblockhash: b.previousblockhash ?? null,
          mediantime: b.mediantime,
          nonce: b.nonce,
          bits: parseInt(b.bits, 16),
          difficulty: b.difficulty,
        };
      },
    ],
    ['GET', /^\/api\/tx\/(\w+)$/, async ([, id]) => index.esplora(await tx(id))],
    ['GET', /^\/api\/tx\/(\w+)\/hex$/, async ([, id]) => (await tx(id)).tx.hex],
    ['GET', /^\/api\/tx\/(\w+)\/status$/, async ([, id]) => index.status(await tx(id))],
    [
      'GET',
      /^\/api\/tx\/(\w+)\/outspend\/(\d+)$/,
      async ([, id, vout]) => {
        await index.sync();
        return index.outspend(checkTxid(id), Number(vout));
      },
    ],
    [
      'GET',
      /^\/api\/tx\/(\w+)\/outspends$/,
      async ([, id]) => {
        const e = await tx(id);
        return canonicalOut(e.tx).map((o) => index.outspend(e.tx.txid, o.n));
      },
    ],
    [
      'GET',
      /^\/api\/address\/([^/]+)\/txs$/,
      async ([, a]) => {
        const address = await checkAddress(decodeURIComponent(a));
        await index.sync();
        return [...index.mempoolTxs(address).slice(0, 50), ...index.chainTxs(address)].map((e) => index.esplora(e));
      },
    ],
    [
      'GET',
      /^\/api\/address\/([^/]+)\/txs\/chain(?:\/(\w+))?$/,
      async ([, a, last]) => {
        const address = await checkAddress(decodeURIComponent(a));
        await index.sync();
        return index.chainTxs(address, last && checkTxid(last)).map((e) => index.esplora(e));
      },
    ],
    [
      'GET',
      /^\/api\/address\/([^/]+)\/txs\/mempool$/,
      async ([, a]) => {
        const address = await checkAddress(decodeURIComponent(a));
        await index.sync();
        return index.mempoolTxs(address).slice(0, 50).map((e) => index.esplora(e));
      },
    ],
    [
      'GET',
      /^\/api\/address\/([^/]+)\/utxo$/,
      async ([, a]) => {
        const address = await checkAddress(decodeURIComponent(a));
        await index.sync();
        return index.utxos(address);
      },
    ],
    [
      'POST',
      /^\/api\/tx$/,
      async (_, { body }) => {
        let txid;
        try {
          txid = await rpc('sendrawtransaction', [body.trim()]);
        } catch (e) {
          if (!(e instanceof RpcError)) throw e;
          // Esplora's wording, with litecoind's code and reject reason inside.
          throw new HttpError(400, `sendrawtransaction RPC error: ${JSON.stringify({ code: e.code, message: e.message })}`);
        }
        await index.syncFresh().catch(() => {});
        return txid;
      },
    ],
    [
      'GET',
      /^\/api\/v1\/fees\/recommended$/,
      async () => {
        // The relay minimum, in litoshi/vB: regtest has no fee market.
        const info = await rpc('getmempoolinfo');
        const perKvB = Math.max(litoshi(info.mempoolminfee), litoshi(info.minrelaytxfee));
        const fee = Math.max(1, Math.ceil(perKvB / 1000));
        return { fastestFee: fee, halfHourFee: fee, hourFee: fee, economyFee: fee, minimumFee: fee };
      },
    ],
    ['GET', /^\/dev\/status$/, () => chainStatus()],
    ['GET', /^\/dev\/address\/(\w+)$/, async ([, w]) => ({ wallet: w, address: await newAddress(wallet(w)) })],
    ['GET', /^\/dev\/wallet\/(\w+)$/, ([, w]) => walletInfo(wallet(w))],
    [
      'POST',
      /^\/dev\/mine$/,
      async (_, { input }) => {
        const n = Number(input.n ?? 1);
        const height = await mine(n, wallet(input.to ?? 'miner'));
        return { mined: n, height };
      },
    ],
    [
      'POST',
      /^\/dev\/pay$/,
      async (_, { input }) => ({ txid: await pay(wallet(input.from ?? 'bob'), input.to, input.amount) }),
    ],
    ['POST', /^\/dev\/time$/, async (_, { input }) => moveTime(Number(input.seconds))],
    ['GET', /^\/(index\.html)?$/, () => ({ html: PAGE })],
  ];

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${HOST}:${HTTP_PORT}`);
    const path = url.pathname.replace(/(.)\/+$/, '$1');
    let status = 200;
    let type = 'text/plain; charset=utf-8';
    let out;
    try {
      if (req.method === 'OPTIONS') {
        status = 204;
        out = '';
      } else {
        let route;
        let match;
        for (const r of routes) {
          if ((match = r[1].exec(path))) {
            route = r;
            break;
          }
        }
        if (!route) throw new HttpError(404, 'Not found');
        if (route[0] !== req.method) throw new HttpError(405, 'Method not allowed');
        const body = req.method === 'POST' ? await readBody(req) : '';
        let input = Object.fromEntries(url.searchParams);
        if (path.startsWith('/dev/') && body.trim()) {
          try {
            input = { ...input, ...(body.trim().startsWith('{') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body))) };
          } catch {
            throw new HttpError(400, 'Bad request body');
          }
        }
        const result = await route[2](match, { body, input });
        if (result?.html) {
          type = 'text/html; charset=utf-8';
          out = result.html;
        } else if (typeof result === 'string') {
          out = result;
        } else {
          type = 'application/json';
          out = JSON.stringify(result);
        }
      }
    } catch (e) {
      const dev = path.startsWith('/dev/');
      status = e instanceof HttpError ? e.status : e instanceof NotRunning ? 503 : dev ? 400 : 500;
      if (dev) {
        type = 'application/json';
        out = JSON.stringify({ error: e.message });
      } else {
        out = e.message;
      }
    }
    res.writeHead(status, { ...CORS, 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(out);
    if (!(req.method === 'GET' && (path.startsWith('/dev/') || path === '/')) && req.method !== 'OPTIONS') {
      console.log(`${req.method} ${url.pathname}${url.search} ${status} ${Date.now() - started} ms${status >= 400 ? `  ${String(out).slice(0, 160)}` : ''}`);
    }
  });

  // Keep the chain's clock running while the clock is moved: setmocktime stops it.
  setInterval(() => {
    if (loadState().offset) syncClock().catch(() => {});
  }, 10_000).unref();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(HTTP_PORT, HOST, resolve);
  });
  const base = `http://${HOST}:${HTTP_PORT}`;
  console.log(`Litecoin regtest wallet   ${base}/`);
  console.log(`Esplora-style API         ${base}/api   (e.g. ${base}/api/blocks/tip/height)`);
  console.log(`Dev controls              ${base}/dev/status, POST ${base}/dev/mine, /dev/pay, /dev/time`);
  try {
    await index.sync();
    console.log(`indexed ${index.hashes.length} blocks`);
  } catch (e) {
    console.log(`not indexed yet: ${e.message}`);
  }
  console.log('Ctrl-C stops the server (litecoind keeps running).');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 4_000_000) {
        reject(new HttpError(413, 'Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// The dev wallet page

const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Litecoin regtest wallet</title>
<style>
:root { color-scheme: light dark; --bg: #f5f6f8; --card: #fff; --text: #1d2330; --muted: #5d6676; --line: #dde1e7; --accent: #2f5d9e; --on-accent: #fff; --ok: #1d7a3e; --bad: #b3261e; }
@media (prefers-color-scheme: dark) { :root { --bg: #14171c; --card: #1c2027; --text: #e7eaf0; --muted: #9ba4b3; --line: #2f353f; --accent: #8db0ea; --on-accent: #10141a; --ok: #6cc58b; --bad: #f28b82; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.35rem; margin: 6px 0 2px; }
.note { color: var(--muted); font-size: .9rem; margin: 0 0 14px; }
section { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
h2 { font-size: 1rem; margin: 0 0 10px; }
button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); cursor: pointer; }
button.primary, button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
button:disabled { opacity: .55; cursor: default; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.balance { font-size: 1.9rem; font-weight: 600; margin-top: 10px; }
.sub { color: var(--muted); font-size: .9rem; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .86rem; word-break: break-all; }
label { display: block; color: var(--muted); font-size: .9rem; margin: 10px 0 4px; }
input { width: 100%; font: inherit; padding: 9px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--text); }
.msg { margin: 10px 0 0; font-size: .9rem; word-break: break-word; }
.ok { color: var(--ok); } .bad { color: var(--bad); }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; justify-content: space-between; gap: 12px; padding: 9px 0; border-top: 1px solid var(--line); }
li:first-child { border-top: 0; }
li .amt { text-align: right; white-space: nowrap; }
a { color: var(--accent); }
dl { display: grid; grid-template-columns: auto 1fr; gap: 4px 14px; margin: 0 0 10px; }
dt { color: var(--muted); } dd { margin: 0; }
</style>
</head>
<body>
<main>
  <h1>Litecoin regtest wallet</h1>
  <p class="note">A test wallet on a Litecoin regtest chain that runs only on this computer. Its coins are not real.</p>

  <section>
    <div class="row" role="group" aria-label="Wallet">
      <button type="button" data-wallet="alice">Alice</button>
      <button type="button" data-wallet="bob">Bob</button>
    </div>
    <div class="balance" id="balance">…</div>
    <div class="sub" id="pending"></div>
  </section>

  <section>
    <h2>Receive</h2>
    <div class="mono" id="address">…</div>
    <div class="row" style="margin-top: 10px">
      <button type="button" id="copy">Copy</button>
      <button type="button" id="fresh">New address</button>
      <span class="sub" id="copied"></span>
    </div>
  </section>

  <section>
    <h2>Send</h2>
    <form id="send" autocomplete="off">
      <label for="to">To address, or paste a litecoin: link</label>
      <input id="to" spellcheck="false" placeholder="rltc1…">
      <label for="amount">Amount in LTC</label>
      <input id="amount" inputmode="decimal" placeholder="0.5">
      <div class="row" style="margin-top: 12px"><button class="primary" type="submit" id="sendButton">Send</button></div>
      <p class="msg" id="sendMsg" hidden></p>
    </form>
  </section>

  <section>
    <h2>Recent transactions</h2>
    <ul id="txs"></ul>
    <p class="sub" id="noTxs" hidden>None yet.</p>
  </section>

  <section>
    <h2>Chain</h2>
    <dl>
      <dt>Height</dt><dd id="height">…</dd>
      <dt>Tip time</dt><dd id="tiptime">…</dd>
      <dt>Median time past</dt><dd id="mediantime">…</dd>
      <dt>Clock</dt><dd id="clock">…</dd>
    </dl>
    <p class="sub">A payment confirms when a block is mined. Time locks are checked against the median time past, the median of the last 11 block times.</p>
    <div class="row">
      <button type="button" data-mine="1">Mine 1 block</button>
      <button type="button" data-mine="6">Mine 6 blocks</button>
    </div>
    <div class="row" style="margin-top: 8px">
      <button type="button" data-time="3600">Time +1 h</button>
      <button type="button" data-time="43200">Time +12 h</button>
      <button type="button" data-time="129600">Time +36 h</button>
    </div>
    <p class="msg" id="chainMsg" hidden></p>
  </section>
</main>
<script>
"use strict";
var $ = function (id) { return document.getElementById(id); };
var wallet = "bob";
try { wallet = localStorage.getItem("ltc-dev-wallet") || "bob"; } catch (e) {}
var addresses = {};

function call(method, path, body) {
  return fetch(path, {
    method: method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.json().catch(function () { return { error: res.status + " " + res.statusText }; }).then(function (data) {
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    });
  });
}
function ltc(x) {
  var s = (Math.round(Math.abs(x) * 1e8) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return (x < 0 ? "−" : "") + s + " LTC";
}
function when(t) { return new Date(t * 1000).toLocaleString(); }
function span(h) {
  var d = Math.floor(h / 24), r = h % 24;
  return (d ? d + " d" : "") + (d && r ? " " : "") + (r || !d ? r + " h" : "");
}
function show(el, text, ok) {
  el.hidden = false;
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "bad");
}

function selectWallet(w) {
  wallet = w;
  try { localStorage.setItem("ltc-dev-wallet", w); } catch (e) {}
  document.querySelectorAll("[data-wallet]").forEach(function (b) {
    b.setAttribute("aria-pressed", String(b.dataset.wallet === w));
  });
  $("balance").textContent = "…";
  $("sendMsg").hidden = true;
  if (addresses[w]) $("address").textContent = addresses[w]; else freshAddress();
  refresh();
}
function freshAddress() {
  var w = wallet;
  $("address").textContent = "…";
  $("copied").textContent = "";
  call("GET", "/dev/address/" + w).then(function (r) {
    addresses[w] = r.address;
    if (w === wallet) $("address").textContent = r.address;
  }).catch(function (e) { $("address").textContent = e.message; });
}

function refresh() {
  var w = wallet;
  call("GET", "/dev/status").then(function (s) {
    $("height").textContent = s.height;
    $("tiptime").textContent = when(s.tiptime);
    $("mediantime").textContent = when(s.mediantime);
    $("clock").textContent = s.offset ? when(s.clock) + " (real time + " + span(Math.round(s.offset / 3600)) + ")" : "Real time";
  }).catch(function (e) { $("height").textContent = e.message; });
  call("GET", "/dev/wallet/" + w).then(function (r) {
    if (w !== wallet) return;
    $("balance").textContent = ltc(r.balance);
    $("pending").textContent = r.unconfirmed ? ltc(r.unconfirmed) + " unconfirmed, on its way" : "";
    var list = $("txs");
    list.textContent = "";
    $("noTxs").hidden = r.txs.length > 0;
    r.txs.forEach(function (t) {
      var li = document.createElement("li");
      var left = document.createElement("div");
      var what = document.createElement("div");
      what.textContent = t.category === "generate" || t.category === "immature" ? "Mined" : t.amount < 0 ? "Sent" : "Received";
      var sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = when(t.time) + " · ";
      var a = document.createElement("a");
      a.href = "/api/tx/" + t.txid;
      a.className = "mono";
      a.textContent = t.txid.slice(0, 12) + "…";
      sub.appendChild(a);
      left.appendChild(what);
      left.appendChild(sub);
      var right = document.createElement("div");
      right.className = "amt";
      var amt = document.createElement("div");
      amt.textContent = (t.amount > 0 ? "+" : "") + ltc(t.amount);
      var conf = document.createElement("div");
      conf.className = "sub";
      conf.textContent = t.confirmations > 0 ? t.confirmations + (t.confirmations === 1 ? " confirmation" : " confirmations") : "unconfirmed";
      right.appendChild(amt);
      right.appendChild(conf);
      li.appendChild(left);
      li.appendChild(right);
      list.appendChild(li);
    });
  }).catch(function (e) { $("balance").textContent = e.message; });
}

// A litecoin: link (litecoin:address?amount=…) fills both fields.
function readUri() {
  var m = /^litecoin:(?:\/\/)?([^?]+)(?:\?(.*))?$/i.exec($("to").value.trim());
  if (!m) return;
  $("to").value = m[1];
  var amount = new URLSearchParams(m[2] || "").get("amount");
  if (amount) $("amount").value = amount;
}
$("to").addEventListener("input", function (ev) { if (!/^(insertText|delete)/.test(ev.inputType || "")) readUri(); });
$("to").addEventListener("change", readUri);

$("send").addEventListener("submit", function (ev) {
  ev.preventDefault();
  readUri();
  var to = $("to").value.trim(), amount = $("amount").value.trim().replace(",", ".");
  var msg = $("sendMsg");
  if (!to) return show(msg, "Enter an address.", false);
  if (!/^\d+(\.\d{1,8})?$/.test(amount) || Number(amount) <= 0) return show(msg, "Enter an amount in LTC, like 0.5.", false);
  $("sendButton").disabled = true;
  call("POST", "/dev/pay", { from: wallet, to: to, amount: amount }).then(function (r) {
    show(msg, "Sent " + ltc(Number(amount)) + ". Transaction " + r.txid + ". It confirms when the next block is mined.", true);
    $("to").value = "";
    $("amount").value = "";
    refresh();
  }).catch(function (e) { show(msg, e.message, false); })
    .then(function () { $("sendButton").disabled = false; });
});

// The clipboard API where it is allowed, else select the address and copy that.
function copySelected() {
  var range = document.createRange();
  range.selectNodeContents($("address"));
  var sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  var ok = false;
  try { ok = document.execCommand("copy"); } catch (e) {}
  $("copied").textContent = ok ? "Copied" : "Selected: copy it";
}
$("copy").addEventListener("click", function () {
  if (!navigator.clipboard || !window.isSecureContext) return copySelected();
  navigator.clipboard.writeText($("address").textContent)
    .then(function () { $("copied").textContent = "Copied"; }, copySelected);
});
$("fresh").addEventListener("click", freshAddress);

function chainAction(button, path, body, describe) {
  var buttons = document.querySelectorAll("[data-mine], [data-time]");
  buttons.forEach(function (b) { b.disabled = true; });
  call("POST", path, body).then(function (r) { show($("chainMsg"), describe(r), true); refresh(); })
    .catch(function (e) { show($("chainMsg"), e.message, false); })
    .then(function () { buttons.forEach(function (b) { b.disabled = false; }); });
}
document.querySelectorAll("[data-mine]").forEach(function (b) {
  b.addEventListener("click", function () {
    var n = Number(b.dataset.mine);
    chainAction(b, "/dev/mine", { n: n }, function (r) {
      return "Mined " + n + (n === 1 ? " block" : " blocks") + ". Height " + r.height + ".";
    });
  });
});
document.querySelectorAll("[data-time]").forEach(function (b) {
  b.addEventListener("click", function () {
    var s = Number(b.dataset.time);
    chainAction(b, "/dev/time", { seconds: s }, function (r) {
      return "Moved the clock " + span(s / 3600) + " ahead and mined " + r.mined + " blocks. Median time past: " + when(r.mediantime) + ".";
    });
  });
});
document.querySelectorAll("[data-wallet]").forEach(function (b) {
  b.addEventListener("click", function () { selectWallet(b.dataset.wallet); });
});

selectWallet(wallet === "alice" ? "alice" : "bob");
setInterval(function () { if (!document.hidden) refresh(); }, 4000);
</script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// Commands

const ltc = (x) => `${Number(x).toFixed(8)} LTC`;
const time = (t) => `${new Date(t * 1000).toISOString().replace('.000Z', 'Z').replace('T', ' ')} (${t})`;
function duration(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s % 60 && `${s % 60}s`].filter(Boolean).join(' ') || '0s';
}

function printStatus(s) {
  console.log(`height            ${s.height}`);
  console.log(`tip time          ${time(s.tiptime)}`);
  console.log(`median time past  ${time(s.mediantime)}`);
  console.log(`clock             ${s.offset ? `${time(s.clock)}, real time + ${duration(s.offset)}` : 'real time'}`);
  for (const [name, b] of Object.entries(s.wallets)) {
    if (!b) {
      console.log(`${name.padEnd(17)} (not loaded)`);
      continue;
    }
    const extra = [b.unconfirmed && `${ltc(b.unconfirmed)} unconfirmed`, b.immature && `${ltc(b.immature)} immature`].filter(Boolean);
    console.log(`${name.padEnd(17)} ${ltc(b.balance)}${extra.length ? `  (+ ${extra.join(', ')})` : ''}`);
  }
}

async function start() {
  if (!existsSync(LITECOIND)) throw new Error(`no litecoind at ${LITECOIND}`);
  writeConfig();
  const running = pid();
  if (running) {
    console.log(`litecoind is running (pid ${running})`);
  } else {
    const args = [`-datadir=${DATADIR}`, '-daemon'];
    const { offset = 0 } = loadState();
    if (offset) args.push(`-mocktime=${now() + offset}`);
    execFileSync(LITECOIND, args, { stdio: 'inherit' }); // prints "Litecoin Core starting"
  }
  await waitForRpc();
  await syncClock();

  const onDisk = (await rpc('listwalletdir')).wallets.map((w) => w.name);
  const loaded = await rpc('listwallets');
  for (const name of WALLETS) {
    if (loaded.includes(name)) continue;
    if (onDisk.includes(name)) {
      await rpc('loadwallet', [name, true]);
    } else {
      // A legacy (non-descriptor) wallet, loaded again on every start.
      await rpc('createwallet', [name, false, false, '', false, false, true]);
      console.log(`created wallet ${name}`);
    }
  }

  const height = await rpc('getblockcount');
  if (height < SETUP_HEIGHT) {
    console.log(`mining ${SETUP_HEIGHT - height} blocks to the miner (past every soft fork and MWEB)`);
    await mine(SETUP_HEIGHT - height, 'miner');
  }
  if (!(await rpc('listtransactions', ['*', 1], 'bob')).length) {
    const txid = await rpc('sendtoaddress', [await newAddress('bob'), 10], 'miner');
    await mine(1, 'miner');
    console.log(`gave bob 10 LTC in ${txid}`);
  }
  printStatus(await chainStatus());
}

async function stop() {
  const p = pid();
  if (!p) {
    console.log('litecoind is not running');
    return;
  }
  try {
    await rpc('stop');
  } catch {
    process.kill(p, 'SIGTERM');
  }
  for (let i = 0; i < 480; i++) {
    try {
      process.kill(p, 0);
    } catch {
      console.log('litecoind stopped');
      return;
    }
    await sleep(250);
  }
  throw new Error(`litecoind (pid ${p}) did not stop within 120 s`);
}

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : fallback;
};
const to = option('to', 'miner');
const from = option('from', 'bob');
const [command, ...rest] = args;

const commands = {
  start,
  stop,
  serve,
  status: async () => printStatus(await chainStatus()),
  mine: async (n = '1') => {
    const height = await mine(Number(n), to);
    console.log(`mined ${n} to ${to}; height ${height}`);
  },
  pay: async (address, amount) => console.log(await pay(from, address, amount)),
  address: async (wallet) => console.log(await newAddress(wallet ?? '')),
  time: async (text = '') => {
    const m = /^\+?(\d+)([smhd]?)$/.exec(text.trim());
    if (!m) throw new Error('time +seconds (or +90m, +12h, +2d)');
    const seconds = Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
    const s = await moveTime(seconds);
    console.log(`clock moved ${duration(seconds)}; mined ${s.mined} blocks`);
    printStatus(s);
  },
};

if (!commands[command]) {
  const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
  console.log(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(command ? 1 : 0);
}
try {
  await commands[command](...rest);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
