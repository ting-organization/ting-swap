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
  assert.deepEqual(await answer({ type: 1 }, hooks), { type: 1 }, 'Discord\'s ping');

  const watched = await answer({ type: 2, member: { user }, data: { name: 'watch', options: [{ name: 'listing', value: 42 }, { name: 'role', value: 'seller' }] } }, hooks);
  assert.equal(watched.data.flags, 64, 'only the user sees the answer');
  assert.match(watched.data.content, /listing #42 at each step that needs you as its seller/);
  assert.deepEqual(S.watchersOf(state, 42), [['1001', 'seller']]);

  const button = await answer({ type: 3, user: { id: '1002' }, data: { custom_id: 'watch:42:buyer' } }, hooks);
  assert.match(button.data.content, /as its buyer/);
  assert.deepEqual(S.watchersOf(state, 42), [['1001', 'seller'], ['1002', 'buyer']]);

  assert.match((await answer({ type: 2, member: { user }, data: { name: 'watching' } }, hooks)).data.content, /#42 \(seller\)/);
  assert.match((await answer({ type: 2, member: { user }, data: { name: 'watch', options: [{ name: 'listing', value: 7 }, { name: 'role', value: 'seller' }] } }, hooks)).data.content, /no listing #7/);
  assert.match((await answer({ type: 3, user, data: { custom_id: 'watch:42:thief' } }, hooks)).data.content, /Not a button/);

  dmOk = false;
  const refused = await answer({ type: 3, user: { id: '1003' }, data: { custom_id: 'watch:42:buyer' } }, hooks);
  assert.match(refused.data.content, /cannot send you direct messages/);
  assert.equal(S.watchersOf(state, 42).length, 2, 'no watcher who cannot get messages');

  await answer({ type: 2, member: { user }, data: { name: 'unwatch', options: [{ name: 'listing', value: 42 }] } }, hooks);
  assert.deepEqual(S.watchersOf(state, 42), [['1002', 'buyer']]);
});
