// Reading Litecoin and sending to it through public explorers, for the page
// and the watchtower alike (HTLC.md, "Reading"). The first explorer named is
// asked first; while it cannot be reached, the next in line, and so on. Every
// explorer answers in the same shapes here, whatever its own API:
//
// - 'esplora': litecoinspace.org's API, or scripts/ltc-dev.mjs on regtest.
// - 'blockbook': Trezor's indexer, as wallets run it.
// - 'blockcypher': api.blockcypher.com, which answers anyone about 100
//   requests an hour, so it is asked within a budget and only as a last resort.
//
// Only an answer that says the explorer cannot answer now (unreachable, a
// server error, too many requests, out of sync) passes the question on. "No
// such transaction" is an answer, and is not asked again elsewhere. Only the
// first explorer is `trusted`: the seller's page accepts a lock, and gives up
// on one, only on its word, so that a backup widens nothing a trade relies on.

const int = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : 0);
const hexId = (v) => (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Each request waits at most this long. */
const TIMEOUT = 15_000;
/** A request the explorer could not answer is tried this many times more, after these pauses. */
const RETRY_PAUSES = [300, 900];
/** An explorer whose calls failed this many times in a row rests: REST at first, twice as long each time after, MAX_REST at most. */
const FAILURES_TO_REST = 2;
const REST = 30_000;
const MAX_REST = 600_000;
/** A Blockbook's sync is checked again after this long. */
const SYNC_AGAIN = 60_000;
/** A Blockbook more than this many blocks behind its own node counts as out of sync. */
const SYNC_SLACK = 1;

export class ExplorerError extends Error {
  /** `down` when the explorer cannot answer now, so that the next one is asked. */
  constructor(message, status = 0, down = false) {
    super(message);
    this.status = status;
    this.down = down;
  }
}

/** Whether an error says only that its explorer cannot answer now: anything but a plain 400 or 404. */
export const isDown = (e) => e instanceof ExplorerError && (e.down || ![400, 404].includes(e.status));

/** What is common to every explorer: requests with retries, a rest after failures, and a budget. */
class Backend {
  constructor({ base, name, trusted = false, perHour = 0, gap = 0, pauses = RETRY_PAUSES }) {
    this.base = base.replace(/\/+$/, '');
    this.name = name ?? new URL(this.base).host;
    this.trusted = trusted;
    this.pauses = pauses;
    /** At most this many requests an hour, and this many ms between two; 0 for no limit. */
    this.perHour = perHour;
    this.gap = gap;
    this.sent = [];
    this.nextAt = 0;
    this.failures = 0;
    this.restUntil = 0;
    this.lastError = null;
  }

  /** Whether to ask this explorer now: not resting, and with budget left. */
  ready(t = Date.now()) {
    if (t < this.restUntil) return false;
    if (!this.perHour) return true;
    this.sent = this.sent.filter((s) => t - s < 3_600_000);
    return this.sent.length < this.perHour;
  }

  /** Why this explorer is not asked now, in words. */
  why() {
    if (Date.now() < this.restUntil) return `${this.name} rests after failing${this.lastError ? ` (${this.lastError.message})` : ''}`;
    return `${this.name}: its hourly budget is spent`;
  }

  succeeded() {
    this.failures = 0;
    this.restUntil = 0;
  }

  failed(e) {
    this.failures++;
    this.lastError = e;
    const retryAfter = Number(e.retryAfter) * 1000;
    if (e.status === 429) this.restUntil = Date.now() + Math.min(MAX_REST, retryAfter > 0 ? retryAfter : REST * 4);
    else if (this.failures >= FAILURES_TO_REST) this.restUntil = Date.now() + Math.min(MAX_REST, REST * 2 ** (this.failures - FAILURES_TO_REST));
  }

  /** One request, tried again while the explorer cannot answer it. Text, or parsed JSON; a POST when `body` is given. */
  async request(path, { body, text = false } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(path, { body, text });
      } catch (e) {
        if (!isDown(e) || e.status === 429 || attempt >= this.pauses.length) throw e;
        await sleep(this.pauses[attempt]);
      }
    }
  }

  async once(path, { body, text }) {
    if (this.perHour) {
      if (!this.ready()) throw new ExplorerError(`${this.name}: its hourly budget is spent`, 429);
      this.sent.push(Date.now());
    }
    if (this.gap) {
      const wait = this.nextAt - Date.now();
      this.nextAt = Math.max(Date.now(), this.nextAt) + this.gap;
      if (wait > 0) await sleep(wait);
    }
    const init = { cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT) };
    let response;
    try {
      // A plain-text body asks for no CORS preflight, which some explorers refuse.
      response = await fetch(this.base + path, body === undefined ? init : { ...init, method: 'POST', body, headers: { 'content-type': 'text/plain' } });
    } catch {
      throw new ExplorerError(`cannot reach ${this.name}`, 0, true);
    }
    const answer = await response.text().catch(() => '');
    if (!response.ok) {
      // A proxy's error page says nothing worth showing but its status; a JSON error, its words.
      let words = /^\s*</.test(answer) || /^error code: \d+/.test(answer) ? '' : answer.trim().slice(0, 300);
      try {
        const j = JSON.parse(answer);
        const said = typeof j?.error === 'string' ? j.error : j?.error?.message ?? j?.message;
        if (typeof said === 'string' && said) words = said.slice(0, 300);
      } catch { /* not JSON: as it is */ }
      const e = new ExplorerError(words || `${this.name} answered ${response.status}`, response.status);
      e.retryAfter = response.headers.get('retry-after');
      throw e;
    }
    if (text) return answer.trim();
    try {
      return JSON.parse(answer);
    } catch {
      throw new ExplorerError(`${this.name} answered something that is not JSON`, response.status, true);
    }
  }
}

/** Not found: a 400 or a 404. Anything else is thrown on. */
const notFound = (e) => e instanceof ExplorerError && !isDown(e);

/** The part of an Esplora API the page reads: litecoinspace.org, or scripts/ltc-dev.mjs. */
class Esplora extends Backend {
  async tip() {
    const hash = hexId(await this.request('/blocks/tip/hash', { text: true }));
    if (!hash) throw new ExplorerError(`${this.name} named no tip`, 0, true);
    if (this.tipKept?.hash !== hash) {
      const b = await this.request(`/block/${hash}`);
      this.tipKept = { height: int(b?.height), hash, time: int(b?.timestamp), mtp: int(b?.mediantime) || null };
    }
    return { ...this.tipKept };
  }

  async out(txid, vout, known) {
    let base = known;
    if (!base) {
      let tx;
      try {
        tx = await this.request(`/tx/${txid}`);
      } catch (e) {
        if (notFound(e)) return { missing: true };
        throw e;
      }
      const o = Array.isArray(tx?.vout) ? tx.vout[vout] : null;
      if (!o || int(o.value) <= 0 || typeof o.scriptpubkey !== 'string') return { missing: true };
      base = { value: int(o.value), script: o.scriptpubkey.toLowerCase(), confirmed: tx.status?.confirmed === true, height: int(tx.status?.block_height) };
    }
    const s = await this.request(`/tx/${txid}/outspend/${vout}`);
    return {
      ...base, spent: s?.spent === true, spender: hexId(s?.txid), spenderConfirmed: s?.status?.confirmed === true, spenderHeight: int(s?.status?.block_height),
    };
  }

  async txStatus(txid) {
    try {
      const s = await this.request(`/tx/${txid}/status`);
      return { found: true, confirmed: s?.confirmed === true, height: int(s?.block_height) };
    } catch (e) {
      if (notFound(e)) return { found: false, confirmed: false, height: 0 };
      throw e;
    }
  }

  async utxos(address) {
    const list = await this.request(`/address/${encodeURIComponent(address)}/utxo`);
    return (Array.isArray(list) ? list : []).map((u) => ({
      txid: hexId(u?.txid), vout: int(u?.vout), value: int(u?.value), confirmed: u?.status?.confirmed === true, height: int(u?.status?.block_height),
    }));
  }

  async used(address) {
    const txs = await this.request(`/address/${encodeURIComponent(address)}/txs`);
    return Array.isArray(txs) && txs.length > 0;
  }

  async feeRate() {
    const fastest = Number((await this.request('/v1/fees/recommended'))?.fastestFee);
    return Number.isFinite(fastest) && fastest > 0 ? fastest : null;
  }

  broadcast(txHex) {
    return this.request('/tx', { body: txHex, text: true });
  }
}

/** Trezor's Blockbook, at its `/api`. It knows no median time past: that comes from the last eleven blocks' times, read once each. */
class Blockbook extends Backend {
  /** Throws, as down, unless the indexer is in step with its node. Its status, checked again after SYNC_AGAIN. */
  async synced(fresh = false) {
    if (!fresh && this.syncedAt && Date.now() - this.syncedAt < SYNC_AGAIN) return this.status;
    const s = await this.request('/');
    const height = int(s?.blockbook?.bestHeight);
    if (s?.blockbook?.inSync !== true || !height || int(s?.backend?.blocks) - height > SYNC_SLACK) {
      this.syncedAt = 0;
      throw new ExplorerError(`${this.name} is not in step with Litecoin`, 0, true);
    }
    this.syncedAt = Date.now();
    this.status = { height };
    return this.status;
  }

  async block(height) {
    const b = await this.request(`/v2/block/${height}?pageSize=1`);
    return { hash: hexId(b?.hash), prev: hexId(b?.previousBlockHash), time: int(b?.time) };
  }

  async tip() {
    const { height } = await this.synced(true);
    if (this.tipKept?.height !== height) {
      const top = await this.block(height);
      if (!top.hash) throw new ExplorerError(`${this.name} named no tip`, 0, true);
      const chain = [top];
      for (let h = height - 1; h > height - 11 && h >= 0; h--) {
        const kept = this.blocks?.get(h);
        chain.push(kept && kept.hash === chain.at(-1).prev ? kept : await this.block(h));
      }
      this.blocks = new Map(chain.map((b, i) => [height - i, b]));
      const times = chain.map((b) => b.time).sort((a, b) => a - b);
      this.tipKept = { height, hash: top.hash, time: top.time, mtp: times.length === 11 ? times[5] : null };
    }
    return { ...this.tipKept };
  }

  async tx(txid) {
    await this.synced();
    try {
      return await this.request(`/v2/tx/${txid}?spending=true`);
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }

  async out(txid, vout) {
    const tx = await this.tx(txid);
    const o = Array.isArray(tx?.vout) ? tx.vout.find((x) => int(x?.n) === vout) : null;
    if (!o || int(o.value) <= 0 || typeof o.hex !== 'string') return { missing: true };
    const height = Math.max(0, int(tx.blockHeight));
    const spenderHeight = o.spent === true ? Math.max(0, int(o.spentHeight)) : 0;
    return {
      value: int(o.value), script: o.hex.toLowerCase(), confirmed: height > 0, height,
      spent: o.spent === true, spender: o.spent === true ? hexId(o.spentTxId) : null, spenderConfirmed: spenderHeight > 0, spenderHeight,
    };
  }

  async txStatus(txid) {
    const tx = await this.tx(txid);
    const height = Math.max(0, int(tx?.blockHeight));
    return tx ? { found: true, confirmed: height > 0, height } : { found: false, confirmed: false, height: 0 };
  }

  async utxos(address) {
    await this.synced();
    const list = await this.request(`/v2/utxo/${encodeURIComponent(address)}`);
    return (Array.isArray(list) ? list : []).map((u) => ({
      txid: hexId(u?.txid), vout: int(u?.vout), value: int(u?.value), confirmed: int(u?.height) > 0, height: Math.max(0, int(u?.height)),
    }));
  }

  async used(address) {
    await this.synced();
    const a = await this.request(`/v2/address/${encodeURIComponent(address)}?details=basic`);
    return int(a?.txs) + int(a?.unconfirmedTxs) > 0;
  }

  async feeRate() {
    // LTC per kB.
    const perKb = Number((await this.request('/v2/estimatefee/2'))?.result);
    return Number.isFinite(perKb) && perKb > 0 ? (perKb * 1e8) / 1000 : null;
  }

  async broadcast(txHex) {
    const answer = await this.request('/v2/sendtx/', { body: txHex });
    return hexId(answer?.result) ?? '';
  }
}

/**
 * api.blockcypher.com's Litecoin API, at `/v1/ltc/main`. It knows no median
 * time past: its tip has none, and the caller keeps the last one it read.
 */
class Blockcypher extends Backend {
  /** One transaction, without its inputs and with only output `vout`; null when there is none. */
  async tx(txid, vout = 1e6) {
    try {
      return await this.request(`/txs/${txid}?instart=1000000&outstart=${vout}&limit=1`);
    } catch (e) {
      if (notFound(e)) return null;
      throw e;
    }
  }

  async tip() {
    const c = await this.request('');
    const height = int(c?.height);
    const hash = hexId(c?.hash);
    if (!height || !hash) throw new ExplorerError(`${this.name} named no tip`, 0, true);
    this.fee = int(c.high_fee_per_kb) / 1000 || null;
    return { height, hash, time: Math.floor(Date.parse(c.time) / 1000) || 0, mtp: null };
  }

  async out(txid, vout) {
    const tx = await this.tx(txid, vout);
    const o = tx?.outputs?.[0];
    if (!o || int(tx.vout_sz) <= vout || int(o.value) <= 0 || typeof o.script !== 'string') return { missing: true };
    const height = Math.max(0, int(tx.block_height));
    const spender = hexId(o.spent_by);
    const by = spender ? await this.tx(spender) : null;
    const spenderHeight = Math.max(0, int(by?.block_height));
    return {
      value: int(o.value), script: o.script.toLowerCase(), confirmed: height > 0, height,
      spent: Boolean(spender), spender, spenderConfirmed: spenderHeight > 0, spenderHeight,
    };
  }

  async txStatus(txid) {
    const tx = await this.tx(txid);
    const height = Math.max(0, int(tx?.block_height));
    return tx ? { found: true, confirmed: height > 0, height } : { found: false, confirmed: false, height: 0 };
  }

  async utxos(address) {
    const a = await this.request(`/addrs/${encodeURIComponent(address)}?unspentOnly=true&includeScript=false&limit=200`);
    return [...(a?.txrefs ?? []), ...(a?.unconfirmed_txrefs ?? [])]
      .filter((r) => Number.isInteger(r?.tx_output_n) && r.tx_output_n >= 0 && r.spent !== true)
      .map((r) => ({ txid: hexId(r.tx_hash), vout: int(r.tx_output_n), value: int(r.value), confirmed: int(r.block_height) > 0, height: Math.max(0, int(r.block_height)) }));
  }

  async used(address) {
    const a = await this.request(`/addrs/${encodeURIComponent(address)}?limit=1`);
    return int(a?.final_n_tx) + int(a?.n_tx) + int(a?.unconfirmed_n_tx) > 0;
  }

  async feeRate() {
    if (!this.fee) await this.tip();
    return this.fee;
  }

  async broadcast(txHex) {
    const answer = await this.request('/txs/push', { body: JSON.stringify({ tx: txHex }) });
    return hexId(answer?.tx?.hash) ?? '';
  }
}

const KINDS = { esplora: Esplora, blockbook: Blockbook, blockcypher: Blockcypher };

/**
 * Litecoin through a line of explorers, `[{ kind, base, trusted?, perHour?, gap? }]`,
 * the first asked first. Every call goes to the first explorer that is not
 * resting and has budget left, then down the line while each cannot answer.
 */
export class Explorer {
  constructor(list) {
    if (!list.length) throw new Error('no Litecoin explorer named');
    this.backends = list.map((b) => {
      const Kind = KINDS[b.kind];
      if (!Kind) throw new Error(`no Litecoin explorer of kind ${b.kind}`);
      return new Kind(b);
    });
    /** The explorer that answered last. */
    this.last = this.backends[0];
  }

  get primary() { return this.backends[0]; }
  get base() { return this.primary.base; }
  get names() { return this.backends.map((b) => b.name); }
  /** Whether the first explorer is resting after failing, so that reads go down the line. */
  get resting() { return !this.primary.ready(); }

  async call(method, ...args) {
    return (await this.ask(method, ...args)).answer;
  }

  /** The answer, and the explorer that gave it. */
  async ask(method, ...args) {
    let error = null;
    for (const b of this.backends) {
      if (!b.ready()) continue;
      try {
        const answer = await b[method](...args);
        b.succeeded();
        this.last = b;
        return { answer, via: b };
      } catch (e) {
        if (!isDown(e)) throw e;
        b.failed(e);
        error ??= e;
      }
    }
    if (error) throw error;
    throw new ExplorerError(`no Litecoin explorer can be asked just now: ${this.backends.map((b) => b.why()).join('; ')}`, 0, true);
  }

  /** The tip: `{ height, hash, time, mtp }`, `mtp` null from an explorer that cannot tell it. */
  tip() { return this.call('tip'); }

  /**
   * One output: `{ missing }`, or its value and script, its block, and whether
   * it is spent and by what, with `trusted` saying whether the first explorer
   * said so. `known`, an earlier answer whose transaction is buried deep
   * enough not to change, spares reading the transaction again.
   */
  async out(txid, vout, known) {
    const reuse = known && !known.missing && known.confirmed ? { value: known.value, script: known.script, confirmed: true, height: known.height } : undefined;
    // An explorer that cannot spare the transaction's read reads it whole.
    const { answer, via } = await this.ask('out', txid, vout, reuse);
    return { ...answer, trusted: via.trusted && (!reuse || via.constructor !== Esplora || known.trusted !== false) };
  }

  /** `{ found, confirmed, height }`. */
  txStatus(txid) { return this.call('txStatus', txid); }
  /** The unspent outputs at an address: `[{ txid, vout, value, confirmed, height }]`. */
  utxos(address) { return this.call('utxos', address); }
  /** Whether any transaction ever paid or spent at an address. */
  used(address) { return this.call('used', address); }
  /** The explorer's fastest rate in litoshi per vbyte, or null. */
  feeRate() { return this.call('feeRate'); }

  /**
   * Sends a transaction; one the chain already has counts as sent (null).
   * Throws otherwise, with `refused` when Litecoin itself turned it down, not
   * when no explorer could be reached.
   */
  async broadcast(txHex) {
    try {
      return await this.call('broadcast', txHex);
    } catch (e) {
      if (/already in (the )?(block ?chain|mempool)|txn-already-known|already known|already have transaction/i.test(e.message)) return null;
      throw Object.assign(new Error(e.message), { refused: !isDown(e) });
    }
  }
}
