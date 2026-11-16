#!/usr/bin/env node
// The Ting Swap watchtower (watchtower/README.md): reads the HTLC program on
// Ting and the locks on Litecoin, keeps a Discord feed of the listings,
// reminds those who watch a listing at the steps that need them, finishes the
// seller's signed LTC claim once the buyer's claim makes the secret public,
// and sends the DLR refund once a deadline passes with no claim. It holds no
// key, and nothing depends on it: the pages do every step themselves.
//
//   node watchtower/src/main.mjs [--dry-run]            production, as LTC_PRODUCTION pins it
//   node watchtower/src/main.mjs --node <url> --htlc <id> --coin <id> --ltc <url> --ltcnet regtest
//   node watchtower/src/main.mjs register               registers the slash commands, then stops
import { createServer } from 'node:http';
import { hex, unhex } from '../../web/js/bytes.js';
import { CODE_HASHES, LTC_PRODUCTION } from '../../web/js/config.js';
import { decodeCoin } from '../../web/js/swap.js';
import { sendClaims, sendRefunds } from './act.mjs';
import { Litecoin, Ting } from './chains.mjs';
import { answer, Discord, signedByDiscord } from './discord.mjs';
import { feedMessage, notesFor } from './notes.mjs';
import * as S from './state.mjs';
import { acceptedLocks, closed, lockOf, outKey, pays, tradesOf } from './trades.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const env = process.env;

const production = !opt('node');
const setup = production ? LTC_PRODUCTION : {
  node: opt('node'), htlc: opt('htlc'), coin: opt('coin'), ltc: opt('ltc'), ltcnet: opt('ltcnet') ?? 'regtest', tconfs: Number(opt('tconfs') ?? 3),
};
if (!production && (!setup.htlc || !setup.coin || !setup.ltc)) throw new Error('a test setup names --node, --htlc, --coin and --ltc');
if (!production && setup.ltcnet === 'mainnet') throw new Error('a test setup runs on Litecoin regtest or testnet, never mainnet');

const config = {
  dryRun: flag('dry-run') || env.DRY_RUN === '1',
  statePath: env.STATE_FILE ?? 'watchtower-state.json',
  pageUrl: env.PAGE_URL ?? 'https://ting-organization.github.io/ting-swap/',
  poll: Number(env.POLL_SECONDS ?? 15) * 1000,
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  discord: { token: env.DISCORD_TOKEN, applicationId: env.DISCORD_APPLICATION_ID, publicKey: env.DISCORD_PUBLIC_KEY, channel: env.DISCORD_CHANNEL },
};

/** Outputs of takes on open listings read at most this many a round, those never read first: free takes cannot flood the explorer. */
const OTHER_READS = 8;
/** An output Litecoin did not have is read again after this long. */
const MISSING_AGAIN = 300;
/** Takes matching an accept whose locks are read every round, at most: anyone can post copies of a take. */
const ACCEPTED_READS = 4;
const PRICE_EVERY = 600;

const now = () => Math.floor(Date.now() / 1000);
const log = (text) => console.log(`${new Date().toISOString()} ${text}`);

const program = unhex(setup.htlc);
const coinId = unhex(setup.coin);
const ting = new Ting({ node: setup.node, program });
const litecoin = new Litecoin(setup.ltc);
const discord = new Discord({ ...config.discord, dryRun: config.dryRun, log });
const state = S.load(config.statePath);
const outs = new Map();
let trades = new Map();
let coin = null;
let usd = null;
let usdAt = 0;
let ltcTip = null;

if (args[0] === 'register') {
  if (!config.discord.token || !config.discord.applicationId) throw new Error('registering needs DISCORD_TOKEN and DISCORD_APPLICATION_ID');
  await discord.register();
  log('registered /watch, /unwatch and /watching');
  process.exit(0);
}

/** Refuses to run against anything but the chain, program and coin the page is pinned to, as the page does. */
async function check() {
  const tip = await ting.readTip();
  if (production && tip.chainId !== setup.chainId) throw new Error(`the node is on chain ${tip.chainId}, not Ting's`);
  const p = await ting.node.contract(program);
  if (p.code_hash !== CODE_HASHES.htlc) throw new Error(`the program runs code ${p.code_hash}, not the HTLC program`);
  const c = await ting.node.contract(coinId);
  const cfg = await ting.node.record(coinId, new Uint8Array(32));
  if (c.code_hash !== CODE_HASHES.coin || !cfg) throw new Error('the DLR coin does not run the reference coin program');
  coin = decodeCoin(cfg);
}

const outOf = (lock) => (lock ? outs.get(lock.key)?.out : undefined);

async function readOut(lock) {
  try {
    outs.set(lock.key, { out: await litecoin.out(lock.txid, lock.vout), at: now() });
  } catch (e) {
    log(`cannot read ${lock.key} on Litecoin: ${e.message}`);
  }
}

/**
 * Reads what this round needs of Litecoin: every round, the locks an accept
 * may be for, until a claim of theirs is in a block; in turns, at most
 * OTHER_READS, the other takes' locks of open listings, until each is seen.
 */
async function readLitecoin() {
  ltcTip = await litecoin.tip().catch((e) => { log(`cannot read Litecoin's tip: ${e.message}`); return ltcTip; });
  if (now() - usdAt > PRICE_EVERY) {
    usd = (await litecoin.usd()) ?? usd;
    usdAt = now();
  }
  const others = [];
  for (const trade of trades.values()) {
    if (trade.accepted && !trade.refunded) {
      const named = new Set(trade.signedClaims.map((s) => outKey(s.claim)));
      const locks = acceptedLocks(trade, program, setup.ltcnet).sort((a, b) => Number(named.has(b.lock.key)) - Number(named.has(a.lock.key))).slice(0, ACCEPTED_READS);
      for (const { lock } of locks) {
        const seen = outOf(lock);
        if (seen?.spent && seen.spenderConfirmed) continue;
        await readOut(lock);
      }
    } else if (!closed(trade)) {
      for (const take of trade.takes) {
        const lock = lockOf(trade, take, program, setup.ltcnet);
        if (!lock) continue;
        const kept = outs.get(lock.key);
        if (kept && !kept.out.missing) continue;
        if (kept && now() - kept.at < MISSING_AGAIN) continue;
        others.push({ lock, at: kept?.at ?? 0 });
      }
    }
  }
  for (const { lock } of others.sort((a, b) => a.at - b.at).slice(0, OTHER_READS)) await readOut(lock);
}

const lockedNow = (trade) => trade.takes.some((take) => pays(lockOf(trade, take, program, setup.ltcnet), outOf(lockOf(trade, take, program, setup.ltcnet)), trade.listed.want));

/**
 * Posts a feed message for every listing not over when first seen, and edits
 * each as it moves on. The USD estimate is LTC's price when it was posted, so
 * that a price change alone edits nothing.
 */
async function updateFeed() {
  if (!config.discord.channel && !config.dryRun) return;
  for (const trade of trades.values()) {
    const kept = state.feed[trade.id];
    if (!kept && closed(trade)) continue;
    const price = kept ? kept.usd ?? null : usd;
    const message = feedMessage(trade, { coin, usd: price, pageUrl: config.pageUrl, locked: lockedNow(trade) });
    const text = JSON.stringify(message);
    if (kept?.text === text) continue;
    try {
      if (kept) await discord.edit(kept.message, message);
      const id = kept?.message ?? (await discord.post(message));
      state.feed[trade.id] = { message: id, text, usd: price };
    } catch (e) {
      log(`#${trade.id}: the feed message did not go out: ${e.message}`);
    }
  }
}

function view(trade) {
  return {
    now: now(), coin, program, net: setup.ltcnet, tconfs: setup.tconfs, ltcTip, outOf,
    claim: Object.values(state.claims).find((c) => c.listing === trade.id && !c.error) ?? null,
  };
}

/** Sends each watcher the reminders due to them that they did not get yet. */
async function sendNotes() {
  for (const [idText] of Object.entries(state.watch)) {
    const id = Number(idText);
    const trade = trades.get(id);
    if (!trade) continue;
    for (const [user, role] of S.watchersOf(state, id)) {
      for (const note of notesFor(trade, role, view(trade))) {
        const key = S.sentKey(user, id, note.key);
        if (state.sent[key]) continue;
        try {
          await discord.dm(user, note.text);
          state.sent[key] = now();
        } catch (e) {
          log(`#${id}: no direct message to ${user}: ${e.message}`);
          if (e.code === 50007) state.sent[key] = -now();
        }
      }
    }
  }
}

/** The first direct message to a new watcher: where the listing stands, and what is due now, which is then sent. */
async function welcome(user, id, role) {
  const trade = trades.get(id);
  const due = notesFor(trade, role, view(trade)).filter((n) => !state.sent[S.sentKey(user, id, n.key)]);
  const text = [`You are watching listing #${id} as its ${role}. ${config.pageUrl}#/l/${id}`, ...due.map((n) => n.text)].join('\n\n');
  try {
    await discord.dm(user, text);
  } catch (e) {
    log(`#${id}: no welcome message to ${user}: ${e.message}`);
    return false;
  }
  for (const n of due) state.sent[S.sentKey(user, id, n.key)] = now();
  return true;
}

async function round() {
  await ting.readTip();
  if (production && ting.tip.chainId !== setup.chainId) throw new Error(`the node moved to chain ${ting.tip.chainId}`);
  trades = tradesOf(await ting.readEvents(), coinId);
  await readLitecoin();
  const t = now();
  await sendClaims({ trades, program, net: setup.ltcnet, outOf, litecoin, state, now: t, dryRun: config.dryRun, log });
  await sendRefunds({ trades, ting, state, now: t, dryRun: config.dryRun, log });
  await updateFeed();
  await sendNotes();
  S.save(config.statePath, state);
}

function serve() {
  if (!config.discord.publicKey) {
    log('no DISCORD_PUBLIC_KEY: no interactions endpoint, so no /watch and no buttons');
    return;
  }
  createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(`ok, ${trades.size} listings, Ting ${ting.tip?.height ?? '?'}\n`);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= 65_536) chunks.push(c); });
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      if (size > 65_536 || !signedByDiscord(config.discord.publicKey, req.headers['x-signature-ed25519'], req.headers['x-signature-timestamp'], body)) {
        res.writeHead(401).end('bad signature');
        return;
      }
      let out;
      try {
        out = await answer(JSON.parse(body.toString('utf8')), {
          watch: (user, id, role) => S.watch(state, user, id, role),
          unwatch: (user, id) => S.unwatch(state, user, id),
          watching: (user) => S.watching(state, user),
          known: (id) => trades.has(id),
          welcome,
        });
        S.save(config.statePath, state);
      } catch (e) {
        log(`an interaction failed: ${e.message}`);
        out = { type: 4, data: { content: 'Something went wrong; try again in a minute.', flags: 64 } };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
    });
  }).listen(config.port, config.host, () => log(`interactions on http://${config.host}:${config.port}/`));
}

await check();
log(`watching ${hex(program)} on ${production ? 'Ting' : setup.node}, Litecoin ${setup.ltcnet}${config.dryRun ? ', dry run: nothing is sent' : ''}`);
serve();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { S.save(config.statePath, state); process.exit(0); });
for (;;) {
  try {
    await round();
  } catch (e) {
    log(`round failed: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, config.poll));
}
