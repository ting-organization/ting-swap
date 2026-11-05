// What every Ting client needs: the domain-separated hash, accounts,
// transaction envelopes, and a node's REST API (Ting wiki: data/encoding,
// programs/conventions, data/blocks, start/explore).
import { concat, framed, hex, u16, unhex, utf8, Writer } from './bytes.js';
import { sha256 } from './sha256.js';

/** The bytes SHA-256 reads before `x` in `H(tag, x)`. */
export function hashPrefix(tag) {
  const t = utf8(tag);
  return concat(utf8('Ting/'), u16(t.length), t);
}

/** `H(tag, x) = SHA256("Ting/" ‖ u16(len(tag)) ‖ tag ‖ x)`, `x` the parts joined. */
export const H = (tag, ...parts) => sha256(concat(hashPrefix(tag), ...parts));

export const policyAccount = (policy, params) => H('app/account-v1/policy', policy, framed(params));
export const contractAccount = (owner) => H('app/account-v1/contract', owner);

/** A Call transaction: `01 ‖ 00 ‖ budget ‖ target ‖ Bytes(input)`. */
export function encodeCall(target, input, budget) {
  const w = new Writer().u8(1).u8(0);
  for (const n of budget) w.u64(n);
  return w.put(target).bytes(input).finish();
}

/** A Deploy transaction: `01 ‖ 01 ‖ budget ‖ Bytes(code) ‖ Bytes(input)`. */
export function encodeDeploy(code, input, budget) {
  const w = new Writer().u8(1).u8(1);
  for (const n of budget) w.u64(n);
  return w.bytes(code).bytes(input).finish();
}

export const transactionId = (chain, tx) => H('transaction', chain, tx);

/** The ContractId a top-level deployment creates (Ting wiki: data/records). */
export const deployedId = (chain, tx) => H('contract', chain, transactionId(chain, tx), new Uint8Array(8));

/** A failure a node reports, with its HTTP status. */
export class NodeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Node {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
  }

  async request(path, body) {
    let response;
    try {
      response = await fetch(this.base + path, body === undefined
        ? { cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      throw new NodeError(`cannot reach ${this.base}`, 0);
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw new NodeError(json?.error ?? `${response.status} from the node`, response.status);
    return json;
  }

  status() {
    return this.request('/v1/status');
  }

  block(heightOrId) {
    return this.request(`/v1/blocks/${heightOrId}`);
  }

  contract(id) {
    return this.request(`/v1/contracts/${hex(id)}`);
  }

  /** Records read together from one state: each value as bytes, or null when absent. */
  async storage(reads) {
    const values = [];
    for (let i = 0; i < reads.length; i += 1024) {
      const part = reads.slice(i, i + 1024);
      const answer = await this.request('/v1/storage', {
        reads: part.map(([contract, key]) => ({ contract: hex(contract), key: hex(key) })),
      });
      for (const v of answer.values) values.push(v.value_hex == null ? null : unhex(v.value_hex));
    }
    return values;
  }

  async record(contract, key) {
    return (await this.storage([[contract, key]]))[0];
  }

  /** Submits a canonical transaction; its id. */
  async submit(tx) {
    const answer = await this.request('/v1/transactions', { hex: hex(tx) });
    return answer.id;
  }

  /** A transaction's status and a page of its occurrences, from the `from`-th. */
  transaction(id, from = 0) {
    return this.request(`/v1/transactions/${typeof id === 'string' ? id : hex(id)}?from=${from}`);
  }

  /** The transactions waiting in the node's pool for a block: ids, sizes and budgets. */
  mempool() {
    return this.request('/v1/mempool');
  }

  /** How many times blocks of the canonical chain include a transaction. */
  async occurrences(id) {
    let from = 0;
    for (;;) {
      const page = await this.transaction(id, from).catch(() => null);
      if (!page) return from;
      from += page.occurrences.length;
      if (!page.has_more) return from;
    }
  }

  /** One page of a program's events, of one topic if given. */
  events(contract, topic, from = 1, limit = 100) {
    const t = topic ? `&topic=${hex(topic)}` : '';
    return this.request(`/v1/events?contract=${hex(contract)}${t}&from=${from}&limit=${limit}`);
  }
}

/** The bytes of a 32-byte id written in hex, or null. */
export function idOf(text) {
  try {
    const id = unhex(String(text ?? '').trim().toLowerCase());
    return id.length === 32 ? id : null;
  } catch {
    return null;
  }
}

