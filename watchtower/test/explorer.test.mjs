// web/js/explorer.js and web/js/price.js, which the page and the watchtower
// share, against a fake network: each kind of explorer reads one real lock
// (listing #1's on Litecoin mainnet) the same, and the line of explorers
// passes a question on only while one cannot answer.
import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';
import { Explorer } from '../../web/js/explorer.js';
import { readPrice } from '../../web/js/price.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Answers fetches by the first matching route: `[status, body]`, a body (200), 'unreachable', or a function of the match. */
function network(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method ?? 'GET'} ${url}`);
    for (const [pattern, answer] of routes) {
      const m = typeof pattern === 'string' ? (url === pattern ? [url] : null) : url.match(pattern);
      if (!m) continue;
      const a = typeof answer === 'function' ? answer(m, init) : answer;
      if (a === 'unreachable') throw new TypeError('fetch failed');
      const [status, body] = Array.isArray(a) ? a : [200, a];
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    }
    return new Response('not found', { status: 404 });
  };
  return calls;
}

const fast = { pauses: [0, 0] };
const ESPLORA = { kind: 'esplora', base: 'https://esplora.test/api', trusted: true, ...fast };
const BLOCKBOOK = { kind: 'blockbook', base: 'https://blockbook.test/api', ...fast };
const BLOCKCYPHER = { kind: 'blockcypher', base: 'https://cypher.test/v1/ltc/main', ...fast };

// The lock and its claim, as each explorer told them on 2026-11-20.
const LOCK = '9e6e8bf6ce298783a08f931c7825144530809641ac5c7e2a7ce37254270c7b62';
const CLAIM = '46f680c74b54fbe567bf96c2d0d0650800c8dafe96d96366ee1c54382ca17166';
const SCRIPT = '0020f263847238c3f4abe6abe64042d540efccaddb5a40c87dbfc261feac8edd5d74';
const OUT = { value: 174000000, script: SCRIPT, confirmed: true, height: 3215182, spent: true, spender: CLAIM, spenderConfirmed: true, spenderHeight: 3215200 };

const esploraLock = [
  [`https://esplora.test/api/tx/${LOCK}`, { vout: [{ value: 174000000, scriptpubkey: SCRIPT }, { value: 4909694, scriptpubkey: '0014e273' }], status: { confirmed: true, block_height: 3215182 } }],
  [`https://esplora.test/api/tx/${LOCK}/outspend/0`, { spent: true, txid: CLAIM, vin: 0, status: { confirmed: true, block_height: 3215200 } }],
];
const blockbookSynced = ['https://blockbook.test/api/', { blockbook: { bestHeight: 3216481, inSync: true }, backend: { blocks: 3216481 } }];
const blockbookLock = [
  blockbookSynced,
  [`https://blockbook.test/api/v2/tx/${LOCK}?spending=true`, {
    blockHeight: 3215182,
    vout: [{ value: '174000000', n: 0, spent: true, spentTxId: CLAIM, spentHeight: 3215200, hex: SCRIPT }, { value: '4909694', n: 1, hex: '0014e273' }],
  }],
];
const blockcypherLock = [
  [`https://cypher.test/v1/ltc/main/txs/${LOCK}?instart=1000000&outstart=0&limit=1`, { block_height: 3215182, vout_sz: 2, outputs: [{ value: 174000000, script: SCRIPT, spent_by: CLAIM }] }],
  [`https://cypher.test/v1/ltc/main/txs/${CLAIM}?instart=1000000&outstart=1000000&limit=1`, { block_height: 3215200, vout_sz: 1, outputs: [] }],
];

test('each kind of explorer reads the same lock the same', async () => {
  for (const [kind, routes] of [[ESPLORA, esploraLock], [BLOCKBOOK, blockbookLock], [BLOCKCYPHER, blockcypherLock]]) {
    network(routes);
    const out = await new Explorer([kind]).out(LOCK, 0);
    assert.deepEqual(out, { ...OUT, trusted: kind === ESPLORA }, kind.kind);
  }
});

test('a transaction no explorer has is missing, and is not asked of the next one', async () => {
  const calls = network([[/esplora\.test\/api\/tx\//, [404, 'Transaction not found']], [/blockbook/, 'unreachable']]);
  const out = await new Explorer([ESPLORA, BLOCKBOOK]).out(LOCK, 0);
  assert.deepEqual(out, { missing: true, trusted: true });
  assert.ok(!calls.some((c) => c.includes('blockbook')), 'a 404 is an answer');
  network([blockbookSynced, [/blockbook\.test\/api\/v2\/tx\//, [400, { error: `Transaction '${LOCK}' not found` }]]]);
  assert.deepEqual(await new Explorer([BLOCKBOOK]).out(LOCK, 0), { missing: true, trusted: false }, 'Blockbook says so with a 400');
});

test('while the first explorer cannot answer, the next one does, and only the first is trusted', async () => {
  const calls = network([[/esplora\.test/, [525, 'error code: 525']], ...blockbookLock]);
  const explorer = new Explorer([ESPLORA, BLOCKBOOK]);
  const out = await explorer.out(LOCK, 0);
  assert.deepEqual(out, { ...OUT, trusted: false });
  assert.equal(calls.filter((c) => c.includes('esplora')).length, 3, 'tried three times');
  assert.equal(explorer.last.name, 'blockbook.test');
  await explorer.out(LOCK, 0);
  assert.ok(explorer.resting, 'two failed calls in a row: it rests');
  const before = calls.length;
  await explorer.out(LOCK, 0);
  assert.ok(calls.slice(before).every((c) => c.includes('blockbook')), 'a resting explorer is not asked');
  explorer.primary.restUntil = 0;
  network(esploraLock);
  assert.deepEqual(await explorer.out(LOCK, 0), { ...OUT, trusted: true }, 'rested: asked first again');
  assert.equal(explorer.primary.failures, 0);
});

test('an error page says only its status, and a call no explorer answers names the first one\'s error', async () => {
  network([[/esplora\.test/, [525, '<!DOCTYPE html><html>Cloudflare</html>']], [/blockbook/, 'unreachable']]);
  await assert.rejects(new Explorer([ESPLORA, BLOCKBOOK]).tip(), /^Error: esplora\.test answered 525$/);
});

test('a Blockbook out of step with its node is passed over', async () => {
  const calls = network([
    [/esplora\.test/, 'unreachable'],
    ['https://blockbook.test/api/', { blockbook: { bestHeight: 1512572, inSync: false }, backend: { blocks: 3216421 } }],
    ...blockcypherLock,
  ]);
  const out = await new Explorer([ESPLORA, BLOCKBOOK, BLOCKCYPHER]).out(LOCK, 0);
  assert.deepEqual(out, { ...OUT, trusted: false });
  assert.ok(!calls.some((c) => c.includes('blockbook.test/api/v2')), 'nothing read from it');
});

test('a tip that did not move costs one request; an output six blocks deep costs only its spend', async () => {
  let hash = 'aa'.repeat(32);
  const calls = network([
    ['https://esplora.test/api/blocks/tip/hash', () => hash],
    [/esplora\.test\/api\/block\/(\w+)$/, (m) => ({ height: m[1] === 'aa'.repeat(32) ? 100 : 101, mediantime: 5000, timestamp: 6000 })],
    ...esploraLock,
  ]);
  const explorer = new Explorer([ESPLORA]);
  assert.deepEqual(await explorer.tip(), { height: 100, hash, time: 6000, mtp: 5000 });
  await explorer.tip();
  assert.equal(calls.length, 3, 'the same tip: its block is not read again');
  hash = 'bb'.repeat(32);
  assert.equal((await explorer.tip()).height, 101);
  calls.length = 0;
  const known = await explorer.out(LOCK, 0);
  assert.equal(calls.length, 2);
  calls.length = 0;
  assert.deepEqual(await explorer.out(LOCK, 0, known), { ...OUT, trusted: true });
  assert.deepEqual(calls, [`GET https://esplora.test/api/tx/${LOCK}/outspend/0`]);
  assert.equal((await explorer.out(LOCK, 0, { ...known, trusted: false })).trusted, false, 'what a backup said stays a backup\'s');
});

test('Blockbook\'s median time past comes from the last eleven blocks, each read once', async () => {
  let best = 1000;
  const times = { 990: 50, 991: 10, 992: 20, 993: 30, 994: 40, 995: 60, 996: 70, 997: 80, 998: 90, 999: 100, 1000: 110, 1001: 120 };
  const calls = network([
    ['https://blockbook.test/api/', () => ({ blockbook: { bestHeight: best, inSync: true }, backend: { blocks: best } })],
    [/blockbook\.test\/api\/v2\/block\/(\d+)\?pageSize=1$/, (m) => ({ hash: String(m[1]).padStart(64, '0'), previousBlockHash: String(m[1] - 1).padStart(64, '0'), time: times[m[1]] })],
  ]);
  const explorer = new Explorer([BLOCKBOOK]);
  const tip = await explorer.tip();
  assert.equal(tip.height, 1000);
  assert.equal(tip.mtp, 60, 'the median of blocks 990 to 1000');
  assert.equal(calls.filter((c) => c.includes('/v2/block/')).length, 11);
  best = 1001;
  calls.length = 0;
  assert.equal((await explorer.tip()).mtp, 70, 'the median of blocks 991 to 1001');
  assert.equal(calls.filter((c) => c.includes('/v2/block/')).length, 1, 'only the new block is read');
});

test('Blockcypher is asked within its hourly budget, and knows no median time past', async () => {
  const calls = network([['https://cypher.test/v1/ltc/main', { height: 3216481, hash: 'cc'.repeat(32), time: '2026-11-20T20:44:18Z', high_fee_per_kb: 12000 }]]);
  const explorer = new Explorer([{ ...BLOCKCYPHER, perHour: 2 }]);
  assert.deepEqual(await explorer.tip(), { height: 3216481, hash: 'cc'.repeat(32), time: 1795207458, mtp: null });
  assert.equal(await explorer.feeRate(), 12, 'from the tip just read');
  await explorer.tip();
  await assert.rejects(explorer.tip(), /budget is spent/);
  assert.equal(calls.length, 2);
});

test('a transaction sent counts as sent when the chain has it; refused only when Litecoin said no', async () => {
  network([['https://esplora.test/api/tx', [400, 'sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}']]]);
  assert.equal(await new Explorer([ESPLORA]).broadcast('00'), null);
  network([['https://esplora.test/api/tx', [400, 'sendrawtransaction RPC error: {"code":-26,"message":"non-final"}']]]);
  await assert.rejects(new Explorer([ESPLORA]).broadcast('00'), (e) => e.refused === true && /non-final/.test(e.message));
  network([[/esplora/, 'unreachable'], ['https://blockbook.test/api/v2/sendtx/', [400, { error: '-26: non-final' }]]]);
  await assert.rejects(new Explorer([ESPLORA, BLOCKBOOK]).broadcast('00'), (e) => e.refused === true && e.message === '-26: non-final', 'the backup\'s refusal is Litecoin\'s');
  const calls = network([[/./, 'unreachable']]);
  await assert.rejects(new Explorer([ESPLORA, BLOCKBOOK]).broadcast('00'), (e) => e.refused === false);
  assert.equal(calls.length, 6, 'each tried three times');
  network([['https://cypher.test/v1/ltc/main/txs/push', (m, init) => ({ tx: { hash: JSON.parse(init.body).tx === 'abcd' ? CLAIM : '' } })]]);
  assert.equal(await new Explorer([BLOCKCYPHER]).broadcast('abcd'), CLAIM, 'Blockcypher takes it as JSON in a plain-text body');
});

test('the price comes from the first source with a recent one', async () => {
  const sources = [
    { url: 'https://a.test/', read: (a) => ({ usd: a.USD, time: a.time }) },
    { url: 'https://b.test/', read: (a) => ({ usd: Number(a.price), time: Math.floor(Date.parse(a.time) / 1000) }) },
  ];
  const now = 1795207458;
  network([['https://a.test/', { USD: 42, time: now - 19 * 3600 }], ['https://b.test/', { price: '39.897', time: '2026-11-20T20:44:00Z' }]]);
  assert.deepEqual(await readPrice(sources, { maxAge: 7200, now }), { url: 'https://b.test/', usd: 39.897, time: 1795207440 }, 'a stuck price is passed over');
  network([['https://a.test/', [525, '']], ['https://b.test/', 'unreachable']]);
  assert.equal(await readPrice(sources, { maxAge: 7200, now }), null);
});
