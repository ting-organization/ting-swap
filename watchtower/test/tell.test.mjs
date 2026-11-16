import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { empty, watch } from '../src/state.mjs';
import { sendNotes, updateFeed, welcome } from '../src/tell.mjs';
import { claimOf, tradesOf } from '../src/trades.mjs';
import * as F from './fixture.mjs';

const quiet = () => {};

/** A stand-in Discord: live or not, noting its calls, and failing as told. */
function fakeDiscord({ live = true } = {}) {
  let n = 0;
  return {
    live, calls: [], failEdit: null, failDm: null,
    async post(message) { this.calls.push(['post', message.embeds[0].title]); return live ? `m${++n}` : null; },
    async edit(id, message) { this.calls.push(['edit', id, message.embeds[0].title]); if (this.failEdit) throw this.failEdit; },
    async dm(user, text) { this.calls.push(['dm', user, text]); if (this.failDm) throw this.failDm; return live; },
  };
}

const feed = (trades, state, discord, printed = new Map()) => updateFeed({
  trades, state, discord, printed, coin: F.COIN, usd: 44, pageUrl: 'x/', feedMin: 1_000_000n, channel: '9', lockedNow: () => false, log: quiet,
});
const view = (trade) => ({ now: 1_900_000_100, coin: F.COIN, program: F.program, net: F.NET, tconfs: 30, ltcTip: { mtp: 0 }, outOf: () => F.lockOut(1), claim: null, claimOf: (t) => claimOf(t, F.program, F.NET, () => F.lockOut(1)) });

test('the feed: not live, printed once and nothing kept', async () => {
  const trades = tradesOf([F.listed(1)], F.coin);
  const state = empty();
  const discord = fakeDiscord({ live: false });
  const printed = new Map();
  await feed(trades, state, discord, printed);
  await feed(trades, state, discord, printed);
  assert.deepEqual(discord.calls.map((c) => c[0]), ['post'], 'printed once');
  assert.deepEqual(state.feed, {}, 'no message id kept for the run after');
});

test('the feed: posted, edited, posted anew when deleted, small listings left out', async () => {
  const state = empty();
  const discord = fakeDiscord();
  await feed(tradesOf([F.listed(1), F.listed(2, { want: 999_999n })], F.coin), state, discord);
  assert.deepEqual(Object.keys(state.feed), ['1'], 'a listing under the minimum is not posted');
  assert.equal(state.feed[1].message, 'm1');
  await feed(tradesOf([F.listed(1)], F.coin), state, discord);
  assert.equal(discord.calls.length, 1, 'nothing changed: nothing sent');
  await feed(tradesOf([F.listed(1), F.withdrawn(1)], F.coin), state, discord);
  assert.deepEqual(discord.calls.at(-1), ['edit', 'm1', '#1 · Buy 10 DLR for 0.5 LTC']);
  discord.failEdit = Object.assign(new Error('Unknown Message'), { status: 404, code: 10008 });
  await feed(tradesOf([F.listed(1), F.taken(1), F.accepted(1)], F.coin), state, discord);
  assert.deepEqual(discord.calls.slice(-2).map((c) => c[0]), ['edit', 'post'], 'deleted: posted anew');
  assert.equal(state.feed[1].message, 'm2');
  discord.failEdit = Object.assign(new Error('Discord 500'), { status: 500 });
  const before = state.feed[1].text;
  await feed(tradesOf([F.listed(1), F.taken(1), F.accepted(1), F.claimed(1)], F.coin), state, discord);
  assert.equal(state.feed[1].text, before, 'another failure: kept as it was, tried again next round');
});

test('reminders: kept as sent only when Discord sent them', async () => {
  const trades = tradesOf([F.listed(1), F.taken(1), F.accepted(1)], F.coin);
  const state = empty();
  watch(state, 'u1', 1, 'buyer');
  const notes = (discord, printed = new Set()) => sendNotes({ trades, state, discord, printed, viewOf: view, now: 5, log: quiet });
  const dry = fakeDiscord({ live: false });
  const printed = new Set();
  await notes(dry, printed);
  await notes(dry, printed);
  assert.equal(dry.calls.length, 1, 'not live: printed once');
  assert.deepEqual(state.sent, {}, 'and not kept');
  const live = fakeDiscord();
  live.failDm = Object.assign(new Error('Discord 500'), { status: 500 });
  await notes(live);
  assert.deepEqual(state.sent, {}, 'a failure: tried again later');
  live.failDm = null;
  await notes(live);
  assert.deepEqual(state.sent, { 'u1|1|accepted': 5 });
  const closedDms = fakeDiscord();
  closedDms.failDm = Object.assign(new Error('Cannot send messages to this user'), { status: 403, code: 50007 });
  watch(state, 'u2', 1, 'buyer');
  await notes(closedDms);
  assert.equal(state.sent['u2|1|accepted'], -5, 'a user who takes no direct messages: not asked again');
});

test('welcome: a watcher is kept only when it can be messaged', async () => {
  const trade = tradesOf([F.listed(1), F.taken(1), F.accepted(1)], F.coin).get(1);
  const state = empty();
  const run = (discord, dryRun) => welcome({ trade, user: 'u1', role: 'buyer', state, discord, viewOf: view, pageUrl: 'x/', now: 5, dryRun, log: quiet });
  assert.equal(await run(fakeDiscord({ live: false }), false), false, 'no token: cannot message, not kept');
  assert.equal(await run(fakeDiscord({ live: false }), true), true, 'a dry run plays along');
  assert.deepEqual(state.sent, {}, 'but keeps nothing');
  const live = fakeDiscord();
  assert.equal(await run(live, false), true);
  assert.match(live.calls[0][2], /You are watching listing #1 as its buyer[\s\S]*The seller accepted a lock/);
  assert.deepEqual(state.sent, { 'u1|1|accepted': 5 }, 'what it said counts as sent');
});
