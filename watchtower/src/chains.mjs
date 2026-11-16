// Reading Ting and Litecoin, the way the page does (HTLC.md, "Reading"), and
// sending what the watchtower sends: the program's own refund input on Ting,
// and finished claims on Litecoin.
import { hex, Reader, unhex } from '../../web/js/bytes.js';
import * as H from '../../web/js/htlc.js';
import { Node, NodeError } from '../../web/js/ting.js';

/** The program's events of this many blocks below the tip are read again every round, so that what a reorganization dropped is dropped here too. */
const REORG_WINDOW = 100;

const int = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : 0);
const hexId = (v) => (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null);

export class Ting {
  constructor({ node, program }) {
    this.node = new Node(node);
    this.program = program;
    this.events = [];
    this.from = 1;
    this.tip = null;
  }

  /** The tip: its height, and its block's timestamp, which claims and refunds go by. */
  async readTip() {
    const status = await this.node.status();
    const height = int(status.height);
    const block = await this.node.block(height);
    this.tip = { height, time: int(block?.timestamp), chainId: status.chain_id };
    return this.tip;
  }

  /** Reads the program's events since the last read, and again those of the last REORG_WINDOW blocks, in place of what was read of them before. */
  async readEvents() {
    const start = Math.max(1, Math.min(this.from, (this.tip?.height ?? 0) - REORG_WINDOW));
    const fresh = [];
    let from = start;
    for (;;) {
      const page = await this.node.events(this.program, H.TOPIC, from, 100);
      for (const block of page.items ?? []) {
        for (const e of block.events ?? []) {
          try {
            const r = new Reader(unhex(e.payload_hex));
            r.take(32);
            fresh.push({ ...H.decodeEvent(r), height: int(block.height), time: int(block.timestamp), tx: hexId(e.transaction) });
          } catch { /* not one the watchtower reads */ }
        }
      }
      const next = int(page.next);
      if (!page.items?.length || next > int(page.height) || next <= from) {
        this.from = Math.max(from, next || from);
        break;
      }
      from = next;
    }
    this.events = [...this.events.filter((e) => e.height < start), ...fresh];
    return this.events;
  }

  /** The lock record of a listing, or null once a claim or a refund ended it. */
  async lock(id) {
    return H.decodeLock(id, await this.node.record(this.program, H.lockKey(id)));
  }

  /** Sends one of the program's own inputs: no signature, no fee of its own. Its transaction id. */
  async sendOwn(input) {
    return hexId(await this.node.submit(H.ownCall(this.program, input)));
  }

  /** Where a transaction sent stands: done, failed, pending or missing. */
  async txState(id) {
    try {
      const answer = await this.node.transaction(id);
      const seen = answer.occurrences?.[0];
      if (seen) return seen.receipt?.status === 0 ? 'done' : 'failed';
      return 'pending';
    } catch (e) {
      if (e instanceof NodeError && e.status === 404) return 'missing';
      throw e;
    }
  }
}

export class ExplorerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** The part of an Esplora API the watchtower reads: litecoinspace.org, or scripts/ltc-dev.mjs on regtest. */
export class Litecoin {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
  }

  async request(path, { body, text = false } = {}) {
    let response;
    try {
      response = await fetch(this.base + path, body === undefined ? {} : { method: 'POST', body });
    } catch {
      throw new ExplorerError(`cannot reach ${this.base}`, 0);
    }
    const answer = await response.text();
    if (!response.ok) throw new ExplorerError(answer.slice(0, 300) || `${response.status} from the explorer`, response.status);
    if (text) return answer.trim();
    try {
      return JSON.parse(answer);
    } catch {
      throw new ExplorerError('the explorer answered something that is not JSON', response.status);
    }
  }

  /** The tip: its height and median time past, which T1 goes by. */
  async tip() {
    const hash = hexId(await this.request('/blocks/tip/hash', { text: true }));
    if (!hash) throw new ExplorerError('the explorer named no tip', 0);
    const block = await this.request(`/block/${hash}`);
    return { height: int(block?.height), mtp: int(block?.mediantime) };
  }

  /** One output: missing, or its value and script, whether its transaction is in a block, and whether it is spent and by what. */
  async out(txid, vout) {
    let tx;
    try {
      tx = await this.request(`/tx/${txid}`);
    } catch (e) {
      if (e.status === 404 || e.status === 400) return { missing: true };
      throw e;
    }
    const o = Array.isArray(tx?.vout) ? tx.vout[vout] : null;
    const value = int(o?.value);
    if (!o || value <= 0 || typeof o.scriptpubkey !== 'string') return { missing: true };
    const spend = await this.request(`/tx/${txid}/outspend/${vout}`);
    return {
      value, script: o.scriptpubkey.toLowerCase(), confirmed: tx.status?.confirmed === true, height: int(tx.status?.block_height),
      spent: spend?.spent === true, spender: hexId(spend?.txid), spenderConfirmed: spend?.status?.confirmed === true,
    };
  }

  /** A transaction's status: whether the explorer knows it, and whether it is in a block. */
  async txStatus(txid) {
    try {
      const s = await this.request(`/tx/${txid}/status`);
      return { found: true, confirmed: s?.confirmed === true };
    } catch (e) {
      if (e.status === 404 || e.status === 400) return { found: false, confirmed: false };
      throw e;
    }
  }

  /** Sends a transaction; one the chain already has counts as sent. Throws otherwise, `refused` when Litecoin turned it down. */
  async broadcast(txHex) {
    try {
      return await this.request('/tx', { body: txHex, text: true });
    } catch (e) {
      if (/already in (the )?(block ?chain|mempool)|txn-already-known|already known/i.test(e.message)) return null;
      throw Object.assign(new Error(e.message), { refused: e.status === 400 });
    }
  }

  /** LTC's price in USD, or null. */
  async usd() {
    try {
      const answer = await this.request('/v1/prices');
      const usd = Number(answer?.USD);
      return Number.isFinite(usd) && usd > 0 ? usd : null;
    } catch {
      return null;
    }
  }
}

export { hex };
