// Ting Swap, the page: reads the chain through one node, and does the swap's
// operations as TCR-1 call links, which Ting ID, or any wallet that reads
// them, signs and submits. The page holds no key and no coins.
import { equal, hex, Reader, unhex } from './bytes.js';
import { CODE_HASHES, DEFAULT_NODE, NETWORKS } from './config.js';
import { qrSvg } from './qr.js';
import {
  byRate, CONFIG_KEY, COUNT_KEY, decodeCoin, decodeCoinAccount, decodeCount, decodeEvent, decodeListing,
  formatAmount, linkAmount, listingKey, offerCall, parseAmount, rate, takeCall, TEMPLATES, TOPIC,
  withdrawCall,
} from './swap.js';
import {
  callLink, checkListed, decodeExecuted, decodeTemplateList, decodeValues, EXECUTED, operationHash, TEMPLATES_KEY,
  textProblem,
} from './tcr.js';
import { contractAccount, idOf, Node, NodeError } from './ting.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const now = () => Math.floor(Date.now() / 1000);
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const app = {
  node: null,
  chain: null,
  chainHex: '',
  network: null,
  swap: null,
  /** The swap's own account, which holds what open listings offer. */
  vault: null,
  /** The program's template list: each template's hash, in hex, to its text. */
  templates: null,
  /** Coins by ContractId in hex: `{ id, name, symbol, decimals, known }`, or `{ id, bad }` for a contract that is no coin. */
  coins: new Map(),
  /** The coins this page names as known on this network, in hex. */
  known: [],
  /** The coin the page asks the wallet to pay a withdrawal's fee in, when there is one. */
  feeCoin: null,
  /** Open listings by id, read from the chain. */
  listings: new Map(),
  /** How many listings were ever made. */
  count: 0,
  /** Read at least once since the page opened. */
  loaded: false,
  /** The swap's events, oldest first, each with its block's height and time. */
  events: [],
  /** The height to read events from next. */
  eventsFrom: 1,
  /** Accounts the user linked, in hex: public addresses only, to show what is theirs. */
  accounts: new Set(),
  /** What the current view does every second, when the chain or the accounts change, and when it goes away. */
  tick: null,
  onData: null,
  onAccounts: null,
  leave: null,
};

// ---- Formatting ------------------------------------------------------------

const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function ago(t) {
  const s = Math.max(0, now() - t);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return date(t);
}

const date = (t) => new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const short = (id) => `${hex(id).slice(0, 6)}…${hex(id).slice(-4)}`;

function who(account) {
  if (!account) return '—';
  const text = hex(account);
  if (equal(account, app.vault)) return '<span class="account" title="The swap’s own account">the swap</span>';
  const mine = isMine(account);
  return `<span class="account${mine ? ' mine' : ''}" title="${text}">${mine ? 'you' : short(account)}</span>`;
}

/** A coin as the page has it, loading it on first sight is the caller's job. */
const coinOf = (id) => app.coins.get(hex(id)) ?? { id, symbol: '?', name: 'a coin not read yet', decimals: 0, pending: true };

/** A text from a coin's configuration, which nothing checks, or null when it is not one to show. */
function shownText(text, max) {
  if (!text || textProblem(text)) return null;
  return [...text].length > max ? [...text].slice(0, max - 1).join('') + '…' : text;
}

/** The known coin whose symbol an unknown coin takes, or null. */
function imitated(coin) {
  if (coin.known || coin.bad) return null;
  const symbol = (coin.symbol ?? '').trim().toLowerCase();
  for (const k of app.known) {
    const other = app.coins.get(k);
    if (other && other.symbol.trim().toLowerCase() === symbol) return other;
  }
  return null;
}

/** A coin's mark: a disc in a colour of its ContractId, with its symbol's first letter. */
function coinMark(coin) {
  const h = hex(coin.id);
  const hue = parseInt(h.slice(0, 4), 16) % 360;
  const letter = [...(shownText(coin.symbol, 8) ?? '?')][0].toUpperCase();
  return `<span class="mark" style="--h:${hue}" aria-hidden="true">${esc(letter)}</span>`;
}

/** A coin's symbol, its mark, and whether the page knows it. */
function coinTag(id, { name = false } = {}) {
  const coin = coinOf(id);
  const symbol = shownText(coin.symbol, 10) ?? '?';
  const fake = imitated(coin);
  const title = `${shownText(coin.name, 40) ?? 'A name this page cannot show'} · ${hex(id)}${coin.known ? ' · a coin this page knows' : fake ? ` · NOT ${fake.name}: it only calls itself ${coin.symbol}` : ' · a coin this page does not know: check its ContractId'}`;
  const flag = coin.known ? `<span class="flag known" aria-label="known coin">${icon('check')}</span>`
    : `<span class="flag ${fake ? 'fake' : 'unknown'}" aria-label="${fake ? 'imitation' : 'unknown coin'}">${icon('alert')}</span>`;
  return `<span class="coin${coin.known ? ' is-known' : ''}" title="${esc(title)}">${coinMark(coin)}<b>${esc(symbol)}</b>${flag}${name ? `<span class="coin-name">${esc(shownText(coin.name, 28) ?? '')}</span>` : ''}</span>`;
}

/** An amount of a coin, in its units. */
function amount(id, value, { max } = {}) {
  const coin = coinOf(id);
  return `<span class="amt"><span class="num">${formatAmount(value, coin.decimals, max ?? coin.decimals)}</span> ${coinTag(id)}</span>`;
}

/** What one unit of `a` is worth in `b`, at a listing's terms. */
function rateLine(aCoin, a, bCoin, b) {
  const ca = coinOf(aCoin), cb = coinOf(bCoin);
  // Two coins that call themselves the same are told apart by their ContractIds.
  const same = ca.symbol === cb.symbol;
  const name = (c) => `${esc(shownText(c.symbol, 10) ?? '?')}${same ? `<span class="muted">·${hex(c.id).slice(0, 4)}</span>` : ''}`;
  return `1 ${name(ca)} = ${rate(a, ca.decimals, b, cb.decimals)} ${name(cb)}`;
}

/** A field's value as a wallet shows it (TCR-1, field types). */
function shown(type, v) {
  if (type === 'amount') return amount(v.coin, v.amount);
  if (type === 'account') return who(v);
  if (v instanceof Uint8Array) return esc(hex(v));
  return esc(String(v));
}

/** An operation in its template's words, each slot shown as a wallet would, `{payment}` as `pay`. */
function sentence(template, values, pay) {
  let decoded;
  try {
    decoded = decodeValues(template, values);
  } catch {
    return `An operation this page cannot show: <code>${esc(hex(values))}</code>`;
  }
  return decoded.parts.map((p) => {
    if (p.payment) return pay ? amount(pay.coin, pay.amount) : 'its payment';
    return p.slot ? shown(p.type, p.value) : esc(p.text);
  }).join('');
}

function toast(message, kind = 'info', ms = 6000) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), ms);
  return el;
}

// ---- Reading the chain -----------------------------------------------------

/** Reads coins the page has not seen: whether each runs the coin program, and its name, symbol and decimals. */
async function loadCoins(ids) {
  const fresh = [...new Set(ids.map((id) => hex(id)))].filter((h) => !app.coins.has(h) || app.coins.get(h).pending);
  if (!fresh.length) return;
  const configs = await app.node.storage(fresh.map((h) => [unhex(h), CONFIG_KEY]));
  await Promise.all(fresh.map(async (h, i) => {
    const id = unhex(h);
    const contract = await app.node.contract(id).catch(() => null);
    if (!contract || contract.code_hash !== CODE_HASHES.coin || !configs[i]) {
      app.coins.set(h, { id, bad: true, symbol: '?', name: 'not a coin', decimals: 0 });
      return;
    }
    try {
      app.coins.set(h, { id, ...decodeCoin(configs[i]), known: app.known.includes(h) });
    } catch {
      app.coins.set(h, { id, bad: true, symbol: '?', name: 'not a coin', decimals: 0 });
    }
  }));
}

/**
 * Reads the open listings. The first time, every listing ever made; then the
 * ones open before and the ones made since, so a refresh reads what can have
 * changed and nothing more.
 */
async function loadListings() {
  const count = decodeCount(await app.node.record(app.swap, COUNT_KEY));
  const ids = app.loaded ? [...app.listings.keys()] : [];
  for (let id = app.loaded ? app.count + 1 : 1; id <= count; id++) ids.push(id);
  const values = await app.node.storage(ids.map((id) => [app.swap, listingKey(id)]));
  const before = [...app.listings.keys()].join();
  for (const [i, id] of ids.entries()) {
    const listing = decodeListing(id, values[i]);
    if (listing) app.listings.set(id, listing);
    else app.listings.delete(id);
  }
  const changed = !app.loaded || count !== app.count || before !== [...app.listings.keys()].join();
  app.count = count;
  app.loaded = true;
  await loadCoins([...app.listings.values()].flatMap((l) => [l.giveCoin, l.wantCoin]));
  return changed;
}

/** Reads the swap's events since the last read. */
async function loadEvents() {
  let from = app.eventsFrom;
  let added = 0;
  for (;;) {
    const page = await app.node.events(app.swap, TOPIC, from, 100);
    for (const block of page.items) {
      for (const e of block.events) {
        try {
          const r = new Reader(unhex(e.payload_hex));
          r.take(32);
          app.events.push({ ...decodeEvent(r), height: block.height, time: block.timestamp });
          added++;
        } catch { /* not one this page reads */ }
      }
    }
    if (!page.items.length || page.next > page.height) {
      app.eventsFrom = Math.max(from, page.next ?? from);
      break;
    }
    from = page.next;
  }
  await loadCoins(app.events.slice(-added || app.events.length).flatMap((e) => [e.giveCoin, e.wantCoin].filter(Boolean)));
  return added > 0;
}

async function refresh() {
  const [listings, events] = await Promise.all([loadListings(), loadEvents()]);
  if (listings || events) app.onData?.();
}

/** The available balance of `coin` in each linked account. */
async function balances(coin) {
  const accounts = [...app.accounts];
  const values = await app.node.storage(accounts.map((a) => [coin, unhex(a)]));
  return accounts.map((a, i) => ({ account: unhex(a), ...decodeCoinAccount(values[i]) }));
}

// ---- Doing things ----------------------------------------------------------

/**
 * Does an operation: `call` from swap.js, `pay` as `{ coin, to, amount }` or
 * none, and `from` for the maker's withdrawal. It goes to Ting ID, or any
 * wallet that reads TCR-1 call links, as a link; a withdrawal names the coin
 * it can take a fee payment in. The page watches the program's events until
 * it is done, then calls `done(true)`; `done(false)` when the dialog is closed
 * first or it fails.
 */
async function perform({ call, pay, label, from, feeCoin, warn = '', done }) {
  const decimals = pay ? coinOf(pay.coin).decimals : 0;
  const link = await callLink({
    chainHex: app.chainHex, program: app.swap, template: call.template, values: call.values,
    coin: pay ? pay.coin : feeCoin, to: pay?.to, amount: pay ? linkAmount(pay.amount, decimals) : null,
    from, returnTo: location.origin + location.pathname + location.search,
  });
  const dialog = $('#call-dialog');
  let qr = null;
  try { qr = qrSvg(link); } catch { /* too long for a QR code */ }
  $('.dialog-body', dialog).innerHTML = `<div class="eyebrow">Sign with Ting ID</div><h2>${esc(label)}</h2>
    <p class="call-sentence">${sentence(call.template, call.values, pay)}</p>
    ${warn}
    <p class="hint">${pay ? `Ting ID shows what leaves your account itself: ${amount(pay.coin, pay.amount)} to ${who(pay.to)}, and the fee.` : 'Nothing leaves your account but the fee.'}</p>
    <div class="call-pay">
      ${qr ? `<button class="qr" aria-label="Show the QR code full screen">${qr}</button>` : '<p class="hint">Too long for a QR code: open it on the phone that has Ting ID.</p>'}
      <div class="pay-side">
        <p class="hint">Scan it with Ting ID, or open it on the phone.${qr ? ' Click the code to show it full screen.' : ''}</p>
        <div class="row"><a class="button primary" href="${esc(link)}">Open in Ting ID</a><button id="copy-call">Copy link</button></div>
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
 * Looks for the operation in the program's events until it is done, or the
 * dialog is closed; and in the node's pool, to say when Ting ID has sent it.
 * From then on the page knows the transaction, and says so if it fails.
 */
async function watchCall(dialog, call, label, start, done) {
  const operation = hex(operationHash(call.head));
  const token = (dialog.watching = {});
  const read = new Set();
  let sent = null;
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    if (dialog.watching !== token) return;
    if (!dialog.open) return done?.(false);
    try {
      const executed = await findExecuted(operation, start);
      if (executed) {
        dialog.close();
        // Whoever scanned this page's code made the call: the page shows their account as theirs.
        if (!isMine(executed.account)) linkAccount(executed.account, true);
        toast(`${esc(label)}: done, in block ${executed.height}`, 'success', 10_000);
        await refresh().catch(() => {});
        return done?.(true, executed);
      }
      if (sent) {
        const seen = (await app.node.transaction(sent)).occurrences?.[0];
        if (seen && seen.receipt.status !== 0) {
          callState(dialog, 'failed', 'It did not go through', `${esc(label)} failed: ${esc(failure(seen.receipt))}`);
          return done?.(false);
        }
      } else if ((sent = await pooled(call.head, read))) {
        callState(dialog, 'sent', 'Ting ID sent it', 'It is being confirmed, which usually takes a minute or two.');
      }
    } catch { /* the next look tries again */ }
  }
}

/** The *executed* event of `operation` from height `start` on, with its height, or null. */
async function findExecuted(operation, start) {
  let from = start;
  for (;;) {
    const page = await app.node.events(app.swap, EXECUTED, from, 100);
    for (const block of page.items) {
      for (const e of block.events) {
        const r = new Reader(unhex(e.payload_hex));
        r.take(32);
        const executed = decodeExecuted(r);
        if (hex(executed.operation) === operation) return { height: block.height, account: executed.account };
      }
    }
    if (!page.items.length || page.next > page.height) return null;
    from = page.next;
  }
}

/** Shows where a call stands in place of its code, which has done its job. */
function callState(dialog, kind, title, text) {
  const mark = kind === 'sent' ? '<span class="spinner big" aria-hidden="true"></span>' : icon('alert');
  $('.call-pay', dialog).innerHTML = `<div class="call-state ${kind}" role="status">${mark}
    <div><b>${esc(title)}</b><p id="call-status">${text}</p></div></div>`;
}

/**
 * The id of a transaction that calls the operation `head` and waits in the
 * node's pool, or null. The wallet made it, so the page knows no id: it reads
 * each pooled transaction once, noting it in `read`, and looks at what it asks
 * the swap.
 */
async function pooled(head, read) {
  for (const { id } of (await app.node.mempool()).items) {
    if (read.has(id)) continue;
    try {
      const input = swapInput((await app.node.transaction(id)).pending_transaction?.hex);
      read.add(id);
      if (input && equal(input.subarray(0, head.length), head)) return id;
    } catch { /* in a block already, or out of reach; the next look tries again */ }
  }
  return null;
}

/** Follows a transaction the page knows by id: into the node's pool, then into a block. */
async function follow(id, label, done) {
  const note = toast(`${esc(label)}: waiting for it to arrive…`, 'info', 600_000);
  const started = Date.now();
  const end = (message, kind, ok, seen) => {
    note.remove();
    toast(message, kind, 10_000);
    done?.(ok, seen);
  };
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let answer;
    try {
      answer = await app.node.transaction(id);
    } catch (e) {
      if (!(e instanceof NodeError) || e.status !== 404 || Date.now() - started > 120_000) {
        return end(`${esc(label)}: the node no longer has it`, 'error', false);
      }
      continue;
    }
    const seen = answer.occurrences?.[0];
    if (seen) {
      if (seen.receipt.status === 0) return end(`${esc(label)}: done, in block ${seen.height}`, 'success', true, seen);
      return end(`${esc(label)} failed: ${esc(failure(seen.receipt))}`, 'error', false, seen);
    }
    if (answer.pending) note.innerHTML = `${esc(label)}: received. It is being confirmed, which usually takes a minute or two.`;
    if (Date.now() - started > 20 * 60_000) return end(`${esc(label)}: still not confirmed after 20 minutes`, 'error', false);
  }
}

/** Why a transaction failed: the program's message, or the receipt's status. */
function failure(receipt) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(unhex(receipt.result_hex)) || receipt.status_name;
  } catch {
    return receipt.status_name;
  }
}

/** A warning for coins in a trade that the page does not know, or none. */
function coinWarning(ids) {
  const strange = ids.map(coinOf).filter((c) => !c.known);
  if (!strange.length) return '';
  const lines = strange.map((c) => {
    const fake = imitated(c);
    return fake
      ? `<li><b>${esc(shownText(c.symbol, 10) ?? '?')}</b> here is <b>not</b> ${esc(fake.name)}: another coin that calls itself the same. Its ContractId is <code>${hex(c.id)}</code>.</li>`
      : `<li><b>${esc(shownText(c.symbol, 10) ?? '?')}</b> (“${esc(shownText(c.name, 40) ?? '?')}”) is not a coin this page knows. Anyone can make a coin and name it anything: make sure <code>${hex(c.id)}</code> is the one you mean.</li>`;
  }).join('');
  return `<div class="banner warn">${icon('alert')}<ul>${lines}</ul></div>`;
}

/** Takes a listing: the taker pays its maker, and gets what it offers. */
async function take(listing) {
  const fresh = decodeListing(listing.id, await app.node.record(app.swap, listingKey(listing.id)));
  if (!fresh) {
    await refresh().catch(() => {});
    return toast(`Listing ${listing.id} was just taken or withdrawn.`, 'error');
  }
  await perform({
    call: takeCall(fresh), pay: { coin: fresh.wantCoin, to: fresh.maker, amount: fresh.want },
    label: `Take listing ${fresh.id}`, warn: coinWarning([fresh.giveCoin, fresh.wantCoin]),
    done: (ok) => ok && route(),
  });
}

/** Withdraws a listing, from its maker's account only. */
async function withdraw(listing) {
  await perform({
    call: withdrawCall(listing), from: listing.maker, feeCoin: app.feeCoin ?? listing.giveCoin,
    label: `Withdraw listing ${listing.id}`, done: (ok) => ok && route(),
  });
}

async function guard(action) {
  try {
    await action();
  } catch (e) {
    toast(esc(e.message), 'error');
  }
}

// ---- Routing ---------------------------------------------------------------

function route() {
  app.leave?.();
  app.leave = null;
  app.tick = null;
  app.onData = null;
  app.onAccounts = null;
  const [, view, arg] = location.hash.split('/');
  $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (view || 'market')));
  const main = $('#view');
  main.className = '';
  if (view === 'new') return renderNew(main, arg);
  if (view === 'listing' && /^\d+$/.test(arg ?? '')) return renderListing(main, Number(arg));
  if (view === 'activity') return renderActivity(main);
  if (view === 'about') return renderAbout(main);
  return renderMarket(main, arg);
}

// ---- Market ----------------------------------------------------------------

/** The two coins of a pair, in a fixed order: known coins first, then by ContractId. */
function pairOf(a, b) {
  const [ha, hb] = [hex(a), hex(b)];
  const rank = (h) => (app.known.includes(h) ? app.known.indexOf(h) : 1000);
  return rank(ha) < rank(hb) || (rank(ha) === rank(hb) && ha < hb) ? [ha, hb] : [hb, ha];
}

/** A listing as a row: what the taker gets and pays, and its rate, quoted in `base` when given, else in what it offers. */
function listingRow(l, { base } = {}) {
  const mine = isMine(l.maker);
  return `<article class="listing${mine ? ' own' : ''}" data-id="${l.id}">
    <a class="listing-link" href="#/listing/${l.id}" aria-label="Listing ${l.id}"></a>
    <div class="leg get"><span class="label">You get</span>${amount(l.giveCoin, l.give)}</div>
    <div class="leg pay"><span class="label">You pay</span>${amount(l.wantCoin, l.want)}</div>
    <div class="leg rate"><span class="label">Rate</span><span class="rate-text">${base && equal(base, l.wantCoin) ? rateLine(l.wantCoin, l.want, l.giveCoin, l.give) : rateLine(l.giveCoin, l.give, l.wantCoin, l.want)}</span></div>
    <div class="leg meta"><span class="label">#${l.id} · ${esc(ago(l.listedAt))}</span>${mine ? '<span class="badge mine">Your listing</span>' : who(l.maker)}</div>
    <div class="leg act">${mine ? `<button data-withdraw="${l.id}">Withdraw</button>` : `<button class="primary" data-take="${l.id}">Take</button>`}</div>
  </article>`;
}

function wireRows(root) {
  $$('[data-take]', root).forEach((b) => (b.onclick = () => guard(() => take(app.listings.get(Number(b.dataset.take))))));
  $$('[data-withdraw]', root).forEach((b) => (b.onclick = () => guard(() => withdraw(app.listings.get(Number(b.dataset.withdraw))))));
}

function renderMarket(main, pairArg) {
  main.className = 'market';
  const state = { mine: false };
  const draw = () => {
    const open = [...app.listings.values()];
    const trades = app.events.filter((e) => e.kind === 'taken');
    const pairs = new Map();
    for (const l of open) {
      const key = pairOf(l.giveCoin, l.wantCoin).join('-');
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    const [pa, pb] = (pairArg ?? '').split('-');
    const selected = pairs.has(`${pa}-${pb}`) || (/^[0-9a-f]{64}$/.test(pa ?? '') && /^[0-9a-f]{64}$/.test(pb ?? '')) ? [pa, pb] : null;
    const shownList = open.filter((l) => !state.mine || isMine(l.maker));
    const coinsListed = new Set(open.flatMap((l) => [hex(l.giveCoin), hex(l.wantCoin)]));
    const last = trades.at(-1);

    let book;
    if (!app.loaded) {
      book = '<div class="empty"><span class="spinner big"></span><p class="muted">Reading the listings…</p></div>';
    } else if (selected) {
      const [a, b] = selected.map(unhex);
      const sell = shownList.filter((l) => equal(l.giveCoin, a) && equal(l.wantCoin, b)).sort(byRate);
      const buy = shownList.filter((l) => equal(l.giveCoin, b) && equal(l.wantCoin, a)).sort(byRate);
      // Both sides quoted alike, in what one of the pair's first coin is worth.
      const column = (title, list) => `<section class="column">
        <header><h2>${title}</h2><span class="muted">${plural(list.length, 'listing')}, best rate first</span></header>
        ${list.length ? list.map((l) => listingRow(l, { base: a })).join('') : '<p class="muted empty-col">None open.</p>'}
      </section>`;
      book = `<div class="book">
        ${column(`Get ${coinTag(a)} for ${coinTag(b)}`, sell)}
        ${column(`Get ${coinTag(b)} for ${coinTag(a)}`, buy)}
      </div>`;
    } else if (shownList.length) {
      book = `<div class="list">${shownList.sort((x, y) => y.id - x.id).map((l) => listingRow(l)).join('')}</div>`;
    } else {
      book = `<div class="empty">${icon('swap')}<h2>${state.mine ? 'You have no open listings' : 'No open listings yet'}</h2>
        <p class="muted">${state.mine ? 'Listings your linked accounts made show here.' : 'Make the first: say what you give and what you want for it.'}</p>
        <a class="button primary" href="#/new">New listing</a></div>`;
    }

    main.innerHTML = `
      <section class="hero">
        <div class="hero-text">
          <div class="eyebrow">Peer to peer, on chain</div>
          <h1>Swap coins on Ting, one listing at a time</h1>
          <p>List what you give and what you want for it. Your coins wait in the swap program until someone takes the
          listing with Ting ID, or you withdraw it. Each trade settles in one transaction, and nobody in between holds a key.</p>
          <div class="row"><a class="button primary large" href="#/new">${icon('plus')} New listing</a><a class="button large ghost" href="#/about">How it works</a></div>
        </div>
        <dl class="stats">
          <div><dt>Open listings</dt><dd>${app.loaded ? open.length.toLocaleString() : '…'}</dd></div>
          <div><dt>Trades</dt><dd>${trades.length.toLocaleString()}</dd></div>
          <div><dt>Coins listed</dt><dd>${coinsListed.size.toLocaleString()}</dd></div>
          <div><dt>Last trade</dt><dd class="small">${last ? esc(ago(last.time)) : '—'}</dd></div>
        </dl>
      </section>
      <section class="board">
        <div class="filters">
          <div class="pairs" role="tablist" aria-label="Pairs">
            <a class="pill${selected ? '' : ' active'}" href="#/">All <span class="count">${open.length}</span></a>
            ${[...pairs.entries()].map(([key, n]) => {
              const [x, y] = key.split('-').map(unhex);
              const on = selected && selected.join('-') === key;
              return `<a class="pill${on ? ' active' : ''}" href="#/market/${key}">${coinTag(x)}<span class="slash">/</span>${coinTag(y)} <span class="count">${n}</span></a>`;
            }).join('')}
          </div>
          <label class="toggle"><input type="checkbox" id="mine"${state.mine ? ' checked' : ''}${app.accounts.size ? '' : ' disabled'}> <span>Only mine</span></label>
        </div>
        ${book}
      </section>`;
    $('#mine', main).onchange = (e) => { state.mine = e.target.checked; draw(); };
    wireRows(main);
  };
  draw();
  app.onData = draw;
  app.onAccounts = draw;
  let last = 0;
  app.tick = () => {
    if (now() - last < 60) return;
    last = now();
    $$('.listing .meta .label', main).forEach((el) => {
      const l = app.listings.get(Number(el.closest('.listing').dataset.id));
      if (l) el.textContent = `#${l.id} · ${ago(l.listedAt)}`;
    });
  };
}

// ---- One listing -----------------------------------------------------------

function renderListing(main, id) {
  main.className = 'detail';
  const draw = () => {
    const open = app.listings.get(id);
    const history = app.events.filter((e) => e.id === id);
    const made = history.find((e) => e.kind === 'listed');
    const closed = history.find((e) => e.kind !== 'listed');
    const l = open ?? made;
    if (!l) {
      main.innerHTML = app.loaded
        ? `<section class="notice"><h1>No listing ${id}</h1><p class="muted">${id > app.count ? `Listings count from 1; ${app.count ? `${app.count} is the latest` : 'none is made yet'}.` : 'It is not open, and this node has no event of it.'}</p><a class="button" href="#/">Back to the market</a></section>`
        : '<section class="notice"><span class="spinner big"></span><p class="muted">Reading the listing…</p></section>';
      return;
    }
    const mine = isMine(l.maker);
    const status = open ? '<span class="badge open">Open</span>'
      : closed?.kind === 'taken' ? '<span class="badge taken">Taken</span>'
        : closed?.kind === 'withdrawn' ? '<span class="badge withdrawn">Withdrawn</span>' : '<span class="badge">Closed</span>';
    const action = !open ? `<p class="muted">${closed?.kind === 'taken' ? `${who(closed.taker)} took it ${esc(ago(closed.time))}, paying ${who(closed.maker)}.` : closed?.kind === 'withdrawn' ? `Its maker withdrew it ${esc(ago(closed.time))} and got the coins back.` : 'It is no longer open.'}</p>`
      : mine ? `<div class="row"><button class="large" id="withdraw">${icon('undo')} Withdraw it</button></div>
          <p class="hint">Your coins come back to the account that listed them. Only that account can sign this.</p>`
        : `<div class="row"><button class="primary large" id="take">${icon('swap')} Take it with Ting ID</button></div>
          <p class="hint">You pay the maker ${amount(l.wantCoin, l.want)} and get ${amount(l.giveCoin, l.give)} from the swap, in one transaction. If someone takes it first, nothing is paid.</p>
          <details class="owner"><summary>Is it yours?</summary><p class="hint">Withdraw it with the account that listed it, ${who(l.maker)}.</p><button id="withdraw">Withdraw with Ting ID</button></details>`;
    main.innerHTML = `
      <a class="back" href="#/">${icon('back')} Market</a>
      <div class="detail-grid">
        <section class="ticket">
          <header><div><div class="eyebrow">Listing #${l.id}</div><h1>${amount(l.giveCoin, l.give)}</h1><p class="muted">for ${amount(l.wantCoin, l.want)}</p></div>${status}</header>
          <div class="legs">
            <div class="big-leg"><span class="label">${open && !mine ? 'You get' : 'Offered'}</span>${amount(l.giveCoin, l.give)}</div>
            <div class="swap-icon" aria-hidden="true">${icon('swap')}</div>
            <div class="big-leg"><span class="label">${open && !mine ? 'You pay' : 'Wanted'}</span>${amount(l.wantCoin, l.want)}</div>
          </div>
          <dl class="lines">
            <div><dt>Rate</dt><dd>${rateLine(l.giveCoin, l.give, l.wantCoin, l.want)}<br><span class="muted">${rateLine(l.wantCoin, l.want, l.giveCoin, l.give)}</span></dd></div>
            <div><dt>Maker</dt><dd>${who(l.maker)}</dd></div>
            ${open ? `<div><dt>Listed</dt><dd>${esc(date(l.listedAt))}</dd></div>` : ''}
          </dl>
          ${coinWarning([l.giveCoin, l.wantCoin])}
          ${action}
        </section>
        <aside class="side">
          <div class="card"><h2>The coins</h2>${[l.giveCoin, l.wantCoin].map((c) => coinCard(c)).join('')}</div>
          <div class="card"><h2>History</h2><ol class="activity">${history.length ? history.slice().reverse().map((e) => `<li>${eventText(e, false)}<time>${esc(date(e.time))}</time></li>`).join('') : '<li class="muted">No events of it on this node yet.</li>'}</ol></div>
        </aside>
      </div>`;
    const takeButton = $('#take', main);
    if (takeButton) takeButton.onclick = () => guard(() => take(open));
    const withdrawButton = $('#withdraw', main);
    if (withdrawButton) withdrawButton.onclick = () => guard(() => withdraw(open));
  };
  draw();
  app.onData = draw;
  app.onAccounts = draw;
}

function coinCard(id) {
  const c = coinOf(id);
  const fake = imitated(c);
  return `<div class="coin-card">
    ${coinTag(id, { name: true })}
    <p class="hint">${c.known ? 'A coin this page knows.' : fake ? `<b class="danger">Not ${esc(fake.name)}</b>: it only calls itself ${esc(shownText(c.symbol, 10) ?? '?')}.` : 'Not a coin this page knows: coins name themselves.'} ${c.decimals} decimals.</p>
    <code class="id">${hex(id)}</code>
  </div>`;
}

// ---- New listing -----------------------------------------------------------

const COINS = 'ting-swap/coins';

function savedCoins() {
  try {
    return JSON.parse(localStorage.getItem(COINS) ?? '[]').filter((h) => /^[0-9a-f]{64}$/.test(h));
  } catch {
    return [];
  }
}

function saveCoin(h) {
  try {
    localStorage.setItem(COINS, JSON.stringify([...new Set([...savedCoins(), h])]));
  } catch { /* kept for this visit only */ }
}

/** The coins to choose from: the known ones, then every other good coin the page has seen. */
function choosable() {
  const seen = [...app.coins.values()].filter((c) => !c.bad && !c.pending).map((c) => hex(c.id));
  return [...new Set([...app.known, ...savedCoins(), ...seen])].filter((h) => app.coins.get(h) && !app.coins.get(h).bad);
}

function renderNew(main) {
  main.className = 'new';
  const choices = choosable();
  const form = { give: choices[0] ?? '', want: choices[1] ?? '', giveAmount: '', wantAmount: '' };
  const coinSelect = (name, value) => `<div class="coin-select">
      <select id="${name}-coin" aria-label="Coin">${value ? '' : '<option value="" selected disabled>Pick a coin</option>'}${choosable().map((h) => {
        const c = app.coins.get(h);
        return `<option value="${h}"${h === value ? ' selected' : ''}>${esc(shownText(c.symbol, 10) ?? '?')} · ${esc(shownText(c.name, 24) ?? '?')}${c.known ? '' : ` · ${h.slice(0, 6)}…`}</option>`;
      }).join('')}<option value="add">Another coin…</option></select>
    </div>`;
  const draw = () => {
    main.innerHTML = `
      <a class="back" href="#/">${icon('back')} Market</a>
      <div class="new-grid">
        <form class="ticket composer" id="new-form" autocomplete="off">
          <div class="eyebrow">New listing</div>
          <h1>What do you offer?</h1>
          <div class="field-block">
            <label for="give-amount">You give</label>
            <div class="amount-row">
              <input id="give-amount" inputmode="decimal" placeholder="0.0" value="${esc(form.giveAmount)}">
              ${coinSelect('give', form.give)}
            </div>
            <p class="hint" id="give-hint"></p>
          </div>
          <button type="button" class="flip" id="flip" aria-label="Swap the two sides" title="Swap the two sides">${icon('flip')}</button>
          <div class="field-block">
            <label for="want-amount">You want</label>
            <div class="amount-row">
              <input id="want-amount" inputmode="decimal" placeholder="0.0" value="${esc(form.wantAmount)}">
              ${coinSelect('want', form.want)}
            </div>
            <p class="hint" id="want-hint"></p>
          </div>
          <div class="preview" id="preview"></div>
          <div id="warn"></div>
          <button class="primary large wide" id="list" type="submit">List with Ting ID</button>
          <p class="hint">Ting ID moves what you give into the swap program’s own account, where it waits until someone takes the listing or you withdraw it.</p>
        </form>
        <aside class="side">
          <div class="card steps">
            <h2>How a listing works</h2>
            <ol>
              <li><span><b>You list.</b> Your coins go into the swap program, held for this listing alone. Ting ID signs one payment, bound to this one listing.</span></li>
              <li><span><b>Someone takes it.</b> They pay you what you asked, straight to your account, and get your coins from the swap in the same transaction.</span></li>
              <li><span><b>Or you withdraw it.</b> Until it is taken, you can take it down and have your coins back.</span></li>
            </ol>
            <p class="hint">Listings are whole: a listing is taken in full or not at all. Savings accounts, with their time lock, cannot list.</p>
          </div>
          <div class="card" id="add-coin-card" hidden>
            <h2>Add a coin</h2>
            <form class="row" id="add-coin"><label class="field"><span>Its ContractId</span><input id="add-coin-id" class="mono" placeholder="64 hex digits" autocomplete="off"></label><button>Add</button></form>
            <p class="hint">Any coin of Ting’s coin program can be traded. Coins name themselves, so check the ContractId with whoever issued it.</p>
          </div>
        </aside>
      </div>`;
    wire();
    update();
  };
  const update = async () => {
    const give = form.give && app.coins.get(form.give);
    const want = form.want && app.coins.get(form.want);
    const g = give ? parseAmount(form.giveAmount, give.decimals) : null;
    const w = want ? parseAmount(form.wantAmount, want.decimals) : null;
    const preview = $('#preview', main);
    const problems = [];
    if (!give || !want) problems.push(choosable().length < 2 ? 'Add the other coin with Another coin…, by its ContractId.' : 'Pick both coins.');
    else if (form.give === form.want) problems.push('Pick two different coins.');
    if (give && form.giveAmount && g == null) problems.push(`${esc(give.symbol)} has ${give.decimals} decimals.`);
    if (want && form.wantAmount && w == null) problems.push(`${esc(want.symbol)} has ${want.decimals} decimals.`);
    const ready = !problems.length && g > 0n && w > 0n;
    preview.innerHTML = ready
      ? `<div class="preview-line"><span class="label">Rate</span><b>${rateLine(give.id, g, want.id, w)}</b></div><div class="preview-line muted"><span class="label"></span>${rateLine(want.id, w, give.id, g)}</div>`
      : problems.length && (form.giveAmount || form.wantAmount) ? `<p class="hint error">${problems.join(' ')}</p>` : '';
    $('#warn', main).innerHTML = give && want && form.give !== form.want ? coinWarning([give.id, want.id]) : '';
    $('#list', main).disabled = !ready;
    const hint = $('#give-hint', main);
    if (give && app.accounts.size) {
      try {
        const held = (await balances(give.id)).reduce((n, b) => n + b.available, 0n);
        if (form.give === hex(give.id)) {
          hint.innerHTML = `Your linked accounts hold ${amount(give.id, held)}. <button type="button" class="link" id="max">Use all</button>`;
          const max = $('#max', main);
          if (max) max.onclick = () => { form.giveAmount = formatAmount(held, give.decimals).replace(/,/g, ''); $('#give-amount', main).value = form.giveAmount; update(); };
        }
      } catch { hint.textContent = ''; }
    } else {
      hint.textContent = '';
    }
  };
  const wire = () => {
    for (const side of ['give', 'want']) {
      $(`#${side}-amount`, main).oninput = (e) => { form[`${side}Amount`] = e.target.value; update(); };
      $(`#${side}-coin`, main).onchange = (e) => {
        if (e.target.value === 'add') {
          e.target.value = form[side];
          $('#add-coin-card', main).hidden = false;
          $('#add-coin-id', main).focus();
          app.adding = side;
          return;
        }
        form[side] = e.target.value;
        update();
      };
    }
    $('#flip', main).onclick = () => {
      [form.give, form.want, form.giveAmount, form.wantAmount] = [form.want, form.give, form.wantAmount, form.giveAmount];
      draw();
    };
    $('#add-coin', main).onsubmit = async (e) => {
      e.preventDefault();
      const id = idOf($('#add-coin-id', main).value);
      if (!id) return toast('A ContractId is 64 hex digits.', 'error');
      await loadCoins([id]).catch(() => {});
      const coin = app.coins.get(hex(id));
      if (!coin || coin.bad) return toast('That contract is not a coin of Ting’s coin program, so the swap does not trade it.', 'error');
      saveCoin(hex(id));
      form[app.adding ?? 'want'] = hex(id);
      toast(`Added ${esc(shownText(coin.symbol, 10) ?? '?')}.`, 'success', 3000);
      draw();
    };
    $('#new-form', main).onsubmit = (e) => {
      e.preventDefault();
      const give = app.coins.get(form.give), want = app.coins.get(form.want);
      const g = parseAmount(form.giveAmount, give.decimals), w = parseAmount(form.wantAmount, want.decimals);
      if (!(g > 0n && w > 0n) || form.give === form.want) return;
      guard(() => perform({
        call: offerCall(want.id, w), pay: { coin: give.id, to: app.vault, amount: g },
        label: 'New listing', warn: coinWarning([give.id, want.id]),
        done: (ok, executed) => {
          if (!ok) return;
          const made = app.events.find((ev) => ev.kind === 'listed' && ev.height === executed.height && equal(ev.maker, executed.account));
          location.hash = made ? `#/listing/${made.id}` : '#/';
        },
      }));
    };
  };
  if (!choices.length) {
    main.innerHTML = '<section class="notice"><span class="spinner big"></span><p class="muted">Reading the coins…</p></section>';
    loadCoins([...app.known, ...savedCoins()].map(unhex)).then(() => {
      const again = choosable();
      form.give = again[0] ?? '';
      form.want = again[1] ?? '';
      draw();
    }).catch((err) => toast(esc(err.message), 'error'));
  } else {
    draw();
  }
  app.onAccounts = update;
}

// ---- Activity --------------------------------------------------------------

function eventText(e, link = true) {
  const ref = link ? `<a href="#/listing/${e.id}">#${e.id}</a>` : `#${e.id}`;
  switch (e.kind) {
    case 'listed': return `${icon('plus')}<span>${who(e.maker)} listed ${amount(e.giveCoin, e.give)} for ${amount(e.wantCoin, e.want)} <span class="muted">${ref}</span></span>`;
    case 'taken': return `${icon('swap')}<span>${who(e.taker)} took ${ref}: ${amount(e.giveCoin, e.give)} for ${amount(e.wantCoin, e.want)} from ${who(e.maker)}</span>`;
    case 'withdrawn': return `${icon('undo')}<span>${who(e.maker)} withdrew ${ref}, getting back ${amount(e.giveCoin, e.give)}</span>`;
    default: return 'Something unknown';
  }
}

function renderActivity(main) {
  main.className = 'activity-page';
  const state = { kind: 'all' };
  const draw = () => {
    const list = app.events.filter((e) => state.kind === 'all' || e.kind === state.kind).slice().reverse().slice(0, 200);
    main.innerHTML = `<header class="page-head"><h1>Activity</h1><p class="muted">Everything the swap did, newest first, as the chain recorded it.</p>
      <div class="pairs">${['all', 'taken', 'listed', 'withdrawn'].map((k) => `<button class="pill${state.kind === k ? ' active' : ''}" data-kind="${k}">${{ all: 'All', taken: 'Trades', listed: 'Listings', withdrawn: 'Withdrawals' }[k]}</button>`).join('')}</div></header>
      <ol class="activity big">${list.length ? list.map((e) => `<li class="${e.kind}">${eventText(e)}<time title="Block ${e.height}">${esc(ago(e.time))}</time></li>`).join('') : '<li class="muted">Nothing yet.</li>'}</ol>`;
    $$('[data-kind]', main).forEach((b) => (b.onclick = () => { state.kind = b.dataset.kind; draw(); }));
  };
  draw();
  app.onData = draw;
  app.onAccounts = draw;
}

// ---- About -----------------------------------------------------------------

function renderAbout(main) {
  main.className = 'about';
  main.innerHTML = `<article class="prose">
    <h1>How Ting Swap works</h1>
    <p>Ting Swap is a market of listings on the <a href="https://node1.ting-node.com/wiki">Ting</a> chain. A listing says:
    <em>I give this much of one coin for that much of another.</em> Anyone can take it, in full, with Ting ID.</p>
    <h2>Listing</h2>
    <p>When you list, Ting ID signs one payment: what you give, into the swap program’s own account, bound to this one
    listing. The program records the listing, numbered, with your account as its maker. There are no deposits and no
    balances in the swap: each listing holds exactly its own coins, and nothing else.</p>
    <h2>Taking</h2>
    <p>Whoever takes a listing pays its maker what the listing asks, straight from their account to the maker’s, and
    the program hands them the listed coins in the same transaction. If the listing was taken or withdrawn first, the
    whole transaction fails and nothing is paid. Ting ID shows both amounts before you approve: what you pay on its own
    line, which it checks itself, and what you get in the program’s words.</p>
    <h2>Withdrawing</h2>
    <p>Until a listing is taken, its maker can withdraw it and have the coins back, to the same account. Nobody else
    can, and nothing else can move them.</p>
    <h2>Accounts with a time lock</h2>
    <p>A Ting ID Savings account makes everything wait for its delay, so that a stolen key cannot empty it at once. A
    trade cannot wait a week, so the swap refuses those accounts outright: list and take from a Spending account.</p>
    <h2>Coins name themselves</h2>
    <p>Anyone can make a coin of Ting’s coin program and call it anything, even Daler. The swap trades any of them, so
    this page marks the coins it knows ${icon('check')}, warns about the others, and shows every coin’s ContractId. A
    coin that copies a known coin’s symbol is marked as an imitation.</p>
    <h2>Trust nothing, check everything</h2>
    <p>The page holds no key and no coins. It reads the chain through <code>${esc(app.node.base)}</code> and checks the
    code of what it makes calls for: the swap program <code>${esc(hex(app.swap))}</code> against the CodeHash it was
    written for, and every coin against the coin program’s. The program checks each coin itself too. Its rules are in
    its specification, <code>SPEC.md</code>, beside its source.</p>
    <dl class="lines facts">
      <div><dt>Swap program</dt><dd><code>${esc(hex(app.swap))}</code></dd></div>
      <div><dt>Its CodeHash</dt><dd><code>${esc(CODE_HASHES.swap)}</code></dd></div>
      <div><dt>Its own account</dt><dd><code>${esc(hex(app.vault))}</code></dd></div>
      <div><dt>Listings made</dt><dd>${app.count.toLocaleString()}</dd></div>
    </dl>
  </article>`;
}

// ---- Your accounts -----------------------------------------------------------

function openSigning() {
  const dialog = $('#sign-dialog');
  const body = $('.dialog-body', dialog);
  const linked = [...app.accounts];
  body.innerHTML = `<div class="eyebrow">Ting ID</div><h2>Signing with Ting ID</h2>
    <p>This page holds no key and no coins. Each action becomes a Ting call link, shown as a QR code to scan with
    Ting ID or a link to open on the phone. Ting ID shows the action in the program’s words and what leaves your
    account, signs it with the account you choose, and submits it. The page then finds it on the chain.</p>
    <h3>Your accounts</h3>
    <p class="hint">The page shows these as you, with your listings. It keeps only their addresses, in this browser;
    a call Ting ID sends back to this page links the account that made it.</p>
    <ul class="linked">${linked.map((a) => `<li><code title="${a}">${a.slice(0, 10)}…${a.slice(-8)}</code><button data-unlink="${a}">Remove</button></li>`).join('')
      || '<li class="muted">None yet.</li>'}</ul>
    <form class="row" id="link-form">
      <label class="field"><span>Add an account</span><input id="link-account" class="mono" autocomplete="off" placeholder="64 hex digits"></label>
      <button>Add</button>
    </form>`;
  $('#link-form', body).addEventListener('submit', (e) => {
    e.preventDefault();
    const account = idOf($('#link-account', body).value);
    if (!account) return toast('An account is 64 hex digits.', 'error');
    linkAccount(account, true);
    openSigning();
  });
  $$('[data-unlink]', body).forEach((b) => (b.onclick = () => { linkAccount(unhex(b.dataset.unlink), false); openSigning(); }));
  if (!dialog.open) dialog.showModal();
}

const ACCOUNTS = 'ting-swap/accounts';

function loadAccounts() {
  try {
    const list = JSON.parse(localStorage.getItem(ACCOUNTS) ?? '[]');
    app.accounts = new Set(list.filter((a) => /^[0-9a-f]{64}$/.test(a)));
  } catch {
    app.accounts = new Set();
  }
}

function linkAccount(account, linked) {
  const text = hex(account);
  if (linked) app.accounts.add(text);
  else app.accounts.delete(text);
  try {
    localStorage.setItem(ACCOUNTS, JSON.stringify([...app.accounts]));
  } catch { /* kept for this visit only */ }
  app.onAccounts?.();
  updateChip();
}

const isMine = (account) => Boolean(account) && app.accounts.has(hex(account));

function updateChip() {
  const chip = $('#sign-chip');
  chip.innerHTML = `${icon('wallet')} <span>${app.accounts.size ? plural(app.accounts.size, 'account') : 'Ting ID'}</span>`;
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 'success', 2500);
  } catch {
    toast('Copying is not allowed here', 'error', 2500);
  }
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

// ---- Icons -----------------------------------------------------------------

function icon(name) {
  const paths = {
    swap: '<path d="M7 7h12l-3.5-3.5M17 17H5l3.5 3.5"/>',
    flip: '<path d="M8 4v16m0 0l-4-4m4 4l4-4M16 20V4m0 0l-4 4m4-4l4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M16 12.5h2M3 9.5h18"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
    moon: '<path d="M20 14.5A8 8 0 019.5 4a8 8 0 1010.5 10.5z"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
}

// ---- Start -----------------------------------------------------------------

function fatal(title, detail) {
  $('#view').innerHTML = `<section class="notice"><h1>${esc(title)}</h1><p>${detail}</p></section>`;
}

async function boot() {
  try { applyTheme(localStorage.getItem(THEME)); } catch { /* the system's */ }
  $('#theme').innerHTML = icon('moon');
  $('#theme').onclick = toggleTheme;
  const query = new URLSearchParams(location.search);
  app.node = new Node(query.get('node') || DEFAULT_NODE);
  let status;
  try {
    status = await app.node.status();
  } catch (e) {
    return fatal('Cannot reach the node', `${esc(app.node.base)}: ${esc(e.message)}`);
  }
  app.chainHex = status.chain_id;
  app.chain = unhex(status.chain_id);
  app.network = NETWORKS[app.chainHex] ?? { name: status.network ?? 'Unknown network', swap: '', coins: [] };
  $('#network').textContent = app.network.name;
  app.swap = idOf(query.get('swap') || app.network.swap);
  if (!app.swap) {
    return fatal('Ting Swap is not open on this network yet', `The swap program is not deployed on ${esc(app.network.name)}, or this page does not know where. Add <code>?swap=&lt;ContractId&gt;</code> to the address to use another deployment.`);
  }
  app.vault = contractAccount(app.swap);
  const extra = (query.get('coins') ?? '').split(',').map((t) => t.trim().toLowerCase()).filter((t) => /^[0-9a-f]{64}$/.test(t));
  app.known = [...new Set([...app.network.coins, ...extra])];
  try {
    const swap = await app.node.contract(app.swap);
    if (swap.code_hash !== CODE_HASHES.swap) {
      return fatal('This swap runs other code', `The contract runs code <code>${esc(swap.code_hash)}</code>, not the swap program this page was written for. The page makes no calls for it.`);
    }
    app.templates = decodeTemplateList(await app.node.record(app.swap, TEMPLATES_KEY));
    try {
      for (const t of Object.values(TEMPLATES)) checkListed(app.templates, t);
    } catch (e) {
      return fatal('This swap lists other operations', `Its template list does not hold the operations this page makes: ${esc(e.message)}.`);
    }
    await loadCoins([...app.known, ...savedCoins()].map(unhex));
    app.feeCoin = app.known.map((h) => app.coins.get(h)).find((c) => c && !c.bad)?.id ?? null;
  } catch (e) {
    return fatal('Cannot read the swap', esc(e.message));
  }
  loadAccounts();
  const chip = $('#sign-chip');
  updateChip();
  chip.onclick = openSigning;
  for (const id of ['sign', 'call']) {
    const dialog = $(`#${id}-dialog`);
    $('.close', dialog).onclick = () => dialog.close();
    dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  }
  setInterval(() => app.tick?.(), 1000);
  setInterval(() => { if (!$('input:focus')) refresh().catch(() => {}); }, 12_000);
  window.addEventListener('hashchange', arrive);
  arrive();
  refresh().catch((e) => toast(`Reading the swap: ${esc(e.message)}`, 'error'));
}

/** Routes, or takes a call back from Ting ID: the link's `return` opened with `#ting-tx=` (TCR-1, the link). */
function arrive() {
  const m = location.hash.match(/^#ting-tx=([0-9a-fA-F]{64})$/);
  if (!m) return route();
  const id = m[1].toLowerCase();
  history.replaceState(null, '', location.pathname + location.search);
  follow(id, 'Your call from Ting ID', async (ok, seen) => {
    await refresh().catch(() => {});
    if (!ok || !seen) return;
    // The wallet sent this transaction here: the account it acted for is the user's.
    const actor = actorOf(seen.receipt);
    if (actor && !isMine(actor)) {
      linkAccount(actor, true);
      toast(`Linked your account <code>${short(actor)}</code>: the page shows your listings as yours.`, 'success', 8000);
    }
    const listing = listingOfReceipt(seen.receipt);
    if (listing) location.hash = `#/listing/${listing}`;
  });
  route();
}

/** The account a call to the swap acted for, from its receipt's *executed* event, or null. */
function actorOf(receipt) {
  for (const e of receipt?.events ?? []) {
    if (e.contract !== hex(app.swap)) continue;
    const payload = unhex(e.payload_hex);
    if (payload.length >= 64 && equal(payload.subarray(0, 32), EXECUTED)) return payload.slice(32, 64);
  }
  return null;
}

/** The listing a receipt's swap event names, or null. */
function listingOfReceipt(receipt) {
  for (const e of receipt?.events ?? []) {
    if (e.contract !== hex(app.swap)) continue;
    const payload = unhex(e.payload_hex);
    if (payload.length < 41 || !equal(payload.subarray(0, 32), TOPIC)) continue;
    return Number(new Reader(payload.subarray(33, 41)).u64());
  }
  return null;
}

/** The input of a transaction that calls the swap, or null. */
function swapInput(txHex) {
  if (!txHex) return null;
  const r = new Reader(unhex(txHex));
  if (r.u8() !== 1 || r.u8() !== 0) return null;
  for (let i = 0; i < 4; i++) r.u64();
  return equal(r.id(), app.swap) ? r.bytes() : null;
}

boot();
