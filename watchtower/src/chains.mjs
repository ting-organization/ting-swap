// Reading Ting the way the page does (HTLC.md, "Reading"), and sending the
// program's own refund input on Ting. Litecoin, read and sent to through the
// same explorers as the page, is web/js/explorer.js's.
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

export { hex };
