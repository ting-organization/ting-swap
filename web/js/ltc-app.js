// Ting Swap for Litecoin, the page (HTLC.md, "The page"): DLR on Ting for LTC
// on Litecoin, with nobody sending first. It reads Ting through one node and
// Litecoin through an Esplora-style explorer, keeps this browser's keys and
// secrets (ltc-keys.js), and hands the seller's Ting actions to Ting ID as
// TCR-1 call links. Everything else it sends itself: takes, claims, releases
// and refunds on Ting, which need no signature, and the Litecoin claim,
// release and refund, which it signs here.
//
// On the production network as config.js pins it (LTC_PRODUCTION), or, opened
// with a test setup's address, on the Ting development chain and Litecoin
// regtest or testnet.
import { equal, hex, Reader, unhex } from './bytes.js';
import { CODE_HASHES, LTC_PRODUCTION } from './config.js';
import * as H from './htlc.js';
import * as K from './ltc-keys.js';
import * as L from './ltc.js';
import { qrSvg } from './qr.js';
import { isPublicKey, publicKey } from './secp256k1.js';
import { claimFee as claimFeeNow, twoDigits } from './fees.js';
import { decodeCoin, decodeCoinAccount, formatAmount, linkAmount, parseAmount, rate } from './swap.js';
import {
  callLink, checkListed, decodeExecuted, decodeTemplateList, decodeValues, EXECUTED, operationHash, TEMPLATES_KEY,
} from './tcr.js';
import { contractAccount, idOf, Node, NodeError } from './ting.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const now = () => Math.floor(Date.now() / 1000);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A number from a node or an explorer, as a number: anything else becomes 0, so that nothing it sends lands in the page as markup. */
const int = (v) => (Number.isSafeInteger(Number(v)) ? Number(v) : 0);
/** A transaction id or hash from a node or an explorer: 64 hex digits, or null. */
const hexId = (v) => (typeof v === 'string' && /^[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null);

/**
 * An address the page may talk to or link: https, or http on this computer
 * only, as a development setup has it. Null for anything else.
 */
function safeUrl(text) {
  try {
    const url = new URL(text);
    if (url.protocol === 'https:') return url.href;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return url.href;
  } catch { /* not an address */ }
  return null;
}

/** The only Ting chain this page runs on: the development chain. */
const DEVELOPMENT = '8578787146be1ef0aacc797754001290272915e89cd9e5784fe1368e4c2131bc';
/** htlc.wasm's CodeHash, as build.sh prints it. */
const HTLC_CODE = CODE_HASHES.htlc;
/** The Litecoin networks this page runs on. Never mainnet. */
const LTC_NETS = ['regtest', 'testnet'];
/** T1 is the listing's window, the program's gap and this much more after the lock is made: time for the seller to accept. */
const ACCEPT_TIME = 18 * 3600;
/** The seller's page wants at least this much of that time left, so an accept is not refused for a few seconds. */
const CHECK_MARGIN = 600;
/** How often a trade is read again from both chains while it is open, and the market. */
const TRADE_POLL = 4000;
const MARKET_POLL = 10_000;
/** A transaction the page sent that no node or explorer knows after this many seconds is sent again. */
const RESEND_AFTER = 30;
/**
 * Ting's nodes admit a block stamped up to 2 hours ahead of their clocks, and
 * claims and refunds go by the block's stamp. The buyer's page sends a first
 * claim only while the deadline is more than that, and half an hour more, away:
 * later, a seller who mines could put a refund in a block stamped past the
 * deadline ahead of the claim, then claim the LTC with the secret it made
 * public. A claim already sent is sent again until it is in.
 */
const CLOCK_SLACK = 7_200;
const FIRST_CLAIM_BEFORE = CLOCK_SLACK + 1_800;
/** How many Ting blocks an accept is buried under before the buyer's page claims, unless the address says otherwise. */
const TCONFS = 30;
/** The page reads the program's events of this many blocks below the tip again on every read, so that an event a reorganization dropped is dropped here too. */
const REORG_WINDOW = 100;
/** The most litoshi per vbyte the page pays, from the address or the explorer. */
const MAX_FEE_RATE = 1000;
/** An LTC claim waiting longer than this for a block gets a warning. */
const SLOW_CLAIM = 1800;
/**
 * The least litoshi per vbyte of the claim the seller's page signs ahead at an
 * accept, which pays twice the rate of the moment if more: it may go out days
 * later, and nobody can raise its fee then. About 170 vbytes, so a few
 * thousand litoshi.
 */
const SIGNED_CLAIM_RATE = 10;
/** Outputs of takes that matter for no claim, read at most this many per round, so that free takes cannot flood the explorer. */
const OTHER_READS = 8;
/** An output Litecoin did not have, read again after this long; one that pays another script never again. */
const MISSING_AGAIN = 300;
/** Inside Discord's own browser, which can lose what a page keeps. */
const DISCORD = /discord/i.test(navigator.userAgent);
/**
 * Where the page reads LTC's price in USD, for an estimate next to LTC
 * amounts; `price` in the address names another source of the same shape, or
 * `off`. Read this often, kept in this browser, and shown only while at most
 * this old. Never a price for DLR.
 */
const PRICE_URL = 'https://litecoinspace.org/api/v1/prices';
const PRICE_EVERY = 10 * 60_000;
const PRICE_AGE = 2 * 3600;
const PRICE_KEY = 'ting-swap/ltc-usd';

/** Thrown to stop an action the user turned down: nothing to report. */
class Quiet extends Error {}

class ExplorerError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

/** The part of an Esplora API the page reads (litecoinspace.org, or scripts/ltc-dev.mjs on regtest). */
class Esplora {
  constructor(base) {
    this.base = base.replace(/\/+$/, '');
  }

  async request(path, { body, text = false } = {}) {
    let response;
    try {
      response = await fetch(this.base + path, body === undefined ? { cache: 'no-store' } : { method: 'POST', body, cache: 'no-store' });
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

  tx(txid) { return this.request(`/tx/${txid}`); }
  txStatus(txid) { return this.request(`/tx/${txid}/status`); }
  outspend(txid, vout) { return this.request(`/tx/${txid}/outspend/${vout}`); }
  utxo(address) { return this.request(`/address/${encodeURIComponent(address)}/utxo`); }
  addressTxs(address) { return this.request(`/address/${encodeURIComponent(address)}/txs`); }
  tipHash() { return this.request('/blocks/tip/hash', { text: true }); }
  block(hash) { return this.request(`/block/${hash}`); }
  fees() { return this.request('/v1/fees/recommended'); }
  broadcast(txHex) { return this.request('/tx', { body: txHex, text: true }); }
}

const app = {
  node: null,
  chainHex: '',
  program: null,
  /** The program's own account, which holds what open listings and locks hold. */
  vault: null,
  /** The DLR coin: its ContractId, and `{ name, symbol, decimals }`. */
  coin: null,
  dlr: { symbol: 'DLR', decimals: 8, name: 'Daler' },
  wallet: '',
  ltc: null,
  net: 'regtest',
  /** The regtest wallet page of scripts/ltc-dev.mjs, which stands in for the buyer's and seller's own Litecoin wallets. */
  ltcWallet: '',
  confs: 1,
  tconfs: TCONFS,
  /** What a claim pays now, from recent blocks (fees.js); null until read. */
  claimRate: null,
  /** Litoshi per vbyte for the page's Litecoin transactions; null asks the explorer. */
  ltcFee: null,
  /** Open listings by id, and how many were ever made. */
  listings: new Map(),
  count: 0,
  loaded: false,
  /** The program's events, oldest first, each with its block's height, time and transaction. */
  events: [],
  eventsFrom: 1,
  /** Ting's tip. */
  tip: { height: 0, time: 0 },
  tingError: null,
  /**
   * Litecoin as last read: the tip, outputs by `txid:vout` (each with `at`, when
   * it was read), unspent outputs by address, transactions' status by id, and
   * what failed to read in the last round, by the same keys.
   */
  lt: { tip: null, outs: new Map(), utxos: new Map(), txs: new Map(), error: null, failed: new Map() },
  /** What each trade's automatic steps last could not do, by listing. */
  actionErrors: new Map(),
  /** What the current view does every second, when data changes, and what it reads every few seconds. */
  tick: null,
  onData: null,
  reader: null,
  leave: null,
  /** Actions in flight, so that none starts twice. */
  busy: new Set(),
  discordOk: false,
  /** LTC's price in USD as last read, `{ url, usd, time, read }`, and its source; '' for none. */
  price: null,
  priceUrl: '',
  /** What the current view does when a new price arrives, when not `onData`. */
  onPrice: null,
};

// ---- Formatting ------------------------------------------------------------

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const short = (bytesOrHex) => {
  const h = typeof bytesOrHex === 'string' ? bytesOrHex : hex(bytesOrHex);
  return `${h.slice(0, 8)}…${h.slice(-6)}`;
};
const ltcText = (litoshi) => formatAmount(BigInt(litoshi), 8);
const dlrText = (units) => formatAmount(BigInt(units), app.dlr.decimals);
/** A plain LTC amount for links and messages: no separators. */
const ltcPlain = (litoshi) => ltcText(litoshi).replace(/,/g, '');
const dlrPlain = (units) => dlrText(units).replace(/,/g, '');

const ltcMark = '<span class="mark ltc-mark" aria-hidden="true">Ł</span>';
const dlrMark = () => `<span class="mark" style="--h:${parseInt(hex(app.coin).slice(0, 4), 16) % 360}" aria-hidden="true">${esc(app.dlr.symbol[0] ?? 'D')}</span>`;
const dlr = (units) => `<span class="amt"><span class="num">${dlrText(units)}</span> <span class="coin">${dlrMark()}<b>${esc(app.dlr.symbol)}</b></span></span>`;
const ltc = (litoshi) => `<span class="amt"><span class="num">${ltcText(litoshi)}</span> <span class="coin">${ltcMark}<b>LTC</b></span></span>`;
const rateText = (amount, want) => `1 ${esc(app.dlr.symbol)} = ${rate(BigInt(amount), app.dlr.decimals, BigInt(want), 8)} LTC`;
const rateBack = (amount, want) => `1 LTC = ${rate(BigInt(want), 8, BigInt(amount), app.dlr.decimals)} ${esc(app.dlr.symbol)}`;

/** The LTC price while it is recent enough to show, or null. */
const livePrice = () => (app.price && now() - app.price.time <= PRICE_AGE ? app.price : null);

/** "≈ $21.95" for an LTC amount in litoshi, or nothing without a recent price. LTC only: never for DLR. */
function usd(litoshi) {
  const p = livePrice();
  if (!p) return '';
  const value = (Number(BigInt(litoshi)) / 1e8) * p.usd;
  return `<span class="usd">≈ $${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
}

/** Where the USD estimates come from, in a sentence, or '' when the page shows none. */
function usdNote() {
  const p = livePrice();
  if (!p) return '';
  const read = new Date(p.read * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `≈ USD at ${esc(new URL(p.url).host)}’s LTC price, $${p.usd.toLocaleString('en-US', { maximumFractionDigits: 2 })} at ${esc(read)}: an estimate.`;
}

const localTime = (t) => new Date(t * 1000).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** A UTC time for a message others read: the time alone today, the date too otherwise. */
function utcTime(t) {
  const d = new Date(t * 1000);
  const hm = d.toISOString().slice(11, 16);
  if (d.toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)) return `${hm} UTC`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}, ${hm} UTC`;
}

function span(seconds) {
  const s = Math.abs(seconds);
  if (s < 60) return 'under a minute';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 10 * 3600) {
    const m = Math.floor((s % 3600) / 60);
    return `${Math.floor(s / 3600)} h${m ? ` ${m} min` : ''}`;
  }
  if (s < 72 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d ${Math.round((s % 86400) / 3600)} h`;
}

/** "in 5 h" or "5 h ago". */
const relative = (t) => (t - now() >= 0 ? `in ${span(t - now())}` : `${span(t - now())} ago`);

/** A time with its countdown, which the page keeps up to date. */
const when = (t) => `<span class="when"><span>${esc(localTime(t))}</span> <time class="countdown" data-at="${t}"></time></span>`;

function who(account) {
  if (!account) return '—';
  return `<span class="account" title="${hex(account)}">${short(account)}</span>`;
}

/** A transaction id in mono, shortened, with a copy button, and a link when there is one. */
function txid(id, { href } = {}) {
  const text = esc(short(id));
  return `<span class="txid"><code title="${esc(id)}">${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${text}</a>` : text}</code><button class="copy" data-copy="${esc(id)}" data-done="Transaction id copied" aria-label="Copy the transaction id" title="Copy">${icon('copy')}</button></span>`;
}

/** A value to copy: shown in full in mono, with a copy button. */
const copyable = (value, done = 'Copied') => `<span class="copyable"><code>${esc(value)}</code><button class="copy" data-copy="${esc(value)}" data-done="${esc(done)}" aria-label="Copy" title="Copy">${icon('copy')}</button></span>`;

function toast(message, kind = 'info', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(esc(done), 'success', 2500);
  } catch {
    toast('Copying is not allowed here: select the text and copy it yourself.', 'error', 4000);
  }
}

/** Why a Ting transaction failed: the program's message, or the receipt's status. */
function failure(receipt) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(unhex(receipt.result_hex)) || receipt.status_name;
  } catch {
    return receipt.status_name;
  }
}

/** A Litecoin error in a few plain words: litecoind's message without the RPC wrapping. */
const ltcWords = (e) => String(e?.message ?? e).match(/"message":"([^"]+)"/)?.[1] ?? String(e?.message ?? e);

// ---- This browser's keys ---------------------------------------------------

const marks = new Map();

/** Counter n's public key and secret hash, worked out once. */
function marksOf(n) {
  if (!marks.has(n)) marks.set(n, K.marksAt(K.seed(), n));
  return marks.get(n);
}

const myTrades = () => (app.program ? K.trades(app.program) : []);
const mine = (id, role) => myTrades().find((t) => t.listing === id && t.role === role) ?? null;
/** Keeps a trade's new fields; the trade as saved. */
const update = (trade, fields) => K.updateTrade(app.program, trade, fields);

/** The seed, made now if there is none; asks first inside Discord, and refuses when the browser cannot keep it. */
async function ensureSeed() {
  const have = K.seed();
  if (have) return have;
  if (!K.canStore()) throw new Error('This browser does not let the page keep keys (a private window, or site data blocked). Open the page in a normal window first.');
  if (DISCORD && !app.discordOk) {
    if (!(await askDiscord())) throw new Quiet();
    app.discordOk = true;
  }
  return K.makeSeed();
}

function askDiscord() {
  return new Promise((resolve) => {
    const dialog = $('#notice-dialog');
    $('.dialog-body', dialog).innerHTML = `<div class="eyebrow">Before the page makes your keys</div>
      <h2>Open this in your browser</h2>
      <p>You opened this page inside Discord. The page keeps your trade’s keys and secret in the browser itself, and
      Discord’s built-in browser can forget them when it closes, with your coins locked behind them.</p>
      <p>Open the link in Safari, Chrome or Firefox instead: copy it, or use “Open in browser” in Discord’s menu.</p>
      <div class="row"><button class="primary" id="discord-copy" autofocus>${icon('copy')} Copy the link</button><button id="discord-go">Continue here anyway</button></div>`;
    let answer = false;
    $('#discord-copy', dialog).onclick = () => copy(location.href, 'Link copied: open it in your browser');
    $('#discord-go', dialog).onclick = () => { answer = true; dialog.close(); };
    dialog.onclose = () => resolve(answer);
    dialog.showModal();
  });
}

/**
 * Asks before a second accept link for a listing while another may still be
 * approved: true to go on. Both could be approved, the first in a block wins,
 * and the page then holds back the release of both locks until the accept is
 * buried.
 */
function askSecondLink(d, others) {
  return new Promise((resolve) => {
    const dialog = $('#notice-dialog');
    const which = others.map((k) => d.takes.find((x) => x.lockOf && outKey(x.lockOf) === k)?.index).filter((i) => i != null).map((i) => `lock ${i + 1}`).join(', ');
    $('.dialog-body', dialog).innerHTML = `<div class="eyebrow">Another accept link is out</div>
      <h2>Open a second accept link?</h2>
      <p>You already opened an accept link for ${esc(which || 'another lock')} of this listing, and Ting ID can still approve it, also later. If both are
      approved, only the first to reach a block goes through. Your page then holds back the release of both locks until
      that accept is ${app.tconfs} blocks deep, so that a reorganization cannot swap one accept for the other after a release.</p>
      <p>If you closed that link without approving it, and will not approve it, go on.</p>
      <div class="row"><button class="primary" id="second-go" autofocus>Open the new link</button><button id="second-cancel">Cancel</button></div>`;
    let answer = false;
    $('#second-go', dialog).onclick = () => { answer = true; dialog.close(); };
    $('#second-cancel', dialog).onclick = () => dialog.close();
    dialog.onclose = () => resolve(answer);
    dialog.showModal();
  });
}

// ---- Reading Ting ----------------------------------------------------------

/** Reads the open listings: every one the first time, then the ones open before and the ones made since. */
async function loadListings() {
  const count = H.decodeCount(await app.node.record(app.program, H.COUNT_KEY));
  const ids = app.loaded ? [...app.listings.keys()] : [];
  for (let id = app.loaded ? app.count + 1 : 1; id <= count; id++) ids.push(id);
  const values = await app.node.storage(ids.map((id) => [app.program, H.listingKey(id)]));
  const before = [...app.listings.keys()].join();
  for (const [i, id] of ids.entries()) {
    let listing = null;
    try {
      listing = H.decodeListing(id, values[i]);
    } catch { /* not one this page reads */ }
    if (listing) app.listings.set(id, listing);
    else app.listings.delete(id);
  }
  const changed = !app.loaded || count !== app.count || before !== [...app.listings.keys()].join();
  app.count = count;
  app.loaded = true;
  return changed;
}

/** What identifies an event in a block: to tell whether a read changed anything. */
const eventMark = (e) => `${e.block}:${e.tx}:${e.kind}:${e.id}`;

/**
 * Reads the program's events: those since the last read, and again those of
 * the last REORG_WINDOW blocks, in place of what was read of them before. An
 * event a reorganization dropped is dropped here too, and one it moved gets its
 * new block: depths are counted from blocks the node has now.
 */
async function loadEvents() {
  const start = Math.max(1, Math.min(app.eventsFrom, app.tip.height - REORG_WINDOW));
  const fresh = [];
  let from = start;
  for (;;) {
    const page = await app.node.events(app.program, H.TOPIC, from, 100);
    for (const block of page.items ?? []) {
      for (const e of block.events ?? []) {
        try {
          const r = new Reader(unhex(e.payload_hex));
          r.take(32);
          fresh.push({ ...H.decodeEvent(r), height: int(block.height), time: int(block.timestamp), tx: hexId(e.transaction), block: hexId(block.block) });
        } catch { /* not one this page reads */ }
      }
    }
    const next = int(page.next);
    if (!page.items?.length || next > int(page.height) || next <= from) {
      app.eventsFrom = Math.max(from, next || from);
      break;
    }
    from = next;
  }
  const kept = app.events.filter((e) => e.height < start);
  const before = app.events.filter((e) => e.height >= start).map(eventMark).join();
  app.events = [...kept, ...fresh];
  return before !== fresh.map(eventMark).join();
}

let tingReading = null;

/** Reads Ting again, once at a time; true when something changed. */
function refreshTing() {
  tingReading ??= (async () => {
    try {
      const status = await app.node.status();
      const height = int(status.height);
      const moved = height !== app.tip.height;
      app.tip = { height, time: now() };
      const [listings, events] = await Promise.all([loadListings(), loadEvents()]);
      app.tingError = null;
      if (events) findMyListings();
      return moved || listings || events;
    } catch (e) {
      app.tingError = e.message;
      return true;
    } finally {
      tingReading = null;
    }
  })();
  return tingReading;
}

/**
 * A seller's trade follows every listing with its key. A key is public as soon
 * as its offer is in Ting's pool, and anyone can list with it, even in an
 * earlier block. Acting on such a copy is harmless: only its maker can accept
 * it, and a claim of any of its locks pays this trade's key. So the automatic
 * steps run for every listing with the key (`listings`); the trade's own
 * listing, the one it shows (`listing`), is the one made by the transaction
 * Ting ID reported, else by the account it reported, else the first.
 */
function findMyListings() {
  if (!K.seed()) return;
  for (const t of myTrades()) {
    if (t.role !== 'seller') continue;
    const m = marksOf(t.n);
    if (!m) continue;
    const all = app.events.filter((e) => e.kind === 'listed' && equal(e.key, m.pub)).sort((a, b) => a.id - b.id);
    if (!all.length) continue;
    const main = all.find((e) => t.listedTx && e.tx === t.listedTx) ?? all.find((e) => t.maker && hex(e.maker) === t.maker) ?? all[0];
    const listings = all.map((e) => e.id);
    if (t.listing !== main.id || String(t.listings ?? []) !== String(listings)) update(t, { listing: main.id, listings });
  }
}

/** Notes, for the seller's trade with key `pub`, the transaction and account that listed it, as Ting ID reported them. */
function pinListing(pub, tx, account) {
  for (const t of myTrades()) {
    const m = t.role === 'seller' ? marksOf(t.n) : null;
    if (m && equal(m.pub, pub)) update(t, { listedTx: hexId(tx), maker: account ? hex(account) : null });
  }
}

/** The listings a trade acts on: a seller's every listing with its key, a buyer's own. */
const listingsOf = (t) => (t.role === 'seller' && t.listings?.length ? t.listings : t.listing ? [t.listing] : []);

/** The seller's trade of this browser whose key another's listing copies, or null. */
const copiedBy = (id) => myTrades().find((t) => t.role === 'seller' && t.listing !== id && t.listings?.includes(id)) ?? null;

/** Everything known of one listing, from its record and its events, with this browser's part in it. */
function tradeOf(id) {
  const evs = app.events.filter((e) => e.id === id);
  const listed = evs.find((e) => e.kind === 'listed') ?? null;
  const open = app.listings.get(id) ?? null;
  const terms = open ?? (listed && { ...listed, listedAt: listed.time });
  const releases = [];
  const signedClaims = [];
  for (const e of evs.filter((x) => x.kind === 'released')) {
    try {
      releases.push({ ...e, release: L.decodeRelease(e.data) });
    } catch { /* not a Litecoin release */ }
    try {
      signedClaims.push({ ...e, claim: L.decodeSignedClaim(e.data) });
    } catch { /* not a signed claim */ }
  }
  return {
    id, open, listed, terms,
    takes: evs.filter((e) => e.kind === 'taken').map((e, index) => ({ ...e, index, lockOf: lockOfTake(e) })),
    accepted: evs.find((e) => e.kind === 'accepted') ?? null,
    claimed: evs.find((e) => e.kind === 'claimed') ?? null,
    refunded: evs.find((e) => e.kind === 'refunded') ?? null,
    withdrawn: evs.find((e) => e.kind === 'withdrawn') ?? null,
    releases,
    signedClaims,
    seller: mine(id, 'seller'),
    buyer: mine(id, 'buyer'),
  };
}

function lockOfTake(take) {
  try {
    return L.decodeTakeLock(take.lock);
  } catch {
    return null;
  }
}

/** Whether a listing is one this page trades: Litecoin, for the DLR it was given. */
const forThisPage = (l) => l.chain === 'LTC' && equal(l.coin, app.coin) && l.key.length === 33 && isPublicKey(l.key);

const matchesAccept = (take, acc) => Boolean(acc) && equal(take.taker, acc.taker) && equal(take.hash, acc.hash) && take.t1 === acc.t1;
const depthOf = (height) => (height ? Math.max(0, app.tip.height - height + 1) : 0);
const outKey = (lock) => `${lock.txid}:${lock.vout}`;

const scripts = new Map();

/** The lock a take names, as the seller's page rebuilds it: its script, output and address; null for lock bytes it cannot read. */
function lockScript(terms, take) {
  const lock = take.lockOf;
  if (!lock) return null;
  const key = `${terms.id}|${hex(terms.key)}|${hex(take.lock)}|${hex(take.taker)}|${hex(take.hash)}|${take.t1}`;
  if (!scripts.has(key)) {
    let made = null;
    try {
      const htlc = { tag: L.lockTag(app.program, terms.id, take.taker), hash: take.hash, seller: terms.key, buyer: lock.buyer, t1: take.t1 };
      made = { htlc, ...L.lockOutput(htlc, app.net), txid: lock.txid, vout: lock.vout };
    } catch { /* not a lock */ }
    scripts.set(key, made);
  }
  return scripts.get(key);
}

const releaseChecks = new Map();

/**
 * The seller's release of a take's lock: the first released event naming its
 * output whose signature really releases that lock, checked against the
 * script rebuilt from the take and the output's value as Litecoin has it.
 * Anyone can post release data, as anyone can post a take: one whose
 * signature does not verify is no release, and neither is one for an output
 * this page has not read yet. Null without one.
 */
function releaseOf(d, take) {
  const lock = lockScript(d.terms, take);
  if (!lock) return null;
  const out = outOf(lock.txid, lock.vout);
  if (!out || out.missing || out.script !== hex(lock.scriptPubKey)) return null;
  for (const r of d.releases) {
    if (r.release.txid !== lock.txid || r.release.vout !== lock.vout) continue;
    const key = `${hex(r.data)}|${hex(lock.script)}|${out.value}`;
    if (!releaseChecks.has(key)) {
      let ok = false;
      try {
        ok = L.verifyReleaseSignature({ txid: lock.txid, vout: lock.vout, value: out.value, htlc: lock.htlc, signature: r.release.signature });
      } catch { /* not a signature */ }
      releaseChecks.set(key, ok);
    }
    if (releaseChecks.get(key)) return r;
  }
  return null;
}

/**
 * The seller's signed claim of a lock (`lockScript`'s) whose output `out`
 * Litecoin has: the first posted for that output whose signature is the
 * listing key's over the claim it names, checked against the rebuilt script
 * and the output's value. Anyone can post release data: one that does not
 * verify is no signed claim. Null without one.
 */
function signedClaimOf(d, lock, out) {
  for (const s of d.signedClaims) {
    if (s.claim.txid !== lock.txid || s.claim.vout !== lock.vout) continue;
    const key = `${hex(s.data)}|${hex(lock.script)}|${out.value}`;
    if (!releaseChecks.has(key)) {
      let ok = false;
      try {
        ok = L.verifyClaimSignature({ txid: lock.txid, vout: lock.vout, value: out.value, htlc: lock.htlc, out: s.claim.out, signature: s.claim.signature });
      } catch { /* not a signature */ }
      releaseChecks.set(key, ok);
    }
    if (releaseChecks.get(key)) return s;
  }
  return null;
}

// ---- Reading Litecoin ------------------------------------------------------

async function readTip() {
  const hash = hexId(await app.ltc.tipHash());
  if (!hash) throw new ExplorerError('the explorer named no tip', 0);
  const block = await app.ltc.block(hash);
  app.lt.tip = { height: int(block?.height), hash, mtp: int(block?.mediantime), time: int(block?.timestamp) };
}

/** One output as the explorer has it, with when it was read: missing, or its value and script, its block and whether it is spent. */
async function readOut(txidHex, vout) {
  const key = `${txidHex}:${vout}`;
  let tx;
  try {
    tx = await app.ltc.tx(txidHex);
  } catch (e) {
    if (e.status === 404 || e.status === 400) {
      app.lt.outs.set(key, { missing: true, at: now() });
      return;
    }
    throw e;
  }
  const out = Array.isArray(tx?.vout) ? tx.vout[vout] : null;
  const value = int(out?.value);
  if (!out || value <= 0 || typeof out.scriptpubkey !== 'string') {
    app.lt.outs.set(key, { missing: true, at: now() });
    return;
  }
  const spend = await app.ltc.outspend(txidHex, vout);
  app.lt.outs.set(key, {
    value, script: out.scriptpubkey.toLowerCase(), confirmed: tx.status?.confirmed === true, height: int(tx.status?.block_height),
    spent: spend?.spent === true, spender: hexId(spend?.txid), spenderConfirmed: spend?.status?.confirmed === true,
    spenderHeight: int(spend?.status?.block_height), at: now(),
  });
}

async function readTxStatus(id) {
  try {
    const s = await app.ltc.txStatus(id);
    app.lt.txs.set(id, { found: true, confirmed: s?.confirmed === true, height: int(s?.block_height) });
  } catch (e) {
    if (e.status !== 404 && e.status !== 400) throw e;
    app.lt.txs.set(id, { found: false });
  }
}

/** The unspent outputs at an address, as the explorer lists them, each checked to be one. */
async function readUtxos(address) {
  const list = await app.ltc.utxo(address);
  app.lt.utxos.set(address, (Array.isArray(list) ? list : []).map((u) => ({
    txid: hexId(u?.txid), vout: int(u?.vout), value: int(u?.value),
    status: { confirmed: u?.status?.confirmed === true, block_height: int(u?.status?.block_height) },
  })).filter((u) => u.txid && u.value > 0));
}

/**
 * Reads Litecoin's tip, then what `first` asks for, then what `rest` asks
 * for: outputs as `[txid, vout]`, addresses and transactions. Each read is on
 * its own, so that one that fails (an unrelated take's output, say) stops no
 * other; what failed is kept in `app.lt.failed` by its key. `app.lt.error`
 * says only that Litecoin could not be read at all.
 */
async function refreshLtc(first = {}, rest = {}) {
  try {
    await readTip();
    app.lt.error = null;
  } catch (e) {
    app.lt.error = e.message;
    return;
  }
  const run = async ({ outs = [], addresses = [], txs = [] }) => {
    const jobs = [
      ...outs.map(([t, v]) => [`${t}:${v}`, () => readOut(t, v)]),
      ...addresses.map((a) => [a, () => readUtxos(a)]),
      ...txs.map((t) => [t, () => readTxStatus(t)]),
    ];
    const results = await Promise.allSettled(jobs.map(([, job]) => job()));
    results.forEach((r, i) => {
      if (r.status === 'rejected') app.lt.failed.set(jobs[i][0], r.reason?.message ?? String(r.reason));
      else app.lt.failed.delete(jobs[i][0]);
    });
  };
  await run(first);
  await run(rest);
}

const ltcDepth = (height) => (height && app.lt.tip ? Math.max(0, app.lt.tip.height - height + 1) : 0);
const outOf = (txidHex, vout) => app.lt.outs.get(`${txidHex}:${vout}`);

/**
 * Litoshi per vbyte for the page's Litecoin transactions: the address's
 * `ltcfee`, or the explorer's fastest rate, never under 2 nor over
 * MAX_FEE_RATE. An answer that is not a number counts as none.
 */
async function feeRate() {
  if (app.ltcFee) return app.ltcFee;
  try {
    const fastest = Number((await app.ltc.fees())?.fastestFee);
    if (!Number.isFinite(fastest) || fastest <= 0) return 2;
    return Math.min(MAX_FEE_RATE, Math.max(2, Math.ceil(fastest)));
  } catch {
    return 2;
  }
}

/**
 * Sends a Litecoin transaction; one the chain already has counts as sent.
 * Throws otherwise, with `refused` when Litecoin itself turned it down, not
 * when the explorer could not be reached.
 */
async function broadcast(txHex) {
  try {
    return await app.ltc.broadcast(txHex);
  } catch (e) {
    if (/already in (the )?(block ?chain|mempool)|txn-already-known|already known/i.test(e.message)) return null;
    throw Object.assign(new Error(ltcWords(e)), { refused: e.status === 400 });
  }
}

/**
 * What the seller's page checks before accepting a take, exactly as
 * htlc-e2e.mjs's checkTake: the script rebuilt from the take and the listing,
 * the output it names exists, pays that script's address at least the wanted
 * amount, has enough confirmations and is unspent, and T1 leaves the gap.
 * From what Litecoin was last read as: `{ state: 'ok' | 'wait' | 'bad' | 'unknown', words }`.
 */
function checkTake(terms, take) {
  const lock = lockScript(terms, take);
  if (!lock) return { state: 'bad', words: 'its lock is not a Litecoin lock this page can read: not acceptable' };
  const out = outOf(lock.txid, lock.vout);
  if (!out) return { state: 'unknown', words: 'checking it on Litecoin…', lock };
  if (out.missing) return { state: 'bad', words: 'Litecoin has no such output (yet): not acceptable', lock };
  if (out.script !== hex(lock.scriptPubKey)) return { state: 'bad', words: 'the output it names does not pay this take’s lock address: not acceptable', lock };
  if (BigInt(out.value) < terms.want) return { state: 'bad', words: `it holds ${ltcText(out.value)} LTC, less than the ${ltcText(terms.want)} LTC wanted: not acceptable`, lock, out };
  if (out.spent) return { state: 'bad', words: 'the lock was already spent: not acceptable', lock, out };
  if (take.t1 < now() + terms.window + H.GAP + CHECK_MARGIN) return { state: 'bad', words: `its Litecoin lock ends too soon to accept (${localTime(take.t1)})`, lock, out };
  const depth = out.confirmed ? ltcDepth(out.height) : 0;
  const counted = `${ltcText(out.value)} LTC locked, ${depth} of ${app.confs} confirmation${app.confs === 1 ? '' : 's'}`;
  if (depth < app.confs) return { state: 'wait', words: `${counted}: waiting for confirmations`, lock, out, depth };
  return { state: 'ok', words: `${counted}: ready`, lock, out, depth };
}

/** What a Litecoin address starts with on this page's network, for a field's placeholder. */
const addressHint = () => ({ mainnet: 'ltc1…', regtest: 'rltc1…' })[app.net] ?? 'tltc1…';

/** Production's band says only *Early testing*; a test setup's band and footer say so, and that no coin is real. */
function markSetup() {
  if (app.production) return;
  $('.test-band').innerHTML = `<b>Test setup</b><span class="long">The Ting development chain and Litecoin ${esc(app.net)}. No coin here is real.</span><span class="short">No coin here is real.</span>`;
  $('.foot span').textContent = `Ting Swap · DLR ↔ LTC · a test setup on the Ting development chain and Litecoin ${app.net} · your keys stay in this browser`;
}

// ---- LTC's price in USD ------------------------------------------------------

/** The price source the address names: `price=off` for none, another http(s) URL, or litecoinspace.org's. */
function priceSource(query) {
  const p = query.get('price');
  if (p === 'off') return '';
  if (!p) return PRICE_URL;
  try {
    const url = new URL(p);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

/** The last good price from this source that this browser kept, or null. */
function savedPrice() {
  try {
    const p = JSON.parse(localStorage.getItem(PRICE_KEY) ?? 'null');
    if (p && p.url === app.priceUrl && Number.isFinite(p.usd) && p.usd > 0 && Number.isInteger(p.time) && Number.isInteger(p.read)) return p;
  } catch { /* none kept */ }
  return null;
}

/** Reads the price, `{ "time": …, "USD": … }`, and keeps a good one. A failure is quiet: the page then shows no USD. */
async function readPrice() {
  if (!app.priceUrl) return;
  try {
    const response = await fetch(app.priceUrl, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return;
    const answer = await response.json();
    const usd = Number(answer?.USD);
    const time = Number(answer?.time);
    if (!(Number.isFinite(usd) && usd > 0 && Number.isInteger(time) && time > 0)) return;
    app.price = { url: app.priceUrl, usd, time, read: now() };
    try { localStorage.setItem(PRICE_KEY, JSON.stringify(app.price)); } catch { /* kept for this visit only */ }
    (app.onPrice ?? app.onData)?.();
  } catch { /* no USD until a later read works */ }
}

/** Reads what a claim pays now. A failure is quiet: the page then sets the least cap. */
async function readClaimRate() {
  try {
    app.claimRate = await claimFeeNow(app.node, app.coin);
    (app.onPrice ?? app.onData)?.();
  } catch { /* the next read tries again */ }
}

// ---- Calls through Ting ID -------------------------------------------------

/** `v` with one decimal, as `toFixed(1)` rounds it, without a trailing `.0`. */
function fixed1(v) {
  const t = v.toFixed(1);
  return t.endsWith('.0') ? t.slice(0, -2) : t;
}

/** A span of seconds in words, as Ting ID words one (TCR-1, field types): `45 minutes`, `12 hours`, `7 days`. */
function durationWords(seconds) {
  const s = Number(seconds);
  if (s === 0) return 'none';
  const of = (n, noun) => `${n} ${n === '1' ? noun : `${noun}s`}`;
  if (s < 3600) return of(String(Math.round(s / 60)), 'minute');
  if (s < 86_400) return of(fixed1(s / 3600), 'hour');
  return of(fixed1(s / 86_400), 'day');
}

/**
 * An operation in the words Ting ID shows it, each value as TCR-1's field
 * types say: amounts in their coin, accounts and hashes in full, bytes by
 * their length, an enum by its label, a duration in words.
 */
function walletSentence(template, values, pay, shownAs = {}) {
  let decoded;
  try {
    decoded = decodeValues(template, values);
  } catch {
    return `An operation this page cannot show: <code>${esc(hex(values))}</code>`;
  }
  return decoded.parts.map((p) => {
    if (p.payment) return `<b>${pay ? `${dlrText(pay.amount)} ${esc(app.dlr.symbol)}` : 'its payment'}</b>`;
    if (!p.slot) return esc(p.text);
    if (shownAs[p.slot]) return shownAs[p.slot];
    const v = p.value;
    let text;
    if (p.type === 'amount') text = equal(v.coin, app.coin) ? `${dlrText(v.amount)} ${esc(app.dlr.symbol)}` : `${v.amount} of coin ${hex(v.coin)}`;
    else if (p.type === 'account' || p.type === 'bytes32') text = `<span class="mono">${hex(v)}</span>`;
    else if (p.type === 'bytes') text = v.length === 1 ? '1 byte' : `${v.length} bytes`;
    else if (p.type?.enum) text = esc(v.label);
    else if (p.type === 'text') text = `“${esc(v)}”`;
    else if (p.type === 'time') text = esc(new Date(v * 1000).toLocaleString());
    else if (p.type === 'duration') text = esc(durationWords(v));
    else text = esc(String(v));
    return `<b>${text}</b>`;
  }).join('');
}

/**
 * Which way to Ting ID suits this device: the Ting ID app on Android, which
 * opens `ting:call` links; Ting ID Web on an iPhone or iPad, since Ting ID is
 * an Android app; on a computer, the QR code for the app on a phone, or Ting
 * ID Web.
 */
function device() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  return 'computer';
}

/**
 * Hands an operation to Ting ID as a call link: the dialog with the ways to
 * open it that suit this device (the app, Ting ID Web, the QR code) and the
 * link itself. The page watches the program's events until it is done, then
 * calls `done(true, executed)`; `done(false)` when the dialog is closed first
 * or the call fails.
 */
async function perform({ call, pay, label, from, feeCoin, notes = '', done }) {
  const link = await callLink({
    chainHex: app.chainHex, program: app.program, template: call.template, values: call.values,
    coin: pay ? pay.coin : feeCoin, to: pay?.to, amount: pay ? linkAmount(pay.amount, app.dlr.decimals) : null,
    from, returnTo: location.origin + location.pathname + location.search,
  });
  const dialog = $('#call-dialog');
  let qr = null;
  try { qr = qrSvg(link); } catch { /* too long for a QR code */ }
  const qrButton = qr ? `<button class="qr" aria-label="Show the QR code full screen">${qr}</button>` : '';
  const kind = device();
  const toApp = `<a class="button primary" id="open-app" href="${esc(link)}" autofocus>${icon('key')} Open in Ting ID</a>`;
  const toWeb = (primary) => (app.wallet ? `<a class="button${primary ? ' primary' : ''}" id="open-wallet" href="${esc(walletUrl(link))}" target="_blank" rel="noopener"${primary ? ' autofocus' : ''}>${icon(primary ? 'key' : 'external')} ${primary ? 'Open in Ting ID Web' : 'Ting ID Web'}</a>` : '');
  const copyButton = '<button id="copy-call">Copy link</button>';
  // On a phone the code is for another device, so it folds away; on a computer it comes first, for the app on a phone.
  const folded = qrButton ? `<details class="owner tech"><summary>Show the QR code, for Ting ID on another phone</summary>${qrButton}</details>` : '';
  const ways = {
    android: `<p class="hint">Opens the Ting ID app. If your identity is in Ting ID Web instead, open it there.</p>
      <div class="row">${toApp}${toWeb(false)}${copyButton}</div>${folded}`,
    ios: `<p class="hint">Opens Ting ID Web, which signs with your passkey. Ting ID itself is an Android app: if your identity is there, scan the QR code with it.</p>
      <div class="row">${toWeb(true)}${copyButton}</div>${folded}`,
    computer: `<p class="hint">${qrButton ? 'Scan the code with the Ting ID app on your phone, or open it in Ting ID Web if your identity is set up there.' : 'Too long for a QR code: open it in Ting ID Web, or copy the link to the phone that has Ting ID.'}</p>
      <div class="row">${toWeb(!qrButton)}${copyButton}</div>`,
  };
  $('.dialog-body', dialog).innerHTML = `<div class="eyebrow">Sign with Ting ID</div><h2>${esc(label)}</h2>
    <p class="call-sentence">${walletSentence(call.template, call.values, pay)}</p>
    ${notes}
    <p class="hint">${pay ? `Ting ID shows what leaves your account itself: ${dlr(pay.amount)} to the swap program, and the fee.` : 'Nothing leaves your account but the fee.'}</p>
    <div class="call-pay ${kind}">
      ${kind === 'computer' ? qrButton : ''}
      <div class="pay-side">
        ${ways[kind]}
        <p class="hint waiting" id="call-status"><span class="spinner" aria-hidden="true"></span> Waiting for you to approve it in Ting ID…</p>
      </div>
    </div>`;
  $('#copy-call', dialog).onclick = () => copy(link, 'Call link copied');
  const code = $('.qr', dialog);
  if (code) code.onclick = () => code.classList.toggle('full');
  dialog.oncancel = (e) => {
    if (!code?.isConnected || !code.classList.contains('full')) return;
    e.preventDefault();
    code.classList.remove('full');
  };
  if (!dialog.open) dialog.showModal();
  const start = (await app.node.status()).height;
  watchCall(dialog, call, label, start, done);
}

/**
 * A call link as Ting ID Web opens it, after `#`, as written: the wallet reads
 * its fields as TCR-1 says, each decoded once, so a `return` address with its
 * own query string arrives whole (ting-id-web's linkFromAddress).
 */
const walletUrl = (link) => `${app.wallet}#${link}`;

/** Watches for the operation's *executed* event until it is done or the dialog closes; says when Ting ID has sent it. */
async function watchCall(dialog, call, label, start, done) {
  const operation = hex(operationHash(call.head));
  const token = (dialog.watching = {});
  const read = new Set();
  let sent = null;
  for (;;) {
    await sleep(2500);
    if (dialog.watching !== token) return;
    if (!dialog.open) return done?.(false);
    try {
      const executed = await findExecuted(operation, start);
      if (executed) {
        dialog.close();
        toast(`${esc(label)}: done, in block ${executed.height}`, 'success', 8000);
        await refreshTing();
        app.onData?.();
        return done?.(true, executed);
      }
      if (sent) {
        const seen = (await app.node.transaction(sent)).occurrences?.[0];
        if (seen && seen.receipt.status !== 0) {
          callState(dialog, 'failed', 'It did not go through', `${esc(label)} failed: ${esc(failure(seen.receipt))}`);
          return done?.(false);
        }
      } else if ((sent = hexId(await pooled(call.head, read)))) {
        callState(dialog, 'sent', 'Ting ID sent it', `Waiting for a block, a few seconds on this chain. Transaction ${txid(sent)}`);
      }
    } catch { /* the next look tries again */ }
  }
}

async function findExecuted(operation, start) {
  let from = start;
  for (;;) {
    const page = await app.node.events(app.program, EXECUTED, from, 100);
    for (const block of page.items) {
      for (const e of block.events) {
        const r = new Reader(unhex(e.payload_hex));
        r.take(32);
        const executed = decodeExecuted(r);
        if (hex(executed.operation) === operation) return { height: int(block.height), account: executed.account, tx: hexId(e.transaction) };
      }
    }
    if (!page.items.length || page.next > page.height) return null;
    from = page.next;
  }
}

function callState(dialog, kind, title, text) {
  const mark = kind === 'sent' ? '<span class="spinner big" aria-hidden="true"></span>' : icon('alert');
  $('.call-pay', dialog).innerHTML = `<div class="call-state ${kind}" role="status">${mark}
    <div><b>${esc(title)}</b><p id="call-status">${text}</p></div></div>`;
}

/** The id of a pooled transaction that calls the operation `head`, or null; each one is read once. */
async function pooled(head, read) {
  for (const { id } of (await app.node.mempool()).items) {
    if (read.has(id)) continue;
    try {
      const input = programInput((await app.node.transaction(id)).pending_transaction?.hex);
      read.add(id);
      if (input && equal(input.subarray(0, head.length), head)) return id;
    } catch { /* in a block already; the next look tries again */ }
  }
  return null;
}

/** The input of a transaction that calls the program, or null. */
function programInput(txHex) {
  if (!txHex) return null;
  const r = new Reader(unhex(txHex));
  if (r.u8() !== 1 || r.u8() !== 0) return null;
  for (let i = 0; i < 4; i++) r.u64();
  return equal(r.id(), app.program) ? r.bytes() : null;
}

// ---- Own calls: no signature, no fee of their own ------------------------------

/** Sends one of the program's own inputs; the transaction's id. */
async function sendOwn(input) {
  const id = hexId(await app.node.submit(H.ownCall(app.program, input)));
  if (!id) throw new Error('the node answered with no transaction id');
  return id;
}

/** Where a Ting transaction the page sent stands: done, failed, pending or missing. */
async function tingTx(id) {
  try {
    const answer = await app.node.transaction(id);
    const seen = answer.occurrences?.[0];
    if (seen) return seen.receipt?.status === 0 ? { state: 'done', height: int(seen.height) } : { state: 'failed', height: int(seen.height), reason: failure(seen.receipt ?? {}) };
    return { state: 'pending' };
  } catch (e) {
    if (e instanceof NodeError && e.status === 404) return { state: 'missing' };
    throw e;
  }
}

/** Follows a Ting transaction the user asked for, with toasts, then reads again. */
async function followTing(id, label) {
  const note = toast(`${esc(label)}: sent, waiting for a block…`, 'info', 120_000);
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    let s;
    try {
      s = await tingTx(id);
    } catch {
      continue;
    }
    if (s.state === 'done' || s.state === 'failed') {
      note.remove();
      if (s.state === 'done') toast(`${esc(label)}: done, in block ${s.height}`, 'success', 8000);
      else toast(`${esc(label)} failed: ${esc(s.reason)}`, 'error', 12_000);
      await refreshTing();
      app.onData?.();
      return s;
    }
  }
  note.remove();
  toast(`${esc(label)}: not in a block after two minutes. The page tries again when you reload.`, 'error', 10_000);
  return { state: 'missing' };
}

async function guard(action) {
  try {
    await action();
  } catch (e) {
    if (!(e instanceof Quiet)) toast(esc(e.message), 'error', 9000);
  }
}

/** Runs an action unless the same one is still running. */
async function once(key, action) {
  if (app.busy.has(key)) return;
  app.busy.add(key);
  try {
    await action();
  } finally {
    app.busy.delete(key);
  }
}

// ---- What the pages do by themselves ---------------------------------------------

/** The output paid to the buyer's lock address that the take names: the first with at least the wanted amount. */
function paymentOf(t) {
  const utxos = app.lt.utxos.get(t.address) ?? [];
  return utxos.filter((u) => BigInt(u.value) >= BigInt(t.want)).sort((a, b) => Number(b.status.confirmed) - Number(a.status.confirmed))[0] ?? null;
}

/**
 * The buyer's take among the listing's takes: the earliest that matches it
 * exactly, its secret's hash, receiving account, T1 and key, and the output
 * its page posted when it knows it. Anyone can post copies of a take, with
 * other lock bytes or another T1: they are not this one.
 */
function takeOfBuyer(d, t) {
  const m = marksOf(t.n);
  if (!m) return null;
  const posted = t.takeTx ?? t.take;
  return d.takes.find((x) => x.lockOf && equal(x.hash, m.hash) && hex(x.taker) === t.receive && x.t1 === t.t1
    && equal(x.lockOf.buyer, m.pub) && (!posted?.txid || (x.lockOf.txid === posted.txid && x.lockOf.vout === posted.vout))) ?? null;
}

/**
 * The lock the buyer's claim on Ting was for, once that claim is in: its
 * secret is public then, and the lock the seller's to claim however late, so
 * the buyer's refund never takes it, even after T1. Null before the claim.
 */
function claimedLock(d, t) {
  if (!d.claimed) return null;
  const take = takeOfBuyer(d, t);
  return take && matchesAccept(take, d.accepted) ? take.lockOf : null;
}

/** What the buyer's refund takes back: every output in a block at the lock address but the claimed lock. */
function refundable(d, t) {
  const claimed = claimedLock(d, t);
  const key = claimed ? outKey(claimed) : null;
  return (app.lt.utxos.get(t.address) ?? []).filter((u) => u.status.confirmed && outKey(u) !== key);
}

/**
 * Once this buyer's claim is on Ting, sends the seller's signed claim of the
 * accepted lock, finished with this trade's secret: the seller agreed to it at
 * the accept, and it pays only their address. Never before the claim is on
 * Ting, which would hand over the LTC before the DLR. Sent once; resendLtc
 * sends it again while the explorer does not know it.
 */
async function sendSellerClaim(d, t, take) {
  if (!d.claimed || t.sellerClaim || !matchesAccept(take, d.accepted)) return;
  const lock = lockScript(d.terms, take);
  const out = lock && outOf(lock.txid, lock.vout);
  if (!out || out.missing || out.spent || out.script !== hex(lock.scriptPubKey)) return;
  const ahead = signedClaimOf(d, lock, out);
  if (!ahead) return;
  await once(`seller-claim:${t.n}`, async () => {
    let tx;
    try {
      tx = L.finishClaim({
        txid: lock.txid, vout: lock.vout, value: out.value, htlc: lock.htlc, out: ahead.claim.out, signature: ahead.claim.signature,
        secret: K.secretAt(K.seed(), t.n),
      });
    } catch {
      return; // signedClaimOf checked it: nothing this page can send
    }
    let error = null;
    try {
      await broadcast(tx.hex);
    } catch (e) {
      error = e.message;
    }
    update(t, { sellerClaim: { txid: tx.txid, hex: tx.hex, at: now(), error } });
  });
}

/** The buyer's Litecoin release or refund, and the seller's claim it sent, sent again while the explorer does not know it: one an explorer lost. */
async function resendLtc(d, t) {
  const claimed = claimedLock(d, t);
  const claimedOut = claimed && outOf(claimed.txid, claimed.vout);
  for (const sent of [t.releaseTx, t.sellerClaim, ...Object.values(t.refundTxs ?? {})]) {
    if (!sent?.hex) continue;
    // A refund that spends the claimed lock would take the seller's LTC: it is never sent again.
    if (claimed && sent.covers?.includes(outKey(claimed))) continue;
    // The seller's claim is done with once the lock is spent, by it or by another claim of theirs.
    if (sent === t.sellerClaim && claimedOut?.spent) continue;
    const s = app.lt.txs.get(sent.txid);
    if (!s || s.found || now() - sent.at < RESEND_AFTER) continue;
    await once(`resend:${sent.txid}`, async () => {
      let error = null;
      try {
        await broadcast(sent.hex);
      } catch (e) {
        error = e.message;
      }
      // The time is noted whatever came of it, so that it is tried again later, not in every read.
      if (t.releaseTx?.txid === sent.txid) update(t, { releaseTx: { ...t.releaseTx, at: now(), error } });
      else if (t.sellerClaim?.txid === sent.txid) update(t, { sellerClaim: { ...t.sellerClaim, at: now(), error } });
      else update(t, { refundTxs: { ...t.refundTxs, [sent.txid]: { ...sent, at: now(), error } } });
    });
  }
}

/**
 * The buyer's page, by itself: posts the take once the payment is on
 * Litecoin. Once the seller's accept names this taker, hash and T1 exactly,
 * is buried under `tconfs` Ting blocks, and the lock record in the chain's
 * state says the same, it sends the claim: a first claim only while the
 * deadline is more than FIRST_CLAIM_BEFORE away; a claim it sent, it sends
 * again until it is buried. It also sends its Litecoin release or refund
 * again while the explorer does not know it.
 */
async function autoBuyer(d, t, { ltc = true, ting = true } = {}) {
  if (ltc) await resendLtc(d, t);
  if (!ting) return;
  const m = marksOf(t.n);
  const take = takeOfBuyer(d, t);
  if (!take) {
    // Posting the take goes by the payment as Litecoin has it: not without a fresh read.
    if (!ltc) return;
    const pay = paymentOf(t);
    if (!pay || !d.open || d.accepted || d.withdrawn) return;
    if (t.t1 < now() + d.terms.window + H.GAP + 60) {
      if (!t.takeLate) update(t, { takeLate: true });
      return;
    }
    if (t.takeTx) {
      const s = await tingTx(t.takeTx.id).catch(() => null);
      if (s?.state === 'failed') {
        if (t.takeTx.failed !== s.reason) update(t, { takeTx: { ...t.takeTx, failed: s.reason } });
        return;
      }
      if (s?.state !== 'missing' || now() - t.takeTx.at < RESEND_AFTER) return;
    }
    await once(`take:${t.n}`, async () => {
      const lock = L.encodeTakeLock({ txid: pay.txid, vout: pay.vout, buyer: m.pub });
      const input = H.takeInput({ id: d.id, taker: unhex(t.receive), hash: m.hash, t1: t.t1, lock });
      const id = await sendOwn(input);
      update(t, { takeTx: { id, txid: pay.txid, vout: pay.vout, value: pay.value, at: now() } });
    });
    return;
  }
  if (t.take?.txid !== take.lockOf.txid || t.take?.vout !== take.lockOf.vout) {
    update(t, { take: { txid: take.lockOf.txid, vout: take.lockOf.vout, tx: take.tx, height: take.height } });
  }
  const acc = d.accepted;
  if (!acc || !equal(acc.hash, m.hash)) return;
  if (!equal(acc.taker, unhex(t.receive)) || acc.t1 !== t.t1) {
    if (!t.acceptProblem) update(t, { acceptProblem: 'The accept names your hash but another account or T1 than your lock: the page will not claim.' });
    return;
  }
  // The claim on Ting made the secret public: the seller's signed claim goes out with it, so the seller need not be there.
  if (ltc && d.claimed) await sendSellerClaim(d, t, take);
  if (depthOf(acc.height) < app.tconfs) return;
  if (d.claimed && depthOf(d.claimed.height) >= app.tconfs) return;
  if (t.claimTx) {
    if (!d.claimed && now() > acc.deadline) return;
    const s = await tingTx(t.claimTx.id).catch(() => null);
    if (s?.state === 'failed' && !d.claimed) {
      if (t.claimTx.failed !== s.reason) update(t, { claimTx: { ...t.claimTx, failed: s.reason } });
      return;
    }
    if (s?.state !== 'missing' || now() - t.claimTx.at < RESEND_AFTER) return;
  } else {
    if (d.claimed) return;
    if (acc.deadline - now() <= FIRST_CLAIM_BEFORE) {
      if (!t.claimTooLate) update(t, { claimTooLate: true });
      return;
    }
    // The accept as the chain's state has it now, not only as an event read before: a
    // reorganization can drop an accept, and a claim then would only make the secret public.
    let lock = null;
    try {
      lock = H.decodeLock(d.id, await app.node.record(app.program, H.lockKey(d.id)));
    } catch { /* not a lock this page reads */ }
    if (!lock) throw new Error('the accept is not in the chain’s state: your page waits before claiming');
    if (!equal(lock.taker, unhex(t.receive)) || !equal(lock.hash, m.hash) || lock.t1 !== t.t1) {
      throw new Error('the lock on Ting names another account, hash or T1 than yours: your page does not claim');
    }
  }
  await once(`claim:${t.n}`, async () => {
    const secret = K.secretAt(K.seed(), t.n);
    const id = await sendOwn(H.claimInput(d.id, secret));
    update(t, { claimTx: { id, at: now(), sends: (t.claimTx?.sends ?? 0) + 1 } });
  });
}

/**
 * The take the accept was for: the one this browser made the accept link
 * for, or else the first matching take whose output pays the script rebuilt
 * from it at least the wanted amount, or else the first matching one. A dust
 * take, or a copy, with the same taker, hash and T1 posted before it is not it.
 */
function acceptedTake(d, t = d.seller) {
  if (!d.accepted) return null;
  const matching = d.takes.filter((x) => x.lockOf && matchesAccept(x, d.accepted));
  const pays = (x) => {
    const lock = lockScript(d.terms, x);
    const o = lock && outOf(lock.txid, lock.vout);
    return Boolean(o && !o.missing && o.script === hex(lock.scriptPubKey) && BigInt(o.value) >= BigInt(d.terms.want));
  };
  return matching.find((x) => t?.accepting?.[outKey(x.lockOf)]) ?? matching.find(pays) ?? matching[0] ?? null;
}

function checkTakeAny(terms, take) {
  const lock = lockScript(terms, take);
  if (!lock) return null;
  const o = outOf(lock.txid, lock.vout);
  if (!o || o.missing || o.script !== hex(lock.scriptPubKey)) return null;
  return { ...lock, out: o, key: outKey(lock) };
}

/** The accepted lock as Litecoin has it, ready to claim: its script, output and value; null until read. */
function acceptedLock(d, t = d.seller) {
  const take = acceptedTake(d, t);
  return take ? checkTakeAny(d.terms, take) : null;
}

/** The LTC claims this browser sent for a listing's accepted lock. */
const claimsOf = (t, key) => Object.values(t.ltcClaims ?? {}).filter((s) => (s.key ?? s.covers?.[0]) === key);

/**
 * The seller's page, by itself: once the listing is accepted or withdrawn, it
 * releases the other locks. Once the claim on Ting shows the secret, it claims
 * the accepted lock, and that one alone, to the payout address: the seller
 * agreed to that output, and whatever else is at the lock address is the
 * buyer's. A claim an explorer lost it sends again; one Litecoin refuses
 * outright it gives up, and claims anew. The listing is done once the accepted
 * lock is spent in a block, whoever spent it.
 */
async function autoSeller(d, t, { ting = true } = {}) {
  // Releases are sent on Ting: not while Ting cannot be read. The claim below needs only the claim already seen.
  if (ting && (d.accepted || d.withdrawn)) await releaseOthers(d, t);
  if (!d.claimed) {
    // Until the buyer claims, the accepted lock's signed claim stays on Ting, for whoever sends it then.
    if (ting && d.accepted && t.payout && now() <= d.accepted.deadline) {
      const c = acceptedLock(d, t);
      if (c && !c.out.spent) await keepSignedClaim(d, t, c);
    }
    return;
  }
  const c = acceptedLock(d, t);
  if (!c) return;
  if (c.out.spent) {
    if (c.out.spenderConfirmed && !t.doneIn?.[d.id]) update(t, { doneIn: { ...(t.doneIn ?? {}), [d.id]: true } });
    return;
  }
  const sent = claimsOf(t, c.key);
  // The claim signed at the accept, finished with the secret now public: the same transaction the buyer's page or a watchtower sends.
  const ahead = sent.find((s) => s.signed && !s.hex && !s.dead);
  if (ahead) {
    await once(`ltc-claim:${c.key}`, async () => {
      let tx = null;
      try {
        const posted = L.decodeSignedClaim(unhex(ahead.signed.data));
        tx = L.finishClaim({ txid: c.txid, vout: c.vout, value: c.out.value, htlc: c.htlc, out: posted.out, signature: posted.signature, secret: d.claimed.secret });
        update(t, { ltcClaims: { ...t.ltcClaims, [ahead.txid]: { ...ahead, hex: tx.hex, at: now(), first: now() } } });
        await broadcast(tx.hex);
        update(t, { ltcClaimError: null });
        toast('Your page sent your signed LTC claim.', 'success', 8000);
      } catch (e) {
        // One that cannot be finished, or that Litecoin refuses outright, is given up: the page claims anew.
        const dead = !tx || e.refused ? e.message : null;
        update(t, { ltcClaims: { ...t.ltcClaims, [ahead.txid]: { ...t.ltcClaims[ahead.txid], at: now(), dead } }, ltcClaimError: e.message });
      }
    });
    return;
  }
  for (const s of sent) {
    if (s.dead || !s.hex) continue;
    const st = app.lt.txs.get(s.txid);
    if (!st || st.found || now() - s.at < RESEND_AFTER) continue;
    await once(`ltc-claim:${s.txid}`, async () => {
      try {
        await broadcast(s.hex);
        update(t, { ltcClaims: { ...t.ltcClaims, [s.txid]: { ...s, at: now() } } });
      } catch (e) {
        update(t, { ltcClaims: { ...t.ltcClaims, [s.txid]: { ...s, at: now(), dead: e.refused ? e.message : null } }, ltcClaimError: e.message });
      }
    });
  }
  if (!t.payout || sent.some((s) => !s.dead)) return;
  await once(`ltc-claim:${c.key}`, async () => {
    const rate = await feeRate();
    try {
      const tx = L.claimTx({
        txid: c.txid, vout: c.vout, value: c.out.value, htlc: c.htlc, secret: d.claimed.secret,
        key: K.keyAt(K.seed(), t.n), to: t.payout, feeRate: rate, network: app.net,
      });
      await broadcast(tx.hex);
      update(t, {
        ltcClaims: { ...(t.ltcClaims ?? {}), [tx.txid]: { txid: tx.txid, hex: tx.hex, fee: tx.fee, value: c.out.value - tx.fee, rate, key: c.key, listing: d.id, at: now(), first: now() } },
        ltcClaimError: null,
      });
      toast('Your page claimed the LTC on Litecoin.', 'success', 8000);
    } catch (e) {
      update(t, { ltcClaimError: e.message });
    }
  });
}

/** Whether a seller's trade knows which listing with its key is its own: Ting ID reported the transaction or the account that made it. */
const pinned = (t) => Boolean(t?.listedTx || t?.maker);

/**
 * What the page reads of Litecoin for one listing, `t` the trade this browser
 * has in it, if any:
 * - `first`, read every round: the accepted lock's output of the trade on
 *   screen, of a buyer's listing, or of a seller's own listing, known to be
 *   its own; the buyer's address and own take; the page's own transactions;
 * - `followed`: the accepted lock of every other listing with a seller's key,
 *   a copy, which holds nothing of the seller's, or the seller's own listing
 *   when the page cannot tell which is its own: a few a round, in turns;
 * - `rest`: every other take's lock, copies of the accepted take included, a
 *   few a round.
 */
function needsOf(d, t) {
  const first = { outs: [], addresses: [], txs: [] };
  const followed = [];
  const rest = [];
  if (!d.terms || !forThisPage(d.terms)) return { first, followed, rest };
  const seller = t?.role === 'seller' ? t : null;
  const own = t?.role === 'buyer' ? takeOfBuyer(d, t) : null;
  const accepted = acceptedTake(d, seller ?? d.seller);
  const sure = !seller || (d.id === seller.listing && pinned(seller)) || d.id === app.viewing;
  for (const take of d.takes) {
    const lock = lockScript(d.terms, take);
    if (!lock) continue;
    if (take === own || (take === accepted && sure)) first.outs.push([lock.txid, lock.vout]);
    else if (take === accepted) followed.push(lock);
    // After an accept, the other takes matter only to the seller, who releases them.
    else if (!d.accepted || seller) rest.push(lock);
  }
  if (t?.role === 'buyer' && t.address) first.addresses.push(t.address);
  for (const s of Object.values(t?.ltcClaims ?? {})) if (s.txid) first.txs.push(s.txid);
  if (t?.releaseTx?.txid) first.txs.push(t.releaseTx.txid);
  if (t?.sellerClaim?.txid) first.txs.push(t.sellerClaim.txid);
  for (const r of Object.values(t?.refundTxs ?? {})) if (r.txid) first.txs.push(r.txid);
  return { first, followed, rest };
}

/**
 * Which of these locks to read this round: at most `cap`, those never read
 * first, then those read longest ago. A lock missing from Litecoin is read
 * again only after MISSING_AGAIN; an output that pays none of the scripts its
 * takes name, or is spent in a block, never again. Takes and copied listings
 * cost little to make: however many there are, they take at most `cap` reads
 * a round, and each gets its turn.
 */
function pickRest(locks, cap = OTHER_READS) {
  const byKey = new Map();
  for (const lock of locks) byKey.set(outKey(lock), [...(byKey.get(outKey(lock)) ?? []), lock]);
  const due = [];
  for (const [key, group] of byKey) {
    const o = app.lt.outs.get(key);
    let when;
    if (!o) when = 0;
    else if (o.missing) when = now() - o.at > MISSING_AGAIN ? o.at : null;
    else if (!group.some((l) => o.script === hex(l.scriptPubKey))) when = null;
    else if (o.spent && o.spenderConfirmed) when = null;
    else when = o.at ?? 0;
    if (when != null) due.push([when, group[0]]);
  }
  return due.sort((a, b) => a[0] - b[0]).slice(0, cap).map(([, l]) => [l.txid, l.vout]);
}

/** Whether a listing of a trade of this browser still has something for the page to do or watch. */
function isActive(d, t) {
  if (!d.terms) return true;
  if (t.role === 'seller') {
    const own = d.id === t.listing;
    if (t.doneIn?.[d.id] || t.droppedIn?.[d.id] || (own && t.done) || d.refunded) return false;
    return !(d.withdrawn && !d.accepted && (t.releasedIn?.[d.id] || (own && t.releasedAll)));
  }
  return !t.finished;
}

/**
 * One round of reading and acting: Ting, then Litecoin for every open listing
 * of this browser's trades and the trade on screen, then each one's automatic
 * steps, whatever the view. One listing's failure is that listing's alone.
 * What needs no fresh read of one chain runs while that chain cannot be read:
 * the buyer's claim on Ting, and sending it again, without Litecoin; the
 * seller's LTC claim, and sending it again, without Ting, from the claim the
 * page already saw.
 */
async function round() {
  await refreshTing();
  const jobs = [];
  for (const t of myTrades()) {
    for (const id of listingsOf(t)) if (isActive(tradeOf(id), t)) jobs.push({ t, id });
  }
  const firsts = [];
  const followed = [];
  const rests = [];
  const add = (d, t) => {
    const n = needsOf(d, t);
    firsts.push(n.first);
    followed.push(...n.followed);
    rests.push(...n.rest);
  };
  for (const { t, id } of jobs) {
    try {
      add(tradeOf(id), t);
    } catch (e) {
      app.actionErrors.set(id, e.message);
    }
  }
  if (app.viewing != null && !jobs.some((j) => j.id === app.viewing)) {
    const d = tradeOf(app.viewing);
    try {
      add(d, d.seller ?? d.buyer);
    } catch { /* the view shows what it has */ }
  }
  const outs = new Map();
  for (const f of firsts) for (const [txidHex, vout] of f.outs) outs.set(`${txidHex}:${vout}`, [txidHex, vout]);
  // The followed listings' accepted locks take their turns ahead of other takes, so that a seller's own
  // listing among copies is read within a few rounds however many copies there are.
  for (const [txidHex, vout] of pickRest(followed.filter((l) => !outs.has(outKey(l))))) outs.set(`${txidHex}:${vout}`, [txidHex, vout]);
  const first = {
    outs: [...outs.values()],
    addresses: [...new Set(firsts.flatMap((f) => f.addresses))],
    txs: [...new Set(firsts.flatMap((f) => f.txs))],
  };
  await refreshLtc(first, { outs: pickRest(rests).filter(([txidHex, vout]) => !outs.has(`${txidHex}:${vout}`)) });
  app.readEvery = jobs.length || app.viewing != null ? TRADE_POLL : MARKET_POLL;
  if (!K.seed()) return;
  const tingRead = !app.tingError;
  const ltcRead = !app.lt.error;
  for (const job of jobs) {
    const fresh = () => myTrades().find((x) => x.n === job.t.n) ?? job.t;
    try {
      const t = fresh();
      if (t.role === 'buyer') await autoBuyer(tradeOf(job.id), t, { ltc: ltcRead, ting: tingRead });
      else if (ltcRead) await autoSeller(tradeOf(job.id), t, { ting: tingRead });
      if (ltcRead && tingRead) noteFinished(tradeOf(job.id), fresh());
      app.actionErrors.delete(job.id);
    } catch (e) {
      app.actionErrors.set(job.id, e.message);
    }
  }
}

/**
 * Marks what is over: a seller's withdrawn listing whose other locks are all
 * released, spent or not there; a listing whose accepted lock Litecoin still
 * has not seen when its T1 has passed, which nothing can claim any more (a
 * copy whose maker accepted a lock that does not exist, say); a buyer whose
 * part is over (the DLR claimed and buried, or the LTC back) with nothing left
 * at the lock address.
 */
function noteFinished(d, t) {
  if (!d.terms) return;
  if (t.role === 'seller') {
    if (d.accepted && !t.droppedIn?.[d.id] && app.lt.tip && app.lt.tip.mtp > d.accepted.t1) {
      const take = acceptedTake(d, t);
      const o = take && outOf(take.lockOf.txid, take.lockOf.vout);
      if (!take || o?.missing) update(t, { droppedIn: { ...(t.droppedIn ?? {}), [d.id]: true } });
    }
    if (!d.withdrawn || d.accepted || t.releasedIn?.[d.id]) return;
    const open = d.takes.some((x) => {
      const c = checkTake(d.terms, x);
      if (!c.lock) return false;
      if (!c.out) return true;
      return !c.out.missing && !c.out.spent && c.out.script === hex(c.lock.scriptPubKey) && !releaseOf(d, x);
    });
    if (!open) update(t, { releasedIn: { ...(t.releasedIn ?? {}), [d.id]: true } });
    return;
  }
  if (t.finished || !app.lt.utxos.has(t.address) || (app.lt.utxos.get(t.address) ?? []).length) return;
  const take = takeOfBuyer(d, t);
  const ours = take && matchesAccept(take, d.accepted);
  const done = (ours && d.claimed && depthOf(d.claimed.height) >= app.tconfs)
    || (t.releaseTx && app.lt.txs.get(t.releaseTx.txid)?.confirmed)
    || Object.values(t.refundTxs ?? {}).some((r) => app.lt.txs.get(r.txid)?.confirmed);
  if (done) update(t, { finished: true });
}

// ---- Routing ---------------------------------------------------------------

function route() {
  app.leave?.();
  app.leave = null;
  app.tick = null;
  app.onData = null;
  app.viewing = null;
  app.onPrice = null;
  const [, view, arg] = location.hash.split('/');
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (view || 'market')));
  const main = $('#view');
  main.className = '';
  main.painted = null;
  window.scrollTo(0, 0);
  if (view === 'sell') return renderSell(main);
  if (view === 'l' && /^\d+$/.test(arg ?? '')) return renderTrade(main, Number(arg));
  if (view === 'about') return renderAbout(main);
  if (view === 'backup') return renderBackup(main);
  return renderMarket(main);
}

/** Sets a view's HTML when it changed, so a refresh that changes nothing leaves the page alone. */
function paint(main, html, wire) {
  if (main.painted === html) return false;
  const open = new Set($$('details[data-keep][open]', main).map((el) => el.dataset.keep));
  main.innerHTML = html;
  main.painted = html;
  $$('details[data-keep]', main).forEach((el) => { if (open.has(el.dataset.keep)) el.open = true; });
  tickTimes();
  wire?.();
  return true;
}

const tradeLink = (id) => `${location.origin}${location.pathname}${location.search}#/l/${id}`;

function banners() {
  const out = [];
  if (DISCORD) {
    out.push(`<div class="callout warn">${icon('alert')}<div><b>You are inside Discord’s browser.</b> It can forget what this page keeps, your keys included.
      Open the link in Safari, Chrome or Firefox. <button class="link" data-copy="${esc(location.href)}" data-done="Link copied">Copy the link</button></div></div>`);
  }
  if (myTrades().length && !K.backedUp() && !location.hash.startsWith('#/backup')) {
    out.push(`<div class="callout warn">${icon('key')}<div><b>Save your backup code.</b> Your trades’ keys live only in this browser: clearing it loses them, and the coins they lock, unless you have the code. <a href="#/backup">Show my backup code</a></div></div>`);
  }
  for (const [id, message] of app.actionErrors) {
    if (app.viewing != null && app.viewing !== id) continue;
    out.push(`<div class="callout bad">${icon('alert')}<div><b>Your page could not act on listing #${int(id)} just now:</b> ${esc(message)}. It tries again with the next read.</div></div>`);
  }
  if (app.tingError) out.push(`<div class="callout bad">${icon('alert')}<div><b>Cannot read Ting right now.</b> ${esc(app.tingError)}. The page tries again every few seconds. <button class="link" data-retry>Retry now</button></div></div>`);
  return out.length ? `<div class="banners">${out.join('')}</div>` : '';
}

// ---- Market ----------------------------------------------------------------

/** A trade of this browser's in a few words: where it stands. */
function stepOf(t) {
  if (t.role === 'seller' && !t.listing) return { text: 'Waiting for you to approve the listing in Ting ID', tone: 'wait' };
  const d = tradeOf(t.listing);
  if (t.role === 'seller') {
    if (d.claimed) {
      const done = Object.values(t.ltcClaims ?? {}).some((c) => (c.listing ?? t.listing) === t.listing && app.lt.txs.get(c.txid)?.confirmed) || t.done || t.doneIn?.[t.listing];
      return done ? { text: 'Done: LTC claimed', tone: 'done' } : { text: 'The buyer claimed: your page claims the LTC', tone: 'act' };
    }
    if (d.refunded) return { text: 'Ended: DLR refunded to you', tone: 'off' };
    if (d.accepted) return now() > d.accepted.deadline ? { text: 'The buyer did not claim: get your DLR back', tone: 'act' } : { text: 'Accepted: waiting for the buyer to claim', tone: 'wait' };
    if (d.withdrawn) return { text: 'Withdrawn', tone: 'off' };
    const fresh = d.takes.filter((x) => !releaseOf(d, x));
    if (fresh.length) return { text: `${plural(fresh.length, 'lock')} posted: check and accept`, tone: 'act' };
    return { text: 'Listed: waiting for a buyer', tone: 'wait' };
  }
  const take = d.terms ? takeOfBuyer(d, t) : null;
  if (d.claimed && take && matchesAccept(take, d.accepted)) return { text: `Done: you got ${dlrPlain(d.claimed.paid)} ${app.dlr.symbol}`, tone: 'done' };
  if (t.releaseTx) return { text: 'Released: your LTC is back', tone: 'off' };
  if (t.refundTxs && Object.keys(t.refundTxs).length) return { text: 'Refunded: your LTC is back', tone: 'off' };
  if (!take && (t.takeTx?.failed || t.takeLate)) return { text: 'No take posted: your LTC comes back after its lock ends', tone: 'act' };
  if (!take) return t.takeTx ? { text: 'Payment seen: posting your take', tone: 'wait' } : { text: `Send ${ltcPlain(t.want)} LTC to your lock`, tone: 'act' };
  if (d.accepted && matchesAccept(take, d.accepted)) {
    return !t.claimTx && t.claimTooLate ? { text: 'Too late to claim safely: your LTC comes back', tone: 'act' } : { text: 'Accepted: your page claims the DLR', tone: 'act' };
  }
  if (releaseOf(d, take)) return { text: 'The seller released your lock: take your LTC back', tone: 'act' };
  if (d.accepted || d.withdrawn) return { text: 'Not accepted: your LTC comes back', tone: 'act' };
  return { text: 'Locked: waiting for the seller to accept', tone: 'wait' };
}

function marketRow(l) {
  const yours = Boolean(mine(l.id, 'seller'));
  const d = tradeOf(l.id);
  const locks = d.takes.filter((x) => !releaseOf(d, x)).length;
  const forOne = !H.isZero(l.taker);
  // What the buyer's page refuses to lock for: offered as a view, not as a buy.
  const refused = l.window < H.MIN_WINDOW ? `held only ${span(l.window)} once accepted: too short to claim safely`
    : BigInt(l.fee) * 1000n > BigInt(l.amount) ? 'its claim pays more than a thousandth in fees' : '';
  return `<article class="listing ltc-row${yours ? ' own' : ''}" data-id="${l.id}">
    <a class="listing-link" href="#/l/${l.id}" aria-label="Listing ${l.id}"></a>
    <div class="leg get"><span class="label">You get</span>${dlr(l.amount)}</div>
    <div class="leg pay"><span class="label">You pay</span>${ltc(l.want)}${usd(l.want)}</div>
    <div class="leg rate"><span class="label">Rate</span><span class="rate-text">${rateText(l.amount, l.want)}</span></div>
    <div class="leg meta"><span class="label">#${l.id} · held ${span(l.window)} once accepted</span><span class="meta-line">${yours ? '<span class="badge mine">Your listing</span>' : who(l.maker)}${forOne ? `<span class="badge for-one" title="Only ${hex(l.taker)} can take it">For one buyer</span>` : ''}${locks ? `<span class="badge taken">${plural(locks, 'lock')}</span>` : ''}${refused ? `<span class="badge refused" title="${esc(refused)}">Not buyable here</span>` : ''}</span></div>
    <div class="leg act">${yours ? `<a class="button" href="#/l/${l.id}">Open</a>` : refused ? `<a class="button" href="#/l/${l.id}">View</a>` : `<a class="button primary" href="#/l/${l.id}">Buy with LTC</a>`}</div>
  </article>`;
}

function renderMarket(main) {
  main.className = 'market';
  const draw = () => {
    const open = [...app.listings.values()];
    const ours = open.filter(forThisPage).sort((a, b) => {
      const x = a.want * b.amount, y = b.want * a.amount;
      return x < y ? -1 : x > y ? 1 : a.id - b.id;
    });
    const others = open.length - ours.length;
    const swaps = app.events.filter((e) => e.kind === 'claimed').length;
    const best = ours[0];
    const trades = myTrades().slice().sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
    let book;
    if (!app.loaded) {
      book = '<div class="empty"><span class="spinner big"></span><p class="muted">Reading the listings…</p></div>';
    } else if (ours.length) {
      book = `<div class="list">${ours.map(marketRow).join('')}</div>`;
    } else {
      book = `<div class="empty">${icon('swap')}<h2>No DLR listed for LTC yet</h2>
        <p class="muted">Sell some: say how much DLR, and how much LTC you want for it.</p>
        <a class="button primary" href="#/sell">Sell DLR for LTC</a></div>`;
    }
    paint(main, `${banners()}
      <header class="page-header">
        <div>
          <h1>DLR for Litecoin</h1>
          <p>The buyer locks LTC on Litecoin, the seller locks DLR on Ting, and one secret settles both: nobody sends
          first, and if anything stalls, both get their coins back.</p>
        </div>
        <div class="page-actions"><a class="button ghost" href="#/about">How it works</a><a class="button primary" href="#/sell">${icon('plus')} Sell DLR for LTC</a></div>
      </header>
      <dl class="stats">
        <div><dt>Open listings</dt><dd>${app.loaded ? ours.length.toLocaleString() : '…'}</dd></div>
        <div><dt>Swaps done</dt><dd>${swaps.toLocaleString()}</dd></div>
        <div><dt>Best rate</dt><dd class="small">${best ? `${rate(best.want, 8, best.amount, app.dlr.decimals, 5)} ${esc(app.dlr.symbol)}<span class="muted"> / LTC</span>` : '—'}</dd></div>
        <div><dt>Your trades</dt><dd>${trades.length.toLocaleString()}</dd></div>
      </dl>
      ${trades.length ? `<section class="board my-trades">
        <header class="section-head"><h2>Your trades</h2><span class="muted">In this browser. <a href="#/backup">Backup code</a></span></header>
        <div class="trade-rows">${trades.map((t) => {
          const s = stepOf(t);
          const d = t.listing ? tradeOf(t.listing) : null;
          const amount = t.role === 'seller' ? (d?.terms?.amount ?? BigInt(t.amount ?? 0)) : d?.terms?.amount;
          const want = t.role === 'seller' ? (d?.terms?.want ?? BigInt(t.want ?? 0)) : BigInt(t.want ?? 0);
          if (!t.listing) {
            return `<div class="trade-row pending">
              <span class="role seller">Selling</span>
              <span class="what">${dlr(BigInt(t.amount))} <span class="muted">for</span> ${ltc(BigInt(t.want))}</span>
              <span class="step wait">${esc(s.text)}</span>
              <span class="row"><button class="primary" data-reoffer="${t.n}">Open in Ting ID again</button><button data-discard="${t.n}">Discard</button></span>
            </div>`;
          }
          return `<a class="trade-row" href="#/l/${t.listing}">
            <span class="role ${t.role}">${t.role === 'seller' ? 'Selling' : 'Buying'}</span>
            <span class="what">${t.listing ? `#${t.listing} · ` : ''}${amount != null ? dlr(amount) : '…'} <span class="muted">for</span> ${ltc(want)}</span>
            <span class="step ${s.tone}">${esc(s.text)}</span>
          </a>`;
        }).join('')}</div>
      </section>` : ''}
      <section class="board">
        <header class="section-head"><h2>DLR for LTC</h2><span class="muted">Best rate first${others ? ` · ${plural(others, 'other listing')} for other coins or chains not shown` : ''}</span></header>
        ${book}
      </section>`, () => wireCommon(main));
  };
  draw();
  app.onData = draw;
}

function wireCommon(main) {
  $$('[data-retry]', main).forEach((b) => (b.onclick = () => read()));
  $$('[data-reoffer]', main).forEach((b) => (b.onclick = () => guard(async () => {
    const t = myTrades().find((x) => x.n === Number(b.dataset.reoffer));
    if (t && !t.listing) await offer(t);
  })));
  $$('[data-discard]', main).forEach((b) => (b.onclick = () => guard(async () => {
    await refreshTing();
    const t = myTrades().find((x) => x.n === Number(b.dataset.discard));
    if (!t || t.listing) return app.onData?.();
    K.dropTrade(app.program, t.n);
    toast('Discarded. If you approve that link in Ting ID later anyway, the listing still shows up here.', 'info', 6000);
    app.onData?.();
  })));
}

// ---- Sell ------------------------------------------------------------------

/** How many times what a claim pays now a listing's fee is: generous, so that the claim goes in even if fees rise while the trade runs. */
const FEE_MARGIN = 3n;

/**
 * The run fee a listing gets, which its buyer's claim, or a refund, pays
 * exactly: three times what a claim pays now, and at least 0.00001 DLR, so
 * that a claim pays something even when nothing paid a fee lately; never more
 * than a thousandth of what it sells, the program's limit (HTLC.md). The seller
 * approves it with the offer.
 */
function runFee(amount) {
  if (!(amount > 0n)) return 0n;
  const least = 10n ** BigInt(app.dlr.decimals) / 100_000n;
  const rate = twoDigits(FEE_MARGIN * (app.claimRate ?? 0n));
  const fee = rate > least ? rate : least;
  const most = amount / 1000n;
  return fee < most ? fee : most;
}

function renderSell(main) {
  main.className = 'new';
  const form = { amount: '', want: '', payout: '', hours: '12', taker: '' };
  const draw = () => {
    main.innerHTML = `${banners()}
      <a class="back" href="#/">${icon('back')} Market</a>
      <div class="new-grid">
        <form class="ticket composer" id="sell-form" autocomplete="off" novalidate>
          <div class="eyebrow">Sell DLR for LTC</div>
          <h1>What do you sell?</h1>
          <div class="field-block">
            <label for="sell-amount">You sell</label>
            <div class="amount-row"><input id="sell-amount" name="amount" inputmode="decimal" placeholder="0.0" value="${esc(form.amount)}"><span class="unit-tag">${dlrMark()} ${esc(app.dlr.symbol)}</span></div>
          </div>
          <div class="field-block">
            <label for="sell-want">You want</label>
            <div class="amount-row"><input id="sell-want" name="want" inputmode="decimal" placeholder="0.0" value="${esc(form.want)}"><span id="want-usd"></span><span class="unit-tag">${ltcMark} LTC</span></div>
          </div>
          <label class="field wide-field"><span>Your Litecoin address, to be paid</span>
            <input id="sell-payout" name="payout" class="mono" placeholder="${addressHint()}" value="${esc(form.payout)}" spellcheck="false">
            <span class="hint" id="payout-hint">Your page claims the LTC to this address by itself.</span></label>
          <details class="owner"${form.taker || form.hours !== '12' ? ' open' : ''}><summary>More options</summary>
            <label class="field"><span>Lock window, hours</span><input id="sell-hours" name="hours" type="number" min="${H.MIN_WINDOW / 3600}" max="${H.MAX_WINDOW / 3600}" step="1" value="${esc(form.hours)}">
              <span class="hint">How long the DLR wait for the buyer once you accept.</span></label>
            <label class="field wide-field"><span>Only for one buyer</span><input id="sell-taker" name="taker" class="mono" placeholder="Their Ting account, or leave empty for anyone" value="${esc(form.taker)}" spellcheck="false"></label></details>
          <div class="preview" id="preview"></div>
          <button class="primary large wide" id="list" type="submit">${icon('key')} List with Ting ID</button>
          <p class="hint usd-note" id="usd-note"></p>
        </form>
        <aside class="side">
          <div class="card steps">
            <h2>How selling works</h2>
            <ol>
              <li><span><b>You list.</b> Your DLR wait in the swap program.</span></li>
              <li><span><b>A buyer locks the LTC.</b> Your page checks it, and you accept.</span></li>
              <li><span><b>Both pages claim.</b> The buyer gets the DLR, you get the LTC.</span></li>
            </ol>
            <p class="hint">Until you accept, you can withdraw. Save your <a href="#/backup">backup code</a>: this browser keeps the trade’s key.</p>
          </div>
        </aside>
      </div>`;
    wire();
    preview();
  };
  const values = () => {
    const amount = parseAmount(form.amount, app.dlr.decimals);
    const want = parseAmount(form.want, 8);
    const hours = Number(form.hours);
    const fee = runFee(amount);
    const taker = form.taker.trim() ? accountOf(form.taker) : null;
    const problems = [];
    if (form.amount && !(amount > 0n)) problems.push(`The DLR amount is a number with at most ${app.dlr.decimals} decimals.`);
    if (form.want && !(want > 0n)) problems.push('The LTC amount is a number with at most 8 decimals.');
    if (want > BigInt(L.MAX_MONEY)) problems.push('That is more LTC than there will ever be.');
    if (!Number.isInteger(hours) || hours * 3600 < H.MIN_WINDOW || hours * 3600 > H.MAX_WINDOW) problems.push(`The lock window is whole hours, from ${H.MIN_WINDOW / 3600} to ${H.MAX_WINDOW / 3600}: less would leave the buyer too little time to claim safely.`);
    if (form.taker.trim() && !taker) problems.push('The buyer’s account is 64 hex digits, or their ting:pay link.');
    const payoutProblem = addressProblem(form.payout);
    const ready = amount > 0n && want > 0n && !problems.length && form.payout.trim() && !payoutProblem;
    return { amount, want, hours, fee, taker, problems, payoutProblem, ready };
  };
  const preview = () => {
    const v = values();
    const box = $('#preview', main);
    const hint = $('#payout-hint', main);
    hint.classList.toggle('error', Boolean(v.payoutProblem));
    hint.textContent = v.payoutProblem ?? 'Your page claims the LTC to this address by itself.';
    $('#list', main).disabled = !v.ready;
    $('#want-usd', main).innerHTML = v.want > 0n && v.want <= BigInt(L.MAX_MONEY) ? usd(v.want) : '';
    $('#usd-note', main).innerHTML = usdNote();
    if (!(v.amount > 0n && v.want > 0n)) {
      box.innerHTML = v.problems.length && (form.amount || form.want) ? `<p class="hint error">${esc(v.problems.join(' '))}</p>` : '';
      return;
    }
    const call = H.offerCall({ taker: v.taker, chain: 'LTC', want: v.want, key: publicKey(new Uint8Array(32).fill(1)), window: v.hours * 3600, coin: app.coin, fee: v.fee ?? 0n });
    box.innerHTML = `<div class="preview-line"><span class="label">Rate</span><b>${rateText(v.amount, v.want)}</b></div>
      <div class="preview-line"><span class="label">Network fee</span><span>${dlr(v.fee)} <span class="muted">${!app.claimRate ? '· the least, as nothing paid fees lately' : twoDigits(FEE_MARGIN * app.claimRate) >= v.fee ? `· ${FEE_MARGIN}× what a claim pays now, paid by the buyer’s claim` : `· the least the page sets: a claim pays about ${dlrText(app.claimRate)} ${esc(app.dlr.symbol)} now`}</span></span></div>
      ${v.problems.length ? `<p class="hint error">${esc(v.problems.join(' '))}</p>` : ''}
      <details class="owner tech"><summary>What Ting ID will show</summary><p class="wallet-preview">${walletSentence(call.template, call.values, { amount: v.amount }, { key: '<b class="placeholder">33 bytes</b>' })}</p></details>`;
  };
  const wire = () => {
    for (const name of Object.keys(form)) {
      const input = $(`[name=${name}]`, main);
      if (input) input.oninput = (e) => { form[name] = e.target.value; preview(); };
    }
    $('#sell-form', main).onsubmit = (e) => {
      e.preventDefault();
      guard(() => sell(values(), form.payout.trim()));
    };
  };
  draw();
  app.onPrice = preview;
}

/** A Ting account from 64 hex digits or a ting:pay link, or null; never the zero account or the coin's reserved one. */
function accountOf(text) {
  const t = String(text ?? '').trim();
  const m = /^ting:(?:\/\/)?pay\?(.*)$/i.exec(t);
  const id = idOf(m ? new URLSearchParams(m[1]).get('to') : t);
  if (!id || H.isZero(id) || (H.isZero(id.subarray(0, 31)) && id[31] === 1)) return null;
  return id;
}

async function sell(v, payout) {
  if (!v.ready) return;
  await ensureSeed();
  const n = await freshCounter();
  const key = K.keyAt(K.seed(), n);
  const trade = K.saveTrade(app.program, {
    n, role: 'seller', listing: null, created: Date.now(), payout, amount: String(v.amount), want: String(v.want),
    window: v.hours * 3600, fee: String(v.fee), taker: v.taker ? hex(v.taker) : null,
  });
  await offer(trade, publicKey(key));
}

/** Hands a seller trade's offer to Ting ID; again, from its saved terms, when the first dialog was closed. */
async function offer(trade, pub = marksOf(trade.n).pub) {
  const call = H.offerCall({
    taker: trade.taker ? unhex(trade.taker) : null, chain: 'LTC', want: BigInt(trade.want), key: pub, window: trade.window,
    coin: app.coin, fee: BigInt(trade.fee),
  });
  await perform({
    call, pay: { coin: app.coin, to: app.vault, amount: BigInt(trade.amount) }, label: 'List DLR for LTC',
    notes: '<p class="hint">The key is this browser’s new Litecoin key for this trade: the LTC can be claimed only with it.</p>',
    done: (ok, executed) => {
      if (!ok) return;
      // The listing is the one this call made: its transaction, by the account that approved it.
      if (executed) pinListing(pub, executed.tx, executed.account);
      findMyListings();
      const t = myTrades().find((x) => x.n === trade.n);
      location.hash = t?.listing ? `#/l/${t.listing}` : '#/';
    },
  });
}

/**
 * The counter for a new trade. The program's events are read first: a
 * counter whose key a listed event already shows, or whose secret's hash a
 * taken event does, is skipped (a backup code used in two browsers, or a
 * restore that could not see a lock nobody took), and so is any a trade of
 * this browser holds. Never two locks with one secret.
 */
async function freshCounter() {
  await refreshTing();
  if (app.tingError) throw new Error(`Cannot read Ting to check this browser’s next key: ${app.tingError}`);
  const pubs = new Set(app.events.filter((e) => e.kind === 'listed').map((e) => hex(e.key)));
  const hashes = new Set(app.events.filter((e) => e.kind === 'taken').map((e) => hex(e.hash)));
  const s = K.seed();
  return K.takeCounter((n) => {
    const m = K.marksAt(s, n);
    return !m || pubs.has(hex(m.pub)) || hashes.has(hex(m.hash));
  });
}

// ---- One trade -------------------------------------------------------------

function renderTrade(main, id) {
  main.className = 'detail trade';
  const form = { receive: '', refund: '', payout: '', maker: '', holds: null };
  const draw = () => {
    const active = document.activeElement;
    if (active && main.contains(active) && active.matches('input, textarea')) return;
    paint(main, tradeHtml(id, form), () => wireTrade(main, id, form, draw));
  };
  app.viewing = id;
  app.readEvery = TRADE_POLL;
  draw();
  app.onData = draw;
  app.tick = tickTimes;
  // A trade opened from the market is read at once, not at the next round.
  read().catch(() => {});
}

function tickTimes() {
  $$('time[data-at]').forEach((el) => {
    const text = relative(Number(el.dataset.at));
    if (el.textContent !== text) el.textContent = text;
  });
}

function tradeHtml(id, form) {
  const d = tradeOf(id);
  if (!d.terms) {
    return app.loaded
      ? `<section class="notice"><h1>No listing #${id}</h1><p class="muted">${id > app.count ? `Listings count from 1; ${app.count ? `#${app.count} is the latest` : 'none is made yet'}.` : 'This node has no event of it.'}</p><a class="button" href="#/">Back to the market</a></section>`
      : '<section class="notice"><span class="spinner big"></span><p class="muted">Reading the listing…</p></section>';
  }
  const l = d.terms;
  if (!forThisPage(l)) {
    return `<section class="notice"><h1>Listing #${id} is not one for LTC in ${esc(app.dlr.symbol)}</h1><p class="muted">It is for ${esc(l.chain)}, in coin <code>${hex(l.coin)}</code>. This page trades DLR for LTC only, and makes no calls for it.</p><a class="button" href="#/">Back to the market</a></section>`;
  }
  const role = d.seller ? 'seller' : d.buyer ? 'buyer' : 'watcher';
  const status = d.claimed ? '<span class="badge open">Swapped</span>'
    : d.refunded ? '<span class="badge withdrawn">Refunded</span>'
      : d.accepted ? '<span class="badge taken">Accepted</span>'
        : d.withdrawn ? '<span class="badge withdrawn">Withdrawn</span>'
          : '<span class="badge open">Open</span>';
  const roleChip = role === 'seller' ? '<span class="role-chip seller">You are the seller</span>'
    : role === 'buyer' ? '<span class="role-chip buyer">You are the buyer</span>'
      : d.open && !d.accepted ? '<span class="role-chip buyer">Open to buy</span>' : '<span class="role-chip">Watching</span>';
  const panels = [];
  if (d.seller) panels.push(sellerPanel(d, d.seller, form));
  if (d.buyer) panels.push(buyerPanel(d, d.buyer, form));
  if (!d.seller && !d.buyer) panels.push(d.open && !d.accepted ? offerPanel(d, form) : watchPanel(d));
  const panelsHtml = panels.join('');
  const ltcNote = app.lt.error ? `<div class="callout bad">${icon('alert')}<div><b>Cannot read Litecoin right now.</b> ${esc(app.lt.error)}. The page tries again every few seconds. <button class="link" data-retry>Retry now</button></div></div>` : '';
  return `${banners()}${ltcNote}
    <a class="back" href="#/">${icon('back')} Market</a>
    <div class="detail-grid">
      <section class="ticket trade-ticket">
        <header><div><div class="eyebrow">Listing #${l.id} · ${roleChip}</div><h1>${dlr(l.amount)}</h1><p class="muted">for ${ltc(l.want)}${usd(l.want)}</p></div>${status}</header>
        <p class="hint terms-line">${rateText(l.amount, l.want)} · held ${span(l.window)} once accepted${H.isZero(l.taker) ? '' : ` · only for ${who(l.taker)}`}</p>
        ${role === 'watcher' ? endedBanner(d) : ''}
        ${role === 'watcher' && copiedBy(id) ? copyNote(copiedBy(id), form) : ''}
        ${role === 'seller' && !pinned(d.seller) && (d.seller.listings?.length ?? 0) > 1 ? whichIsYours(d.seller, form) : ''}
        ${panelsHtml}
        ${usdNote() ? `<p class="hint usd-note">${usdNote()}</p>` : ''}
      </section>
      <aside class="side">
        ${timelineCard(d)}
        ${deadlinesCard(d)}
        ${role === 'watcher' ? locksCard(d) : ''}
        ${panelsHtml.includes('data-share') ? '' : shareCard(d)}
      </aside>
    </div>`;
}

/** On a listing that names a seller trade's key without being its own. */
function copyNote(t, form) {
  const main = `<a href="#/l/${int(t.listing)}">#${int(t.listing)}</a>`;
  return `<div class="callout">${icon('key')}<div><b>This listing names your Litecoin key</b>, as your listing ${main} does, ${pinned(t) ? 'but another account made it' : 'and the page cannot tell which of them you made'}.
    Only its maker can accept a lock for it; if one is accepted and claimed, the LTC is paid to your key, and your page claims it for you, as it releases this listing’s other locks.${pinned(t) ? '' : ` If this one is yours, enter the Ting account you listed with on ${main}.`}</div></div>
    ${payoutField(t, form)}`;
}

/**
 * Asks the seller of a trade whose key several listings name, and whose own
 * listing the page cannot tell (after a restore without the account), for the
 * account they listed with.
 */
function whichIsYours(t, form) {
  const others = t.listings.filter((x) => x !== t.listing).map((x) => `<a href="#/l/${int(x)}">#${int(x)}</a>`).join(', ');
  return `<div class="callout warn">${icon('key')}<div><b>Other listings name this trade’s Litecoin key:</b> ${others}. Anyone can list again with a key, and this page cannot tell which listing you made: it shows the first, and acts for all of them. Enter the Ting account you listed with, and it picks yours.
    <div class="row inline-form"><input class="mono" name="maker" placeholder="64 hex digits, from Ting ID → Receive → Spending" value="${esc(form.maker ?? '')}" spellcheck="false"><button data-pin-maker>Pick mine</button></div></div></div>`;
}

function endedBanner(d) {
  if (d.withdrawn) return `<div class="callout">${icon('undo')}<div><b>Withdrawn</b> by the seller in block ${d.withdrawn.height}, ${esc(localTime(d.withdrawn.time))}. The ${esc(app.dlr.symbol)} went back to the seller’s account.</div></div>`;
  if (d.refunded) return `<div class="callout">${icon('undo')}<div><b>Refunded.</b> The buyer did not claim before the deadline, so the ${esc(app.dlr.symbol)} went back to the seller (block ${d.refunded.height}). The buyer gets their LTC back after their lock ends.</div></div>`;
  return '';
}

const panel = (title, body, tone = '') => `<div class="now-panel ${tone}"><h2>${title}</h2>${body}</div>`;
const nextLine = (text) => `<p class="next">${icon('clock')}<span>${text}</span></p>`;
const waiting = (text) => `<p class="waiting-line"><span class="spinner" aria-hidden="true"></span><span>${text}</span></p>`;

/**
 * The trade as plain text, for a chat or a message: what it offers, the LTC
 * in dollars while there is a recent price, the rate, where it stands, and its
 * link. Never a key or the secret, and never a dollar value for DLR.
 */
function shareText(d) {
  const l = d.terms;
  const sym = app.dlr.symbol;
  const p = livePrice();
  const dollars = p ? ` (≈ $${((Number(BigInt(l.want)) / 1e8) * p.usd).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : '';
  const acc = d.accepted;
  const own = d.buyer ? takeOfBuyer(d, d.buyer) : null;
  const live = d.takes.filter((x) => !releaseOf(d, x));
  let state;
  if (d.claimed) state = 'Done: both sides claimed.';
  else if (d.refunded) state = `Refunded: the buyer did not claim in time, and the ${sym} went back to the seller.`;
  else if (d.withdrawn) state = 'Withdrawn by the seller.';
  else if (acc) state = `Accepted: ${dlrPlain(acc.amount)} ${sym} are held for the buyer until ${utcTime(acc.deadline)}.`;
  else if (own) state = `${checkTake(l, own).words.replace(/^./, (c) => c.toUpperCase())}. Over to the seller to accept.`;
  else if (live.length) state = `${live.length === 1 ? 'A buyer has' : `${live.length} buyers have`} locked LTC: over to the seller to accept.`;
  else state = `Open. Nobody sends first: the buyer locks the LTC, then the seller locks the ${sym}.`;
  return [
    `${d.claimed ? 'Swap' : 'Listing'} #${l.id}: ${dlrPlain(l.amount)} ${sym} for ${ltcPlain(l.want)} LTC${dollars}`,
    d.claimed ? `Rate ${rateBack(l.amount, l.want)}` : `Rate ${rateBack(l.amount, l.want)}, held ${span(l.window)} once accepted`,
    state,
    tradeLink(d.id),
  ].join('\n');
}

const shareButton = (d) => `<button data-share data-copy="${esc(shareText(d))}" data-done="Copied: paste it in your chat">${icon('copy')} Copy for sharing</button>`;

// ---- The seller's side -----------------------------------------------------

function sellerPanel(d, t, form) {
  const l = d.terms;
  if (d.claimed) {
    // The other buyers' locks stay in view after the swap: the seller sees that each was released.
    const others = takeRows(d, { seller: true, skipAccepted: true });
    return sellerClaimedPanel(d, t, form) + (others ? panel('Other buyers’ locks', `<p class="hint">Your page released them, so those buyers can take their LTC back at once.</p>${others}`) : '');
  }
  if (d.refunded) return panel('Your DLR are back', `<p>The buyer did not claim in time, so the program sent the ${esc(app.dlr.symbol)} back to your account.</p>`, 'done');
  if (d.accepted) {
    const acc = d.accepted;
    const others = takeRows(d, { seller: true, skipAccepted: true });
    if (now() > acc.deadline) {
      return panel('The buyer did not claim in time', `<p>The deadline passed at ${when(acc.deadline)}, and the secret never appeared on Ting. Get your ${dlr(l.amount)} back; the buyer’s page refunds their LTC after their lock ends.</p>
        <div class="row"><button class="primary large" data-refund-dlr>${icon('undo')} Get your DLR back</button></div>
        ${nextLine('The refund needs no signature: the page sends it, and it is done in a block, a few seconds here.')}${others ? `<h3>Other buyers’ locks</h3>${others}` : ''}`, 'act');
    }
    const main = acceptedLock(d, t);
    const ahead = main && signedClaimOf(d, main, main.out);
    return panel('Waiting for the buyer to claim', `<p>${dlr(acc.amount)} are held for the buyer until ${when(acc.deadline)}.</p>
      ${waiting('Their page claims by itself. Then the LTC is claimed to your address.')}
      ${ahead ? `<p class="hint">Your signed LTC claim is on Ting, block ${ahead.height}: once the buyer claims, their page or a watchtower can send it to <code>${esc(t.payout)}</code> for you. It pays only that address.</p>`
        : t.signedClaimError ? `<div class="callout bad">${icon('alert')}<div><b>Your signed LTC claim is not on Ting yet:</b> ${esc(t.signedClaimError)}. Your page tries again.</div></div>` : ''}
      ${nextLine(ahead ? `If nobody sends it, your page does when you come back: come back before ${esc(localTime(acc.t1))} to be sure.` : `Keep this page open, or come back before ${esc(localTime(acc.t1))}.`)}
      ${payoutField(t, form)}
      <div class="row">${shareButton(d)}</div>
      ${others ? `<h3>Other buyers’ locks</h3><p class="hint">Your page releases them by itself, so that those buyers take their LTC back now.</p>${t.releaseError ? `<div class="callout bad">${icon('alert')}<div><b>A release did not go out:</b> ${esc(t.releaseError)}. Your page tries again.</div></div>` : ''}${others}` : ''}`, 'wait');
  }
  if (d.withdrawn) {
    const rows = takeRows(d, { seller: true });
    const toRelease = d.takes.some((x) => {
      const o = x.lockOf && outOf(x.lockOf.txid, x.lockOf.vout);
      return !releaseOf(d, x) && o && !o.missing && !o.spent;
    });
    return panel('You withdrew this listing', `<p>The ${dlr(l.amount)} are back in your account, block ${d.withdrawn.height}.</p>
      ${rows ? `<p>${toRelease ? 'Your page releases the buyers’ locks by itself, so they get their LTC back at once:' : 'The locks buyers posted for it:'}</p>${rows}` : ''}`, 'done');
  }
  const rows = takeRows(d, { seller: true });
  const share = `<div class="row">${shareButton(d)}</div>`;
  const withdraw = `<details class="owner" data-keep="withdraw"><summary>Withdraw the listing</summary><p class="hint">Your ${esc(app.dlr.symbol)} come back to the account that listed them. Ting ID signs it; anyone who locked LTC can still be released.</p><button data-withdraw>${icon('undo')} Withdraw with Ting ID</button></details>`;
  if (!rows) {
    return panel('Waiting for a buyer', `<p>Your listing is open. Share the link with a buyer.</p>
      ${share}
      ${waiting('Watching for a buyer’s LTC lock. The buyer always pays first.')}
      ${withdraw}`, 'wait');
  }
  return panel('A buyer locked LTC: check and accept', `<p>Your page checked each lock on Litecoin.</p>
    ${payoutField(t, form)}
    ${rows}
    ${nextLine(`Accepting holds your ${dlr(l.amount)} for that buyer for ${span(l.window)}. As you accept, your page signs the claim of the LTC to your address and posts it on Ting, so that it can be sent for you once the buyer claims.`)}
    ${share}${withdraw}`, 'act');
}

/** The takes of a listing, each with its check; for the seller with Accept and Decline. */
function takeRows(d, { seller = false, skipAccepted = false } = {}) {
  const rows = [];
  for (const take of d.takes) {
    const accepted = matchesAccept(take, d.accepted);
    if (skipAccepted && accepted) continue;
    const released = releaseOf(d, take);
    const c = checkTake(d.terms, take);
    const key = c.lock ? outKey(c.lock) : null;
    const sentRelease = Boolean(key && d.seller?.releases?.[key]);
    const linkOut = Boolean(key && linkHolds(d, d.seller, key));
    let line, tone;
    if (accepted) {
      line = 'Accepted'; tone = 'ok';
    } else if (released) {
      line = `Released in block ${released.height}: ${c.out?.spent ? 'the buyer took the LTC back' : 'the buyer can take the LTC back at once'}`; tone = 'off';
    } else if (sentRelease && seller) {
      line = 'Released by your page: waiting for a Ting block'; tone = 'off';
    } else {
      line = c.words; tone = c.state;
    }
    const lockThere = c.lock && c.out && !c.out.missing && !c.out.spent && c.out.script === hex(c.lock.scriptPubKey);
    const canRelease = seller && !accepted && !released && !sentRelease && !linkOut && lockThere;
    const canAccept = seller && !d.accepted && !d.withdrawn && !released && !sentRelease && c.state === 'ok';
    // Shown, but not usable yet, while the lock waits for its confirmations.
    const soon = seller && !d.accepted && !d.withdrawn && !released && !sentRelease && c.state === 'wait';
    const lockAddr = c.lock ? c.lock.address : null;
    rows.push(`<div class="take ${tone}">
      <div class="take-head"><span class="check-dot ${tone}" aria-hidden="true"></span><b>Lock ${take.index + 1}</b> <span class="muted">by ${who(take.taker)} · block ${take.height}</span></div>
      <p class="check-line ${tone}">${esc(line)}${!accepted && !released && (c.state === 'ok' || c.state === 'wait') ? usd(c.out.value) : ''}</p>
      ${seller && linkOut && !accepted ? `<p class="hint">${d.open ? 'You opened an accept link for this lock. While the listing is open, your page does not release it: that link can still be approved.' : `You opened an accept link for this lock. Your page releases it once the ${d.accepted ? 'accept' : 'withdrawal'} is ${app.tconfs} blocks deep, so that a reorganization cannot bring your accept of it back after its release.`}</p>` : ''}
      <details class="owner tech"><summary>Details</summary><dl class="mini">
        ${c.lock ? `<div><dt>Litecoin</dt><dd>${txid(c.lock.txid)} <span class="muted">output ${int(c.lock.vout)}</span></dd></div>` : ''}
        ${lockAddr ? `<div><dt>Lock address</dt><dd><code class="addr">${esc(lockAddr)}</code></dd></div>` : ''}
        <div><dt>Lock ends</dt><dd>${when(take.t1)}</dd></div>
        <div><dt>Take on Ting</dt><dd>${take.tx ? txid(take.tx) : '—'}</dd></div>
      </dl></details>
      ${canAccept || canRelease || soon ? `<div class="row">${canAccept ? `<button class="primary" data-accept="${take.index}">${icon('check')} Accept with Ting ID</button>` : soon ? `<button class="primary" disabled title="Usable once the lock has ${app.confs} confirmation${app.confs === 1 ? '' : 's'}">${icon('check')} Accept with Ting ID</button>` : ''}${canRelease ? `<button data-release="${take.index}">${d.accepted || d.withdrawn ? 'Release' : 'Decline and release'}</button>` : ''}</div>` : ''}
    </div>`);
  }
  return rows.length ? `<div class="takes">${rows.join('')}</div>` : '';
}

function payoutField(t, form) {
  if (t.payout) return '';
  return `<div class="callout warn">${icon('alert')}<div><b>Where should your LTC go?</b> This trade was restored from a backup code, which does not hold your payout address.
    <div class="row inline-form"><input class="mono" name="payout" placeholder="${addressHint()}" value="${esc(form.payout)}" spellcheck="false"><button data-save-payout>Save</button></div></div></div>`;
}

function sellerClaimedPanel(d, t, form) {
  const l = d.terms;
  const main = acceptedLock(d, t);
  const claims = main ? claimsOf(t, main.key).filter((c) => !c.dead) : [];
  const status = (c) => {
    const s = app.lt.txs.get(c.txid);
    if (s?.confirmed) return plural(ltcDepth(s.height), 'confirmation');
    if (s && !s.found) return 'not seen by the explorer: your page sends it again';
    return 'waiting for a block';
  };
  const lines = claims.map((c) => `<div><dt>LTC claim</dt><dd>${txid(c.txid)} <span class="muted">${ltcText(c.value)} LTC · ${status(c)}</span></dd></div>`).join('');
  const byUs = (spender) => claims.some((c) => c.txid === spender);
  if (!main) {
    const take = acceptedTake(d, t);
    const o = take && outOf(take.lockOf.txid, take.lockOf.vout);
    if (o?.missing) return panel('The accepted lock is not on Litecoin', `<p>The explorer has no output ${txid(take.lockOf.txid)}:${int(take.lockOf.vout)}. The page cannot claim it.</p>${(t.listings?.length ?? 0) > 1 ? payoutField(t, form) : ''}`, 'bad');
    return panel('The buyer claimed: reading the lock', `${waiting('Reading the accepted lock on Litecoin…')}`, 'act');
  }
  if (main.out.spent && !byUs(main.out.spender)) {
    const e = main.out;
    // Before T1 only the seller's key with the secret can spend the lock: a claim from another browser with this backup code.
    if (app.lt.tip && app.lt.tip.mtp <= d.accepted.t1) {
      return panel('Done: the LTC was claimed', `<p>The buyer got ${dlr(d.claimed.paid)} on Ting, and the lock was claimed with this trade’s key in ${txid(e.spender)} (${e.spenderConfirmed ? plural(ltcDepth(e.spenderHeight), 'confirmation') : 'waiting for a block'}): by a browser with your backup code.</p>
        <div class="row">${shareButton(d)}</div>`, 'done');
    }
    return panel('The LTC lock was spent by another transaction', `<p>The lock was spent by ${txid(e.spender)}, after the buyer’s lock ended: most likely the buyer’s refund.</p>`, 'bad');
  }
  if (!main.out.spent && !t.payout) return panel('The buyer claimed: where should your LTC go?', `<p>The secret is on Ting now. Your page claims the ${ltc(l.want)} as soon as it knows your address.</p>${payoutField(t, form)}`, 'act');
  if (main.out.spent && main.out.spenderConfirmed) {
    const done = claims.filter((c) => c.txid === main.out.spender);
    const got = done.reduce((s, c) => s + c.value, 0);
    return panel('Done: you have the LTC', `<p>The buyer got ${dlr(d.claimed.paid)} on Ting, and your LTC claim paid ${ltc(got)}${usd(got)} to <code>${esc(t.payout)}</code> (after a Litecoin fee of ${ltcText(done.reduce((s, c) => s + c.fee, 0))} LTC).</p>
      <dl class="lines mini-lines">${lines}</dl>
      <p class="hint">Your page claimed the lock you accepted, and only that: anything else at its address stays the buyer’s.</p>
      ${app.ltcWallet ? `<p class="hint">In this test setup, see it in the <a href="${esc(app.ltcWallet)}" target="_blank" rel="noopener">Litecoin regtest wallet</a> (Alice).</p>` : ''}
      <div class="row">${shareButton(d)}</div>`, 'done');
  }
  const slow = claims.find((c) => !app.lt.txs.get(c.txid)?.confirmed && now() - (c.first ?? c.at) > SLOW_CLAIM);
  return panel('The buyer claimed: claiming your LTC', `<p>The buyer’s claim revealed the secret on Ting in block ${d.claimed.height}. Your page uses it to claim the lock you accepted, ${ltc(main.out.value)}, to <code>${esc(t.payout)}</code>.</p>
    ${t.ltcClaimError ? `<div class="callout bad">${icon('alert')}<div><b>Litecoin refused the claim:</b> ${esc(t.ltcClaimError)}. The page tries again.</div></div>` : ''}
    ${slow ? `<div class="callout warn">${icon('clock')}<div><b>Your LTC claim has waited ${span(now() - (slow.first ?? slow.at))} for a Litecoin block.</b> It pays ${int(slow.rate) || 'the'} litoshi per vbyte; if Litecoin’s fees rose since, it can wait a long time. This page cannot speed it up: the claim does not signal replace-by-fee, and has no output of yours to pay more from. It must be in a block before the buyer’s lock ends, ${when(d.accepted.t1)}: after that, the buyer could refund the LTC instead.</div></div>` : ''}
    <dl class="lines mini-lines">${lines}</dl>
    ${waiting(claims.length ? (app.net === 'regtest' ? 'Waiting for a Litecoin block: here, whenever the regtest chain mines.' : 'Waiting for a Litecoin block: about 2.5 minutes.') : 'Building and sending the claim…')}`, 'act');
}

// ---- The buyer's side ------------------------------------------------------

/** Where a prospective buyer starts: their Ting account, an optional refund address, and the lock. */
function offerPanel(d, form) {
  const l = d.terms;
  const forOne = !H.isZero(l.taker);
  const others = d.takes.filter((x) => !releaseOf(d, x)).length;
  // Your claim pays the listing's fee out of what you get: refuse a listing
  // whose fee is above a thousandth of its coins, whatever program made it.
  if (BigInt(l.fee) * 1000n > BigInt(l.amount)) {
    return panel('Not a listing to buy', `<div class="callout bad">${icon('alert')}<div>A claim of this listing pays ${dlr(l.fee)} in network fees, out of the ${esc(app.dlr.symbol)} you would get. This page locks only for listings whose fee is at most a thousandth.</div></div>`, 'bad');
  }
  if (l.window < H.MIN_WINDOW) return shortWindowPanel(l);
  return panel(`Buy these ${dlrPlain(l.amount)} ${esc(app.dlr.symbol)} with ${ltcPlain(l.want)} LTC`, `
    <p>You lock ${ltc(l.want)} on Litecoin; the seller then locks the ${esc(app.dlr.symbol)} for you. If they never accept, you get your LTC back.</p>
    <p class="hint">Your claim pays a network fee of ${dlr(l.fee)}: you receive ${dlr(BigInt(l.amount) - BigInt(l.fee))}.</p>
    ${BigInt(l.fee) > 10n * runFee(BigInt(l.amount)) ? `<div class="callout warn">${icon('alert')}<div>This listing’s network fee, ${dlr(l.fee)}, is far more than a claim pays now. It comes out of what you get.</div></div>` : ''}
    ${forOne ? `<div class="callout">${icon('alert')}<div>This listing is for one buyer only: ${who(l.taker)}. Use that account, or the program refuses your take.</div></div>` : ''}
    ${others ? `<div class="callout warn">${icon('alert')}<div>${others === 1 ? 'One buyer has' : `${others} buyers have`} already locked LTC for this listing. The seller accepts only one; if they accept another, you get your LTC back.</div></div>` : ''}
    <label class="field wide-field"><span>Your Ting account, to receive the ${esc(app.dlr.symbol)}</span>
      <input name="receive" class="mono" placeholder="64 hex digits, or a ting:pay link" value="${esc(form.receive)}" spellcheck="false">
      <span class="hint" id="receive-hint">In Ting ID: Wallet → Receive → Spending. A ting:pay link works too.</span></label>
    <details class="owner"${form.refund ? ' open' : ''}><summary>Refund address (optional)</summary>
    <label class="field wide-field"><span>Your Litecoin address for refunds</span>
      <input name="refund" class="mono" placeholder="${addressHint()}" value="${esc(form.refund)}" spellcheck="false">
      <span class="hint" id="refund-hint">Only needed if the trade does not go through. You can add it later.</span></label></details>
    <div class="row"><button class="primary large" data-make-lock>${icon('lock')} Make my Litecoin lock</button></div>
    ${nextLine('Nothing is sent yet: next you get an address to pay from your own Litecoin wallet.')}`, 'act');
}

/**
 * A listing whose window is too short to claim in safely: Ting lets a
 * block's stamp run 2 hours ahead, and a late claim could be overtaken by the
 * seller's refund with the secret already public.
 */
function shortWindowPanel(l) {
  return panel('Not a listing to buy', `<div class="callout bad">${icon('alert')}<div>Once accepted, this listing holds the ${esc(app.dlr.symbol)} for only ${span(l.window)}.
    Ting lets a block’s time run up to 2 hours ahead, so a claim made late in a short window could be overtaken by the
    seller’s refund, with your secret already public. This page locks only for listings that hold the coins for at
    least ${span(H.MIN_WINDOW)}.</div></div>`, 'bad');
}

function buyerPanel(d, t, form) {
  const l = d.terms;
  const take = takeOfBuyer(d, t);
  const pay = paymentOf(t);
  const utxos = app.lt.utxos.get(t.address) ?? [];
  const mtp = app.lt.tip?.mtp ?? 0;
  const afterT1 = mtp > t.t1;
  if (t.acceptProblem) {
    return panel('The accept does not match your lock', `<div class="callout bad">${icon('alert')}<div><b>Refused.</b> ${esc(t.acceptProblem)} Your secret stays secret, so the seller cannot take your LTC. You get it back after your lock ends, ${when(t.t1)}.</div></div>${refundBlock(d, t, form, afterT1)}`, 'bad');
  }
  if (!take) {
    const closed = d.accepted || d.withdrawn || !d.open;
    if (closed && !utxos.length) {
      return panel('The listing closed before you paid', `<div class="callout warn">${icon('alert')}<div>The seller ${d.withdrawn ? 'withdrew the listing' : 'accepted another buyer'} before your payment arrived. <b>Do not pay your lock address now.</b></div></div>
        <div class="row"><button data-forget>Forget this lock</button></div>`, 'bad');
    }
    if (closed) {
      return panel('Your LTC is locked, but the listing closed', `<p>The seller ${d.withdrawn ? 'withdrew the listing' : 'accepted another buyer'} before your page could post your take. Your LTC comes back to you after your lock ends, ${when(t.t1)}.</p>${refundBlock(d, t, form, afterT1)}`, 'bad');
    }
    if (pay && (t.takeTx?.failed || t.takeLate)) {
      const why = t.takeTx?.failed ? `Ting refused it: ${esc(t.takeTx.failed)}.` : 'Your payment came too late for the seller to accept it in time.';
      return panel('Your LTC is locked, but no take was posted', `<p>${ltc(pay.value)} arrived at your lock, but your page could not tell Ting about it. ${why} Nobody can accept it, and the secret stays yours: your LTC comes back to you after your lock ends, ${when(t.t1)}.</p>
        <dl class="lines mini-lines"><div><dt>Litecoin</dt><dd>${txid(pay.txid)}</dd></div>${t.takeTx ? `<div><dt>Take on Ting</dt><dd>${txid(t.takeTx.id)}</dd></div>` : ''}</dl>
        ${refundBlock(d, t, form, afterT1)}`, 'bad');
    }
    if (pay) {
      const confirmed = pay.status.confirmed;
      return panel('Payment seen: posting your take', `<p>${ltc(pay.value)} arrived at your lock (${confirmed ? plural(ltcDepth(pay.status.block_height), 'confirmation') : 'not in a block yet'}). Your page now tells Ting where your lock is: a take, which needs no signature and no fee.</p>
        <dl class="lines mini-lines"><div><dt>Litecoin</dt><dd>${txid(pay.txid)}</dd></div>${t.takeTx ? `<div><dt>Take on Ting</dt><dd>${txid(t.takeTx.id)}</dd></div>` : ''}</dl>
        ${waiting('Waiting for the take to be in a Ting block: a few seconds here.')}`, 'wait');
    }
    const under = utxos.filter((u) => BigInt(u.value) < BigInt(t.want));
    const uri = `litecoin:${t.address}?amount=${ltcPlain(t.want)}`;
    let qr = '';
    try { qr = qrSvg(uri); } catch { /* too long */ }
    return panel(`Send exactly ${ltcPlain(t.want)} LTC to your lock`, `
      <div class="lockbox">
        ${qr ? `<div class="qr small-qr" aria-label="QR code of the payment link">${qr}</div>` : ''}
        <div class="lock-fields">
          <div class="lock-field"><span class="label">Amount</span><span class="lock-value">${ltc(t.want)}${usd(t.want)} <button class="copy" data-copy="${ltcPlain(t.want)}" data-done="Amount copied" aria-label="Copy the amount" title="Copy">${icon('copy')}</button></span></div>
          <div class="lock-field"><span class="label">To your lock address</span>${copyable(t.address, 'Lock address copied')}</div>
          <div class="row"><a class="button primary" href="${esc(uri)}">${icon('external')} Open in your Litecoin wallet</a><button data-copy="${esc(uri)}" data-done="Payment link copied">${icon('copy')} Copy payment link</button></div>
        </div>
      </div>
      <p><b>Pay it from your own Litecoin wallet</b>, in one payment, and nothing more: once your claim makes the secret public, the seller can take anything at this address, not only the lock they accepted.${app.ltcWallet ? ` In this test setup that is the <a href="${esc(app.ltcWallet)}" target="_blank" rel="noopener">Litecoin regtest wallet</a>: pick Bob, paste the payment link, send.` : ''}</p>
      ${under.length ? `<div class="callout bad">${icon('alert')}<div>${ltc(under[0].value)} arrived, less than the ${ltc(t.want)} wanted: the seller cannot accept it. If the trade does not go ahead, you refund it after ${when(t.t1)}. If you pay the full amount as well and it does go ahead, your claim makes the secret public, and with it the seller can take this payment too: a seller using this page claims only the lock they accepted, but nothing makes them.</div></div>${refundBlock(d, t, form, afterT1, { quiet: true })}` : ''}
      ${waiting('Watching Litecoin for your payment. Your page takes it from there.')}
      ${nextLine(`If the seller hasn’t accepted by ${esc(localTime(t.t1 - l.window - H.GAP))}, you take your LTC back.`)}
      <div class="row"><button class="link" data-forget>I changed my mind: forget this lock</button></div>`, 'act');
  }
  const lock = take.lockOf;
  const out = lock && outOf(lock.txid, lock.vout);
  const depth = out?.confirmed ? ltcDepth(out.height) : 0;
  const acc = d.accepted;
  const ours = acc && matchesAccept(take, acc);
  const ltcLines = `<div><dt>Your lock</dt><dd>${txid(lock.txid)} <span class="muted">${out?.missing ? 'not found' : `${plural(depth, 'confirmation')}`}</span></dd></div>
    <div><dt>Take on Ting</dt><dd>${txid(take.tx)} <span class="muted">block ${take.height}</span></dd></div>`;
  if (ours && d.claimed) {
    const buried = depthOf(d.claimed.height);
    const spent = out?.spent;
    // What else is at the lock address: a second payment, or dust. The secret is public now, so the seller can take it too.
    const left = utxos.filter((u) => u.txid !== lock.txid || u.vout !== lock.vout);
    const leftValue = left.reduce((n, u) => n + u.value, 0);
    return panel(buried >= app.tconfs ? `Done: you got ${dlrPlain(d.claimed.paid)} ${esc(app.dlr.symbol)}` : 'Claimed: being buried', `
      <p>${dlr(d.claimed.paid)} went to your account${d.claimed.fee ? `, after a ${dlrText(d.claimed.fee)} ${esc(app.dlr.symbol)} fee` : ''}.</p>
      <details class="owner tech"><summary>Details</summary><dl class="lines mini-lines">${ltcLines}<div><dt>Claim on Ting</dt><dd>${txid(d.claimed.tx)} <span class="muted">${buried >= app.tconfs ? `buried, ${buried} blocks deep` : `${buried} of ${app.tconfs} blocks deep`}</span></dd></div>
      ${spent ? `<div><dt>Seller’s LTC claim</dt><dd>${txid(out.spender)} <span class="muted">${out.spenderConfirmed ? plural(ltcDepth(out.spenderHeight), 'confirmation') : 'waiting for a block'}</span></dd></div>` : ''}</dl></details>
      ${buried < app.tconfs ? waiting('Your page keeps sending the claim until it is buried.')
        : nextLine(spent && out.spenderConfirmed ? 'The seller claimed the LTC. The swap is complete.'
          : spent ? 'The seller’s LTC claim is waiting for a Litecoin block; then the swap is complete.'
            : 'The seller’s page now claims the LTC. Your part is done.')}
      ${left.length ? `<div class="callout warn">${icon('alert')}<div>${ltc(leftValue)} ${left.length === 1 ? 'is' : 'are'} still at your lock address: a second payment, or an amount someone else sent there. Your claim made the secret public, so the seller can take it too; a seller using this page claims only the lock they accepted. If it is still there after your lock ends, ${when(t.t1)}, you can refund it.</div></div>${refundBlock(d, t, form, afterT1, { quiet: true })}` : ''}
      <div class="row">${shareButton(d)}</div>`, buried >= app.tconfs ? 'done' : 'wait');
  }
  if (ours) {
    const deep = depthOf(acc.height);
    if (now() > acc.deadline) {
      return panel('The deadline passed before your claim', `<p>The seller’s accept held the ${esc(app.dlr.symbol)} until ${when(acc.deadline)}. Your secret was never revealed, so the seller cannot take your LTC: it comes back to you after ${when(t.t1)}.</p>${refundBlock(d, t, form, afterT1)}`, 'bad');
    }
    if (!t.claimTx && (t.claimTooLate || acc.deadline - now() <= FIRST_CLAIM_BEFORE)) {
      return panel('Too close to the deadline to claim safely', `<p>The seller’s accept holds the ${esc(app.dlr.symbol)} until ${when(acc.deadline)}, and less than ${span(FIRST_CLAIM_BEFORE)} is left.
        Ting lets a block’s time run up to 2 hours ahead: a claim now could be overtaken by the seller’s refund, with your
        secret public, and the seller could then take your LTC too. So your page does not claim. Your secret stays yours,
        and your LTC comes back to you after your lock ends, ${when(t.t1)}.</p>${refundBlock(d, t, form, afterT1)}`, 'bad');
    }
    const claimLine = t.claimTx ? `<div><dt>Claim on Ting</dt><dd>${txid(t.claimTx.id)}</dd></div>` : '';
    const extra = utxos.filter((u) => u.txid !== lock.txid || u.vout !== lock.vout);
    return panel('The seller accepted: claiming your DLR', `
      <p>${dlr(acc.amount)} are held for you until ${when(acc.deadline)}.</p>
      <p class="hint">Claiming makes your secret public: from then on, the seller can take anything else at your lock address too, not only the lock they accepted.</p>
      ${extra.length ? `<div class="callout warn">${icon('alert')}<div>${ltc(extra.reduce((n, u) => n + u.value, 0))} more ${extra.length === 1 ? 'is' : 'are'} at your lock address. Once your page claims, the seller can take ${extra.length === 1 ? 'it' : 'them'} too; a seller using this page claims only the lock they accepted, and whatever is still there after your lock ends, ${when(t.t1)}, you can refund.</div></div>` : ''}
      <details class="owner tech"><summary>Details</summary><dl class="lines mini-lines">${ltcLines}${claimLine}</dl></details>
      ${t.claimTx?.failed ? `<div class="callout bad">${icon('alert')}<div><b>Ting refused the claim:</b> ${esc(t.claimTx.failed)}.</div></div>` : ''}
      ${deep < app.tconfs ? waiting(`Waiting for the accept to be ${app.tconfs} blocks deep before claiming (${deep} of ${app.tconfs}): a few seconds here.`) : waiting('Claiming: your page sends the claim, with your secret, and sends it again until it is in a block.')}
      `, 'act');
  }
  const released = releaseOf(d, take);
  if (released) return releasedPanel(d, t, take, released, form);
  if (acc || d.withdrawn) {
    return panel(acc ? 'The seller accepted another buyer' : 'The seller withdrew the listing', `<p>Your lock was not accepted. The seller’s page can release it so that you take your LTC back at once; otherwise it comes back to you after your lock ends, ${when(t.t1)}.</p>
      <dl class="lines mini-lines">${ltcLines}</dl>${refundBlock(d, t, form, afterT1)}`, 'bad');
  }
  // The lock as the seller's page checks it: one it cannot accept is said so, with the way back.
  const check = checkTake(l, take);
  if (check.state === 'bad') {
    return panel('The seller cannot accept your lock', `<div class="callout bad">${icon('alert')}<div>${esc(check.words.replace(/^./, (ch) => ch.toUpperCase()))}. Your LTC comes back to you after your lock ends, ${when(t.t1)}.</div></div>
      <details class="owner tech"><summary>Details</summary><dl class="lines mini-lines">${ltcLines}</dl></details>${refundBlock(d, t, form, afterT1)}`, 'bad');
  }
  const confsLeft = Math.max(0, app.confs - depth);
  return panel('Your LTC is locked: over to the seller', `
    <p>${ltc(out?.value ?? t.want)} locked, ${depth} of ${app.confs} confirmation${app.confs === 1 ? '' : 's'}${confsLeft ? '' : ', ready to accept'}.</p>
    ${waiting(`Waiting for the seller to accept, by ${esc(localTime(t.t1 - l.window - H.GAP))}.`)}
    ${nextLine(`Then your page claims the ${esc(app.dlr.symbol)} by itself. Keep this page open, or come back within ${span(l.window)}.`)}
    <details class="owner tech"><summary>Details</summary><dl class="lines mini-lines">${ltcLines}</dl></details>
    <div class="row">${shareButton(d)}</div>
    ${refundBlock(d, t, form, afterT1, { quiet: true })}`, 'wait');
}

function releasedPanel(d, t, take, released, form) {
  const lock = take.lockOf;
  const out = outOf(lock.txid, lock.vout);
  if (t.releaseTx) {
    const s = app.lt.txs.get(t.releaseTx.txid);
    return panel(s?.confirmed ? 'Your LTC is back' : 'Taking your LTC back', `<p>${s?.confirmed ? 'Done:' : 'Sent:'} ${ltc(t.releaseTx.value)}${usd(t.releaseTx.value)} to <code>${esc(t.releaseTx.to)}</code>.</p>
      <dl class="lines mini-lines"><div><dt>Release on Litecoin</dt><dd>${txid(t.releaseTx.txid)} <span class="muted">${s?.confirmed ? plural(ltcDepth(s.height), 'confirmation') : s && !s.found ? 'not seen by the explorer: your page sends it again' : 'waiting for a block'}</span></dd></div></dl>
      ${t.releaseTx.error && !s?.found ? `<div class="callout bad">${icon('alert')}<div><b>Litecoin did not take it again:</b> ${esc(t.releaseTx.error)}.</div></div>${refundBlock(d, t, form, app.lt.tip?.mtp > t.t1)}` : ''}
      ${s?.confirmed ? '' : waiting('Waiting for a Litecoin block.')}`, s?.confirmed ? 'done' : 'wait');
  }
  if (out?.spent) {
    // Unaccepted, the secret was never shown: only the buyer's own key can have spent it, with the release or after T1.
    return panel('Your LTC is back', `<p>Your lock was spent by ${txid(out.spender)} (${out.spenderConfirmed ? plural(ltcDepth(out.spenderHeight), 'confirmation') : 'waiting for a block'}), with your own key: taken back from a browser with your backup code.</p>`, 'done');
  }
  const why = d.accepted ? 'The seller accepted another buyer' : d.withdrawn ? 'The seller withdrew the listing' : 'The seller declined';
  return panel(`${why}: take your LTC back now`, `<p>The seller’s page released your lock in block ${released.height}: its signature lets your LTC go back to you at once, without waiting for ${esc(localTime(t.t1))}.</p>
    ${addressField(t, form)}
    <div class="row"><button class="primary large" data-take-back>${icon('undo')} Take my LTC back now</button></div>
    ${nextLine('Your page signs the other half and sends it to Litecoin. It is final after one Litecoin block.')}
    ${refundBlock(d, t, form, app.lt.tip?.mtp > t.t1, { quiet: true, field: false })}`, 'act');
}

function addressField(t, form) {
  return `<label class="field wide-field"><span>Your Litecoin address</span>
    <input name="refund" class="mono" placeholder="${addressHint()}" value="${esc(form.refund || t.refundTo || '')}" spellcheck="false">
    <span class="hint">Where your LTC goes back to.</span></label>`;
}

/**
 * The buyer's way back after T1: the refunds sent, with where each stands,
 * and while outputs in a block are left at the lock address, a button that
 * refunds them all in one transaction once T1 has passed by Litecoin's
 * median time; before that, when that is.
 */
function refundBlock(d, t, form, afterT1, { quiet = false, field = true } = {}) {
  const sent = Object.values(t.refundTxs ?? {});
  const lines = sent.length ? `<dl class="lines mini-lines">${sent.map((r) => {
    const s = app.lt.txs.get(r.txid);
    const where = s?.confirmed ? plural(ltcDepth(s.height), 'confirmation') : s && !s.found ? 'not seen by the explorer: your page sends it again' : 'waiting for a block';
    return `<div><dt>Refund on Litecoin</dt><dd>${txid(r.txid)} <span class="muted">${ltcText(r.value)} LTC · ${where}</span></dd></div>`;
  }).join('')}</dl>` : '';
  const known = app.lt.utxos.has(t.address);
  const left = refundable(d, t);
  if (known && !left.length) return lines;
  if (!afterT1) return lines + (quiet ? '' : nextLine(`After ${esc(localTime(t.t1))} (Litecoin goes by the median time of its last 11 blocks), a “Refund my LTC” button appears here.`));
  return `${lines}${field ? addressField(t, form) : ''}<div class="row"><button class="primary" data-refund-ltc>${icon('undo')} Refund my LTC</button></div>`;
}

function watchPanel(d) {
  const l = d.terms;
  const text = d.claimed ? `The buyer claimed ${dlr(d.claimed.paid)} in block ${d.claimed.height}; the seller’s page claims the LTC with the secret.`
    : d.accepted ? `The seller accepted a lock: ${dlr(l.amount)} are held for ${who(d.accepted.taker)} until ${when(d.accepted.deadline)}.`
      : d.withdrawn ? 'The seller withdrew it.' : d.refunded ? 'It ended with a refund.' : 'It is open.';
  const late = d.accepted && !d.claimed && !d.refunded && now() > d.accepted.deadline;
  return panel('You are watching this trade', `<p>${text} This page reads both chains for you; you do not take part.</p>
    ${late ? `<p>The deadline passed without a claim. Anyone may send the refund, which returns the ${esc(app.dlr.symbol)} to the seller.</p><div class="row"><button data-refund-dlr>${icon('undo')} Return the DLR to the seller</button></div>` : ''}`, '');
}

// ---- The side cards --------------------------------------------------------

function timelineCard(d) {
  const acc = d.accepted;
  const accTake = acceptedTake(d);
  const accOut = accTake?.lockOf ? outOf(accTake.lockOf.txid, accTake.lockOf.vout) : null;
  const ended = d.withdrawn || d.refunded;
  const liveTakes = d.takes.filter((x) => !releaseOf(d, x));
  const checks = liveTakes.map((x) => checkTake(d.terms, x));
  const ready = checks.find((c) => c.state === 'ok');
  const waitingPay = d.buyer && !takeOfBuyer(d, d.buyer);
  // Who acts and when; transaction ids are in the panel's details, not here.
  const step = (state, title, who_, when_) => `<li class="${state}"><span class="t-dot" aria-hidden="true">${state === 'done' ? icon('check') : ''}</span><div><b>${title}</b><span class="t-who">${who_}</span>${when_ ? `<span class="t-when">${when_}</span>` : ''}</div></li>`;
  const at = (e) => `Block ${e.height} · ${esc(localTime(e.time))}`;
  let lockedState = ended || (!d.open && !acc) ? 'off' : 'now';
  let lockedWhen = d.open ? 'Waiting for a buyer' : '';
  if (acc) {
    lockedState = 'done';
    lockedWhen = accTake ? `${at(accTake)}${accOut && !accOut.missing ? ` · ${ltcText(accOut.value)} LTC` : ''}` : '';
  } else if (ready) {
    lockedState = 'done';
    lockedWhen = `${esc(ready.words)}${liveTakes.length > 1 ? ` · ${plural(liveTakes.length, 'lock')} posted` : ''}`;
  } else if (liveTakes.length) {
    lockedWhen = `${plural(liveTakes.length, 'lock')} posted: ${esc(checks[0].words)}`;
  } else if (waitingPay) {
    lockedWhen = 'Waiting for your payment';
  } else if (d.takes.length) {
    lockedWhen = `Released by the seller${d.open ? '; waiting for another buyer' : ''}`;
  }
  const acceptState = acc ? 'done' : ended ? 'off' : ready ? 'now' : 'next';
  const dlrState = d.claimed ? 'done' : d.refunded || (acc && now() > acc.deadline) ? 'off' : acc ? 'now' : ended ? 'off' : 'next';
  const ltcDone = d.claimed && accOut?.spent;
  const ltcState = ltcDone && accOut.spenderConfirmed ? 'done' : d.claimed ? 'now' : dlrState === 'off' ? 'off' : 'next';
  const ids = [
    d.listed?.tx && ['Listed', txid(d.listed.tx)],
    accTake?.lockOf && ['LTC lock', txid(accTake.lockOf.txid)],
    acc?.tx && ['Accepted', txid(acc.tx)],
    d.claimed?.tx && [`${esc(app.dlr.symbol)} claim`, txid(d.claimed.tx)],
    ltcDone && ['LTC claim', txid(accOut.spender)],
    d.withdrawn?.tx && ['Withdrawn', txid(d.withdrawn.tx)],
    d.refunded?.tx && ['Refunded', txid(d.refunded.tx)],
  ].filter(Boolean);
  return `<div class="card timeline-card"><h2>Progress</h2><ol class="timeline">
    ${step('done', 'Listed', 'Seller', d.listed ? esc(localTime(d.listed.time)) : '')}
    ${step(lockedState, 'LTC locked', 'Buyer', lockedWhen)}
    ${step(acceptState, 'Accepted', 'Seller', acc ? esc(localTime(acc.time)) : ready ? 'Ready for the seller' : '')}
    ${step(dlrState, `${esc(app.dlr.symbol)} claimed`, 'Buyer’s page, by itself', d.claimed ? esc(localTime(d.claimed.time)) : acc ? `Before ${esc(localTime(acc.deadline))}` : '')}
    ${step(ltcState, 'LTC claimed', 'Seller’s page, by itself', ltcDone ? (accOut.spenderConfirmed ? `Litecoin block ${accOut.spenderHeight}` : 'Sent, waiting for a block') : acc ? `Before ${esc(localTime(acc.t1))}` : '')}
    ${d.withdrawn ? `<li class="end"><span class="t-dot" aria-hidden="true">${icon('undo')}</span><div><b>Withdrawn</b><span class="t-who">The ${esc(app.dlr.symbol)} went back to the seller</span><span class="t-when">${esc(localTime(d.withdrawn.time))}</span></div></li>` : ''}
    ${d.refunded ? `<li class="end"><span class="t-dot" aria-hidden="true">${icon('undo')}</span><div><b>Refunded</b><span class="t-who">No claim in time; the ${esc(app.dlr.symbol)} went back to the seller</span><span class="t-when">${esc(localTime(d.refunded.time))}</span></div></li>` : ''}
  </ol>${ids.length ? `<details class="owner tech"><summary>Transactions</summary><dl class="mini">${ids.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl></details>` : ''}</div>`;
}

function deadlinesCard(d) {
  const l = d.terms;
  const acc = d.accepted;
  if (d.claimed && acc) {
    return `<div class="card"><h2>${icon('clock')} Deadlines</h2><p class="hint deadline-met">${icon('check')} <span>Met: claimed ${span(acc.deadline - d.claimed.time)} before the deadline.</span></p></div>`;
  }
  if (d.withdrawn && !d.buyer) return '';
  const role = d.seller ? 'seller' : d.buyer ? 'buyer' : 'watcher';
  const live = d.takes.filter((x) => !releaseOf(d, x));
  const ownTake = d.buyer ? takeOfBuyer(d, d.buyer) : null;
  const released = ownTake && releaseOf(d, ownTake);
  const t1 = acc?.t1 ?? d.buyer?.t1 ?? (live.length === 1 ? live[0].t1 : null);
  const rows = [];
  rows.push(`<div><dt>${esc(app.dlr.symbol)} held for the buyer until</dt><dd>${acc ? when(acc.deadline) : `<span class="muted">Set when the seller accepts: then + ${span(l.window)}</span>`}</dd></div>`);
  const t1Label = role === 'buyer' ? 'Your LTC lock ends (T1)' : 'The buyer’s LTC lock ends (T1)';
  let t1Value = t1 ? when(t1) : '<span class="muted">Set by the buyer’s page when they lock</span>';
  if (!t1 && role === 'watcher' && d.open) t1Value = `<span class="muted">If you lock now:</span> ${when(Math.floor((now() + l.window + H.GAP + ACCEPT_TIME) / 60) * 60)}`;
  rows.push(`<div><dt>${t1Label}</dt><dd>${t1Value}</dd></div>`);
  if (!acc && t1 && !released && !d.withdrawn && (live.length || d.buyer)) {
    rows.push(`<div><dt>${role === 'seller' ? 'You can accept until' : 'The seller can accept until'}</dt><dd>${when(t1 - l.window - H.GAP - (role === 'seller' ? CHECK_MARGIN : 0))}</dd></div>`);
  }
  return `<div class="card"><h2>${icon('clock')} Deadlines</h2><dl class="lines deadlines">${rows.join('')}</dl></div>`;
}

function locksCard(d) {
  if (!d.takes.length) return '';
  return `<div class="card"><h2>Locks on Litecoin</h2><p class="hint">Every lock buyers posted for this listing, checked by this page exactly as the seller’s page checks it.</p>${takeRows(d)}</div>`;
}

function shareCard(d) {
  return `<div class="card share"><h2>${icon('link')} Share</h2>
    <p class="hint">An overview with this trade’s link, for a chat. Anyone can follow the trade with it; it holds no key or secret.</p>
    <div class="row">${shareButton(d)}</div></div>`;
}

// ---- The trade view's actions ------------------------------------------------

function wireTrade(main, id, form, draw) {
  wireCommon(main);
  for (const name of ['receive', 'refund', 'payout', 'maker']) {
    $$(`[name=${name}]`, main).forEach((input) => (input.oninput = (e) => {
      form[name] = e.target.value;
      if (name === 'receive') receiveHint(main, form);
      if (name === 'refund') refundHint(main, form);
    }));
  }
  if ($('[name=receive]', main) && form.receive) receiveHint(main, form);
  const on = (selector, action) => $$(selector, main).forEach((b) => (b.onclick = () => guard(() => action(b))));
  on('[data-make-lock]', () => makeLock(id, form));
  on('[data-accept]', (b) => accept(id, Number(b.dataset.accept)));
  on('[data-release]', (b) => release(id, Number(b.dataset.release)));
  on('[data-withdraw]', () => withdraw(id));
  on('[data-refund-dlr]', () => refundDlr(id));
  on('[data-take-back]', () => takeBack(id, form));
  on('[data-refund-ltc]', () => refundLtc(id, form));
  on('[data-save-payout]', () => savePayout(id, form));
  on('[data-pin-maker]', () => pinMaker(id, form));
  on('[data-forget]', () => forget(id));
  draw.wired = true;
}

let receiveRead = 0;

async function receiveHint(main, form) {
  const hint = $('#receive-hint', main);
  if (!hint) return;
  const account = accountOf(form.receive);
  const token = ++receiveRead;
  if (!form.receive.trim()) {
    hint.className = 'hint';
    hint.textContent = 'In Ting ID: Wallet → Receive → Spending, under “The account, to copy”. You can paste the ting:pay link from there too.';
    return;
  }
  if (!account) {
    hint.className = 'hint error';
    hint.textContent = 'A Ting account is 64 hex digits, or the ting:pay link Ting ID shows under Receive.';
    return;
  }
  try {
    const held = decodeCoinAccount(await app.node.record(app.coin, account));
    if (token !== receiveRead) return;
    hint.className = 'hint';
    hint.innerHTML = held.balance > 0n || held.nonce > 0n
      ? `${icon('check')} <span>${short(account)}: holds ${dlr(held.balance)}. The ${esc(app.dlr.symbol)} go here.</span>`
      : `${short(account)} has never held ${esc(app.dlr.symbol)}. That is fine for a new account: make sure it is the one Ting ID shows you.`;
  } catch {
    hint.className = 'hint';
    hint.textContent = `${short(account)}. The ${app.dlr.symbol} go here.`;
  }
}

function refundHint(main, form) {
  const hint = $('#refund-hint', main);
  if (!hint) return;
  const problem = addressProblem(form.refund);
  hint.className = problem ? 'hint error' : 'hint';
  hint.textContent = problem ?? 'Only needed if the trade does not go through. You can add it later.';
}

function addressProblem(text) {
  if (!String(text ?? '').trim()) return null;
  try {
    L.addressToScript(text.trim(), app.net);
    return null;
  } catch (e) {
    return `That is not a Litecoin ${app.net} address (${e.message.replace(/^not a valid address: /i, '')}).`;
  }
}

/** The buyer's lock: derives the secret and key, sets T1, keeps the trade, then shows where to pay. */
async function makeLock(id, form) {
  const receive = accountOf(form.receive);
  if (!receive) throw new Error('Enter the Ting account that receives the DLR: 64 hex digits, from Ting ID → Receive.');
  const refundProblem = addressProblem(form.refund);
  if (refundProblem) throw new Error(refundProblem);
  await refreshTing();
  const d = tradeOf(id);
  const l = d.open;
  if (!l || d.accepted) throw new Error('The listing was just accepted or withdrawn: there is nothing to lock for.');
  if (!forThisPage(l)) throw new Error('This listing’s Litecoin key is not one the page can lock to.');
  if (BigInt(l.fee) * 1000n > BigInt(l.amount)) throw new Error('This listing’s claim pays more than a thousandth of its coins in fees: the page does not lock for it.');
  if (l.window < H.MIN_WINDOW) throw new Error(`This listing holds the coins for only ${span(l.window)} once accepted: too short to claim safely. The page locks only for ${span(H.MIN_WINDOW)} or more.`);
  if (!H.isZero(l.taker) && !equal(l.taker, receive)) throw new Error(`This listing is for ${short(l.taker)} only: the program would refuse your take.`);
  if (d.seller) throw new Error('This is your own listing.');
  await ensureSeed();
  const n = await freshCounter();
  const m = marksOf(n);
  const t1 = now() + l.window + H.GAP + ACCEPT_TIME;
  const htlc = { tag: L.lockTag(app.program, id, receive), hash: m.hash, seller: l.key, buyer: m.pub, t1 };
  const { address } = L.lockOutput(htlc, app.net);
  K.saveTrade(app.program, {
    n, role: 'buyer', listing: id, created: Date.now(), receive: hex(receive), refundTo: form.refund.trim() || null,
    t1, address, want: String(l.want), amount: String(l.amount),
  });
  toast('Your lock is ready. Pay it from your own Litecoin wallet.', 'success', 5000);
  await read();
}

/**
 * Whether a lock this browser made an accept link for must stay unreleased
 * for now. While the listing is open the link can still be approved; once
 * another accept or a withdrawal closed it, a reorganization could still put
 * this browser's accept of the lock in its place, until that accept or
 * withdrawal is `tconfs` blocks deep. Other buyers' locks are not held back.
 */
function linkHolds(d, t, key) {
  if (!t?.accepting?.[key]) return false;
  const closing = d.accepted ?? d.withdrawn;
  return Boolean(d.open) || !closing || depthOf(closing.height) < app.tconfs;
}

/** Only a listing's maker can accept or withdraw it: once one of this browser's calls did, the listing is the trade's own. */
function pinFromCall(t, id, executed) {
  if (!t || pinned(t) || !executed?.account) return;
  const listed = tradeOf(id).listed;
  if (listed && equal(listed.maker, executed.account)) update(t, { maker: hex(executed.account), listedTx: listed.tx });
}

/** Whether this browser released, or sent a release of, the lock a take names. */
function releasedHere(d, take) {
  return Boolean(take.lockOf && d.seller?.releases?.[outKey(take.lockOf)]) || Boolean(releaseOf(d, take));
}

/**
 * The seller's accept, through Ting ID: refused for a lock this browser
 * released or sent a release of, and for one that does not pass the check,
 * read again from Litecoin now. The page notes which lock the link is for
 * before showing it: while the listing is open, it never releases that lock,
 * since the link can still be approved.
 */
async function accept(id, index) {
  const listing = H.decodeListing(id, await app.node.record(app.program, H.listingKey(id)));
  if (!listing) throw new Error('The listing is no longer open.');
  const d = tradeOf(id);
  const take = d.takes[index];
  if (!d.seller) throw new Error('This browser did not make this listing.');
  if (!take || !take.lockOf) throw new Error('That lock is gone.');
  if (releasedHere(d, take)) throw new Error('You released this lock: the buyer can take the LTC back with it. Not accepting it.');
  await refreshLtc({ outs: [[take.lockOf.txid, take.lockOf.vout]] });
  if (app.lt.error || app.lt.failed.has(outKey(take.lockOf))) throw new Error(`Cannot check the lock on Litecoin: ${app.lt.error ?? app.lt.failed.get(outKey(take.lockOf))}`);
  const c = checkTake(listing, take);
  if (c.state !== 'ok') throw new Error(`Not accepting: ${c.words}.`);
  if (!d.seller.payout) throw new Error('Enter your Litecoin payout address first: your page signs the claim of your LTC to it as you accept.');
  // Another accept link may still be approved: say what a second one means before showing it.
  const others = Object.keys(d.seller.accepting ?? {}).filter((k) => k !== outKey(take.lockOf) && d.takes.some((x) => x.lockOf && outKey(x.lockOf) === k));
  if (others.length && !(await askSecondLink(d, others))) throw new Quiet();
  // The claim, signed now, goes on Ting before the accept: once the buyer claims, it can be sent without this page.
  if (!signedClaimSent(d.seller, outKey(take.lockOf))) {
    try {
      await postSignedClaim(d, take);
    } catch (e) {
      throw new Error(`Not accepting yet: your page could not post your signed LTC claim on Ting (${e.message}). Try again.`);
    }
  }
  update(d.seller, { accepting: { ...(d.seller.accepting ?? {}), [outKey(take.lockOf)]: { at: now(), index } } });
  await perform({
    call: H.acceptCall(listing, take), feeCoin: app.coin, label: `Accept the lock for listing #${id}`,
    notes: `<p class="hint">Checked on Litecoin just now: ${esc(c.words)}. Ting ID shows the buyer’s account and the hash shortened, and the time their lock ends.</p>`,
    done: (ok, executed) => { if (ok) pinFromCall(d.seller, id, executed); app.onData?.(); },
  });
}

/**
 * Signs and posts the release of one lock the seller does not accept: a
 * signature that lets its buyer take the LTC back at once. Refused for the
 * accepted lock, and, while the listing is open, for a lock this browser made
 * an accept link for: with that link approved too, the buyer would have both
 * sides. Returns the Ting transaction's id, or throws saying why not.
 */
async function sendRelease(d, take, t = d.seller) {
  if (!t) throw new Error('This browser did not make this listing.');
  if (matchesAccept(take, d.accepted)) throw new Error('This is the lock you accepted: releasing it would give the buyer both sides. Not releasing.');
  const lock = lockScript(d.terms, take);
  if (!lock) throw new Error('That take names no lock this page can read: there is nothing to release.');
  if (linkHolds(d, t, outKey(lock))) {
    const closing = d.accepted ?? d.withdrawn;
    throw new Error(d.open || !closing
      ? 'You opened an accept link for this lock, and while the listing is open it can still be approved: with a release too, the buyer would have both sides. Withdraw the listing first; your page then releases this lock by itself.'
      : `You opened an accept link for this lock. Your page releases it once the ${d.accepted ? 'accept' : 'withdrawal'} is ${app.tconfs} blocks deep (now ${depthOf(closing.height)}): until then a reorganization could still put your accept of this lock in its place.`);
  }
  await refreshLtc({ outs: [[lock.txid, lock.vout]] });
  const out = outOf(lock.txid, lock.vout);
  if (!out || out.missing || out.script !== hex(lock.scriptPubKey)) throw new Error('There is no such lock on Litecoin to release.');
  if (out.spent) throw new Error('That lock is already spent.');
  const key = K.keyAt(K.seed(), t.n);
  const signature = L.releaseSignature({ txid: lock.txid, vout: lock.vout, value: out.value, htlc: lock.htlc, key });
  const tx = await sendOwn(H.releaseInput(d.id, L.encodeRelease({ txid: lock.txid, vout: lock.vout, signature })));
  update(t, { releases: { ...(t.releases ?? {}), [outKey(lock)]: { id: tx, at: now() } } });
  return tx;
}

/** The claim this browser signed ahead for a lock (by its output's key), if it did. */
const signedClaimSent = (t, key) => Object.values(t?.ltcClaims ?? {}).find((s) => s.signed && s.key === key) ?? null;

/**
 * Signs the claim of a lock ahead, to the payout address, and posts it on Ting
 * as release data, version 2 (HTLC.md, "Spending it"). Once the buyer's claim
 * makes the secret public, anyone can finish and send it, the buyer's page or
 * a watchtower: it pays only the payout address, so the seller need not be
 * there. It is kept among the trade's LTC claims, its txid known before the
 * secret is in, so that whoever sends it, this page knows the spend as its
 * own. Returns the Ting transaction's id, or throws saying why not.
 */
async function postSignedClaim(d, take, t = d.seller) {
  if (!t) throw new Error('this browser did not make this listing');
  if (!t.payout) throw new Error('no payout address yet');
  const lock = lockScript(d.terms, take);
  if (!lock) throw new Error('that take names no lock this page can read');
  const out = outOf(lock.txid, lock.vout);
  if (!out || out.missing || out.script !== hex(lock.scriptPubKey)) throw new Error('there is no such lock on Litecoin');
  if (out.spent) throw new Error('that lock is already spent');
  const rate = Math.min(MAX_FEE_RATE, Math.max(SIGNED_CLAIM_RATE, 2 * (await feeRate())));
  const signed = L.signClaim({ txid: lock.txid, vout: lock.vout, value: out.value, htlc: lock.htlc, key: K.keyAt(K.seed(), t.n), to: t.payout, feeRate: rate, network: app.net });
  const data = L.encodeSignedClaim(signed);
  const id = await sendOwn(H.releaseInput(d.id, data));
  update(t, {
    ltcClaims: {
      ...(t.ltcClaims ?? {}),
      [signed.claim]: {
        txid: signed.claim, fee: signed.fee, value: signed.out.value, rate, key: outKey(lock), listing: d.id,
        signed: { id, data: hex(data), posted: now() },
      },
    },
  });
  return id;
}

/**
 * Posts the signed claim of the accepted lock while the buyer has not claimed:
 * once, if this browser has none for it (a trade restored from a backup code,
 * whose payout address came later, or an accept made before signed claims),
 * and again, the same data, if the node no longer knows the posting and the
 * claim is not on Ting.
 */
async function keepSignedClaim(d, t, c) {
  const own = signedClaimSent(t, c.key);
  if (!own) {
    await once(`signed-claim:${c.key}`, () => postSignedClaim(d, acceptedTake(d, t), t).then(() => update(t, { signedClaimError: null })).catch((e) => update(t, { signedClaimError: e.message })));
    return;
  }
  if (signedClaimOf(d, c, c.out) || now() - (own.signed.posted ?? 0) < RESEND_AFTER) return;
  const s = await tingTx(own.signed.id).catch(() => null);
  if (s?.state !== 'missing') return;
  await once(`signed-claim:${c.key}`, async () => {
    try {
      const id = await sendOwn(H.releaseInput(d.id, unhex(own.signed.data)));
      update(t, { ltcClaims: { ...t.ltcClaims, [own.txid]: { ...own, signed: { ...own.signed, id, posted: now() } } }, signedClaimError: null });
    } catch (e) {
      update(t, { signedClaimError: e.message });
    }
  });
}

/** The seller's Decline and release: one lock, followed into a block. */
async function release(id, index) {
  const d = tradeOf(id);
  const take = d.takes[index];
  if (!d.seller || !take) return;
  const tx = await sendRelease(d, take);
  await followTing(tx, `Release of lock ${index + 1}`);
}

/**
 * Releases, by itself, every lock of an accepted or withdrawn listing but the
 * accepted one: those that are on Litecoin, unspent, and not released yet,
 * from this browser or on Ting; never, while the listing is open, one this
 * browser made an accept link for. It does not wait for the releases to be in
 * a block; the trade view shows them as they arrive.
 */
async function releaseOthers(d, t) {
  for (const take of d.takes) {
    if (matchesAccept(take, d.accepted) || releaseOf(d, take)) continue;
    const c = checkTake(d.terms, take);
    if (!c.lock || !c.out || c.out.missing || c.out.spent || c.out.script !== hex(c.lock.scriptPubKey)) continue;
    const key = outKey(c.lock);
    if (linkHolds(d, t, key)) continue;
    const sent = t.releases?.[key];
    if (sent) {
      // A release sent: sent again only once the node no longer knows it (the same signature, so the same transaction).
      const id = typeof sent === 'string' ? sent : sent.id;
      if (typeof sent !== 'string' && now() - sent.at < RESEND_AFTER) continue;
      const s = await tingTx(id).catch(() => null);
      if (s?.state !== 'missing') continue;
    }
    await once(`release:${key}`, () => sendRelease(d, take, t).then(() => update(t, { releaseError: null })).catch((e) => update(t, { releaseError: e.message })));
  }
}

async function withdraw(id) {
  const d = tradeOf(id);
  const listing = H.decodeListing(id, await app.node.record(app.program, H.listingKey(id)));
  if (!listing) throw new Error('The listing is no longer open: it was accepted or withdrawn.');
  await perform({
    call: H.withdrawCall(listing), from: listing.maker, feeCoin: app.coin, label: `Withdraw listing #${id}`,
    notes: d.takes.length ? '<p class="hint">Once it is withdrawn, your page releases the buyers’ locks by itself, so they take their LTC back at once.</p>' : '',
    done: (ok, executed) => { if (ok) pinFromCall(d.seller, id, executed); app.onData?.(); },
  });
}

async function refundDlr(id) {
  const d = tradeOf(id);
  if (!d.accepted || d.claimed || d.refunded) return;
  if (now() <= d.accepted.deadline) throw new Error('Not yet: the buyer may claim until the deadline.');
  const tx = await sendOwn(H.refundInput(id));
  await followTing(tx, 'Refund of the DLR');
}

function refundAddress(t, form) {
  const to = (form.refund || t.refundTo || '').trim();
  if (!to) throw new Error('Enter your Litecoin address first.');
  const problem = addressProblem(to);
  if (problem) throw new Error(problem);
  if (to !== t.refundTo) update(t, { refundTo: to });
  return to;
}

/**
 * The buyer's release: the seller's signature, the first released event for
 * this lock that verifies, and the buyer's own, sent to Litecoin. The page
 * keeps it once Litecoin took it, and sends it again while the explorer does
 * not know it.
 */
async function takeBack(id, form) {
  const d = tradeOf(id);
  const t = d.buyer;
  const take = t && takeOfBuyer(d, t);
  const lock = take && lockScript(d.terms, take);
  if (!lock) throw new Error('Your lock is not on Ting: there is nothing to take back with a release.');
  const to = refundAddress(t, form);
  await refreshLtc({ outs: [[lock.txid, lock.vout]] });
  const out = outOf(lock.txid, lock.vout);
  if (!out || out.missing || out.spent) throw new Error('The lock is not there to take back.');
  const released = releaseOf(tradeOf(id), take);
  if (!released) throw new Error('The seller has not released this lock: no release on Ting checks out.');
  const tx = L.releaseTx({
    txid: lock.txid, vout: lock.vout, value: out.value, htlc: lock.htlc, key: K.keyAt(K.seed(), t.n),
    signature: released.release.signature, to, feeRate: await feeRate(), network: app.net,
  });
  await broadcast(tx.hex);
  update(t, { releaseTx: { txid: tx.txid, hex: tx.hex, value: out.value - tx.fee, to, at: now() } });
  toast('Sent: your LTC is on its way back.', 'success', 6000);
  await read();
}

/**
 * The buyer's refund after T1: every output in a block at the lock address,
 * in one transaction, an output worth less than its share of the fee left
 * out. The page keeps it once Litecoin took it, and sends it again while the
 * explorer does not know it.
 */
async function refundLtc(id, form) {
  const d = tradeOf(id);
  const t = d.buyer;
  const to = refundAddress(t, form);
  await refreshLtc({ addresses: [t.address] });
  if (app.lt.error || app.lt.failed.has(t.address)) throw new Error(`Cannot read your lock address on Litecoin: ${app.lt.error ?? app.lt.failed.get(t.address)}`);
  if (!(app.lt.tip?.mtp > t.t1)) throw new Error(`Not yet: Litecoin’s median time has not passed ${localTime(t.t1)}.`);
  const utxos = refundable(d, t);
  if (!utxos.length) throw new Error(claimedLock(d, t) ? 'Nothing in a block at your lock address is yours to refund: the lock your claim was for is the seller’s.' : 'Nothing in a block is left at your lock address.');
  const m = marksOf(t.n);
  const htlc = { tag: L.lockTag(app.program, id, unhex(t.receive)), hash: m.hash, seller: d.terms.key, buyer: m.pub, t1: t.t1 };
  if (L.lockOutput(htlc, app.net).address !== t.address) throw new Error('The lock rebuilt from this trade is not the address you paid: not refunding.');
  const tx = L.refundAllTx({
    inputs: utxos.map((u) => ({ txid: u.txid, vout: u.vout, value: u.value, htlc })),
    key: K.keyAt(K.seed(), t.n), to, feeRate: await feeRate(), network: app.net,
  });
  await broadcast(tx.hex);
  update(t, { refundTxs: { ...(t.refundTxs ?? {}), [tx.txid]: { txid: tx.txid, hex: tx.hex, value: tx.value, covers: tx.spent.map(outKey), at: now() } } });
  toast(`Refund sent: ${ltcPlain(tx.value)} LTC is on its way back.`, 'success', 6000);
  await read();
}

/** The seller names the account they listed with: the trade's own listing is the one that account made. */
async function pinMaker(id, form) {
  const t = tradeOf(id).seller;
  const account = accountOf(form.maker);
  if (!t) return;
  if (!account) throw new Error('A Ting account is 64 hex digits, or the ting:pay link Ting ID shows under Receive.');
  const made = (t.listings ?? []).map((x) => tradeOf(x).listed).find((e) => e && equal(e.maker, account));
  if (!made) throw new Error('None of the listings with this trade’s key was made by that account.');
  update(t, { maker: hex(account) });
  findMyListings();
  toast(`Your listing is #${int(made.id)}.`, 'success', 5000);
  if (made.id !== id) location.hash = `#/l/${made.id}`;
  else app.onData?.();
}

async function savePayout(id, form) {
  // A restored trade's payout address, entered on its listing or on another with its key: the trade claims for all of them.
  const t = tradeOf(id).seller ?? copiedBy(id);
  if (!t) return;
  const problem = addressProblem(form.payout) ?? (form.payout.trim() ? null : 'Enter your Litecoin address.');
  if (problem) throw new Error(problem);
  update(t, { payout: form.payout.trim() });
  app.onData?.();
}

async function forget(id) {
  const d = tradeOf(id);
  const t = d.buyer;
  if (!t) return;
  await refreshLtc({ addresses: [t.address] });
  if ((app.lt.utxos.get(t.address) ?? []).length) throw new Error('LTC arrived at this lock: the page keeps it, so you can get it back.');
  K.dropTrade(app.program, t.n);
  toast('Forgotten. Nothing was paid.', 'info', 4000);
  app.onData?.();
}

// ---- About -----------------------------------------------------------------

function renderAbout(main) {
  main.className = 'about';
  main.innerHTML = `${banners()}<article class="prose">
    <h1>How a DLR ↔ LTC swap works</h1>
    <p>Two chains, two people, and nobody sends first. The seller has DLR on Ting and wants LTC; the buyer has LTC and
    wants DLR. Each side locks their coins so that only the other can take them, and only together.</p>
    <h2>The steps</h2>
    <ol class="steps-list">
      <li><b>The seller lists</b> DLR for an amount of LTC, with Ting ID. The DLR go into the swap program on Ting.</li>
      <li><b>The buyer locks the LTC</b> from their own Litecoin wallet, to an address this page makes: it opens with the
      seller’s key and a secret only the buyer’s page knows, or with the buyer’s key alone after a deadline, T1. The
      buyer’s page then tells Ting where the lock is.</li>
      <li><b>The seller accepts.</b> Their page checks the lock on Litecoin itself, and Ting ID locks the DLR for that
      buyer under the same secret’s hash, until a deadline.</li>
      <li><b>The buyer’s page claims the DLR</b> with the secret. That reveals the secret on Ting.</li>
      <li><b>The seller’s page claims the LTC</b> with the secret, to the seller’s Litecoin address.</li>
    </ol>
    <h2>The deadlines</h2>
    <p>Once accepted, the DLR wait for the buyer for the listing’s lock window, 12 hours unless the seller chose
    another. If the buyer does not claim in time, the DLR go back to the seller. The buyer’s Litecoin lock ends at T1,
    always at least 6 hours after the DLR deadline, so the seller can still claim the LTC if the secret appears at the
    last moment. After T1 the buyer can take the LTC back. If the seller declines a lock, their page releases it, and
    the buyer takes the LTC back at once.</p>
    <h2>What this page keeps</h2>
    <p>Your Litecoin keys and the buyer’s secret, in this browser only, made from one random seed. Save its
    <a href="#/backup">backup code</a>: with it, any browser finds your trades again. Without it, clearing the browser
    loses the keys of an open trade, and with them the coins it locks. The page shows the secret to nobody: it leaves
    the browser only inside the claim. The seller’s Ting actions are signed in Ting ID; the page holds no Ting key.</p>
    <h2>Trading over Discord</h2>
    <ul class="safety">
      <li><b>Only pay LTC to the address your own page shows</b>, on the trade’s page, never to an address someone posts in chat.</li>
      <li><b>Never paste your backup code anywhere</b> and never share it: it is the key to every trade of this browser. Nobody needs it, ever.</li>
      <li><b>Anyone can check a trade link.</b> It shows what both chains say, step by step. If someone tells you something the page does not show, believe the page.</li>
      <li><b>Nobody needs to send first.</b> If someone asks you to send coins outside these steps, it is not this swap.</li>
      <li>Open links in your own browser, not inside Discord, which can forget what the page keeps.</li>
    </ul>
    <h2>${app.production ? 'What this page runs on' : 'This test setup'}</h2>
    <p>${app.production ? 'This page runs on Ting’s production network and Litecoin mainnet.' : `This page runs only on the Ting development chain and on Litecoin ${esc(app.net)}: no coin here is real.`} It
    reads Ting through <code>${esc(app.node.base)}</code> and Litecoin through <code>${esc(app.ltc.base)}</code>, and
    checks the program’s code before making any call link.</p>
    <dl class="lines facts">
      <div><dt>HTLC program</dt><dd><code>${esc(hex(app.program))}</code></dd></div>
      <div><dt>Its CodeHash</dt><dd><code>${HTLC_CODE}</code></dd></div>
      <div><dt>${esc(app.dlr.symbol)} coin</dt><dd><code>${esc(hex(app.coin))}</code></dd></div>
      <div><dt>Confirmations</dt><dd>${plural(app.confs, 'Litecoin confirmation')} before accepting · ${plural(app.tconfs, 'Ting block')} under an accept before claiming</dd></div>
    </dl>
  </article>`;
}

// ---- Backup ----------------------------------------------------------------

function renderBackup(main) {
  main.className = 'about backup';
  const state = { shown: false, restoring: false, found: null, error: null, code: '', account: '', replace: false };
  const draw = () => {
    const s = K.seed();
    const trades = myTrades();
    const open = trades.filter((t) => !['done', 'off'].includes(stepOf(t).tone));
    const code = s ? K.groupedCode(K.backupCode(s)) : null;
    main.innerHTML = `${banners()}<article class="prose">
      <h1>Your backup code</h1>
      <p>Every key and secret this page makes comes from one random seed, kept in this browser. The backup code is
      that seed, written out. With it, the page finds your trades again in any browser.</p>
      <div class="callout warn">${icon('alert')}<div><b>Clearing this browser’s data loses the keys of an open trade</b>, and the
      coins it locks with them, unless you have the code. Write it on paper. Never paste it into a chat, a form, or any
      page but this one, and never send it to anyone: nobody needs it, ever.</div></div>
      ${s ? `<div class="card code-card">
        <div class="eyebrow">This browser’s backup code</div>
        ${state.shown ? `<p class="backup-code" translate="no">${esc(code)}</p>
          <div class="row"><button data-copy="${esc(K.backupCode(s))}" data-done="Backup code copied: keep it safe">${icon('copy')} Copy</button><button data-hide>Hide it</button>${K.backedUp() ? '' : `<button class="primary" data-saved>${icon('check')} I wrote it down</button>`}</div>`
          : `<p class="muted">Hidden, so that nobody reads it over your shoulder.</p><div class="row"><button class="primary" data-show>${icon('key')} Show my backup code</button></div>`}
        <p class="hint">${K.backedUp() ? `${icon('check')} You said you wrote it down.` : 'You have not marked it as written down yet.'} ${plural(trades.length, 'trade')} in this browser${open.length ? `, ${open.length} still open` : ''}; ${plural(K.nextCounter(), 'key')} made.</p>
      </div>` : `<div class="card code-card"><p class="muted">This browser has no keys yet. The page makes them with your first listing or lock${DISCORD ? ' (open the page in your real browser first)' : ''}.</p></div>`}
      <h2>Restore from a backup code</h2>
      <p>Paste a code to use it in this browser. The page reads the program’s events for listings made with its keys
      and locks made with its secrets, and puts those trades back. Use one code in one browser at a time.</p>
      <form class="card restore" id="restore-form" autocomplete="off">
        <label class="field"><span>Backup code</span><textarea name="code" rows="2" class="mono" spellcheck="false" placeholder="tingswap1…">${esc(state.code)}</textarea></label>
        <label class="field"><span>The Ting account you listed with <span class="muted">(optional, for a seller)</span></span><input name="account" class="mono" spellcheck="false" placeholder="64 hex digits, from Ting ID → Receive → Spending" value="${esc(state.account)}">
          <span class="hint">Anyone can list again with your listing’s Litecoin key. With your account, the page tells your listing from such copies; without it, it takes the first.</span></label>
        ${s ? `<label class="toggle"><input type="checkbox" name="replace"${state.replace ? ' checked' : ''}> <span>Replace this browser’s own code. I wrote it down.</span></label>` : ''}
        <div class="row"><button class="primary" type="submit"${state.restoring ? ' disabled' : ''}>${state.restoring ? '<span class="spinner"></span> Reading the events…' : 'Restore'}</button></div>
        ${state.error ? `<p class="hint error">${esc(state.error)}</p>` : ''}
        ${state.found ? `<div class="found">${state.found.length ? `<p><b>Found ${plural(state.found.length, 'trade')}:</b></p><ul>${state.found.map((t) => `<li><a href="#/l/${t.listing}">Listing #${t.listing}</a>, as the ${t.role}${t.listings?.length > 1 ? `, and ${plural(t.listings.length - 1, 'more listing')} with its key, which your page follows too` : ''}</li>`).join('')}</ul>` : '<p>No trades of this code on this program. Its keys are in place for new trades.</p>'}</div>` : ''}
        <p class="hint">What the chain does not hold comes back blank: a seller’s Litecoin payout address (the trade asks for it), and a lock that was paid but never reached Ting.</p>
      </form>
    </article>`;
    $('[data-show]', main)?.addEventListener('click', () => { state.shown = true; draw(); });
    $('[data-hide]', main)?.addEventListener('click', () => { state.shown = false; draw(); });
    $('[data-saved]', main)?.addEventListener('click', () => { K.markBackedUp(); draw(); });
    $('[name=code]', main).oninput = (e) => { state.code = e.target.value; };
    $('[name=account]', main).oninput = (e) => { state.account = e.target.value; };
    const replace = $('[name=replace]', main);
    if (replace) replace.onchange = (e) => { state.replace = e.target.checked; };
    $('#restore-form', main).onsubmit = async (e) => {
      e.preventDefault();
      state.error = null;
      state.found = null;
      let seedBytes;
      try {
        seedBytes = K.readBackupCode(state.code);
      } catch (err) {
        state.error = `That is not a backup code: ${err.message}.`;
        return draw();
      }
      const current = K.seed();
      if (current && !equal(current, seedBytes) && !state.replace) {
        state.error = 'This browser has its own code. Write it down, then tick “Replace this browser’s own code”.';
        return draw();
      }
      state.restoring = true;
      draw();
      try {
        const account = state.account.trim() ? accountOf(state.account) : null;
        if (state.account.trim() && !account) throw new Error('The Ting account is 64 hex digits, or the ting:pay link Ting ID shows under Receive.');
        state.found = await restore(seedBytes, account);
        state.code = '';
      } catch (err) {
        state.error = err.message;
      }
      state.restoring = false;
      draw();
    };
  };
  draw();
}

/**
 * Finds the trades of a seed again: counter by counter, the listed events with
 * its key and the taken events with its secret's hash, until GAP_LIMIT
 * counters in a row find nothing. Then makes it this browser's seed.
 *
 * Keys and hashes are public once on chain, and anyone can list again with a
 * key, even ahead of the real listing, or post a take again with a hash. A
 * seller trade follows every listing with its key (acting on a copy is
 * harmless), and shows the one made by `account`, the Ting account the user
 * listed with, when given; else the first, which a copy put ahead of the real
 * listing could be: the page cannot tell, and says so. Of the takes with the hash and this seed's
 * key, the trade's is the earliest whose rebuilt lock address Litecoin has
 * seen paid; a copy with another account, T1 or listing points at an address
 * nobody paid.
 */
async function restore(seedBytes, account = null) {
  if (!K.canStore()) throw new Error('This browser does not let the page keep keys.');
  await refreshTing();
  if (app.tingError) throw new Error(`Cannot read Ting: ${app.tingError}`);
  const listed = app.events.filter((e) => e.kind === 'listed').sort((a, b) => a.id - b.id);
  const taken = app.events.filter((e) => e.kind === 'taken');
  const termsOf = (id) => app.listings.get(id) ?? listed.find((e) => e.id === id);
  const found = [];
  let miss = 0;
  let last = -1;
  for (let n = 0; miss < K.GAP_LIMIT && n < 100_000; n++) {
    const m = K.marksAt(seedBytes, n);
    if (!m) continue;
    const owns = listed.filter((e) => equal(e.key, m.pub));
    // The account the user listed with, when given, tells their listing from copies; without it, the first.
    const byAccount = account ? owns.find((e) => equal(e.maker, account)) : null;
    const own = byAccount ?? owns[0];
    if (own) {
      found.push({
        n, role: 'seller', listing: own.id, listings: owns.map((e) => e.id), created: own.time * 1000, payout: null,
        amount: String(own.amount), want: String(own.want), window: own.window, fee: String(own.fee), restored: true,
        ...(byAccount ? { maker: hex(account) } : {}),
      });
    }
    const takes = taken.filter((e) => equal(e.hash, m.hash));
    const candidates = takes.map((e) => {
      const lock = lockOfTake(e);
      const terms = termsOf(e.id);
      if (!lock || !equal(lock.buyer, m.pub) || !terms || !forThisPage(terms)) return null;
      try {
        const htlc = { tag: L.lockTag(app.program, e.id, e.taker), hash: m.hash, seller: terms.key, buyer: m.pub, t1: e.t1 };
        return { e, lock, terms, address: L.lockOutput(htlc, app.net).address };
      } catch {
        return null;
      }
    }).filter(Boolean);
    let chosen = null;
    for (const c of candidates.slice(0, 5)) {
      try {
        const txs = await app.ltc.addressTxs(c.address);
        if (Array.isArray(txs) && txs.length) {
          chosen = c;
          break;
        }
      } catch {
        // The explorer cannot say: the earliest, marked as not checked.
        chosen = { ...candidates[0], unchecked: true };
        break;
      }
    }
    chosen ??= candidates[0] ? { ...candidates[0], unchecked: true } : null;
    if (chosen) {
      const { e, lock, terms, address } = chosen;
      found.push({
        n, role: 'buyer', listing: e.id, created: e.time * 1000, receive: hex(e.taker), refundTo: null, t1: e.t1, address,
        want: String(terms.want), amount: String(terms.amount), take: { txid: lock.txid, vout: lock.vout, tx: e.tx, height: e.height },
        restored: true, unchecked: Boolean(chosen.unchecked),
      });
    }
    if (own || takes.length) {
      last = n;
      miss = 0;
    } else {
      miss++;
    }
  }
  const same = K.seed() && equal(K.seed(), seedBytes);
  // Another seed's trades count their keys from that seed: they leave with it (its code brings them back).
  if (!same) K.dropAllTrades();
  K.restoreSeed(seedBytes, Math.max(last + 1, same ? K.nextCounter() : 0));
  marks.clear();
  const kept = K.trades(app.program);
  for (const t of found) if (!kept.some((x) => x.n === t.n)) K.saveTrade(app.program, t);
  return found;
}

// ---- Icons -----------------------------------------------------------------

function icon(name) {
  const paths = {
    swap: '<path d="M7 7h12l-3.5-3.5M17 17H5l3.5 3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
    contrast: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 010 16z" fill="currentColor"/>',
    copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2.2"/><path d="M15.5 8.5V6.7a2.2 2.2 0 00-2.2-2.2H6.7a2.2 2.2 0 00-2.2 2.2v6.6a2.2 2.2 0 002.2 2.2h1.8"/>',
    lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2.2"/><path d="M8 10.5V8a4 4 0 018 0v2.5"/>',
    key: '<circle cx="8" cy="15" r="3.8"/><path d="M10.8 12.3L19 4.2M16 7.2l2.3 2.3M13.6 9.6l1.9 1.9"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    chat: '<path d="M5 18.5V7a2.5 2.5 0 012.5-2.5h9A2.5 2.5 0 0119 7v6.5a2.5 2.5 0 01-2.5 2.5H9z"/><path d="M9 9.5h6M9 12.5h4"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    shield: '<path d="M12 3.5l7 2.8v5.2c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6.3z"/>',
    external: '<path d="M14 4.5h5.5V10M19.5 4.5L11 13"/><path d="M17 13.5v4a2 2 0 01-2 2H6.5a2 2 0 01-2-2V9a2 2 0 012-2h4"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}

// ---- Theme -----------------------------------------------------------------

const THEME = 'ting-swap/theme';

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  const next = dark ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME, next); } catch { /* this visit only */ }
}

// ---- Start -----------------------------------------------------------------

function fatal(title, detail) {
  $('#view').innerHTML = `<section class="notice"><h1>${esc(title)}</h1><p>${detail}</p></section>`;
}

let running = null;

/**
 * Runs a round of reading and acting, after the one under way if there is
 * one, so that a caller sees what it did itself; then draws the view again.
 */
async function read() {
  while (running) await running;
  running = round().catch(() => {}).finally(() => { running = null; });
  await running;
  app.onData?.();
}

async function boot() {
  try { applyTheme(localStorage.getItem(THEME)); } catch { /* the system's */ }
  $('#theme').innerHTML = icon('contrast');
  $('#theme').onclick = toggleTheme;
  const query = new URLSearchParams(location.search);
  // Opened with a test setup's address (scripts/htlc-dev.mjs url): the
  // development chain and Litecoin regtest or testnet, as the address names
  // them. Otherwise production, exactly as config.js pins it: no link can
  // change its node, program, coin, explorer, wallet or depths.
  app.production = !query.has('node');
  const setup = app.production ? LTC_PRODUCTION : {
    chainId: DEVELOPMENT, node: query.get('node'), htlc: query.get('htlc'), coin: (query.get('coins') ?? '').split(',')[0],
    ltc: query.get('ltc'), ltcnet: query.get('ltcnet') ?? '', wallet: query.get('wallet') ?? '',
  };
  app.net = setup.ltcnet;
  markSetup();
  if (app.production) {
    if (!setup.htlc) return fatal('Not on Ting yet', 'The HTLC program is not deployed on the production network yet.');
  } else {
    if (!setup.node || !setup.htlc || !setup.ltc) {
      return fatal('This page needs its test setup', 'Open it with the address <code>node scripts/htlc-dev.mjs url</code> prints: it names the Ting node, the HTLC program, the DLR coin, Ting ID Web and the Litecoin explorer.');
    }
    if (!LTC_NETS.includes(app.net)) {
      return fatal('Test networks only', `A test setup runs on Litecoin regtest or testnet, never on <code>${esc(app.net || 'mainnet')}</code>. Add <code>ltcnet=regtest</code> or <code>ltcnet=testnet</code> to the address.`);
    }
    // The node, the explorer, the wallet and the price source over https, or http on this computer only.
    const insecure = ['node', 'ltc', 'wallet', 'price'].filter((name) => query.get(name) && query.get(name) !== 'off' && !safeUrl(query.get(name)));
    if (insecure.length) {
      return fatal('Only https addresses', `The page talks to its node, explorer, wallet and price source over https, or plain http on this computer only. Not: <code>${esc(insecure.join(', '))}</code>.`);
    }
  }
  app.node = new Node(safeUrl(setup.node));
  let status;
  try {
    status = await app.node.status();
  } catch (e) {
    return fatal('Cannot reach the Ting node', `${esc(app.node.base)}: ${esc(e.message)}`);
  }
  if (status.chain_id !== setup.chainId) {
    return app.production
      ? fatal('Not the Ting network', `The node at <code>${esc(app.node.base)}</code> is on chain <code>${esc(status.chain_id)}</code>, not Ting’s.`)
      : fatal('Ting development chain only', `A test setup runs only on the Ting development chain. The node at <code>${esc(app.node.base)}</code> is on chain <code>${esc(status.chain_id)}</code>.`);
  }
  app.chainHex = status.chain_id;
  app.tip = { height: int(status.height), time: now() };
  app.program = idOf(setup.htlc);
  app.coin = idOf(setup.coin);
  if (!app.program || !app.coin) return fatal('The address is missing an id', 'It needs <code>htlc</code>, the program’s ContractId, and <code>coins</code>, the DLR coin’s.');
  app.vault = contractAccount(app.program);
  app.wallet = setup.wallet ? safeUrl(setup.wallet) : '';
  app.ltc = new Esplora(safeUrl(setup.ltc));
  app.ltcWallet = app.net === 'regtest' ? new URL('/', app.ltc.base).href : '';
  const param = (name, fallback, min, max) => {
    const v = Number(query.get(name));
    return query.get(name) != null && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  };
  if (app.production) {
    app.confs = setup.confs;
    app.tconfs = setup.tconfs;
    app.ltcFee = null;
  } else {
    app.confs = param('confs', 1, 0, 100);
    app.tconfs = param('tconfs', TCONFS, 1, 1000);
    app.ltcFee = param('ltcfee', null, 1, MAX_FEE_RATE);
  }
  try {
    const program = await app.node.contract(app.program);
    if (program.code_hash !== HTLC_CODE) {
      return fatal('This program runs other code', `The contract runs code <code>${esc(program.code_hash)}</code>, not the HTLC program this page was written for (<code>${HTLC_CODE}</code>). The page makes no calls for it.`);
    }
    const templates = decodeTemplateList(await app.node.record(app.program, TEMPLATES_KEY));
    for (const t of Object.values(H.TEMPLATES)) checkListed(templates, t);
    const coin = await app.node.contract(app.coin);
    const config = await app.node.record(app.coin, new Uint8Array(32));
    if (coin.code_hash !== CODE_HASHES.coin || !config) {
      return fatal('The DLR coin is not a coin', `<code>${esc(hex(app.coin))}</code> does not run the reference coin program. The page makes no calls for it.`);
    }
    app.dlr = decodeCoin(config);
  } catch (e) {
    return fatal('Cannot read the HTLC program', esc(e.message));
  }
  for (const id of ['call', 'notice']) {
    const dialog = $(`#${id}-dialog`);
    $('.close', dialog).onclick = () => dialog.close();
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) copy(b.dataset.copy, b.dataset.done ?? 'Copied');
  });
  // LTC's price: the one kept from before at once, then read now and every ten minutes.
  app.priceUrl = priceSource(app.production ? new URLSearchParams() : query);
  app.price = app.priceUrl ? savedPrice() : null;
  if (app.priceUrl) {
    readPrice();
    setInterval(readPrice, PRICE_EVERY);
  }
  // What a claim pays now: for the cap a listing gets, and for this page's own claims.
  readClaimRate();
  setInterval(readClaimRate, PRICE_EVERY);
  setInterval(() => app.tick?.(), 1000);
  // Every few seconds, whatever the view: each open trade's automatic steps run from here.
  let last = 0;
  setInterval(() => {
    if (running || Date.now() - last < (app.readEvery ?? MARKET_POLL)) return;
    last = Date.now();
    read().catch(() => {});
  }, 1000);
  window.addEventListener('hashchange', arrive);
  await refreshTing();
  arrive();
  read().catch(() => {});
}

/** Routes, or takes a call back from Ting ID: the link's `return` opened with `#ting-tx=`. */
function arrive() {
  const m = location.hash.match(/^#ting-tx=([0-9a-fA-F]{64})$/);
  if (!m) return route();
  history.replaceState(null, '', location.pathname + location.search);
  route();
  (async () => {
    const tx = m[1].toLowerCase();
    const s = await followTing(tx, 'Your call from Ting ID');
    if (s.state !== 'done') return;
    const answer = await app.node.transaction(tx).catch(() => null);
    let listing = null;
    for (const e of answer?.occurrences?.[0]?.receipt?.events ?? []) {
      if (e.contract !== hex(app.program)) continue;
      try {
        const r = new Reader(unhex(e.payload_hex));
        if (!equal(r.take(32), H.TOPIC)) continue;
        const event = H.decodeEvent(r);
        listing ??= event.id;
        // A listing this browser offered: it is this transaction's, made by its maker.
        if (event.kind === 'listed') pinListing(event.key, tx, event.maker);
      } catch { /* not an event this page reads */ }
    }
    findMyListings();
    if (listing != null) location.hash = `#/l/${listing}`;
  })().catch(() => {});
}

boot();
