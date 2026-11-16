import { strict as assert } from 'node:assert';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { answer, signedByDiscord } from '../src/discord.mjs';
import * as S from '../src/state.mjs';

test('interaction requests: only those signed with the application\'s key', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  const body = Buffer.from('{"type":1}');
  const timestamp = '1794827398';
  const signature = sign(null, Buffer.concat([Buffer.from(timestamp), body]), privateKey).toString('hex');
  assert.ok(signedByDiscord(raw, signature, timestamp, body));
  assert.ok(!signedByDiscord(raw, signature, '1794827399', body), 'another timestamp');
  assert.ok(!signedByDiscord(raw, signature, timestamp, Buffer.from('{"type":2}')), 'another body');
  assert.ok(!signedByDiscord(raw, undefined, timestamp, body), 'no signature');
  const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(12).toString('hex');
  assert.ok(!signedByDiscord(other, signature, timestamp, body), 'another key');
});

test('commands and buttons: watch, unwatch, watching', async () => {
  const state = S.empty();
  let dmOk = true;
  const hooks = {
    watch: (u, id, role) => S.watch(state, u, id, role),
    unwatch: (u, id) => S.unwatch(state, u, id),
    watching: (u) => S.watching(state, u),
    known: (id) => id === 42,
    welcome: async () => dmOk,
  };
  const user = { id: '1001' };
  // What the user ends up seeing: the reply itself, or the deferred one's answer.
  const seen = async (interaction) => {
    const r = answer(interaction, hooks);
    return r.later ? { deferred: r.now, text: await r.later() } : { now: r.now, text: r.now.data?.content };
  };
  assert.deepEqual(answer({ type: 1 }, hooks).now, { type: 1 }, 'Discord\'s ping');

  const watched = await seen({ type: 2, member: { user }, data: { name: 'watch', options: [{ name: 'listing', value: 42 }, { name: 'role', value: 'seller' }] } });
  assert.deepEqual(watched.deferred, { type: 5, data: { flags: 64 } }, 'answered at once with a deferred reply only the user sees');
  assert.match(watched.text, /listing #42 at each step that needs you as its seller/);
  assert.deepEqual(S.watchersOf(state, 42), [['1001', 'seller']]);

  const button = await seen({ type: 3, user: { id: '1002' }, data: { custom_id: 'watch:42:buyer' } });
  assert.match(button.text, /as its buyer/);
  assert.deepEqual(S.watchersOf(state, 42), [['1001', 'seller'], ['1002', 'buyer']]);

  const list = await seen({ type: 2, member: { user }, data: { name: 'watching' } });
  assert.equal(list.now.data.flags, 64);
  assert.match(list.text, /#42 \(seller\)/);
  assert.match((await seen({ type: 2, member: { user }, data: { name: 'watch', options: [{ name: 'listing', value: 7 }, { name: 'role', value: 'seller' }] } })).text, /no listing #7/);
  assert.match((await seen({ type: 3, user, data: { custom_id: 'watch:42:thief' } })).text, /Not a button/);

  dmOk = false;
  const refused = await seen({ type: 3, user: { id: '1003' }, data: { custom_id: 'watch:42:buyer' } });
  assert.match(refused.text, /cannot send you direct messages/);
  assert.equal(S.watchersOf(state, 42).length, 2, 'no watcher who cannot get messages');

  await seen({ type: 2, member: { user }, data: { name: 'unwatch', options: [{ name: 'listing', value: 42 }] } });
  assert.deepEqual(S.watchersOf(state, 42), [['1002', 'buyer']]);
});
