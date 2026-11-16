#!/usr/bin/env node
// Tests the Litecoin side of a swap (web/js/ltc.js, web/js/secp256k1.js)
// against published vectors and against Node's own crypto:
//
// - secp256k1 public keys against OpenSSL; RFC 6979 nonces on the RFC's own
//   P-256 examples and on secp256k1 ones OpenSSL confirms; random signatures
//   checked by OpenSSL, OpenSSL's checked here; DER edge cases (BIP 66).
// - bech32 and bech32m on BIP 173's and BIP 350's lists; base58 and Litecoin
//   addresses on Litecoin Core 0.21's own test data (src/test/data:
//   base58_encode_decode.json, key_io_valid.json, key_io_invalid.json).
// - BIP 143's native P2WPKH and P2WSH examples, from the BIP and from
//   Litecoin Core's tx_valid.json, and BIP 143's other examples there, with
//   every sighash type; txids of transactions tx_valid.json names.
// - Script numbers and pushes, worked out from their definitions.
// - The lock of HTLC.md: its script assembled here byte by byte, its tag and
//   address hashed by Node, and each way to spend it run through a small
//   script interpreter of this file's own, whose signature checks are
//   OpenSSL's over a BIP 143 preimage made here too.
// - The buyer's refund of several locks in one transaction: each input run
//   through that interpreter against its own script and value, each
//   signature checked by OpenSSL, dust worth less than its fee left out.
//
//   node scripts/test-ltc.mjs [rounds]
//
// Exits 1 when any check fails.
import { createHash, createPublicKey, ECDH, generateKeyPairSync, randomBytes, sign as opensslSign, verify } from 'node:crypto';
import { hex, unhex } from '../web/js/bytes.js';
import * as L from '../web/js/ltc.js';
import * as S from '../web/js/secp256k1.js';

const rounds = Number(process.argv[2] ?? 300);
let failures = 0;
let checks = 0;
const check = (ok, what) => {
  checks++;
  if (!ok) {
    failures++;
    console.error(`  FAIL ${what}`);
  }
};
const group = (name, run) => {
  const before = failures;
  const at = checks;
  const started = performance.now();
  try {
    run();
  } catch (e) {
    failures++;
    console.error(`  FAIL threw ${e.stack.split('\n').slice(0, 2).join(' ')}`);
  }
  const ms = (performance.now() - started).toFixed(0);
  console.log(`${failures === before ? 'ok  ' : 'FAIL'} ${name}: ${checks - at} checks, ${ms} ms`);
};
/** That `run` throws, with a message matching `pattern` if one is given. */
const throws = (run, pattern, what) => {
  let message = null;
  try {
    run();
  } catch (e) {
    message = e.message;
  }
  const why = message === null ? ' (no error)' : pattern && !pattern.test(message) ? ` (said: ${message})` : '';
  check(!why, `${what}${why}`);
};
const quietly = (run) => {
  try {
    return run();
  } catch {
    return undefined;
  }
};
const sha = (data) => new Uint8Array(createHash('sha256').update(data).digest());
const big = (h) => BigInt(`0x${h}`);
const be = (v, length = 32) => v.toString(16).padStart(length * 2, '0');
const le = (n, width) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n), 0);
  return b.subarray(0, width);
};
const flipCase = (s) => (s === s.toLowerCase() ? s.toUpperCase() : s.toLowerCase());
const HALF = S.N >> 1n;

/** OpenSSL's public key object of a secp256k1 key, compressed or not. */
const spki = (key) => createPublicKey({
  key: Buffer.concat([
    Buffer.from(key.length === 33 ? '3036301006072a8648ce3d020106052b8104000a032200' : '3056301006072a8648ce3d020106052b8104000a034200', 'hex'),
    Buffer.from(key),
  ]),
  format: 'der',
  type: 'spki',
});
/** Whether OpenSSL takes `der` as a signature of SHA-256(`message`) by `key`. */
const openssl = (message, der, key, encoding = 'der') => {
  try {
    return verify('sha256', message, { key: spki(key), dsaEncoding: encoding }, der);
  } catch {
    return false;
  }
};
const ecdh = (secret, curve = 'secp256k1') => {
  const e = new ECDH(curve);
  e.setPrivateKey(Buffer.from(be(secret), 'hex'));
  return e;
};

// ---- A BIP 143 preimage and a script interpreter of this file's own --------

const varint = (n) => (n < 0xfd ? Buffer.from([n]) : Buffer.from([0xfd, n & 0xff, n >> 8]));
const dsha = (b) => sha(sha(b));

/** BIP 143's preimage, written out again here from the BIP. */
function preimage143(tx, index, scriptCode, value, type) {
  const outpoint = (i) => Buffer.concat([Buffer.from(i.txid, 'hex').reverse(), le(i.vout, 4)]);
  const output = (o) => Buffer.concat([le(o.value, 8), varint(o.script.length), o.script]);
  const base = type & 0x1f;
  const anyone = type & 0x80;
  const zero = Buffer.alloc(32);
  const input = tx.inputs[index];
  let outputs = zero;
  if (base !== 2 && base !== 3) outputs = dsha(Buffer.concat(tx.outputs.map(output)));
  else if (base === 3 && index < tx.outputs.length) outputs = dsha(output(tx.outputs[index]));
  return Buffer.concat([
    le(tx.version, 4),
    anyone ? zero : dsha(Buffer.concat(tx.inputs.map(outpoint))),
    anyone || base === 2 || base === 3 ? zero : dsha(Buffer.concat(tx.inputs.map((i) => le(i.sequence, 4)))),
    outpoint(input), varint(scriptCode.length), scriptCode, le(value, 8), le(input.sequence, 4),
    outputs, le(tx.locktime, 4), le(type, 4),
  ]);
}

/** r and s of a DER signature, read plainly. */
function derParts(der) {
  const lenR = der[3];
  return { r: big(hex(der.subarray(4, 4 + lenR))), s: big(hex(der.subarray(6 + lenR))) };
}

/**
 * Runs a P2WSH spend of `program` by input `index` of `tx`, worth `value`,
 * with Litecoin's standard rules for what the lock uses: MINIMALIF, low S,
 * NULLFAIL, CLEANSTACK, CHECKLOCKTIMEVERIFY. Null when it succeeds, else why
 * not.
 */
function run(tx, index, value, program) {
  const witness = tx.inputs[index].witness.map((b) => Buffer.from(b));
  const script = witness.pop();
  if (Buffer.compare(Buffer.from(sha(script)), Buffer.from(program))) return 'not the script the output commits to';
  if (witness.some((item) => item.length > 80)) return 'a witness item over 80 bytes';
  const stack = witness;
  const exec = [];
  const executing = () => exec.every(Boolean);
  const number = (b) => {
    if (b.length > 5) throw new Error('number too long');
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(i === b.length - 1 ? b[i] & 0x7f : b[i]);
    return b.length && b[b.length - 1] & 0x80 ? -v : v;
  };
  const checksig = (sig, key) => {
    if (!sig.length) return false;
    const der = sig.subarray(0, -1);
    if (derParts(der).s > HALF) throw new Error('high S');
    return openssl(sha(preimage143(tx, index, script, value, sig[sig.length - 1])), der, key);
  };
  try {
    for (let i = 0; i < script.length;) {
      const op = script[i++];
      if (op >= 1 && op <= 75) {
        if (executing()) stack.push(script.subarray(i, i + op));
        i += op;
        continue;
      }
      if (op === 0x63) {
        if (executing()) {
          const top = stack.pop();
          if (!top) return 'IF on an empty stack';
          if (top.length > 1 || (top.length === 1 && top[0] !== 1)) return 'MINIMALIF';
          exec.push(top.length === 1);
        } else {
          exec.push(false);
        }
        continue;
      }
      if (op === 0x67 || op === 0x68) {
        if (!exec.length) return 'ELSE or ENDIF without IF';
        if (op === 0x67) exec.push(!exec.pop());
        else exec.pop();
        continue;
      }
      if (!executing()) continue;
      if (op === 0x75) {
        if (!stack.pop()) return 'DROP on an empty stack';
      } else if (op === 0x82) {
        const n = stack[stack.length - 1].length;
        stack.push(n ? Buffer.from([n]) : Buffer.alloc(0));
      } else if (op === 0x88) {
        if (Buffer.compare(stack.pop(), stack.pop())) return 'EQUALVERIFY failed';
      } else if (op === 0xa8) {
        stack.push(Buffer.from(sha(stack.pop())));
      } else if (op === 0xac || op === 0xad) {
        const key = stack.pop();
        const sig = stack.pop();
        const ok = checksig(sig, key);
        if (!ok && sig.length) return 'NULLFAIL';
        if (op === 0xad) {
          if (!ok) return 'CHECKSIGVERIFY failed';
        } else {
          stack.push(ok ? Buffer.from([1]) : Buffer.alloc(0));
        }
      } else if (op === 0xb1) {
        const t = number(stack[stack.length - 1]);
        const lock = BigInt(tx.locktime);
        if (t < 0n) return 'negative locktime';
        if ((t < 500000000n) !== (lock < 500000000n)) return 'locktime of another kind';
        if (t > lock) return 'locktime not reached';
        if (tx.inputs[index].sequence === 0xffffffff) return 'a final input cannot check a locktime';
      } else {
        return `opcode ${op}`;
      }
    }
  } catch (e) {
    return e.message;
  }
  if (exec.length) return 'unbalanced IF';
  if (stack.length !== 1) return `CLEANSTACK: ${stack.length} items left`;
  return stack[0].length && stack[0].some((b) => b) ? null : 'false at the end';
}

// ---- Published vectors -----------------------------------------------------

// BIP 173 and BIP 350: strings with a valid checksum.
const VALID_BECH32 = [
  'A12UEL5L', 'a12uel5l',
  'an83characterlonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1tt5tgs',
  'abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw',
  '11qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqc8247j',
  'split1checkupstagehandshakeupstreamerranterredcaperred2y9e3w', '?1ezyfcl',
];
const VALID_BECH32M = [
  'A1LQFN3A', 'a1lqfn3a',
  'an83characterlonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11sg7hg6',
  'abcdef1l7aum6echk45nj3s0wdvt2fg8x9yrzpqzd3ryx',
  '11llllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllllludsr8',
  'split1checkupstagehandshakeupstreamerranterredcaperredlc445v', '?1v759aa',
];
// Their invalid strings, each with why the BIP says it is invalid.
const INVALID_BECH32 = [
  ['\x201nwldj5', /out of range/], ['\x7f1axkwrx', /out of range/], ['\x801eym55h', /out of range/],
  ['an84characterslonghumanreadablepartthatcontainsthenumber1andtheexcludedcharactersbio1569pvx', /longer than 90/],
  ['pzry9x0s0muk', /no separator/], ['1pzry9x0s0muk', /no prefix/], ['x1b4n0q5v', /not a bech32 character/],
  ['li1dgmt3', /shorter than 6/], ['de1lg7wt\xff', /out of range/], ['A1G7SGD8', /checksum is wrong/],
  ['10a06t8', /no prefix/], ['1qzzfhee', /no prefix/],
];
const INVALID_BECH32M = [
  ['\x201xj0phk', /out of range/], ['\x7f1g6xzxy', /out of range/], ['\x801vctc34', /out of range/],
  ['an84characterslonghumanreadablepartthatcontainsthetheexcludedcharactersbioandnumber11d6pts4', /longer than 90/],
  ['qyrz8wqd2c9m', /no separator/], ['1qyrz8wqd2c9m', /no prefix/], ['y1b0jsk6g', /not a bech32 character/],
  ['lt1igcx5c0', /not a bech32 character/], ['in1muywd', /shorter than 6/], ['mm1crxm3i', /not a bech32 character/],
  ['au1s5cgom', /not a bech32 character/], ['M1VUXWEZ', /checksum is wrong/], ['16plkw9', /no prefix/],
  ['1p2gdwpf', /no prefix/],
];
// BIP 350's valid segwit addresses and their output scripts (BIP 173's version 0 ones among them).
const SEGWIT_VALID = [
  ['BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4', '0014751e76e8199196d454941c45d1b3a323f1433bd6'],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7', '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262'],
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kt5nd6y', '5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6'],
  ['BC1SW50QGDZ25J', '6002751e'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvaxxpcs', '5210751e76e8199196d454941c45d1b3a323'],
  ['tb1qqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesrxh6hy', '0020000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433'],
  ['tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c', '5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433'],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'],
];
// BIP 173's versions 1 to 16 examples: bech32 checksums, which BIP 350 has since refused.
const BIP173_V1_PLUS = [
  ['bc1pw508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx', '5128751e76e8199196d454941c45d1b3a323f1433bd6751e76e8199196d454941c45d1b3a323f1433bd6'],
  ['BC1SW50QA3JX3S', '6002751e'],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvg6kdaj', '5210751e76e8199196d454941c45d1b3a323'],
];
// BIP 173's, then BIP 350's, invalid segwit addresses, with the BIP's reason.
const SEGWIT_INVALID = [
  ['tc1qw508d6qejxtdg4y5r3zarvary0c5xw7kg3g4ty', /prefix tc/],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', /checksum is wrong/],
  ['BC13W508D6QEJXTDG4Y5R3ZARVARY0C5XW7KN40WF2', /witness version 17/],
  ['bc1rw5uspcuh', /program of 1 bytes/],
  ['bc10w508d6qejxtdg4y5r3zarvary0c5xw7kw508d6qejxtdg4y5r3zarvary0c5xw7kw5rljs90', /program of 41 bytes/],
  ['BC1QR508D6QEJXTDG4Y5R3ZARVARYV98GJ9P', /version 0 witness program of 16 bytes/],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sL5k7', /mixed case/],
  ['bc1zw508d6qejxtdg4y5r3zarvaryvqyzf3du', /bits of padding/],
  ['tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3pjxtptv', /not zero/],
  ['bc1gmk9yu', /no witness version/],
  ['tc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq5zuyut', /prefix tc/],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd', /with a bech32 checksum/],
  ['tb1z0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqglt7rf', /with a bech32 checksum/],
  ['BC1S0XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ54WELL', /with a bech32 checksum/],
  ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh', /with a bech32m checksum/],
  ['tb1q0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq24jc47', /with a bech32m checksum/],
  ['bc1p38j9r5y49hruaue7wxjce0updqjuyyx0kh56v8s25huc6995vvpql3jow4', /"o" is not a bech32 character/],
  ['BC130XLXVLHEMJA6C4DQV22UAPCTQUPFHLXM9H8Z3K2E72Q4K9HCZ7VQ7ZWS8R', /witness version 17/],
  ['bc1pw5dgrnzv', /program of 1 bytes/],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v8n0nx0muaewav253zgeav', /program of 41 bytes/],
  ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vq47Zagq', /mixed case/],
  ['bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7v07qwwzcrf', /bits of padding/],
  ['tb1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vpggkg4j', /not zero/],
];

// Litecoin Core 0.21, src/test/data/base58_encode_decode.json.
const BASE58 = [
  ['', ''],
  ['61', '2g'],
  ['626262', 'a3gV'],
  ['636363', 'aPEr'],
  ['73696d706c792061206c6f6e6720737472696e67', '2cFupjhnEsSn59qHXstmK2ffpLv2'],
  ['00eb15231dfceb60925886b67d065299925915aeb172c06647', '1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L'],
  ['516b6fcd0f', 'ABnLTmg'],
  ['bf4f89001e670274dd', '3SEo3LWLoPntC'],
  ['572e4794', '3EFU7m'],
  ['ecac89cad93923c02321', 'EJDM8drfXA6uyA'],
  ['10c8511e', 'Rt5zm'],
  ['00000000000000000000', '1111111111'],
  ['000111d38e5fc9071ffcd20b4a763cc9ae4f252bb4e48fd66a835e252ada93ff480d6dd43dc62a641155a5', '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'],
  [
    '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f' +
    '303132333435363738393a3b3c3d3e3f404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f' +
    '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f808182838485868788898a8b8c8d8e8f' +
    '909192939495969798999a9b9c9d9e9fa0a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebf' +
    'c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef' +
    'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
    '1cWB5HCBdLjAuqGGReWE3R3CguuwSjw6RHn39s2yuDRTS5NsBgNiFpWgAnEx6VQi8csexkgYw3mdYrMHr8x9i7aEwP8kZ7vc' +
    'cXWqKDvGv3u1GxFKPuAkn8JCPPGDMf3vMMnbzm6Nh9zh1gcNsMvH3ZNLmP5fSG6DGbbi2tuwMWPthr4boWwCxf7ewSgNQeac' +
    'yozhKDDQQ1qL5fQFUW52QKUZDZ5fw3KXNQJMcNTcaB723LchjeKun7MuGW5qyCBZYzA1KjofN1gYBV3NqyhQJ3Ns746GNuf9' +
    'N2pQPmHz4xpnSrrfCvy6TVVz5d4PdrjeshsWQwpZsZGzvbdAdN8MKV5QsBDY',
  ],
];

// Litecoin Core 0.21, src/test/data/key_io_valid.json: its addresses (not its
// private keys), each with its output script, chain and whether the other
// case must work too.
const KEY_IO_VALID = [
  ['LT2KVaAy1ppRuxRgrS5RNU3vBsy7RibPeA', '76a914558dbca7118cd5894502767c7b2ffc21a22f54db88ac', 'main'],
  ['MHrYRxAiMNBTku3eoDHwhA1LQGDjUStZW2', 'a9146d328a5b2a20d943a641c8d29b6cc3c2d2df85d387', 'main'],
  ['M9dw1FAoWpHC6PcMzoCHhqQ9McvTyG5Ywj', 'a914130ef8742ad7492b389509252c6721775fb1127387', 'main'],
  ['mwXn5Vhicdav8Av3KMokx4YNuHoGRKxtWs', '76a914afa9e672141e283dfbcc1cf28f3793a856d3878488ac', 'test'],
  ['QXaUgLHkZcbJb2j5XgMYzY8cF9YM48Y81Z', 'a9147860667e60a6545e18e541984094b29c9c46991b87', 'test'],
  ['QNfyfXGXxfeaG8SQpnHxS2J27ysokKCtZL', 'a91416b18b6002004f5755040e8809755a1777fab4a687', 'test'],
  ['mpWvR79tSrA5xeziB6mjNYWdaVRwBpgnUP', '76a91462b790654f809d32202587c6a43456ffc1965d8388ac', 'regtest'],
  ['QgDNrG4nJpE4VV7PcFMFhkTgwAHWxWS7pj', 'a914d71bee7a1395c10c9ca9a7f53ac086b53e74369d87', 'regtest'],
  ['ltc1qhdhvrwe6rgqns8fz28tee0hphr5x7ulw5exv4w', '0014bb6ec1bb3a1a01381d2251d79cbee1b8e86f73ee', 'main', true],
  ['ltc1qa9dykljtgeayhm8ygx25sc22p0wzgudpe4hw9dyvaz0ye3j5kduq9mf68z', '0020e95a4b7e4b467a4bece4419548614a0bdc2471a1cd6ee2b48ce89e4cc654b378', 'main', true],
  ['ltc1ppu2gv0tujus0f6eggrk7eqmaf0567x6zer4fcuhz4z7ztzq9u9yseqxltc', '51200f14863d7c9720f4eb2840edec837d4be9af1b42c8ea9c72e2a8bc258805e149', 'main', true],
  ['ltc1zjwls6j8c4u', '520293bf', 'main', true],
  ['tltc1qpftpsvdn6mjp8celrkj0qxqy4jlapl959rlwg9', '00140a561831b3d6e413e33f1da4f01804acbfd0fcb4', 'test', true],
  ['tltc1q9awqm4ah2lmettm3hnhgqtssvz527jxglxxshkt75l0ygdl3vlyqy5739f', '00202f5c0dd7b757f795af71bcee802e1060a8af48c8f98d0bd97ea7de4437f167c8', 'test', true],
  ['tltc1pfnh6ljtrdgk4hh3acvu39a742vaqmd2khnd0tp9d0prcnvpq6zgqn0ecgk', '51204cefafc9636a2d5bde3dc33912f7d5533a0db556bcdaf584ad784789b020d090', 'test', true],
  ['tltc1rdljmhjrmdhjsu6qgm75lkm9l0540kkfu', '53106fe5bbc87b6de50e6808dfa9fb6cbf7d', 'test', true],
  ['rltc1q3kquwp848h4juq7rl5q3wqsr29pd3d6wprzz8k', '00148d81c704f53deb2e03c3fd011702035142d8b74e', 'regtest', true],
  ['rltc1qlmpaz9m7vd2578yjlcesf5e0m0fumev8n54nxks4ld66sn7qztfqurdukc', '0020fec3d1177e63554f1c92fe3304d32fdbd3cde5879d2b335a15fb75a84fc012d2', 'regtest', true],
  ['rltc1prd75w9a3v4kfjtkx93z0m2tdl4mpyfqty9kaxxp4zdnlrrkrv4lq6eksea', '51201b7d4717b1656c992ec62c44fda96dfd7612240b216dd318351367f18ec3657e', 'regtest', true],
  ['rltc1sp4r7tfack86dyy6mhs0ptnzrccdhce92kuvzuna7085xg8qm7kxm0fq7xzfsd889mzm4we', '60280d47e5a7b8b1f4d2135bbc1e15cc43c61b7c64aab7182e4fbe79e8641c1bf58db7a41e3093069ce5', 'regtest', true],
  ['LbfVMz974gbbGFqXF7FZUpSBWSbwBHDwR5', '76a914b4565f467408e9e1c1d2a3b0ccdeff84db3a3b9388ac', 'main'],
  ['MWGEAUUZoN4r6puz8KsgnE9wNTQ8fGWCEy', 'a914f54ec8d7b0c3f8ab8194db3432d19f8d44d03b1287', 'main'],
  ['MNYP3h6XQQcVBohyVrxAtRGhbyvPpXzyFR', 'a914a09bd94f4b099d721ddc95bc8ed928aef40833ce87', 'main'],
  ['mnJYjG654G354sX1xEBaPGvGCoe34M1Pqr', '76a9144a7037b0cc4ae15278e7a62549e2acde3f60186688ac', 'test'],
  ['QQjXG2nbVfxysmaEZQVL9TsS359WjDT5ux', 'a9142d4d6b05448a911116292a177c04f7f6bd29ea2c87', 'test'],
  ['QjqYEtoPWjTVxZQFUWdWj6r48hM6i2ESc2', 'a914fedb1f41a5ef541c79a6bedca3f15857414a63fb87', 'test'],
  ['mtJ7NFSGv2WuwsigXhQymzMhxFh9uANCTY', '76a9148c2bcd075a332c4eafaf30876ca9e7a091d037de88ac', 'regtest'],
  ['QfS38XTvXmuNFeyS8orinxHkDkonMDS1ih', 'a914ce88c090d0ee540cab7e2d2286f686434d33d61987', 'regtest'],
  ['ltc1qxjkwr09apz3w5hsr33uyq9sdfx8tn26g39g00g', '001434ace1bcbd08a2ea5e038c7840160d498eb9ab48', 'main', true],
  ['ltc1qjaxhjwmp26afq279pza0zd6lrguxfcee08fw4xv5r6ksrr0wk4uqzjxfdz', '0020974d793b6156ba902bc508baf1375f1a3864e33979d2ea99941ead018deeb578', 'main', true],
  ['ltc1p59fcnxdn05t6adags3dc0vuvm4ejd7chsspp9ryqkvvlxrwkdylqfsruty', '5120a1538999b37d17aeb7a8845b87b38cdd7326fb178402128c80b319f30dd6693e', 'main', true],
  ['ltc1zpr0qrh9zvs', '520208de', 'main', true],
  ['tltc1quf7ycjczjpjd6u9a8mpa00jl7g9aplhy8e0vf7', '0014e27c4c4b029064dd70bd3ec3d7be5ff20bd0fee4', 'test', true],
  ['tltc1qzu820r8szwesmaj7acyvkute2ch2p89rppld6xkmsnfj06sttuaqjymary', '0020170ea78cf013b30df65eee08cb7179562ea09ca3087edd1adb84d327ea0b5f3a', 'test', true],
  ['tltc1pcdvmgxjvz4glnvxfufqt7qgcz94dxqa8t838upq4ajqf2r6f7dastfdk7r', '5120c359b41a4c1551f9b0c9e240bf0118116ad303a759e27e0415ec80950f49f37b', 'test', true],
  ['tltc1rvc3hu7rz7ypgx0ewvf9mnf84ssn9gtu3', '531066237e7862f102833f2e624bb9a4f584', 'test', true],
  ['rltc1q8zvr5cvkf2ke0c5vjm8u6z66zck8en8grn9n22', '001438983a61964aad97e28c96cfcd0b5a162c7ccce8', 'regtest', true],
  ['rltc1q9a3fdc7cmk0ls0tp42lj05jwdhu79jd5str2dnq5nz4xv73wl79qrlnh7e', '00202f6296e3d8dd9ff83d61aabf27d24e6df9e2c9b482c6a6cc1498aa667a2eff8a', 'regtest', true],
  ['rltc1pw6ly729khz7ndll807q5gx77q0nxpkpl7xauxshnzafs906sz3kqm6rx4v', '512076be4f28b6b8bd36ffe77f81441bde03e660d83ff1bbc342f3175302bf50146c', 'regtest', true],
  ['rltc1s207hhga4nkr2vnhc02sr09h3xdp8k74eppgtd9f9js0j8cw5qjw693dd3k8apxrldxdn3f', '602853fd7ba3b59d86a64ef87aa03796f133427b7ab90850b69525941f23e1d4049da2c5ad8d8fd0987f', 'regtest', true],
  ['LgUPnP2UZxmFBJb8FDgNd5JcU9b7CNfrw1', '76a914e915c49f55d8de0b6041de19c9fa2f21820b201288ac', 'main'],
  ['MU2UAbDxiiirZuGTZ6nSaFajsXFkLHozcU', 'a914dcc465d5dd517c24c4dc95d7a338fca76d753ddb87', 'main'],
];

// Litecoin Core 0.21, src/test/data/key_io_invalid.json: none is an address on any network.
const KEY_IO_INVALID = [
  '', 'x', 'dfbPb4pUb4pTX4UQYFUjKyiSF8CQgxugLS62GjwZypEoibsosn9Vb4KVCda1rRWmZmNiRrwvmCn',
  '9HNmZX4VS73qJEWzmNcmXbkQ9TFf6sUTCQ',
  'gjLg9jYHzW5ciXEDz9zWiotzYe2cct2PTtToqpoFgwo4EkCAaDDrofJawHSpRU8ki2bggowiBok',
  'SLrpY37XP4qJryx7fjPZMak4Lxzfo5WShx', 'kTcGJ65MCfb8jXDWf1sYGEpCyA4kcP9BDk',
  '521Yh6VfYQu5PtUDwaFAvsKAwczLgviqYpgbSxRdRzpjtnmT6JmTUeqsATPFj17ABdvzwPv8uugf9',
  'cUBHNh9Q2nDG6rsPProgGCZJnjUMEMyHWqm6p9eHwQJDPdm5rYBE',
  '7V7qeUyYjXzGsWD7SJRAep6s7kcptC2irxWDgByP1vHNt2cTJGcCDqTH9WRYtkQgx6dYxCtXJwgMk',
  'tc1qqtcszl2x5dm89t8989ylwucwsnqq2pmxxv4wuw', 'bt1p2c4wcwdszz8qhgg2anf8q4qh3wfvr007f8zjyfud0wneenz85upsfwevl6',
  'tltc13vj87tzu08d9277dqfzafda7snm796xrx3kyv2536km3m3ef7lk7q0yq8hg', 'RLTC1RUCQRYUFY',
  'ltc10utujc7h82n098qam35qv4sm4kztue0lh04er7zf6lslcwfmhc92kym83guu06nrvl56g2ekm',
  'tltc1qh8tp3qqmtz474xju0rajr3uz8vw00j2r', 'rltc1q2k5v9aryyn8pqg5dsjy0f8700tq2ph7q3mkcu573fjutlckyu7u3ysyapj',
  'ltc153m7rf', 'tltc1qywr4l8fyce9u6lwsykq4uez3g8kjfwterfxtjs784m526tavu84qeslpvf',
  'RLTC1QLPJ9XAKFWDYNP49LZ67kvf6FSKWD0P494P5PLT', 'ltc1qfflgggucfrs482us7q786eew4ryqta3vl2aspf',
  'tltc1q8wdx4az9f0lyvrpumqp74teu99vfay22etgulptz0u3zwl49wc6s2pktf0', 'rltc1qwvcm8vv0z02rvsx40w37jqhwcsr2rzyy7ksnsq',
  'ltc1pdhzupjn6sdyalpqn2flajzeyh7qw7r68z6zqnky8ns07k2du90jsd76y75', 'tltc1z8pp8yj2xsvf40fw42suw8fntrchs0pdc',
  'rltc1sp3lm8alrzckqhe6nk29xp2de7qwvhq5e7qe8fa', 'pLrE7DTSJEqA3EY9pn9xqxGsQQq1ZodMq9',
  'ftPq56BTH4DpneHagKmzzoaFaNzKKtJzNnTw1HKUAHuKoHHANUTkSh8PW1ETaDJARc9B1PzwVok',
  '2MwUPLQvSc9iamSJ4bKEGM7gHBaZeP9LNxp',
  'DHTtS2VMFFKgjtNzvPBmhzkhxpVdQEX8CfEt8h72xDrn9A8LFzUbseFtVPbzAmTPysdDTcQM8iS',
  '2N1evLCwGTML3dbW9PRk8nEgGYNb3rxG5RtN', 'T3zMzNuAAXou7nsh1ah6y1Mrj9DZ2Wgx5yoqiSsrxiQbfw57BHrz',
  'oEPMsv4V5qZKoUyfNeCz1Z87PzPohDwhvJDd4UKivg4PWSen16kAZokNyTveoNrzowQEXaxRi8J',
  'cU6LESh6ttsCfCf4xQXv3CrNY4JHWACNoJCDrbVaRj3WYpyUCGzV', 'tc1q8s7jrus7u2qgdm895pyv30le3cprehalv9lnc3',
  'bt1paw9uw7srejsczdlfe28xwdyqzk8lrjw9x8jdqw6pr2pwd2v9ywusum6u0n',
  'tltc13vgu624uk8ft5ll4aa2mpawe8xj63dxzzyn73zv9920n3v9p4xlvs46fqn5', 'rltc1rvgnh26gv',
  'ltc10wqhm0mq4dq3gcckz0vpa00k62awh67cdwymfu6jc2jttg8n8sdwjdy6hst25zf37fcneh0fh',
  'tltc1qnmrmqt9d459t7yed75t97w85rvhpm2lu', 'rltc1qddrre03z0h5qcg5y4qcyhzh9jera7zue8uv4y5nttg44gtyy8gc3w0j0ra',
  'ltc1qc7c53klkh5hhutxursumtl4eevq03vhzq', 'tltc1q8j0kqm4q2w34kval4px7yauhq02hzy5xqp8jazsvu9zj8ptzhf5qzd7fee',
  'rltc1q9yk0zwnmamlt09wz6yu3v03xwcfnZQ8Ae8tmyc', 'ltc1qc243zefnc9kzmsw72nytw4542g9nhwlxepjl6l',
  'tltc1qve28jd595ssf2usq5rhw24ehsny2f4tg62emue3q9wm40t7hplmqlftk8j', 'rltc1q7mqj6cpffp32z0vksng3z5fr9fvhtt9mrgxrj8',
  'ltc1pt9dz00jx8y7x8ylmwe8q0llyrzs32px96wgsm8znsnmj9cgs0ffszkcwyf', 'tltc1zhf4exwjxy7gh08najmlq4qn37uhvrzsv',
  'rltc14aymck', '2J5Aw2ADD73uDiWjBygH9v9CUc4FoMCnpXmdA3ArF5eG2M3quPMZcVzL7D6FbijsGcsq6dohRrm5',
  '2CyfoCce6BLYfKyAjW6n7x1gie1VMWwnKuZdq4U2MnaYzqSg1NKs6i66DQnGPGzwv33UM5cJehsk',
  'A2oWG2iWYa3NvYJ5r8JcxYCcEeHDP7LGCSMWQFQePa5QuAYsfNHS', '928oyNBWu1x44NuMptnH95toXArxtJBXLsJVg4xBTJuf92Q3HHXy',
  'cTMLykLqdEAst53pvxkJ5urLdXAU4zqhwzAwnurEWowy9d36ABYs', 'cS2qXYzEZkoTgxp3xKBAXFXEQ1TcD9LLoGTpvMSr45o2rfxu1SAj',
  'AyUHw9wePktAhQPe4CUfGD6iU6tP7zGUSUPjp4GkmUj3dqVPDFw4', 'tc1q8e3cz8e6jxrylsvmc7ng595rvn2m74ka5nhmyz',
  'bt1pyaatm98c7wmepfv558k6vt9zhtls6rdggelh86wyahsgye3h7vyst22puy',
  'tltc1355kwhrv2gsc7fyfma88nxqqzs3mmlcetg29cpfrd39hp2xjd3jwsrz78uv', 'rltc1r55jrpej6', 'ltc1pdtjxt', 'tltc1gut4t3',
  'rltc1qnv2uheg45ns07mv6f0h82xz48xzahaemlvxczexnl74jglwvetqp73s7wn', 'ltc1q0susza3qwj6lyp7d2q6g258vrgqw4afzt',
  'tltc1qsv7l20xzequp2hvtpmyc0nw6mmefyd0zj4a27y0jgkr2mcypfnss4fc7ky', 'rltc1qu8qwtg4kx886ex2frzcp4v9lk9V440cd75ch47',
  'LTC1Q3ME3JU4NWKE72UUETHLKLZMWQAVTDG4AG8FXSK', 'tltc1qc5d8gx5zm4vwufpp8galregpckfx52jfwyxtpng8pamd37g0pv3svfvnu4',
  'RLTC1QR29H2QPX85CF7PCHDLWU8L7J4NZ2TW5LA5FFZM',
];

// BIP 143, "Native P2WPKH": the unsigned transaction, input 1's scriptCode and
// value, its preimage and sighash, the key, and the signed transaction.
const P2WPKH = {
  unsigned: '0100000002fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f0000000000eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac11000000',
  scriptCode: '76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac',
  value: 600000000,
  preimage: '0100000096b827c8483d4e9b96712b6713a7b68d6e8003a781feba36c31143470b4efd3752b0a642eea2fb7ae638c36f6252b6750293dbe574a806984b8e4d8548339a3bef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a010000001976a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac0046c32300000000ffffffff863ef3e1a92afbfdb97f31ad0fc7683ee943e9abcf2501590ff8f6551f47e5e51100000001000000',
  sighash: 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670',
  key: '619c335025c7f4012e556c2a58b2506e30b8511b53ade95ea316fd8c3286feb9',
  publicKey: '025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357',
  signed: '01000000000102fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffffef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac000247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee0121025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee635711000000',
};

// BIP 143, "Native P2WSH": the signed transaction as Litecoin Core's
// tx_valid.json has it, input 1's value, and from the BIP its two sighashes
// (SIGHASH_SINGLE out of range, before and after OP_CODESEPARATOR) and keys.
const P2WSH = {
  signed: '01000000000102fe3dc9208094f3ffd12645477b3dc56f60ec4fa8e6f5d67c565d1c6b9216b36e000000004847304402200af4e47c9b9629dbecc21f73af989bdaa911f7e6f6c2e9394588a3aa68f81e9902204f3fcf6ade7e5abb1295b6774c8e0abd94ae62217367096bc02ee5e435b67da201ffffffff0815cf020f013ed6cf91d29f4202e8a58726b1ac6c79da47c23d1bee0a6925f80000000000ffffffff0100f2052a010000001976a914a30741f8145e5acadf23f751864167f32e0963f788ac000347304402200de66acf4527789bfda55fc5459e214fa6083f936b430a762c629656216805ac0220396f550692cd347171cbc1ef1f51e15282e837bb2b30860dc77c8f78bc8501e503473044022027dc95ad6b740fe5129e7e62a75dd00f291a2aeb1200b84b09d9e3789406b6c002201a9ecd315dd6a0e632ab20bbb98948bc0c6fb204f2c286963bb48517a7058e27034721026dccc749adc2a9d0d89497ac511f760f45c47dc5ed9cf352a58ac706453880aeadab210255a9626aebf5e29c0e6538428ba0d1dcf6ca98ffdf086aa8ced5e0d0215ea465ac00000000',
  value: 4900000000,
  sighashes: ['82dde6e4f1e94d02c2b7ad03d2115d691f48d064e9d52f58194a6637e4194391', 'fef7bd749cce710c5c052bd796df1af0d935e59cea63736268bcbe2d2134fc47'],
  keys: ['8e02b539b1500aa7c81cf3fed177448a546f19d2be416c0c61ff28e577d8d0cd', '86bf2ed75935a0cbef03b89d72034bb4c189d381037a5ac121a70016db8896ec'],
};

// Litecoin Core's tx_valid.json: BIP 143's P2SH-P2WSH 6-of-6 multisig, signed
// with ALL, NONE, SINGLE, ALL|ANYONECANPAY, NONE|ANYONECANPAY and
// SINGLE|ANYONECANPAY, spending 987654321; and its two P2WSH spends with
// SINGLE|ANYONECANPAY, 16777215 each.
const MULTISIG = '0100000000010136641869ca081e70f394c6948e8af409e18b619df2ed74aa106c1ca29787b96e0100000023220020a16b5755f7f6f96dbd65f5f0d6ab9418b89af4b1f14a1bb8a09062c35f0dcb54ffffffff0200e9a435000000001976a914389ffce9cd9ae88dcc0631e88a821ffdbe9bfe2688acc0832f05000000001976a9147480a33f950689af511e6e84c138dbbd3c3ee41588ac080047304402206ac44d672dac41f9b00e28f4df20c52eeb087207e8d758d76d92c6fab3b73e2b0220367750dbbe19290069cba53d096f44530e4f98acaa594810388cf7409a1870ce01473044022068c7946a43232757cbdf9176f009a928e1cd9a1a8c212f15c1e11ac9f2925d9002205b75f937ff2f9f3c1246e547e54f62e027f64eefa2695578cc6432cdabce271502473044022059ebf56d98010a932cf8ecfec54c48e6139ed6adb0728c09cbe1e4fa0915302e022007cd986c8fa870ff5d2b3a89139c9fe7e499259875357e20fcbb15571c76795403483045022100fbefd94bd0a488d50b79102b5dad4ab6ced30c4069f1eaa69a4b5a763414067e02203156c6a5c9cf88f91265f5a942e96213afae16d83321c8b31bb342142a14d16381483045022100a5263ea0553ba89221984bd7f0b13613db16e7a70c549a86de0cc0444141a407022005c360ef0ae5a5d4f9f2f87a56c1546cc8268cab08c73501d6b3be2e1e1a8a08824730440220525406a1482936d5a21888260dc165497a90a15669636d8edca6b9fe490d309c022032af0c646a34a44d1f4576bf6a4a74b67940f8faa84c7df9abe12a01a11e2b4783cf56210307b8ae49ac90a048e9b53357a2354b3334e9c8bee813ecb98e99a7e07e8c3ba32103b28f0c28bfab54554ae8c658ac5c3e0ce6e79ad336331f78c428dd43eea8449b21034b8113d703413d57761b8b9781957b8c0ac1dfe69f492580ca4195f50376ba4a21033400f6afecb833092a9a21cfdf1ed1376e58c5d1f47de74683123987e967a8f42103a6d48b1131e94ba04d9737d61acdaa1322008af9602b3b14862c07a1789aac162102d8b661b0b3302ee2f162b09e07a55ad5dfbe673a9f01d9f0c19617681024306b56ae00000000';
const SINGLE_ANYONE = '01000000000102e9b542c5176808107ff1df906f46bb1f2583b16112b95ee5380665ba7fcfc0010000000000ffffffff80e68831516392fcd100d186b3c2c7b95c80b53c77e77c35ba03a66b429a2a1b0000000000ffffffff0280969800000000001976a914de4b231626ef508c9a74a8517e6783c0546d6b2888ac80969800000000001976a9146648a8cd4531e1ec47f35916de8e259237294d1e88ac02483045022100f6a10b8604e6dc910194b79ccfc93e1bc0ec7c03453caaa8987f7d6c3413566002206216229ede9b4d6ec2d325be245c5b508ff0339bf1794078e20bfe0babc7ffe683270063ab68210392972e2eb617b2388771abe27235fd5ac44af8e61693261550447a4c3e39da98ac024730440220032521802a76ad7bf74d0e2c218b72cf0cbc867066e2e53db905ba37f130397e02207709e2188ed7f08f4c952d9d13986da504502b8c3be59617e043552f506c46ff83275163ab68210392972e2eb617b2388771abe27235fd5ac44af8e61693261550447a4c3e39da98ac00000000';

// Litecoin Core's tx_valid.json: transactions it names by txid.
const NAMED = [
  ['23b397edccd3740a74adb603c9756370fafcde9bcc4483eb271ecad09a94dd63', '0100000001b14bdcbc3e01bdaad36cc08e81e69c82e1060bc14e518db2b49aa43ad90ba26000000000490047304402203f16c6f40162ab686621ef3000b04e75418a0c0cb2d8aebeac894ae360ac1e780220ddc15ecdfc3507ac48e1681a33eb60996631bf6bf5bc0a0682c4db743ce7ca2b01ffffffff0140420f00000000001976a914660d4ef3a743e3e696ad990364e555c271ad504b88ac00000000'],
  ['c99c49da4c38af669dea436d3e73780dfdb6c1ecf9958baa52960e8baee30e73', '01000000010276b76b07f4935c70acf54fbf1f438a4c397a9fb7e633873c4dd3bc062b6b40000000008c493046022100d23459d03ed7e9511a47d13292d3430a04627de6235b6e51a40f9cd386f2abe3022100e7d25b080f0bb8d8d5f878bba7d54ad2fda650ea8d158a33ee3cbd11768191fd004104b0e2c879e4daf7b9ab68350228c159766676a14f5815084ba166432aab46198d4cca98fa3e9981d0a90b2effc514b76279476550ba3663fdcaff94c38420e9d5000000000100093d00000000001976a9149a7b0f3b80c6baaeedce0a0842553800f832ba1f88ac00000000'],
  ['ddc454a1c0c35c188c98976b17670f69e586d9c0f3593ea879928332f0a069e7', '0100000001482f7a028730a233ac9b48411a8edfb107b749e61faf7531f4257ad95d0a51c5000000008b483045022100bf0bbae9bde51ad2b222e87fbf67530fbafc25c903519a1e5dcc52a32ff5844e022028c4d9ad49b006dd59974372a54291d5764be541574bb0c4dc208ec51f80b7190141049dd4aad62741dc27d5f267f7b70682eee22e7e9c1923b9c0957bdae0b96374569b460eb8d5b40d972e8c7c0ad441de3d94c4a29864b212d56050acb980b72b2bffffffff0180969800000000001976a914e336d0017a9d28de99d16472f6ca6d5a3a8ebc9988ac00000000'],
];

// ---- secp256k1 -------------------------------------------------------------

group('public keys', () => {
  const edges = [1n, 2n, 3n, S.N - 1n, S.N - 2n, 1n << 128n, (1n << 255n) + 1n];
  const randoms = Array.from({ length: 100 }, () => big(randomBytes(32).toString('hex')) % (S.N - 1n) + 1n);
  for (const secret of [...edges, ...randoms]) {
    const e = ecdh(secret);
    const compressed = e.getPublicKey('hex', 'compressed');
    const full = new Uint8Array(e.getPublicKey(null, 'uncompressed'));
    check(hex(S.publicKey(secret)) === compressed, `public key of ${be(secret).slice(0, 12)}…`);
    check(hex(S.publicKey(S.fromBig(secret))) === compressed, 'the same from 32 bytes');
    check(hex(S.compressPublicKey(full)) === compressed, 'compressing the uncompressed key');
    const [x, y] = S.parsePublicKey(unhex(compressed));
    check(`04${be(x)}${be(y)}` === hex(full), 'a compressed key gives the uncompressed point');
  }
  for (const bad of [0n, S.N, S.N + 1n, -1n, 5, new Uint8Array(31), new Uint8Array(32), S.fromBig(S.N)]) {
    throws(() => S.publicKey(bad), /private key/, `private key ${bad} refused`);
  }
  // Which x have a point: OpenSSL and this code agree, and on its y.
  for (let x = 0n; x < 40n; x++) {
    const key = unhex(`03${be(x)}`);
    const theirs = quietly(() => ECDH.convertKey(Buffer.from(key), 'secp256k1', null, 'hex', 'uncompressed'));
    const mine = quietly(() => S.parsePublicKey(key));
    check(theirs === (mine && `04${be(mine[0])}${be(mine[1])}`), `x = ${x}: ${theirs ? 'a point' : 'no point'}`);
  }
  const good = S.publicKey(7n);
  const full = unhex(ecdh(7n).getPublicKey('hex', 'uncompressed'));
  const offCurve = full.slice();
  offCurve[64] ^= 1;
  const hybrid = full.slice();
  hybrid[0] = 6 + (full[64] & 1);
  for (const [key, why, what] of [
    [unhex(`04${hex(good.subarray(1))}`), /cannot start with 4/, '33 bytes starting 04'],
    [unhex(`05${hex(good.subarray(1))}`), /cannot start with 5/, '33 bytes starting 05'],
    [good.subarray(1), /32 bytes/, '32 bytes'],
    [unhex(`02${be(S.P)}`), /out of range/, 'x = P'],
    [offCurve, /not on the curve/, 'a point off the curve'],
    [hybrid, /cannot start with/, 'a hybrid key (06, 07)'],
    [`02${hex(good)}`, /not bytes/, 'hex text'],
  ]) {
    throws(() => S.parsePublicKey(key), why, `public key refused: ${what}`);
    check(!S.isPublicKey(key), `isPublicKey is false: ${what}`);
  }
  check(S.isPublicKey(good) && S.isPublicKey(full), 'isPublicKey is true for both forms');
});

group('RFC 6979 nonces', () => {
  const first = (secret, digest, order) => S.nonces(secret, digest, order).next().value;
  // RFC 6979 A.2.5: P-256 with SHA-256, the RFC's own key, nonces and signatures.
  const p256 = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
  const x = big('c9afa9d845ba75166b5c215767b1d6934e50c3db36e89b127b8a622b120f6721');
  const p256Key = createPublicKey({
    key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), ecdh(x, 'prime256v1').getPublicKey()]),
    format: 'der',
    type: 'spki',
  });
  for (const [message, k, r, s] of [
    ['sample', 'a6e3c57dd01abe90086538398355dd4c3b17aa873382b0f24d6129493d8aad60',
      'efd48b2aacb6a8fd1140dd9cd45e81d69d2c877b56aaf991c34d0ea84eaf3716', 'f7cb1c942d657c41d436c7a1b6e29f65f3e900dbb9aff4064dc4ab2f843acda8'],
    ['test', 'd16b6ae827f17175e040871a1c7ec3500192c4c92677336ec2537acaee0008e0',
      'f1abb023518351cd71d881567b1ea663ed3efcf6c5132b354f28d3b0b7d38367', '019f4113742a2b14bd25926b49c649155f267e60d3814b4c0cc84250e46f0083'],
  ]) {
    check(first(x, sha(message), p256) === big(k), `P-256, SHA-256, "${message}": the RFC's nonce`);
    const kx = big(ecdh(big(k), 'prime256v1').getPublicKey('hex', 'uncompressed').slice(2, 66));
    check(kx % p256 === big(r), `P-256, "${message}": OpenSSL's k·G gives the RFC's r`);
    check(verify('sha256', Buffer.from(message), { key: p256Key, dsaEncoding: 'ieee-p1363' }, Buffer.from(r + s, 'hex')), `P-256, "${message}": OpenSSL takes the RFC's signature`);
  }
  // secp256k1, as other libraries publish it: OpenSSL confirms that r is the
  // nonce's x and that r, s is a signature, so the nonce is RFC 6979's only
  // if this code (checked above on the RFC's own) draws it too.
  for (const [secret, message, k, r, s] of [
    [1n, 'Satoshi Nakamoto', '8f8a276c19f4149656b280621e358cce24f5f52542772691ee69063b74f15d15',
      '934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8', '2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5'],
    [1n, 'All those moments will be lost in time, like tears in rain. Time to die...', '38aa22d72376b4dbc472e06c3ba403ee0a394da63fc58d88686c611aba98d6b3',
      '8600dbd41e348fe5c9465ab92d23e3db8b98b873beecd930736488696438cb6b', '547fe64427496db33bf66019dacbf0039c04199abb0122918601db38a72cfc21'],
    [big('f8b8af8ce3c7cca5e300d33939540c10d45ce001b8f252bfbc57ba0342904181'), 'Alan Turing', '525a82b70e67874398067543fd84c83d30c175fdc45fdeee082fe13b1d7cfdf1',
      '7063ae83e7f62bbb171798131b4a0564b956930092b33b07b395615d9ec7e15c', '58dfcc1e00a35e1572f366ffe34ba0fc47db1e7189759b9fb233c5b05ab388ea'],
  ]) {
    const what = `secp256k1, "${message.slice(0, 20)}"`;
    check(first(secret, sha(message)) === big(k), `${what}: the nonce`);
    check(big(ecdh(big(k)).getPublicKey('hex', 'uncompressed').slice(2, 66)) % S.N === big(r), `${what}: OpenSSL's k·G gives r`);
    check(openssl(Buffer.from(message), Buffer.from(r + s, 'hex'), S.publicKey(secret), 'ieee-p1363'), `${what}: OpenSSL takes r, s`);
    const der = S.sign(secret, sha(message));
    check(hex(der) === hex(S.encodeDer(big(r), big(s))), `${what}: the signature`);
  }
});

group(`signatures (${rounds} random, checked by OpenSSL)`, () => {
  for (let i = 0; i < rounds; i++) {
    const secret = i < 4 ? [1n, 2n, S.N - 1n, S.N - 2n][i] : big(randomBytes(32).toString('hex')) % (S.N - 1n) + 1n;
    const message = randomBytes(i % 97);
    const digest = sha(message);
    const der = S.sign(secret, digest);
    const key = S.publicKey(secret);
    const { r, s } = S.parseDer(der);
    check(der.length >= 8 && der.length <= 72 && s <= HALF, 'strict DER, low s');
    check(openssl(message, der, key), `OpenSSL takes it (round ${i})`);
    check(S.verify(der, digest, key), `verify takes it (round ${i})`);
    if (i % 10 === 0) {
      check(hex(S.sign(secret, digest)) === hex(der), 'the same every time');
      const bent = der.slice();
      bent[i % der.length] ^= 1 << (i % 8);
      check(!S.verify(bent, digest, key) && !openssl(message, bent, key), 'a changed bit fails both');
      const high = S.encodeDer(r, S.N - s);
      check(openssl(message, high, key) && !S.verify(high, digest, key), 'its high-S twin: OpenSSL takes it, verify does not');
      check(!S.verify(der, sha(Buffer.concat([message, Buffer.from([1])])), key), 'another digest fails');
      check(!S.verify(der, digest, S.publicKey(secret % (S.N - 1n) + 1n)), 'another key fails');
    }
  }
  // OpenSSL's own signatures, whose s is high about half the time.
  let high = 0;
  for (let i = 0; i < 100; i++) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const y = Buffer.from(jwk.y, 'base64url');
    const key = Uint8Array.from([2 + (y[31] & 1), ...Buffer.from(jwk.x, 'base64url')]);
    const message = randomBytes(40);
    const rs = opensslSign('sha256', message, { key: privateKey, dsaEncoding: 'ieee-p1363' });
    const r = big(rs.subarray(0, 32).toString('hex'));
    const s = big(rs.subarray(32).toString('hex'));
    if (s > HALF) high++;
    check(S.verify(S.encodeDer(r, s), sha(message), key) === (s <= HALF), 'verify takes OpenSSL\'s signature when s is low, and only then');
    check(S.verify(S.encodeDer(r, s > HALF ? S.N - s : s), sha(message), key), 'and takes it once s is made low');
  }
  check(high > 20 && high < 80, `OpenSSL made ${high} of 100 with a high s`);
  for (const [secret, digest] of [[0n, sha('x')], [S.N, sha('x')], [1n, sha('x').subarray(1)]]) {
    throws(() => S.sign(secret, digest), null, 'a bad key or digest is refused');
  }
});

group('DER', () => {
  check(hex(S.encodeDer(1n, 1n)) === '3006020101020101', 'r = s = 1');
  check(hex(S.encodeDer(0x80n, 1n)) === '300702020080020101', 'a high bit takes a zero byte');
  check(hex(S.encodeDer(S.N - 1n, HALF)) === `3045022100${be(S.N - 1n)}0220${be(HALF)}`, 'a 33-byte r');
  const one = S.parseDer(unhex('3006020101020101'));
  check(one.r === 1n && one.s === 1n, 'reads r = s = 1');
  check(S.parseDer(S.encodeDer(S.N - 1n, HALF)).s === HALF, 's = N/2 is low');
  for (const [der, why, what] of [
    ['3106020101020101', /no sequence/, 'not a sequence'],
    ['3007020101020101', /sequence length/, 'the wrong sequence length'],
    ['300602010102010100', /sequence length/, 'a trailing byte'],
    ['30060201010201', /bytes/, 'too short'],
    [`3046022100${be(S.N - 1n)}022100${be(1n)}`, /padded/, 's padded to 33 bytes'],
    ['3006020181020101', /r is negative/, 'a negative r'],
    ['300702020001020101', /r is padded/, 'a padded r'],
    ['3006020002020101', /r is not an integer/, 'an empty r'],
    ['3006030101020101', /r is not an integer/, 'r not tagged integer'],
    ['3006020101030101', /s is not an integer/, 's not tagged integer'],
    ['3006020101020181', /s is negative/, 'a negative s'],
    ['300702010102020001', /s is padded/, 'a padded s'],
    ['3006020201020101', /lengths do not add up/, 'lengths that do not add up'],
    ['3006020100020101', /r is out of range/, 'r = 0'],
    ['3006020101020100', /s is out of range/, 's = 0'],
    [hex(S.encodeDer(S.N, 1n)), /r is out of range/, 'r = N'],
    [hex(S.encodeDer(1n, HALF + 1n)), /s is high/, 's above N/2'],
    [`30${(71).toString(16)}${'02210080'.padEnd(70, '0')}0222${'00'.repeat(34)}`, /bytes/, '73 bytes'],
  ]) {
    throws(() => S.parseDer(unhex(der)), why, `refused: ${what}`);
  }
});

// ---- Encodings -------------------------------------------------------------

/** BIP 173's checksum, written out again here: for the uppercase-prefix vectors. */
function polymod(hrp, data) {
  const gen = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  for (const v of [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31), ...data]) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= gen[i];
  }
  return chk;
}
const fiveBit = (s) => [...s.toLowerCase()].map((c) => 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'.indexOf(c));
/** 5-bit values to bytes, dropping the padding: written out again here. */
function toBytes(values) {
  let acc = 0n;
  for (const v of values) acc = (acc << 5n) | BigInt(v);
  const n = Math.floor((values.length * 5) / 8);
  return be(acc >> BigInt(values.length * 5 - n * 8), n);
}

group('bech32 and bech32m (BIP 173, BIP 350)', () => {
  for (const [list, variant] of [[VALID_BECH32, 'bech32'], [VALID_BECH32M, 'bech32m']]) {
    for (const s of list) {
      const got = quietly(() => L.decodeBech32(s));
      check(got?.variant === variant, `${s.slice(0, 30)} is ${variant}`);
      if (got) check(L.encodeBech32(got.hrp, got.data, variant) === s.toLowerCase(), `${s.slice(0, 30)} encodes back`);
    }
  }
  for (const [s, why] of [...INVALID_BECH32, ...INVALID_BECH32M]) throws(() => L.decodeBech32(s), why, `refused: ${JSON.stringify(s.slice(0, 30))}`);
  check(polymod('A', fiveBit('g7sgd8')) === 1, 'A1G7SGD8 is bech32 with its prefix in upper case');
  check(polymod('M', fiveBit('vuxwez')) === 0x2bc830a3, 'M1VUXWEZ is bech32m with its prefix in upper case');
});

group('segwit addresses (BIP 173, BIP 350)', () => {
  for (const [address, script] of SEGWIT_VALID) {
    const hrp = address.slice(0, 2).toLowerCase();
    const got = quietly(() => L.decodeSegwit(hrp, address));
    check(got && hex(L.witnessOutput(got.version, got.program)) === script, `${address.slice(0, 24)}… pays ${script.slice(0, 12)}…`);
    if (got) check(L.encodeSegwit(hrp, got.version, got.program) === address.toLowerCase(), `${address.slice(0, 24)}… encodes back`);
    throws(() => L.decodeSegwit(hrp === 'bc' ? 'tb' : 'bc', address), /prefix/, `${address.slice(0, 24)}… is not of the other prefix`);
  }
  for (const [address, script] of BIP173_V1_PLUS) {
    const got = quietly(() => L.decodeBech32(address));
    const version = got?.data[0];
    check(got?.variant === 'bech32', `${address.slice(0, 24)}… has a bech32 checksum`);
    check(got && `${(version ? 0x50 + version : 0).toString(16)}${(Math.floor(((got.data.length - 1) * 5) / 8)).toString(16).padStart(2, '0')}${toBytes(got.data.slice(1))}` === script, `${address.slice(0, 24)}… holds ${script.slice(0, 12)}…`);
    throws(() => L.decodeSegwit('bc', address), /with a bech32 checksum/, `${address.slice(0, 24)}… is refused since BIP 350`);
  }
  for (const [address, why] of SEGWIT_INVALID) {
    const hrp = /^tb1/i.test(address) ? 'tb' : 'bc';
    throws(() => L.decodeSegwit(hrp, address), why, `refused: ${address.slice(0, 30)}…`);
    throws(() => L.decodeSegwit(hrp === 'bc' ? 'tb' : 'bc', address), null, `refused for the other prefix: ${address.slice(0, 30)}…`);
  }
  // BIP 173: an incomplete group at the end is at most 4 bits, all zero. Nine
  // groups are 45 bits, 5 bytes and 5 bits over.
  throws(() => L.decodeSegwit('bc', L.encodeBech32('bc', [1, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'bech32m')), /5 bits of padding/, '5 bits of padding');
  check(hex(L.decodeSegwit('bc', L.encodeBech32('bc', [1, 0, 0, 0, 0, 0, 0, 0, 0], 'bech32m')).program) === '0000000000', '5 bytes in 8 groups, 0 bits of padding');
  throws(() => L.encodeSegwit('bc', 0, new Uint8Array(21)), /version 0/, 'encoding refuses a 21-byte version 0 program');
  throws(() => L.encodeSegwit('bc', 17, new Uint8Array(20)), /version 17/, 'encoding refuses version 17');
});

group('base58 (Litecoin Core vectors)', () => {
  for (const [data, text] of BASE58) {
    check(L.base58(unhex(data)) === text, `base58 of ${data.slice(0, 16)}`);
    check(hex(L.unbase58(text)) === data, `bytes of ${text.slice(0, 16)}`);
  }
  // Litecoin Core's base58_tests.cpp.
  check(hex(L.unbase58('skip')) === '971a55', '"skip"');
  check(quietly(() => L.unbase58check('3vQB7B6MrGQZaxCuFg4oh')) !== undefined, '3vQB7B6MrGQZaxCuFg4oh checks out');
  throws(() => L.unbase58check('3vQB7B6MrGQZaxCuFg4oi'), /checksum/, '3vQB7B6MrGQZaxCuFg4oi does not');
  throws(() => L.unbase58('bad0IOl'), /not a base58 character/, '0, I, O and l are not base58');
});

group('Litecoin addresses (Litecoin Core key_io vectors)', () => {
  const NET = { main: 'mainnet', test: 'testnet', regtest: 'regtest' };
  const nets = Object.keys(L.NETWORKS);
  for (const [address, script, chain, flip] of KEY_IO_VALID) {
    const net = NET[chain];
    const spendable = L.scriptType(unhex(script)) !== null;
    for (const a of flip ? [address, flipCase(address)] : [address]) {
      if (spendable) check(quietly(() => hex(L.addressToScript(a, net))) === script, `${a} pays ${script}`);
      else throws(() => L.addressToScript(a, net), /no Litecoin rule spends/, `${a} is refused: its witness version is not in use`);
    }
    if (spendable) {
      check(L.scriptToAddress(unhex(script), net) === address, `${script} is ${address}`);
      check(hex(L.destination(address, net)) === script && hex(L.destination(unhex(script), net)) === script, `destination ${address}`);
    } else {
      const { version, program } = L.decodeSegwit(L.NETWORKS[net].hrp, address);
      check(hex(L.witnessOutput(version, program)) === script, `${address} holds ${script}`);
      check(L.encodeSegwit(L.NETWORKS[net].hrp, version, program) === address, `${address} encodes back`);
    }
    for (const other of nets) {
      if (other === net) continue;
      // Testnet and regtest share base58 version bytes.
      const shared = !/^[tr]?ltc1/i.test(address) && net !== 'mainnet' && other !== 'mainnet';
      if (shared) check(hex(L.addressToScript(address, other)) === script, `${address} is ${other}'s too`);
      else throws(() => L.addressToScript(address, other), /address, not/, `${address} is not ${other}'s`);
    }
  }
  for (const a of KEY_IO_INVALID) for (const net of nets) throws(() => L.addressToScript(a, net), null, `${JSON.stringify(a)} is not a ${net} address`);
  // P2SH under Bitcoin's version byte, which Litecoin still reads.
  for (const [address, net, version] of [['MHrYRxAiMNBTku3eoDHwhA1LQGDjUStZW2', 'mainnet', 0x05], ['QXaUgLHkZcbJb2j5XgMYzY8cF9YM48Y81Z', 'testnet', 0xc4]]) {
    const hash = L.unbase58check(address).subarray(1);
    const legacy = L.base58check(Uint8Array.from([version, ...hash]));
    check(hex(L.addressToScript(legacy, net)) === hex(L.addressToScript(address, net)), `${legacy} pays as ${address}`);
    check(L.scriptToAddress(L.addressToScript(legacy, net), net) === address, `and is written ${address}`);
  }
  throws(() => L.addressToScript('ltc1qhdhvrwe6rgqns8fz28tee0hphr5x7ulw5exv4w', 'testnet'), /mainnet address, not testnet/, 'a mainnet address on testnet');
  throws(() => L.addressToScript('mwXn5Vhicdav8Av3KMokx4YNuHoGRKxtWs', 'mainnet'), /testnet or regtest address, not mainnet/, 'a testnet address on mainnet');
  throws(() => L.addressToScript('ltc1qhdhvrwe6rgqns8fz28tee0hphr5x7ulw5exv4q', 'mainnet'), /checksum is wrong/, 'a mistyped address');
  throws(() => L.addressToScript('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet'), /prefix bc/, 'a Bitcoin address');
  throws(() => L.addressToScript('1NS17iag9jJgTHD1VXjvLCEnZuQ3rJDE9L', 'mainnet'), /not a Litecoin address/, 'a Bitcoin P2PKH address');
  throws(() => L.addressToScript(`ltcmweb1${'q'.repeat(100)}`, 'mainnet'), /MWEB/, 'an MWEB address');
  throws(() => L.addressToScript('  ', 'mainnet'), /no address/, 'nothing');
  throws(() => L.addressToScript('ltc1qhdhvrwe6rgqns8fz28tee0hphr5x7ulw5exv4w', 'signet'), /no Litecoin network/, 'an unknown network');
  check(hex(L.addressToScript(' ltc1qhdhvrwe6rgqns8fz28tee0hphr5x7ulw5exv4w\n')) === '0014bb6ec1bb3a1a01381d2251d79cbee1b8e86f73ee', 'spaces around are ignored; mainnet by default');
  throws(() => L.scriptToAddress(unhex('6a0400000000')), /no address/, 'OP_RETURN has no address');
  throws(() => L.destination(unhex('6a0400000000')), /pay to/, 'nor is it a destination');
  // Litecoin Core's GetDustThreshold at its -dustrelayfee default of 0.0003 LTC/kB.
  for (const [address, dust] of [
    ['ltc1qhdhvrwe6rgqns8fz28tee0hphr5x7ulw5exv4w', 2940], ['ltc1qa9dykljtgeayhm8ygx25sc22p0wzgudpe4hw9dyvaz0ye3j5kduq9mf68z', 3300],
    ['ltc1ppu2gv0tujus0f6eggrk7eqmaf0567x6zer4fcuhz4z7ztzq9u9yseqxltc', 3300], ['MHrYRxAiMNBTku3eoDHwhA1LQGDjUStZW2', 5400],
    ['LT2KVaAy1ppRuxRgrS5RNU3vBsy7RibPeA', 5460],
  ]) {
    check(L.dustLimit(L.addressToScript(address)) === dust, `dust for ${L.scriptType(L.addressToScript(address))} is ${dust}`);
  }
});

group('script numbers and pushes', () => {
  // Worked out from the encoding: little-endian magnitude, the sign in the top bit.
  for (const [n, encoded, push] of [
    [0, '', '00'], [1, '01', '51'], [16, '10', '60'], [17, '11', '0111'], [-1, '81', '4f'], [-2, '82', '0182'],
    [127, '7f', '017f'], [128, '8000', '028000'], [-128, '8080', '028080'], [255, 'ff00', '02ff00'], [256, '0001', '020001'],
    [-255, 'ff80', '02ff80'], [32767, 'ff7f', '02ff7f'], [32768, '008000', '03008000'], [2147483647, 'ffffff7f', '04ffffff7f'],
    [2147483648, '0000008000', '050000008000'], [500000000, '0065cd1d', '040065cd1d'], [1900000000, '00b33f71', '0400b33f71'],
    [4294967295, 'ffffffff00', '05ffffffff00'],
  ]) {
    check(hex(L.scriptNum(n)) === encoded, `${n} is ${encoded || 'empty'}`);
    check(hex(L.pushNumber(n)) === push, `${n} is pushed as ${push}`);
    check(L.decodeScriptNum(unhex(encoded), 5) === n, `${encoded || 'empty'} reads ${n}`);
  }
  for (const [bytes, why] of [['00', /not minimal/], ['80', /not minimal/], ['0100', /not minimal/], ['ff0000', /not minimal/], ['0000008000', /5 bytes/]]) {
    throws(() => L.decodeScriptNum(unhex(bytes)), why, `${bytes} refused`);
  }
  const data = (n) => Uint8Array.from({ length: n }, (_, i) => i);
  for (const [bytes, prefix] of [
    [new Uint8Array(0), '00'], [Uint8Array.of(0), '01'], [Uint8Array.of(5), '55'], [Uint8Array.of(0x81), '4f'], [Uint8Array.of(17), '01'],
    [data(75), '4b'], [data(76), '4c4c'], [data(255), '4cff'], [data(256), '4d0001'], [data(65535), '4dffff'], [data(65536), '4e00000100'],
  ]) {
    const push = L.pushData(bytes);
    const tail = bytes.length > 1 || (bytes.length === 1 && (bytes[0] === 0 || bytes[0] === 17)) ? hex(bytes) : '';
    check(hex(push) === prefix + tail, `a push of ${bytes.length} bytes starts ${prefix}`);
    const ops = L.decodeScript(push);
    check(ops.length === 1 && (bytes.length !== 1 || bytes[0] === 0 || bytes[0] === 17 ? hex(ops[0].data ?? []) === hex(bytes) : true), `a push of ${bytes.length} bytes reads back`);
  }
  throws(() => L.decodeScript(unhex('4c')), /past the end/, 'PUSHDATA1 without its length');
  throws(() => L.decodeScript(unhex('4d01')), /past the end/, 'PUSHDATA2 with half its length');
  throws(() => L.decodeScript(unhex('0201')), /past the end/, 'a push one byte short');
});

// ---- Transactions and BIP 143 ----------------------------------------------

group('BIP 143', () => {
  const tx = L.parseTx(P2WPKH.unsigned);
  const scriptCode = unhex(P2WPKH.scriptCode);
  check(hex(L.sighashPreimage(tx, 1, scriptCode, P2WPKH.value, L.SIGHASH_ALL)) === P2WPKH.preimage, 'native P2WPKH: the preimage');
  check(hex(preimage143(tx, 1, scriptCode, P2WPKH.value, 1)) === P2WPKH.preimage, 'native P2WPKH: the preimage, written out here');
  const digest = L.sighash(tx, 1, scriptCode, P2WPKH.value, L.SIGHASH_ALL);
  check(hex(digest) === P2WPKH.sighash, 'native P2WPKH: the sighash');
  check(hex(S.publicKey(unhex(P2WPKH.key))) === P2WPKH.publicKey, 'native P2WPKH: the key');
  const signedTx = L.parseTx(P2WPKH.signed);
  const [sig, key] = signedTx.inputs[1].witness;
  check(hex(S.sign(unhex(P2WPKH.key), digest)) + '01' === hex(sig), 'native P2WPKH: RFC 6979 makes the BIP\'s signature');
  check(openssl(sha(L.sighashPreimage(tx, 1, scriptCode, P2WPKH.value, 1)), sig.subarray(0, -1), key), 'native P2WPKH: OpenSSL takes it');

  const p2wsh = L.parseTx(P2WSH.signed);
  const [sig2, sig1, script] = p2wsh.inputs[1].witness;
  const afterSeparator = script.subarray(script.indexOf(0xab) + 1);
  for (const [i, code, signature] of [[0, script, sig1], [1, afterSeparator, sig2]]) {
    const d = L.sighash(p2wsh, 1, code, P2WSH.value, 3);
    check(hex(d) === P2WSH.sighashes[i], `native P2WSH: sighash ${i + 1}`);
    check(hex(preimage143(p2wsh, 1, code, P2WSH.value, 3)) === hex(L.sighashPreimage(p2wsh, 1, code, P2WSH.value, 3)), `native P2WSH: preimage ${i + 1}, written out here`);
    check(hex(S.sign(unhex(P2WSH.keys[i]), d)) + '03' === hex(signature), `native P2WSH: RFC 6979 makes signature ${i + 1}`);
    check(S.verify(signature.subarray(0, -1), d, S.publicKey(unhex(P2WSH.keys[i]))), `native P2WSH: verify takes signature ${i + 1}`);
  }

  const multisig = L.parseTx(MULTISIG);
  const items = multisig.inputs[0].witness;
  const witnessScript = items[items.length - 1];
  const keys = L.decodeScript(witnessScript).filter((o) => o.data?.length === 33).map((o) => o.data);
  check(keys.length === 6, 'the 6-of-6 script holds 6 keys');
  for (let i = 1; i <= 6; i++) {
    const signature = items[i];
    const type = signature[signature.length - 1];
    const pre = L.sighashPreimage(multisig, 0, witnessScript, 987654321, type);
    check(hex(pre) === hex(preimage143(multisig, 0, witnessScript, 987654321, type)), `6-of-6, type ${type.toString(16)}: the preimage, written out here`);
    check(S.verify(signature.subarray(0, -1), dsha(pre), keys[i - 1]), `6-of-6, type ${type.toString(16)}: verify takes it`);
    check(openssl(sha(pre), signature.subarray(0, -1), keys[i - 1]), `6-of-6, type ${type.toString(16)}: OpenSSL takes it`);
  }
  check(items.slice(1, 7).map((s) => s[s.length - 1].toString(16)).join() === '1,2,3,81,82,83', 'the 6-of-6 uses all six sighash types');

  const pair = L.parseTx(SINGLE_ANYONE);
  for (const [i, input] of pair.inputs.entries()) {
    const [signature, s] = input.witness;
    const code = s[0] === 0x51 ? s.subarray(s.indexOf(0xab) + 1) : s; // OP_CODESEPARATOR runs only behind OP_1 OP_IF
    const d = L.sighash(pair, i, code, 16777215, signature[signature.length - 1]);
    check(S.verify(signature.subarray(0, -1), d, s.subarray(s.length - 34, s.length - 1)), `SINGLE|ANYONECANPAY, input ${i}`);
  }
});

group('transactions', () => {
  for (const [id, raw] of NAMED) {
    const tx = L.parseTx(raw);
    check(L.txid(tx) === id, `txid ${id.slice(0, 16)}…`);
    check(hex(Buffer.from(dsha(unhex(raw))).reverse()) === id, `Node hashes ${id.slice(0, 16)}… alike`);
    check(hex(L.serializeTx(tx)) === raw, `${id.slice(0, 16)}… serializes back`);
    check(L.vsize(tx) === raw.length / 2, `a legacy transaction's vsize is its size (${id.slice(0, 16)}…)`);
  }
  for (const raw of [P2WPKH.unsigned, P2WPKH.signed, P2WSH.signed, MULTISIG, SINGLE_ANYONE]) {
    check(hex(L.serializeTx(L.parseTx(raw))) === raw, `${raw.slice(0, 24)}… serializes back`);
  }
  // The signed P2WPKH example: marker and flag, then witnesses 00 and 02 47 <71> 21 <33>, are 110 bytes.
  const size = P2WPKH.signed.length / 2;
  const signed = L.parseTx(P2WPKH.signed);
  check(L.weight(signed) === 3 * (size - 110) + size, 'the weight of the signed P2WPKH example');
  check(L.vsize(signed) === Math.ceil(L.weight(signed) / 4), 'its vsize');
  check(L.txid(signed) === L.txid({ ...signed, inputs: signed.inputs.map((i) => ({ ...i, witness: [] })) }), 'the witness is not in the txid');
  check(hex(L.serializeTx(signed, { witness: false })) === hex(L.serializeTx({ ...signed, inputs: signed.inputs.map((i) => ({ ...i, witness: [] })) })), 'without witnesses, the legacy form');
  const legacy = NAMED[0][1];
  throws(() => L.parseTx(legacy.slice(0, -2)), /truncated/, 'a truncated transaction');
  throws(() => L.parseTx(`${legacy}00`), /trailing/, 'a trailing byte');
  throws(() => L.parseTx(`01000000000101${legacy.slice(10, -8)}0000000000`), /no witness/, 'a witness flag with no witness');
  throws(() => L.parseTx(`01000000000801${legacy.slice(10)}`), /MWEB/, 'an MWEB transaction');
  throws(() => L.parseTx(`01000000fd0100${legacy.slice(10)}`), /shortest form/, 'a count not in its shortest form');
  throws(() => L.parseTx('zz'), /not hex/, 'not hex');
  throws(() => L.parseTx(undefined), /bytes or hex/, 'nothing');
});

// ---- The lock --------------------------------------------------------------

const keyOf = (label) => sha(label);
const SELLER = keyOf('seller');
const BUYER = keyOf('buyer');
const SECRET = sha('the secret');
const PROGRAM = sha('the program');
const TAKER = sha('the buyer on Ting');
const ID = 7;
const T1 = 1_900_000_000;
const LOCK_TXID = hex(sha('the lock transaction'));
const VOUT = 1;
const VALUE = 1_000_000;

/** The lock's script, assembled here from HTLC.md's opcodes. */
function assembled({ tag, hash, seller, buyer, t1 }) {
  const t = [];
  for (let v = t1; v; v = Math.floor(v / 256)) t.push(v % 256);
  if (t[t.length - 1] & 0x80) t.push(0);
  const time = hex(Uint8Array.from([t.length, ...t]));
  return `20${hex(tag)}75` + // <tag> OP_DROP
    '63' + // OP_IF
    `820120 88 a8 20${hex(hash)} 88 21${hex(seller)} ac`.replace(/ /g, '') + // OP_SIZE <32> OP_EQUALVERIFY OP_SHA256 <hash> OP_EQUALVERIFY <seller> OP_CHECKSIG
    '67' + // OP_ELSE
    '63' + // OP_IF
    `${time}b175 21${hex(buyer)}ac`.replace(/ /g, '') + // <t1> OP_CHECKLOCKTIMEVERIFY OP_DROP <buyer> OP_CHECKSIG
    '67' + // OP_ELSE
    `21${hex(seller)}ad21${hex(buyer)}ac` + // <seller> OP_CHECKSIGVERIFY <buyer> OP_CHECKSIG
    '6868'; // OP_ENDIF OP_ENDIF
}

const tag = L.lockTag(PROGRAM, ID, TAKER);
const HTLC = { tag, hash: sha(SECRET), seller: S.publicKey(SELLER), buyer: S.publicKey(BUYER), t1: T1 };

group('the lock', () => {
  const prefix = Buffer.from('app/htlc-v1/ltc-lock');
  const tagHere = sha(Buffer.concat([Buffer.from('Ting/'), le(prefix.length, 2), prefix, PROGRAM, le(ID, 8), TAKER]));
  check(hex(tag) === hex(tagHere), 'the tag is H("app/htlc-v1/ltc-lock", program ‖ u64 id ‖ taker)');
  check(hex(L.lockTag(PROGRAM, ID + 1, TAKER)) !== hex(tag) && hex(L.lockTag(PROGRAM, ID, PROGRAM)) !== hex(tag), 'another listing or taker, another tag');
  check(hex(HTLC.seller) === ecdh(big(hex(SELLER))).getPublicKey('hex', 'compressed'), 'the seller\'s key is OpenSSL\'s');

  const script = L.htlcScript(HTLC);
  check(hex(script) === assembled(HTLC), 'the script is HTLC.md\'s, byte for byte');
  check(script.length === 226, `the script is ${script.length} bytes`);
  const later = { ...HTLC, t1: 2 ** 31 + 5 };
  check(hex(L.htlcScript(later)) === assembled(later), 'a T1 past 2038 takes 5 bytes');
  for (const h of [HTLC, later, { ...HTLC, t1: L.MIN_T1 }, { ...HTLC, t1: L.MAX_T1 }, { ...HTLC, t1: BigInt(T1) }]) {
    const fields = L.parseHtlcScript(L.htlcScript(h));
    check(['tag', 'hash', 'seller', 'buyer'].every((k) => hex(fields[k]) === hex(h[k])) && fields.t1 === Number(h.t1), `parse gives back the fields, t1 ${h.t1}`);
  }
  const bent = (at, value) => {
    const s = script.slice();
    s[at] = value;
    return s;
  };
  const timeAt = 33 + 1 + 1 + 3 + 1 + 1 + 33 + 1 + 34 + 1 + 1 + 1;
  check(script[timeAt] === 4, 'the T1 push is where it should be');
  for (const [s, what] of [
    [bent(33, 0x76), 'OP_DUP for OP_DROP'], [bent(34, 0x64), 'OP_NOTIF'], [bent(37, 0x21), 'a size other than 32'],
    [bent(timeAt + 5, 0xb2), 'OP_CHECKSEQUENCEVERIFY for OP_CHECKLOCKTIMEVERIFY'], [bent(script.length - 1, 0x67), 'no last OP_ENDIF'],
    [script.subarray(0, -1), 'a byte short'], [Uint8Array.from([...script, 0x51]), 'a byte more'],
    [unhex(assembled(HTLC).replace(`21${hex(HTLC.seller)}ad`, `21${hex(HTLC.buyer)}ad`)), 'another key in the release branch'],
    [unhex(assembled(HTLC).replace(`04${hex(L.scriptNum(T1))}b1`, `05${hex(L.scriptNum(T1))}00b1`)), 'T1 not minimally encoded'],
    [unhex(assembled(HTLC).replace('820120', '824c0120')), '32 pushed with OP_PUSHDATA1'],
  ]) {
    throws(() => L.parseHtlcScript(s), /not the lock's script/, `parse refuses ${what}`);
  }
  check(L.parseHtlcScript(bent(5, script[5] ^ 1)).tag[4] === (tag[4] ^ 1), 'another tag is still a lock');
  for (const [h, why, what] of [
    [{ ...HTLC, t1: L.MIN_T1 - 1 }, /T1/, 'a T1 that nLockTime reads as a height'],
    [{ ...HTLC, t1: L.MAX_T1 + 1 }, /T1/, 'a T1 past 32 bits'],
    [{ ...HTLC, t1: T1 + 0.5 }, /T1/, 'a T1 that is not whole'],
    [{ ...HTLC, buyer: unhex(ecdh(big(hex(BUYER))).getPublicKey('hex', 'uncompressed')) }, /buyer's key is not 33 bytes/, 'an uncompressed key'],
    [{ ...HTLC, seller: unhex(`02${be(5n)}`) }, /seller's key/, 'a key off the curve'],
    [{ ...HTLC, hash: HTLC.hash.subarray(1) }, /hash is not 32 bytes/, 'a short hash'],
    [{ ...HTLC, tag: undefined }, /tag is not 32 bytes/, 'no tag'],
  ]) {
    throws(() => L.htlcScript(h), why, `the script refuses ${what}`);
  }

  for (const [net, hrp] of [['mainnet', 'ltc'], ['testnet', 'tltc'], ['regtest', 'rltc']]) {
    const out = L.lockOutput(HTLC, net);
    check(hex(out.script) === hex(script), `${net}: the script`);
    check(hex(out.scriptPubKey) === `0020${hex(sha(script))}`, `${net}: the output is P2WSH of the script`);
    check(out.address.startsWith(`${hrp}1q`) && hex(L.decodeSegwit(hrp, out.address).program) === hex(sha(script)), `${net}: the address, ${out.address.slice(0, 16)}…`);
    check(hex(L.addressToScript(out.address, net)) === hex(out.scriptPubKey), `${net}: the address pays the output`);
  }

  const lockBytes = L.encodeTakeLock({ txid: LOCK_TXID, vout: VOUT, buyer: HTLC.buyer });
  check(hex(lockBytes) === `01${LOCK_TXID}01000000${hex(HTLC.buyer)}`, 'the take\'s lock bytes: 01 ‖ txid ‖ u32 vout ‖ buyer');
  const lock = L.decodeTakeLock(lockBytes);
  check(lock.txid === LOCK_TXID && lock.vout === VOUT && hex(lock.buyer) === hex(HTLC.buyer), 'and read back');
  check(hex(L.encodeTakeLock({ txid: unhex(LOCK_TXID), vout: VOUT, buyer: HTLC.buyer })) === hex(lockBytes), 'a txid as bytes is the same');
  throws(() => L.decodeTakeLock(Uint8Array.from([2, ...lockBytes.subarray(1)])), /version 2/, 'lock bytes of version 2');
  throws(() => L.decodeTakeLock(lockBytes.subarray(0, -1)), /truncated/, 'lock bytes a byte short');
  throws(() => L.decodeTakeLock(Uint8Array.from([...lockBytes, 0])), /trailing/, 'lock bytes a byte long');
  throws(() => L.decodeTakeLock(unhex(`01${LOCK_TXID}01000000${hex(HTLC.buyer).replace(/^0[23]/, '04')}`)), /buyer's key/, 'lock bytes with a bad key');
  throws(() => L.encodeTakeLock({ txid: LOCK_TXID.slice(2), vout: VOUT, buyer: HTLC.buyer }), /txid/, 'a short txid');
  throws(() => L.encodeTakeLock({ txid: LOCK_TXID, vout: -1, buyer: HTLC.buyer }), /u32/, 'a negative vout');

  const signature = unhex('3006020101020101');
  const release = L.encodeRelease({ txid: LOCK_TXID, vout: VOUT, signature });
  check(hex(release) === `01${LOCK_TXID}0100000008000000${hex(signature)}`, 'the release data: 01 ‖ txid ‖ u32 vout ‖ Bytes(signature)');
  const back = L.decodeRelease(release);
  check(back.txid === LOCK_TXID && back.vout === VOUT && hex(back.signature) === hex(signature), 'and read back');
  throws(() => L.decodeRelease(Uint8Array.from([...release, 0])), /trailing/, 'release data a byte long');
  throws(() => L.decodeRelease(Uint8Array.from([0, ...release.subarray(1)])), /version 0/, 'release data of version 0');

  const out = { value: 123_456, script: L.addressToScript('rltc1q3kquwp848h4juq7rl5q3wqsr29pd3d6wprzz8k', 'regtest') };
  const signedClaim = L.encodeSignedClaim({ txid: LOCK_TXID, vout: VOUT, out, signature });
  check(hex(signedClaim) === `02${LOCK_TXID}0100000040e201000000000016000000${hex(out.script)}08000000${hex(signature)}`, 'the signed claim: 02 ‖ txid ‖ u32 vout ‖ u64 value ‖ Bytes(script) ‖ Bytes(signature)');
  const claimBack = L.decodeSignedClaim(signedClaim);
  check(claimBack.txid === LOCK_TXID && claimBack.vout === VOUT && claimBack.out.value === 123_456 && hex(claimBack.out.script) === hex(out.script) && hex(claimBack.signature) === hex(signature), 'and read back');
  throws(() => L.decodeRelease(signedClaim), /version 2/, 'a signed claim is no release');
  throws(() => L.decodeSignedClaim(release), /version 1/, 'a release is no signed claim');
  throws(() => L.decodeSignedClaim(Uint8Array.from([...signedClaim, 0])), /trailing/, 'a signed claim a byte long');
  throws(() => L.decodeSignedClaim(signedClaim.subarray(0, -1)), /truncated/, 'a signed claim a byte short');
  throws(() => L.decodeSignedClaim(unhex(`02${LOCK_TXID}010000000100000000000000020000006a0008000000${hex(signature)}`)), /standard output/, 'a signed claim to a script with no address');
  throws(() => L.decodeSignedClaim(unhex(`02${LOCK_TXID}01000000000000000000000016000000${hex(out.script)}08000000${hex(signature)}`)), /not an amount/, 'a signed claim of nothing');
  throws(() => L.decodeSignedClaim(unhex(`02${LOCK_TXID}01000000ffffffffffffffff16000000${hex(out.script)}08000000${hex(signature)}`)), /not an amount/, 'a signed claim of more than there is');
  throws(() => L.encodeSignedClaim({ txid: LOCK_TXID, vout: VOUT, out: { value: 1, script: unhex('6a00') }, signature }), /standard output/, 'no signed claim to a script with no address');
  throws(() => L.encodeSignedClaim({ txid: LOCK_TXID, vout: VOUT, out, signature: new Uint8Array(0) }), /no signature/, 'no signed claim without a signature');
});

group('spending the lock', () => {
  const { scriptPubKey } = L.lockOutput(HTLC, 'regtest');
  const program = scriptPubKey.subarray(2);
  const to = 'rltc1q3kquwp848h4juq7rl5q3wqsr29pd3d6wprzz8k';
  const lock = { txid: LOCK_TXID, vout: VOUT, value: VALUE, htlc: HTLC, to, feeRate: 2, network: 'regtest' };
  const script = L.htlcScript(HTLC);

  /** The shape every spend shares, its fee, and that the interpreter takes it. */
  const common = (built, name, { version = 2, locktime, sequence, items, rate = 2 }) => {
    const tx = L.parseTx(built.hex);
    check(hex(L.serializeTx(built.tx)) === built.hex && L.txid(tx) === built.txid, `${name}: hex and txid agree`);
    check(tx.version === version && tx.locktime === locktime, `${name}: version ${version}, nLockTime ${locktime}`);
    check(tx.inputs.length === 1 && tx.inputs[0].txid === LOCK_TXID && tx.inputs[0].vout === VOUT && tx.inputs[0].sequence === sequence, `${name}: spends the lock, nSequence ${sequence.toString(16)}`);
    check(tx.inputs[0].scriptSig.length === 0, `${name}: no scriptSig`);
    check(tx.inputs[0].witness.length === items && hex(tx.inputs[0].witness[items - 1]) === hex(script), `${name}: ${items} witness items, the script last`);
    check(tx.outputs.length === 1 && hex(tx.outputs[0].script) === hex(L.addressToScript(to, 'regtest')), `${name}: one output, to the address`);
    check(tx.outputs[0].value + built.fee === VALUE, `${name}: output and fee make the lock's value`);
    check(built.vsize === L.vsize(tx) && built.fee >= Math.ceil(built.vsize * rate) && built.fee <= Math.ceil((built.vsize + 1) * rate), `${name}: a fee of ${built.fee} for ${built.vsize} vbytes at ${rate} a vbyte`);
    const why = run(tx, 0, VALUE, program);
    check(why === null, `${name}: the script runs${why ? ` (${why})` : ''}`);
    return tx;
  };
  /** Whether OpenSSL takes witness item `at` as the signature of `key`, over this file's own preimage. */
  const signs = (tx, at, key, type) => {
    const sig = tx.inputs[0].witness[at];
    return sig[sig.length - 1] === type && derParts(sig.subarray(0, -1)).s <= HALF
      && openssl(sha(preimage143(tx, 0, script, VALUE, type)), sig.subarray(0, -1), key);
  };

  const claim = L.claimTx({ ...lock, secret: SECRET, key: SELLER });
  const claimed = common(claim, 'claim', { locktime: 0, sequence: 0xffffffff, items: 4 });
  const w = claimed.inputs[0].witness;
  check(hex(w[1]) === hex(SECRET) && hex(w[2]) === '01', 'claim: sig(seller) ‖ secret ‖ 01 ‖ script');
  check(signs(claimed, 0, HTLC.seller, 1), 'claim: the seller signs SIGHASH_ALL, as OpenSSL checks');
  check(hex(L.secretFromWitness(claim.hex)) === hex(SECRET) && hex(L.secretFromWitness(claimed, HTLC.hash)) === hex(SECRET), 'claim: the secret is found in its witness');
  check(L.secretFromWitness(claimed, sha('another hash')) === null, 'claim: not for another hash');
  const wrongSecret = structuredClone(claimed);
  wrongSecret.inputs[0].witness[1] = sha('a guess');
  check(run(wrongSecret, 0, VALUE, program) === 'EQUALVERIFY failed', 'claim: another secret fails the script');
  const otherOutput = structuredClone(claimed);
  otherOutput.outputs[0].value -= 1;
  check(run(otherOutput, 0, VALUE, program) === 'NULLFAIL', 'claim: a changed output fails the signature');

  const refund = L.refundTx({ ...lock, key: BUYER });
  const refunded = common(refund, 'refund', { locktime: T1, sequence: 0xfffffffe, items: 4 });
  check(hex(refunded.inputs[0].witness[1]) === '01' && refunded.inputs[0].witness[2].length === 0, 'refund: sig(buyer) ‖ 01 ‖ (empty) ‖ script');
  check(signs(refunded, 0, HTLC.buyer, 1), 'refund: the buyer signs SIGHASH_ALL, as OpenSSL checks');
  check(L.secretFromWitness(refunded) === null, 'refund: no secret');
  const early = structuredClone(refunded);
  early.locktime = T1 - 1;
  check(run(early, 0, VALUE, program) === 'locktime not reached', 'refund: an nLockTime before T1 fails the script');
  const final = structuredClone(refunded);
  final.inputs[0].sequence = 0xffffffff;
  check(run(final, 0, VALUE, program) === 'a final input cannot check a locktime', 'refund: a final nSequence fails the script');
  const height = structuredClone(refunded);
  height.locktime = 800_000;
  check(run(height, 0, VALUE, program) === 'locktime of another kind', 'refund: an nLockTime in blocks fails the script');

  const sellerSignature = L.releaseSignature({ txid: LOCK_TXID, vout: VOUT, value: VALUE, htlc: HTLC, key: SELLER });
  check(sellerSignature[sellerSignature.length - 1] === 0x82, 'release: the seller signs NONE|ANYONECANPAY');
  const sellerOk = (sig, changes = {}) => L.verifyReleaseSignature({ txid: LOCK_TXID, vout: VOUT, value: VALUE, htlc: HTLC, signature: sig, ...changes });
  check(sellerOk(sellerSignature), 'release: the buyer\'s page takes the seller\'s signature');
  check(!sellerOk(sellerSignature, { vout: 0 }), 'release: not for another output');
  check(!sellerOk(sellerSignature, { value: VALUE - 1 }), 'release: not for another value');
  check(!sellerOk(sellerSignature, { txid: hex(sha('another')) }), 'release: not for another transaction');
  check(!sellerOk(sellerSignature, { htlc: { ...HTLC, t1: T1 + 1 } }), 'release: not for another lock');
  check(!sellerOk(Uint8Array.from([...sellerSignature.subarray(0, -1), 1])), 'release: not with another sighash byte');
  const { r, s } = S.parseDer(sellerSignature.subarray(0, -1));
  check(!sellerOk(Uint8Array.from([...S.encodeDer(r, S.N - s), 0x82])), 'release: not with a high S');
  check(!sellerOk(new Uint8Array(0)) && !sellerOk(Uint8Array.of(0x82)), 'release: not an empty signature');
  const release = L.releaseTx({ ...lock, key: BUYER, signature: sellerSignature });
  const released = common(release, 'release', { locktime: 0, sequence: 0xffffffff, items: 5 });
  const rw = released.inputs[0].witness;
  check(hex(rw[1]) === hex(sellerSignature) && rw[2].length === 0 && rw[3].length === 0, 'release: sig(buyer) ‖ sig(seller) ‖ (empty) ‖ (empty) ‖ script');
  check(signs(released, 0, HTLC.buyer, 1), 'release: the buyer signs SIGHASH_ALL, as OpenSSL checks');
  check(signs(released, 1, HTLC.seller, 0x82), 'release: the seller\'s NONE|ANYONECANPAY, as OpenSSL checks');
  // The seller's signature holds whatever the outputs, and beside other inputs; not with another version.
  const elsewhere = structuredClone(released);
  elsewhere.inputs.unshift({ txid: hex(sha('other')), vout: 3, scriptSig: new Uint8Array(0), sequence: 0xffffffff, witness: [] });
  elsewhere.outputs = [{ value: 5, script: unhex('6a00') }, { value: 6, script: unhex('51') }];
  check(openssl(sha(preimage143(elsewhere, 1, script, VALUE, 0x82)), sellerSignature.subarray(0, -1), HTLC.seller), 'release: the seller\'s signature holds for other outputs and inputs');
  check(!openssl(sha(preimage143({ ...elsewhere, version: 1 }, 1, script, VALUE, 0x82)), sellerSignature.subarray(0, -1), HTLC.seller), 'release: but not for version 1');
  const swapped = structuredClone(released);
  [swapped.inputs[0].witness[0], swapped.inputs[0].witness[1]] = [rw[1], rw[0]];
  check(run(swapped, 0, VALUE, program) !== null, 'release: the signatures swapped fail the script');
  throws(() => L.releaseTx({ ...lock, key: BUYER, signature: L.releaseSignature({ ...lock, vout: 0, key: SELLER }) }), /does not release/, 'release: a signature for another output is refused');
  throws(() => L.releaseTx({ ...lock, key: BUYER, signature: Uint8Array.from([...sellerSignature.subarray(0, -1), 1]) }), /does not release/, 'release: a signature of another type is refused');

  // Other destinations, fee rates and networks.
  for (const [address, net] of [
    ['ltc1ppu2gv0tujus0f6eggrk7eqmaf0567x6zer4fcuhz4z7ztzq9u9yseqxltc', 'mainnet'], ['MHrYRxAiMNBTku3eoDHwhA1LQGDjUStZW2', 'mainnet'],
    ['mwXn5Vhicdav8Av3KMokx4YNuHoGRKxtWs', 'testnet'], ['tltc1q9awqm4ah2lmettm3hnhgqtssvz527jxglxxshkt75l0ygdl3vlyqy5739f', 'testnet'],
  ]) {
    const built = L.claimTx({ ...lock, to: address, network: net, feeRate: 1.5, secret: SECRET, key: SELLER });
    const tx = L.parseTx(built.hex);
    const fees = [Math.ceil(built.vsize * 1.5), Math.ceil((built.vsize + 1) * 1.5)];
    check(hex(tx.outputs[0].script) === hex(L.addressToScript(address, net)) && fees.includes(built.fee), `claim to ${address.slice(0, 12)}… at 1.5 a vbyte`);
    check(run(tx, 0, VALUE, program) === null, `claim to ${address.slice(0, 12)}…: the script runs`);
  }
  const toScript = L.claimTx({ ...lock, to: L.addressToScript(to, 'regtest'), secret: SECRET, key: SELLER });
  check(toScript.hex === claim.hex, 'an output script for the address makes the same claim');

  throws(() => L.claimTx({ ...lock, secret: SECRET, key: BUYER }), /seller key/, 'a claim with the buyer\'s key');
  throws(() => L.claimTx({ ...lock, secret: sha('a guess'), key: SELLER }), /does not hash/, 'a claim with another secret');
  throws(() => L.refundTx({ ...lock, key: SELLER }), /buyer key/, 'a refund with the seller\'s key');
  throws(() => L.releaseSignature({ ...lock, key: BUYER }), /seller key/, 'a release signature with the buyer\'s key');
  throws(() => L.releaseTx({ ...lock, key: SELLER, signature: sellerSignature }), /buyer key/, 'a release with the seller\'s key');
  throws(() => L.claimTx({ ...lock, value: 3000, secret: SECRET, key: SELLER }), /dust limit of 2940/, 'what is left below dust');
  throws(() => L.claimTx({ ...lock, value: 300, secret: SECRET, key: SELLER }), /takes the whole lock/, 'a fee that takes it all');
  throws(() => L.claimTx({ ...lock, feeRate: 0.5, secret: SECRET, key: SELLER }), /fee rate/, 'a fee rate below 1');
  throws(() => L.claimTx({ ...lock, feeRate: Number.NaN, secret: SECRET, key: SELLER }), /fee rate/, 'no fee rate');
  throws(() => L.claimTx({ ...lock, value: 0, secret: SECRET, key: SELLER }), /not an amount/, 'a lock of nothing');
  throws(() => L.claimTx({ ...lock, value: 1.5, secret: SECRET, key: SELLER }), /not an amount/, 'a fraction of a litoshi');
  throws(() => L.claimTx({ ...lock, network: 'mainnet', secret: SECRET, key: SELLER }), /regtest address, not mainnet/, 'an address of another network');
  throws(() => L.claimTx({ ...lock, to: unhex('6a00'), secret: SECRET, key: SELLER }), /pay to/, 'an output script with no address');
  throws(() => L.claimTx({ ...lock, htlc: { ...HTLC, t1: 5 }, secret: SECRET, key: SELLER }), /T1/, 'a lock that is not one');
  const low = L.claimTx({ ...lock, value: 3000 + 2000, secret: SECRET, key: SELLER });
  check(L.parseTx(low.hex).outputs[0].value >= 2940, 'just above dust is fine');

  // The seller's claim signed ahead, before anyone but the buyer knows the secret, and finished by whoever does.
  const OTHER_SCRIPT = L.witnessOutput(0, sha('another payout').subarray(0, 20));
  const ahead = L.signClaim({ ...lock, key: SELLER });
  check(ahead.txid === LOCK_TXID && ahead.vout === VOUT && hex(ahead.out.script) === hex(L.addressToScript(to, 'regtest')) && ahead.out.value + ahead.fee === VALUE, 'signed claim: the lock, one output to the address, and the fee');
  check(ahead.claim === claim.txid, 'signed claim: the claim\'s txid, known before the secret is in');
  check(L.encodeSignedClaim(ahead).length <= 256, 'signed claim: its release data fits the program\'s 256 bytes');
  const claimOk = (changes = {}) => L.verifyClaimSignature({ txid: LOCK_TXID, vout: VOUT, value: VALUE, htlc: HTLC, out: ahead.out, signature: ahead.signature, ...changes });
  check(claimOk(), 'signed claim: the signature checks');
  check(!claimOk({ vout: 0 }), 'signed claim: not for another output');
  check(!claimOk({ value: VALUE - 1 }), 'signed claim: not for another value');
  check(!claimOk({ txid: hex(sha('another')) }), 'signed claim: not for another transaction');
  check(!claimOk({ htlc: { ...HTLC, t1: T1 + 1 } }), 'signed claim: not for another lock');
  check(!claimOk({ htlc: { ...HTLC, seller: HTLC.buyer } }), 'signed claim: not as another seller');
  check(!claimOk({ out: { ...ahead.out, value: ahead.out.value + 1 } }), 'signed claim: not for more out');
  check(!claimOk({ out: { ...ahead.out, script: OTHER_SCRIPT } }), 'signed claim: not to another address');
  check(!claimOk({ out: { ...ahead.out, value: VALUE } }), 'signed claim: not with no fee');
  check(!claimOk({ out: { ...ahead.out, script: unhex('6a00') } }), 'signed claim: not to a script with no address');
  check(!claimOk({ signature: Uint8Array.from([...ahead.signature.subarray(0, -1), 0x82]) }), 'signed claim: not with another sighash byte');
  const parts = S.parseDer(ahead.signature.subarray(0, -1));
  check(!claimOk({ signature: Uint8Array.from([...S.encodeDer(parts.r, S.N - parts.s), 1]) }), 'signed claim: not with a high S');
  check(!claimOk({ signature: L.releaseSignature({ ...lock, key: SELLER }) }), 'signed claim: a release signature is none');
  check(!claimOk({ signature: new Uint8Array(0) }) && !claimOk({ signature: Uint8Array.of(1) }), 'signed claim: not an empty signature');

  const finished = L.finishClaim({ txid: LOCK_TXID, vout: VOUT, value: VALUE, htlc: HTLC, out: ahead.out, signature: ahead.signature, secret: SECRET });
  check(finished.hex === claim.hex && finished.txid === claim.txid && finished.fee === claim.fee, 'signed claim, finished with the secret: byte for byte claimTx\'s claim');
  common(finished, 'finished claim', { locktime: 0, sequence: 0xffffffff, items: 4 });
  const posted = L.decodeSignedClaim(L.encodeSignedClaim(ahead));
  const fromTing = L.finishClaim({ txid: posted.txid, vout: posted.vout, value: VALUE, htlc: HTLC, out: posted.out, signature: posted.signature, secret: SECRET });
  check(fromTing.hex === claim.hex, 'signed claim: read back from its release data, the same claim');
  throws(() => L.finishClaim({ txid: LOCK_TXID, vout: VOUT, value: VALUE, htlc: HTLC, out: ahead.out, signature: ahead.signature, secret: sha('a guess') }), /does not hash/, 'finishing with another secret');
  throws(() => L.finishClaim({ txid: LOCK_TXID, vout: VOUT, value: VALUE, htlc: HTLC, out: { ...ahead.out, value: ahead.out.value + 1 }, signature: ahead.signature, secret: SECRET }), /does not sign/, 'finishing with another output');
  throws(() => L.signClaim({ ...lock, key: BUYER }), /seller key/, 'a signed claim with the buyer\'s key');

  // The same signature in the release branch, beside the buyer's: it signs only this transaction, so it still pays only the seller.
  const branch = structuredClone(finished.tx);
  branch.inputs[0].witness = [Uint8Array.from([...S.sign(BUYER, L.sighash(branch, 0, script, VALUE, 1)), 1]), ahead.signature, new Uint8Array(0), new Uint8Array(0), script];
  check(run(branch, 0, VALUE, program) === null, 'signed claim: in the release branch beside the buyer\'s signature, it spends the lock to the seller\'s output');
  const redirected = structuredClone(branch);
  redirected.outputs[0].script = OTHER_SCRIPT;
  redirected.inputs[0].witness[0] = Uint8Array.from([...S.sign(BUYER, L.sighash(redirected, 0, script, VALUE, 1)), 1]);
  check(run(redirected, 0, VALUE, program) !== null, 'signed claim: but to any other output it fails');
});

group('refunding several locks at once', () => {
  const to = 'rltc1q3kquwp848h4juq7rl5q3wqsr29pd3d6wprzz8k';
  // Three locks of the buyer's: the real one, one with another seller and a later T1,
  // and a dust output at the real address.
  const OTHER = keyOf('another seller');
  const second = { ...HTLC, seller: S.publicKey(OTHER), t1: T1 + 3600 };
  const inputs = [
    { txid: LOCK_TXID, vout: VOUT, value: VALUE, htlc: HTLC },
    { txid: hex(sha('a second lock')), vout: 2, value: 250_000, htlc: second },
    { txid: hex(sha('a dust output')), vout: 0, value: 3300, htlc: HTLC },
  ];
  const programOf = (h) => L.lockOutput(h, 'regtest').scriptPubKey.subarray(2);
  /** OpenSSL's verdict on input `i`'s first witness item, over this file's own preimage. */
  const signsInput = (tx, i, value, h, key) => {
    const sig = tx.inputs[i].witness[0];
    return sig[sig.length - 1] === 1 && derParts(sig.subarray(0, -1)).s <= HALF
      && openssl(sha(preimage143(tx, i, L.htlcScript(h), value, 1)), sig.subarray(0, -1), key);
  };
  const shape = (built, name, { locktime, rate }) => {
    const tx = L.parseTx(built.hex);
    check(hex(L.serializeTx(built.tx)) === built.hex && L.txid(tx) === built.txid, `${name}: hex and txid agree`);
    check(tx.version === 2 && tx.locktime === locktime, `${name}: version 2, nLockTime ${locktime}`);
    check(tx.inputs.length === built.spent.length && tx.inputs.every((input, i) => input.txid === built.spent[i].txid && input.vout === built.spent[i].vout && input.sequence === 0xfffffffe && !input.scriptSig.length), `${name}: ${tx.inputs.length} inputs, nSequence fffffffe, no scriptSig`);
    const total = built.spent.reduce((n, s) => n + s.value, 0);
    check(tx.outputs.length === 1 && tx.outputs[0].value === total - built.fee && built.value === total - built.fee && hex(tx.outputs[0].script) === hex(L.addressToScript(to, 'regtest')), `${name}: one output of the inputs less the fee`);
    check(built.vsize === L.vsize(tx) && built.fee >= Math.ceil(built.vsize * rate) && built.fee <= Math.ceil((built.vsize + tx.inputs.length) * rate), `${name}: a fee of ${built.fee} for ${built.vsize} vbytes at ${rate} a vbyte`);
    return tx;
  };

  const refund = L.refundAllTx({ inputs, key: BUYER, to, feeRate: 2, network: 'regtest' });
  const refunded = shape(refund, 'refund of three', { locktime: T1 + 3600, rate: 2 });
  check(refund.spent.length === 3 && refund.skipped.length === 0, 'refund of three: all three inputs, the dust one too at 2 a vbyte');
  inputs.forEach((lock, i) => {
    const why = run(refunded, i, lock.value, programOf(lock.htlc));
    check(why === null, `refund of three: input ${i} runs its own script${why ? ` (${why})` : ''}`);
    check(signsInput(refunded, i, lock.value, lock.htlc, HTLC.buyer), `refund of three: input ${i} signed SIGHASH_ALL by the buyer, as OpenSSL checks`);
    check(hex(refunded.inputs[i].witness[1]) === '01' && refunded.inputs[i].witness[2].length === 0, `refund of three: input ${i} is sig ‖ 01 ‖ (empty) ‖ script`);
  });
  const moved = structuredClone(refunded);
  moved.outputs[0].value -= 1;
  check(run(moved, 0, VALUE, programOf(HTLC)) === 'NULLFAIL', 'refund of three: a changed output fails every signature');
  check(run(refunded, 1, inputs[0].value, programOf(second)) === 'NULLFAIL', 'refund of three: each input signs its own value');
  const early = structuredClone(refunded);
  early.locktime = T1 + 3599;
  check(run(early, 1, inputs[1].value, programOf(second)) === 'locktime not reached', 'refund of three: before the latest T1, the latest lock fails');
  check(L.secretFromWitness(refund.hex) === null, 'refund of three: no secret');

  // At a high fee rate, an input worth less than it adds to the fee is left out.
  const dear = L.refundAllTx({ inputs, key: BUYER, to, feeRate: 30, network: 'regtest' });
  check(dear.spent.length === 2 && dear.skipped.length === 1 && dear.skipped[0].value === 3300, 'refund at 30 a vbyte: the 3,300 litoshi output is skipped');
  const dearTx = shape(dear, 'refund at 30', { locktime: T1 + 3600, rate: 30 });
  check(run(dearTx, 0, VALUE, programOf(HTLC)) === null && run(dearTx, 1, 250_000, programOf(second)) === null, 'refund at 30: both inputs run');
  const dustFirst = L.refundAllTx({ inputs: [inputs[2], inputs[0]], key: BUYER, to, feeRate: 2, network: 'regtest' });
  check(dustFirst.spent[0].value === 3300 && dustFirst.spent[1].value === VALUE, 'dust first: still one transaction with both');
  check(L.refundAllTx({ inputs: [inputs[0]], key: BUYER, to, feeRate: 2, network: 'regtest' }).hex === L.refundTx({ ...inputs[0], key: BUYER, to, feeRate: 2, network: 'regtest' }).hex, 'one input: the same transaction as refundTx');

  throws(() => L.refundAllTx({ inputs: [inputs[2]], key: BUYER, to, feeRate: 30, network: 'regtest' }), /less than the fee/, 'only dust: nothing to pay out');
  throws(() => L.refundAllTx({ inputs: [inputs[0], { ...inputs[0] }], key: BUYER, to, feeRate: 2, network: 'regtest' }), /named twice/, 'the same output twice');
  throws(() => L.refundAllTx({ inputs: [], key: BUYER, to, feeRate: 2, network: 'regtest' }), /no lock/, 'no input');
  throws(() => L.refundAllTx({ inputs: [inputs[0], { ...inputs[1], htlc: { ...second, buyer: S.publicKey(OTHER) } }], key: BUYER, to, feeRate: 2, network: 'regtest' }), /buyer key/, 'a lock of another buyer');
  throws(() => L.refundAllTx({ inputs, key: BUYER, to, feeRate: Number.NaN, network: 'regtest' }), /fee rate/, 'no fee rate');
});

console.log(`${checks} checks, ${failures} failed`);
process.exit(failures ? 1 : 0);
