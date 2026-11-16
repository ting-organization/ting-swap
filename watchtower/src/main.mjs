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
import { outsInUse, readsDue } from './reads.mjs';
import * as S from './state.mjs';
import { sendNotes, updateFeed, welcome } from './tell.mjs';
import { claimOf, lockOf, pays, tradesOf } from './trades.mjs';

/** No request waits longer than this: one hung connection would hold up a whole round. */
const FETCH_TIMEOUT = 20_000;
const plainFetch = globalThis.fetch;
globalThis.fetch = (url, init = {}) => plainFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT) });

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
  feedMin: BigInt(Math.round(Number(env.FEED_MIN_LTC ?? '0.01') * 1e8)),
  poll: Number(env.POLL_SECONDS ?? 15) * 1000,
  port: Number(env.PORT ?? 8787),
  host: env.HOST ?? '127.0.0.1',
  discord: { token: env.DISCORD_TOKEN, applicationId: env.DISCORD_APPLICATION_ID, publicKey: env.DISCORD_PUBLIC_KEY, channel: env.DISCORD_CHANNEL },
};

const PRICE_EVERY = 600;

const now = () => Math.floor(Date.now() / 1000);
const log = (text) => console.log(`${new Date().toISOString()} ${text}`);

const program = unhex(setup.htlc);
const coinId = unhex(setup.coin);
const ting = new Ting({ node: setup.node, program });
const litecoin = new Litecoin(setup.ltc);
const discord = new Discord({ ...config.discord, dryRun: config.dryRun, log });
const state = S.load(config.statePath);
/** The outputs read, by outpoint, `{ out, at }`: kept in the state, so that a restart reads nothing again it need not. */
const outs = new Map(Object.entries(state.outs ?? {}));
const failed = new Map();
let trades = new Map();
/** Whether the listings were read once: before that, no read can be told useless. */
let read = false;
let coin = null;
let usd = null;
let usdAt = 0;
let ltcTip = null;
let saved = null;

/**
 * Writes the state, keeping only the outputs still of use (outsInUse), and
 * only when it changed. A dry run keeps nothing: what it only printed must not
 * count as done for the run after it.
 */
function saveState() {
  if (config.dryRun) return;
  if (read) {
    const keep = outsInUse({ trades, program, net: setup.ltcnet, now: now() });
    for (const key of outs.keys()) if (!keep.has(key)) outs.delete(key);
  }
  state.outs = Object.fromEntries(outs);
  const text = JSON.stringify(state);
  if (text === saved) return;
  S.save(config.statePath, state);
  saved = text;
}

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
const claimOfTrade = (trade) => claimOf(trade, program, setup.ltcnet, outOf);

async function readOut(lock) {
  try {
    outs.set(lock.key, { out: await litecoin.out(lock.txid, lock.vout), at: now() });
    failed.delete(lock.key);
  } catch (e) {
    failed.set(lock.key, now());
    log(`cannot read ${lock.key} on Litecoin: ${e.message}`);
  }
}

/** Reads what this round needs of Litecoin (reads.mjs). */
async function readLitecoin() {
  ltcTip = await litecoin.tip().catch((e) => { log(`cannot read Litecoin's tip: ${e.message}`); return ltcTip; });
  if (now() - usdAt > PRICE_EVERY) {
    usd = (await litecoin.usd()) ?? usd;
    usdAt = now();
  }
  for (const lock of readsDue({ trades, program, net: setup.ltcnet, outs, failed, now: now(), claimOf: claimOfTrade })) await readOut(lock);
}

/** Whether a buyer's lock pays an open listing and is not spent: released and taken back, it is no lock any more. */
const lockedNow = (trade) => trade.takes.some((take) => {
  const lock = lockOf(trade, take, program, setup.ltcnet);
  const o = outOf(lock);
  return pays(lock, o, trade.listed.want) && !o.spent;
});

function view(trade) {
  const claims = Object.values(state.claims).filter((c) => c.listing === trade.id);
  return {
    now: now(), coin, program, net: setup.ltcnet, tconfs: setup.tconfs, ltcTip, outOf, claimOf: claimOfTrade,
    claim: claims.find((c) => !c.error) ?? claims[0] ?? null,
  };
}

const printedFeed = new Map();
const printedNotes = new Set();

/** The claims and refunds each round; the feed and the reminders apart, so that a slow Discord never holds them up. */
async function round() {
  await ting.readTip();
  if (production && ting.tip.chainId !== setup.chainId) throw new Error(`the node moved to chain ${ting.tip.chainId}`);
  trades = tradesOf(await ting.readEvents(), coinId);
  read = true;
  await readLitecoin();
  const t = now();
  await sendClaims({ trades, program, net: setup.ltcnet, outOf, litecoin, state, now: t, dryRun: config.dryRun, log });
  await sendRefunds({ trades, ting, state, now: t, dryRun: config.dryRun, log });
  saveState();
  tell();
}

let telling = null;
function tell() {
  if (telling) return;
  telling = (async () => {
    try {
      await updateFeed({
        trades, state, discord, printed: printedFeed, coin, usd, pageUrl: config.pageUrl, feedMin: config.feedMin,
        channel: config.discord.channel, lockedNow, log,
      });
      await sendNotes({ trades, state, discord, printed: printedNotes, viewOf: view, now: now(), log });
      saveState();
    } catch (e) {
      log(`the feed or the reminders failed: ${e.message}`);
    } finally {
      telling = null;
    }
  })();
}

function serve() {
  if (!config.discord.publicKey) {
    log('no DISCORD_PUBLIC_KEY: no interactions endpoint, so no /watch and no buttons');
    return;
  }
  const hooks = {
    watch: (user, id, role) => S.watch(state, user, id, role),
    unwatch: (user, id) => S.unwatch(state, user, id),
    watching: (user) => S.watching(state, user),
    known: (id) => trades.has(id),
    welcome: (user, id, role) => welcome({ trade: trades.get(id), user, role, state, discord, viewOf: view, pageUrl: config.pageUrl, now: now(), dryRun: config.dryRun, log }),
  };
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
      let interaction;
      let reply;
      try {
        interaction = JSON.parse(body.toString('utf8'));
        reply = answer(interaction, hooks);
      } catch (e) {
        log(`an interaction failed: ${e.message}`);
        reply = { now: { type: 4, data: { content: 'Something went wrong; try again in a minute.', flags: 64 } } };
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.now));
      saveState();
      if (!reply.later) return;
      let text;
      try {
        text = await reply.later();
      } catch (e) {
        log(`an interaction failed: ${e.message}`);
        text = 'Something went wrong; try again in a minute.';
      }
      saveState();
      await discord.followUp(interaction, text).catch((e) => log(`no answer to an interaction: ${e.message}`));
    });
  }).listen(config.port, config.host, () => log(`interactions on http://${config.host}:${config.port}/`));
}

await check();
log(`watching ${hex(program)} on ${production ? 'Ting' : setup.node}, Litecoin ${setup.ltcnet}${config.dryRun ? ', dry run: nothing is sent or kept' : ''}${discord.live ? '' : ', Discord printed only'}`);
serve();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { saveState(); process.exit(0); });
for (;;) {
  try {
    await round();
  } catch (e) {
    log(`round failed: ${e.message}`);
  }
  await new Promise((r) => setTimeout(r, config.poll));
}
