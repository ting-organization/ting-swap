// Litecoin, as the page needs it for the other side of a swap (HTLC.md, "The
// Litecoin side"): addresses, the lock's witness script and its P2WSH
// address, the take's lock bytes and the release data, and the transactions
// that spend the lock, built and signed here.
//
// Amounts are litoshi (10⁻⁸ LTC) as Numbers: all 84,000,000 LTC fit a double
// exactly. A txid is 64 hex digits in the order explorers show it. Byte
// strings are Uint8Arrays; private keys are 32 bytes or a bigint, as
// secp256k1.js takes them. A network is 'mainnet', 'testnet' or 'regtest'.
import { concat, equal, framed, hex, Reader, u32, u64, unhex } from './bytes.js';
import * as secp from './secp256k1.js';
import { sha256 } from './sha256.js';
import { H } from './ting.js';

const EMPTY = new Uint8Array(0);
const dsha256 = (bytes) => sha256(sha256(bytes));
const reversed = (bytes) => bytes.slice().reverse();

// ---- Networks --------------------------------------------------------------

/**
 * Litecoin's networks: the bech32 prefix and the base58 version bytes of
 * P2PKH and P2SH addresses. P2SH addresses are made with `p2sh`; `p2shLegacy`,
 * Bitcoin's, is still read.
 */
export const NETWORKS = {
  mainnet: { name: 'mainnet', hrp: 'ltc', p2pkh: 0x30, p2sh: 0x32, p2shLegacy: 0x05 },
  testnet: { name: 'testnet', hrp: 'tltc', p2pkh: 0x6f, p2sh: 0x3a, p2shLegacy: 0xc4 },
  regtest: { name: 'regtest', hrp: 'rltc', p2pkh: 0x6f, p2sh: 0x3a, p2shLegacy: 0xc4 },
};

/** A network of NETWORKS, by name or itself. */
export function networkOf(net = 'mainnet') {
  const found = typeof net === 'string' ? NETWORKS[net] : net;
  if (!found?.hrp) throw new Error(`no Litecoin network ${net}`);
  return found;
}

// ---- Base58 ----------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58, with a '1' for each leading zero byte. */
export function base58(bytes) {
  let out = '';
  for (let v = secp.toBig(bytes); v > 0n; v /= 58n) out = B58[Number(v % 58n)] + out;
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = `1${out}`;
  return out;
}

/** The bytes of a base58 string; throws on a character outside the alphabet. */
export function unbase58(text) {
  let v = 0n;
  for (const c of text) {
    const d = B58.indexOf(c);
    if (d < 0) throw new Error(`"${c}" is not a base58 character`);
    v = v * 58n + BigInt(d);
  }
  const body = [];
  for (; v > 0n; v >>= 8n) body.unshift(Number(v & 0xffn));
  let zeros = 0;
  while (text[zeros] === '1') zeros++;
  return concat(new Uint8Array(zeros), Uint8Array.from(body));
}

/** Base58 of `payload ‖ the first 4 bytes of its double SHA-256`. */
export const base58check = (payload) => base58(concat(payload, dsha256(payload).subarray(0, 4)));

/** The payload of a base58check string; throws when its checksum is wrong. */
export function unbase58check(text) {
  const bytes = unbase58(text);
  if (bytes.length < 4) throw new Error('too short for a checksum');
  const payload = bytes.subarray(0, -4);
  if (!equal(dsha256(payload).subarray(0, 4), bytes.subarray(-4))) throw new Error('the checksum is wrong');
  return payload;
}

// ---- Bech32 and segwit addresses (BIP 173, BIP 350) ------------------------

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const CONSTANT = { bech32: 1, bech32m: 0x2bc830a3 };

function polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
}

const expand = (hrp) => {
  const codes = [...hrp].map((c) => c.charCodeAt(0));
  return [...codes.map((c) => c >> 5), 0, ...codes.map((c) => c & 31)];
};

/** A bech32 or bech32m string (`variant`) of the prefix `hrp` and 5-bit values `data`. */
export function encodeBech32(hrp, data, variant = 'bech32') {
  if (!(variant in CONSTANT)) throw new Error(`no checksum ${variant}`);
  if (!/^[\x21-\x7e]{1,83}$/.test(hrp) || hrp !== hrp.toLowerCase()) throw new Error(`the prefix ${hrp}`);
  if (data.some((d) => !(d >= 0 && d < 32))) throw new Error('bech32 data is 5-bit values');
  const mod = polymod([...expand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ CONSTANT[variant];
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((d) => CHARSET[d]).join('')}`;
}

/**
 * `{ hrp, data, variant }` of a bech32 or bech32m string at most `limit`
 * characters long: its prefix in lower case, its 5-bit values without the
 * checksum, and which checksum it has. Throws why it is not one.
 */
export function decodeBech32(text, limit = 90) {
  if (typeof text !== 'string') throw new Error('not text');
  if (text.length > limit) throw new Error(`longer than ${limit} characters`);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 33 || code > 126) throw new Error('a character out of range');
  }
  const lower = text.toLowerCase();
  if (lower !== text && text.toUpperCase() !== text) throw new Error('mixed case');
  const at = lower.lastIndexOf('1');
  if (at < 0) throw new Error('no separator');
  if (at === 0) throw new Error('no prefix');
  const hrp = lower.slice(0, at);
  const rest = lower.slice(at + 1);
  if (rest.length < 6) throw new Error('a checksum shorter than 6 characters');
  const data = [...rest].map((c) => {
    const d = CHARSET.indexOf(c);
    if (d < 0) throw new Error(`"${c}" is not a bech32 character`);
    return d;
  });
  const check = polymod([...expand(hrp), ...data]);
  const variant = Object.keys(CONSTANT).find((name) => CONSTANT[name] === check);
  if (!variant) throw new Error('the checksum is wrong');
  return { hrp, data: data.slice(0, -6), variant };
}

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const max = (1 << to) - 1;
  for (const v of data) {
    acc = ((acc << from) | v) & ((1 << (from + to - 1)) - 1);
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & max);
  } else if (bits >= from) {
    throw new Error(`${bits} bits of padding`);
  } else if ((acc << (to - bits)) & max) {
    throw new Error('padding that is not zero');
  }
  return out;
}

function checkWitness(version, program) {
  if (!Number.isInteger(version) || version < 0 || version > 16) throw new Error(`witness version ${version} does not exist`);
  if (program.length < 2 || program.length > 40) throw new Error(`a witness program of ${program.length} bytes`);
  if (version === 0 && program.length !== 20 && program.length !== 32) {
    throw new Error(`a version 0 witness program of ${program.length} bytes, not 20 or 32`);
  }
}

/** A segwit address: version 0 with a bech32 checksum, 1 to 16 with bech32m. */
export function encodeSegwit(hrp, version, program) {
  checkWitness(version, program);
  return encodeBech32(hrp, [version, ...convertBits(program, 8, 5, true)], version === 0 ? 'bech32' : 'bech32m');
}

/** `{ version, program }` of a segwit address with the prefix `hrp`; throws why it is not one. */
export function decodeSegwit(hrp, address) {
  const { hrp: got, data, variant } = decodeBech32(address);
  if (got !== hrp) throw new Error(`the prefix ${got}, not ${hrp}`);
  if (!data.length) throw new Error('no witness version');
  const version = data[0];
  if (version > 16) throw new Error(`witness version ${version} does not exist`);
  const program = Uint8Array.from(convertBits(data.slice(1), 5, 8, false));
  checkWitness(version, program);
  if (variant !== (version === 0 ? 'bech32' : 'bech32m')) throw new Error(`witness version ${version} with a ${variant} checksum`);
  return { version, program };
}

// ---- Addresses and output scripts ------------------------------------------

/** The output script of a witness program: `OP_n ‖ push(program)`. */
export function witnessOutput(version, program) {
  checkWitness(version, program);
  return concat(Uint8Array.of(version ? 0x50 + version : 0, program.length), program);
}

/** The kind of a standard output script: p2pkh, p2sh, p2wpkh, p2wsh, p2tr, or null. */
export function scriptType(script) {
  const s = script;
  const n = s?.length;
  if (n === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 20 && s[23] === 0x88 && s[24] === 0xac) return 'p2pkh';
  if (n === 23 && s[0] === 0xa9 && s[1] === 20 && s[22] === 0x87) return 'p2sh';
  if (n === 22 && s[0] === 0 && s[1] === 20) return 'p2wpkh';
  if (n === 34 && s[0] === 0 && s[1] === 32) return 'p2wsh';
  if (n === 34 && s[0] === 0x51 && s[1] === 32) return 'p2tr';
  return null;
}

const HRPS = Object.values(NETWORKS).map((n) => n.hrp);

/**
 * The output script an address on `net` pays: P2PKH, P2SH (either version
 * byte), P2WPKH, P2WSH or P2TR. Throws, saying why, for anything else,
 * including an address of another network and witness versions no Litecoin
 * rule spends yet.
 */
export function addressToScript(address, net = 'mainnet') {
  const n = networkOf(net);
  const text = String(address ?? '').trim();
  if (!text) throw new Error('no address');
  const at = text.lastIndexOf('1');
  const prefix = at > 0 ? text.slice(0, at).toLowerCase() : '';
  if (prefix.endsWith('mweb')) throw new Error('an MWEB address: pay to a regular Litecoin address');
  if (HRPS.includes(prefix)) {
    if (prefix !== n.hrp) {
      throw new Error(`a Litecoin ${Object.values(NETWORKS).find((x) => x.hrp === prefix).name} address, not ${n.name}`);
    }
    let w;
    try {
      w = decodeSegwit(n.hrp, text);
    } catch (e) {
      throw new Error(`not a valid address: ${e.message}`);
    }
    if (w.version === 0 || (w.version === 1 && w.program.length === 32)) return witnessOutput(w.version, w.program);
    throw new Error(`an address of witness version ${w.version} with ${w.program.length} bytes, which no Litecoin rule spends yet: anyone could take coins sent there`);
  }
  let payload;
  try {
    payload = unbase58check(text);
  } catch (e) {
    let bech = null;
    try {
      bech = decodeBech32(text);
    } catch {}
    throw new Error(`not a Litecoin address: ${bech ? `the prefix ${bech.hrp}` : e.message}`);
  }
  if (payload.length !== 21) throw new Error(`not a Litecoin address: ${payload.length} bytes`);
  const [version] = payload;
  const hash = payload.subarray(1);
  if (version === n.p2pkh) return concat(Uint8Array.of(0x76, 0xa9, 20), hash, Uint8Array.of(0x88, 0xac));
  if (version === n.p2sh || version === n.p2shLegacy) return concat(Uint8Array.of(0xa9, 20), hash, Uint8Array.of(0x87));
  const other = Object.values(NETWORKS).filter((x) => [x.p2pkh, x.p2sh, x.p2shLegacy].includes(version));
  if (other.length) throw new Error(`a Litecoin ${other.map((x) => x.name).join(' or ')} address, not ${n.name}`);
  throw new Error(`not a Litecoin address: version byte ${version}`);
}

/** The address of a standard output script on `net`; P2SH with the network's current version byte. */
export function scriptToAddress(script, net = 'mainnet') {
  const n = networkOf(net);
  switch (scriptType(script)) {
    case 'p2pkh': return base58check(concat(Uint8Array.of(n.p2pkh), script.subarray(3, 23)));
    case 'p2sh': return base58check(concat(Uint8Array.of(n.p2sh), script.subarray(2, 22)));
    case 'p2wpkh':
    case 'p2wsh': return encodeSegwit(n.hrp, 0, script.subarray(2));
    case 'p2tr': return encodeSegwit(n.hrp, 1, script.subarray(2));
    default: throw new Error('a script with no address');
  }
}

/** The output script `to` stands for: an address on `net`, or a standard output script itself. */
export function destination(to, net = 'mainnet') {
  if (typeof to === 'string') return addressToScript(to, net);
  if (to instanceof Uint8Array && scriptType(to)) return to.slice();
  throw new Error('pay to an address, or to a P2PKH, P2SH, P2WPKH, P2WSH or P2TR script');
}

/** Litecoin Core's default -dustrelayfee, in litoshi per 1,000 bytes: ten times Bitcoin's. */
export const DUST_RELAY_FEE = 30_000;

/**
 * The least value an output paying `script` may have and still be relayed
 * (Litecoin Core's GetDustThreshold): 2,940 litoshi for P2WPKH, 3,300 for
 * P2WSH and P2TR, 5,400 for P2SH and 5,460 for P2PKH.
 */
export function dustLimit(script) {
  const n = script.length;
  const witness = n >= 4 && n <= 42 && (script[0] === 0 || (script[0] >= 0x51 && script[0] <= 0x60)) && script[1] + 2 === n;
  const spend = witness ? 32 + 4 + 1 + Math.floor(107 / 4) + 4 : 32 + 4 + 1 + 107 + 4;
  return Math.floor(((8 + compactSize(n).length + n + spend) * DUST_RELAY_FEE) / 1000);
}

// ---- Script ----------------------------------------------------------------

/** The opcodes the lock and the standard outputs use. */
export const OP = {
  PUSHDATA1: 0x4c, PUSHDATA2: 0x4d, PUSHDATA4: 0x4e, IF: 0x63, ELSE: 0x67, ENDIF: 0x68, DROP: 0x75,
  DUP: 0x76, EQUAL: 0x87, EQUALVERIFY: 0x88, SIZE: 0x82, SHA256: 0xa8, HASH160: 0xa9, CHECKSIG: 0xac,
  CHECKSIGVERIFY: 0xad, CHECKLOCKTIMEVERIFY: 0xb1,
};

/** A script number, minimally encoded: little-endian magnitude, the sign in the top bit, 0 as no bytes. */
export function scriptNum(value) {
  let v = BigInt(value);
  const negative = v < 0n;
  if (negative) v = -v;
  const out = [];
  for (; v > 0n; v >>= 8n) out.push(Number(v & 0xffn));
  if (out.length && out[out.length - 1] & 0x80) out.push(negative ? 0x80 : 0);
  else if (negative) out[out.length - 1] |= 0x80;
  return Uint8Array.from(out);
}

/** The value of a script number of at most `maxLength` bytes; throws if it is longer or not minimal. */
export function decodeScriptNum(bytes, maxLength = 4) {
  const n = bytes.length;
  if (n > maxLength) throw new Error(`a script number of ${n} bytes, more than ${maxLength}`);
  if (n && (bytes[n - 1] & 0x7f) === 0 && (n === 1 || !(bytes[n - 2] & 0x80))) throw new Error('a script number that is not minimal');
  let v = 0n;
  for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(i === n - 1 ? bytes[i] & 0x7f : bytes[i]);
  return Number(n && bytes[n - 1] & 0x80 ? -v : v);
}

/** The shortest push of `bytes` (as MINIMALDATA wants): OP_0, OP_1 to OP_16, OP_1NEGATE, a direct push or OP_PUSHDATA1/2/4. */
export function pushData(bytes) {
  const n = bytes.length;
  if (n === 0) return Uint8Array.of(0);
  if (n === 1 && bytes[0] >= 1 && bytes[0] <= 16) return Uint8Array.of(0x50 + bytes[0]);
  if (n === 1 && bytes[0] === 0x81) return Uint8Array.of(0x4f);
  if (n <= 75) return concat(Uint8Array.of(n), bytes);
  if (n <= 0xff) return concat(Uint8Array.of(OP.PUSHDATA1, n), bytes);
  if (n <= 0xffff) return concat(Uint8Array.of(OP.PUSHDATA2, n & 0xff, n >> 8), bytes);
  return concat(Uint8Array.of(OP.PUSHDATA4), u32(n), bytes);
}

/** The shortest push of a number. */
export const pushNumber = (value) => pushData(scriptNum(value));

/** A script's operations, `{ op }`, with `data` for a push; throws when a push runs past its end. */
export function decodeScript(script) {
  const ops = [];
  for (let i = 0; i < script.length;) {
    const op = script[i++];
    const width = op === OP.PUSHDATA1 ? 1 : op === OP.PUSHDATA2 ? 2 : op === OP.PUSHDATA4 ? 4 : 0;
    if (op > 75 && !width) {
      ops.push({ op });
      continue;
    }
    if (i + width > script.length) throw new Error('a push past the end of the script');
    let n = op;
    if (width) {
      n = 0;
      for (let j = width - 1; j >= 0; j--) n = n * 256 + script[i + j];
      i += width;
    }
    if (i + n > script.length) throw new Error('a push past the end of the script');
    ops.push({ op, data: script.subarray(i, i + n) });
    i += n;
  }
  return ops;
}

// ---- The lock --------------------------------------------------------------

/** The earliest T1: below 500,000,000, nLockTime and CHECKLOCKTIMEVERIFY count blocks, not seconds. */
export const MIN_T1 = 500_000_000;
/** The latest T1: nLockTime is 32 bits. */
export const MAX_T1 = 0xffffffff;

function checkBytes(bytes, length, what) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error(`${what} is not ${length} bytes`);
}

function checkKey(key, who) {
  checkBytes(key, 33, `the ${who}'s key`);
  try {
    secp.parsePublicKey(key);
  } catch (e) {
    throw new Error(`the ${who}'s key: ${e.message}`);
  }
}

function checkT1(t1) {
  const t = typeof t1 === 'bigint' ? Number(t1) : t1;
  if (!Number.isInteger(t) || t < MIN_T1 || t > MAX_T1) throw new Error(`T1 ${t1} is not a time nLockTime can hold`);
  return t;
}

/** The lock's tag, `H("app/htlc-v1/ltc-lock", program ‖ u64 id ‖ taker)`: the program's ContractId, the listing and the buyer's Ting account. */
export function lockTag(program, id, taker) {
  checkBytes(program, 32, 'the program');
  checkBytes(taker, 32, 'the taker');
  return H('app/htlc-v1/ltc-lock', program, u64(id), taker);
}

/**
 * The lock's witness script, version 1, of `{ tag, hash, seller, buyer, t1 }`:
 * 32-byte tag and hash, 33-byte compressed keys, and T1 a Unix time.
 */
export function htlcScript({ tag, hash, seller, buyer, t1 } = {}) {
  checkBytes(tag, 32, 'the tag');
  checkBytes(hash, 32, 'the hash');
  checkKey(seller, 'seller');
  checkKey(buyer, 'buyer');
  const time = checkT1(t1);
  const op = (...codes) => Uint8Array.from(codes);
  return concat(
    pushData(tag), op(OP.DROP),
    op(OP.IF),
    op(OP.SIZE), pushNumber(32), op(OP.EQUALVERIFY), op(OP.SHA256), pushData(hash), op(OP.EQUALVERIFY), pushData(seller), op(OP.CHECKSIG),
    op(OP.ELSE),
    op(OP.IF),
    pushNumber(time), op(OP.CHECKLOCKTIMEVERIFY, OP.DROP), pushData(buyer), op(OP.CHECKSIG),
    op(OP.ELSE),
    pushData(seller), op(OP.CHECKSIGVERIFY), pushData(buyer), op(OP.CHECKSIG),
    op(OP.ENDIF),
    op(OP.ENDIF),
  );
}

/** `{ tag, hash, seller, buyer, t1 }` of a lock's witness script; throws unless it is exactly the script they make. */
export function parseHtlcScript(script) {
  const fail = (why) => {
    throw new Error(`not the lock's script: ${why}`);
  };
  if (!(script instanceof Uint8Array)) fail('not bytes');
  let ops;
  try {
    ops = decodeScript(script);
  } catch (e) {
    fail(e.message);
  }
  if (ops.length !== 25) fail(`${ops.length} operations, not 25`);
  const [tag, hash, seller, time, buyer] = [0, 7, 9, 13, 16].map((i) => ops[i].data);
  if (!tag || !hash || !seller || !time || !buyer) fail('a push is missing');
  const fields = { tag: tag.slice(), hash: hash.slice(), seller: seller.slice(), buyer: buyer.slice(), t1: 0 };
  try {
    fields.t1 = decodeScriptNum(time, 5);
    if (!equal(htlcScript(fields), script)) fail('it is not the script its fields make');
  } catch (e) {
    fail(e.message.replace(/^not the lock's script: /, ''));
  }
  return fields;
}

/** A P2WSH output for a witness script: `{ scriptPubKey, address }`. */
export function p2wsh(script, net = 'mainnet') {
  const program = sha256(script);
  return { scriptPubKey: witnessOutput(0, program), address: encodeSegwit(networkOf(net).hrp, 0, program) };
}

/** Where the buyer pays: the lock's witness script, its P2WSH output script and its address on `net`. */
export function lockOutput(htlc, net = 'mainnet') {
  const script = htlcScript(htlc);
  return { script, ...p2wsh(script, net) };
}

// ---- The take's lock bytes and the release data ----------------------------

function txidBytes(txid) {
  let bytes = txid;
  if (typeof txid === 'string') {
    if (!/^[0-9a-f]{64}$/i.test(txid)) throw new Error('a txid is 64 hex digits');
    bytes = unhex(txid);
  }
  checkBytes(bytes, 32, 'a txid');
  return bytes;
}

function checkVout(vout) {
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error(`output index ${vout} is not a u32`);
  return vout;
}

/** The take's `lock` bytes: `01 ‖ txid(32, as explorers show it) ‖ u32 vout ‖ buyer(33)`. */
export function encodeTakeLock({ txid, vout, buyer }) {
  checkKey(buyer, 'buyer');
  return concat(Uint8Array.of(1), txidBytes(txid), u32(checkVout(vout)), buyer);
}

/** `{ txid, vout, buyer }` of a take's `lock` bytes, the txid in hex; throws unless they are exactly that, version 1. */
export function decodeTakeLock(bytes) {
  const r = new Reader(bytes);
  const version = r.u8();
  if (version !== 1) throw new Error(`lock bytes of version ${version}, not 1`);
  const lock = { txid: hex(r.take(32)), vout: r.u32(), buyer: r.take(33).slice() };
  r.end();
  checkKey(lock.buyer, 'buyer');
  return lock;
}

/** The release data: `01 ‖ txid(32, as explorers show it) ‖ u32 vout ‖ Bytes(signature)`, the signature with its sighash byte. */
export function encodeRelease({ txid, vout, signature }) {
  if (!(signature instanceof Uint8Array) || !signature.length) throw new Error('no signature');
  return concat(Uint8Array.of(1), txidBytes(txid), u32(checkVout(vout)), framed(signature));
}

/** `{ txid, vout, signature }` of release data; throws unless it is exactly that, version 1. */
export function decodeRelease(bytes) {
  const r = new Reader(bytes);
  const version = r.u8();
  if (version !== 1) throw new Error(`release data of version ${version}, not 1`);
  const release = { txid: hex(r.take(32)), vout: r.u32(), signature: r.bytes().slice() };
  r.end();
  return release;
}

// ---- Transactions ----------------------------------------------------------

/** Litecoin's 84,000,000 LTC in litoshi. */
export const MAX_MONEY = 84_000_000 * 100_000_000;

function compactSize(n) {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  if (n <= 0xffffffff) return concat(Uint8Array.of(0xfe), u32(n));
  return concat(Uint8Array.of(0xff), u64(n));
}

const varBytes = (bytes) => concat(compactSize(bytes.length), bytes);

function readCompactSize(r) {
  const b = r.u8();
  const v = b < 0xfd ? b : b === 0xfd ? r.u16() : b === 0xfe ? r.u32() : Number(r.u64());
  if ((b === 0xfd && v < 0xfd) || (b === 0xfe && v <= 0xffff) || (b === 0xff && v <= 0xffffffff)) throw new Error('a size not in its shortest form');
  if (v > 0x02000000) throw new Error('a size too large');
  return v;
}

function readList(r, item) {
  const n = readCompactSize(r);
  const out = [];
  for (let i = 0; i < n; i++) out.push(item());
  return out;
}

/**
 * A transaction's bytes. A transaction is `{ version, inputs, outputs,
 * locktime }`, an input `{ txid, vout, scriptSig, sequence, witness }` (a
 * list of byte strings) and an output `{ value, script }`. With `witness`
 * false, or when no input has a witness, the legacy form, which the txid
 * hashes.
 */
export function serializeTx(tx, { witness = true } = {}) {
  const segwit = witness && tx.inputs.some((i) => i.witness?.length);
  const parts = [u32(tx.version)];
  if (segwit) parts.push(Uint8Array.of(0, 1));
  parts.push(compactSize(tx.inputs.length));
  for (const i of tx.inputs) parts.push(reversed(txidBytes(i.txid)), u32(i.vout), varBytes(i.scriptSig ?? EMPTY), u32(i.sequence));
  parts.push(compactSize(tx.outputs.length));
  for (const o of tx.outputs) parts.push(u64(o.value), varBytes(o.script));
  if (segwit) {
    for (const i of tx.inputs) {
      const items = i.witness ?? [];
      parts.push(compactSize(items.length), ...items.map(varBytes));
    }
  }
  parts.push(u32(tx.locktime));
  return concat(...parts);
}

/** A transaction from its raw bytes or hex; throws unless they are exactly one. MWEB transactions are refused. */
export function parseTx(raw) {
  const bytes = typeof raw === 'string' ? unhex(raw.trim()) : raw;
  if (!(bytes instanceof Uint8Array)) throw new Error('a transaction is bytes or hex');
  const r = new Reader(bytes);
  const version = r.u32();
  const inputs = () => readList(r, () => ({
    txid: hex(reversed(r.take(32))), vout: r.u32(), scriptSig: r.take(readCompactSize(r)).slice(), sequence: r.u32(), witness: [],
  }));
  const outputs = () => readList(r, () => {
    const value = r.u64();
    if (value > BigInt(MAX_MONEY)) throw new Error('an output value out of range');
    return { value: Number(value), script: r.take(readCompactSize(r)).slice() };
  });
  const tx = { version, inputs: inputs(), outputs: [], locktime: 0 };
  let flags = 0;
  if (tx.inputs.length) {
    tx.outputs = outputs();
  } else {
    flags = r.u8();
    if (flags) {
      tx.inputs = inputs();
      tx.outputs = outputs();
    }
  }
  if (flags & 8) throw new Error('an MWEB transaction, which this page does not read');
  if (flags & 1) {
    for (const input of tx.inputs) input.witness = readList(r, () => r.take(readCompactSize(r)).slice());
    if (tx.inputs.every((i) => !i.witness.length)) throw new Error('a witness flag with no witness');
    flags ^= 1;
  }
  if (flags) throw new Error(`unknown transaction flags ${flags}`);
  tx.locktime = r.u32();
  r.end();
  return tx;
}

/** A transaction's id: the double SHA-256 of its legacy form, in hex as explorers show it. */
export const txid = (tx) => hex(reversed(dsha256(serializeTx(tx, { witness: false }))));

/** Its weight: 3 × the legacy size + the full size. */
export const weight = (tx) => 3 * serializeTx(tx, { witness: false }).length + serializeTx(tx).length;

/** Its virtual size, in vbytes: the weight / 4, rounded up. */
export const vsize = (tx) => Math.ceil(weight(tx) / 4);

// ---- Signature hashes (BIP 143) --------------------------------------------

/** The sighash types: ALL, NONE or SINGLE, each alone or with ANYONECANPAY. */
export const SIGHASH_ALL = 0x01;
export const SIGHASH_NONE = 0x02;
export const SIGHASH_SINGLE = 0x03;
export const SIGHASH_ANYONECANPAY = 0x80;
/** What the seller signs a release with. */
export const SIGHASH_RELEASE = SIGHASH_NONE | SIGHASH_ANYONECANPAY;

const outpoint = (input) => concat(reversed(txidBytes(input.txid)), u32(input.vout));
const output = (o) => concat(u64(o.value), varBytes(o.script));

/**
 * BIP 143's preimage for input `index` of `tx`, which spends `value` litoshi:
 * `scriptCode` is the script without its length (for P2WSH, the witness
 * script), and `hashType` the sighash type, any of the six.
 */
export function sighashPreimage(tx, index, scriptCode, value, hashType) {
  const input = tx.inputs[index];
  if (!input) throw new Error(`no input ${index}`);
  const base = hashType & 0x1f;
  const anyone = (hashType & SIGHASH_ANYONECANPAY) !== 0;
  const zero = new Uint8Array(32);
  const prevouts = anyone ? zero : dsha256(concat(...tx.inputs.map(outpoint)));
  const sequences = anyone || base === SIGHASH_SINGLE || base === SIGHASH_NONE
    ? zero : dsha256(concat(...tx.inputs.map((i) => u32(i.sequence))));
  let outputs = zero;
  if (base !== SIGHASH_SINGLE && base !== SIGHASH_NONE) outputs = dsha256(concat(...tx.outputs.map(output)));
  else if (base === SIGHASH_SINGLE && index < tx.outputs.length) outputs = dsha256(output(tx.outputs[index]));
  return concat(
    u32(tx.version), prevouts, sequences, outpoint(input), varBytes(scriptCode), u64(value), u32(input.sequence),
    outputs, u32(tx.locktime), u32(hashType),
  );
}

/** BIP 143's digest: the double SHA-256 of the preimage, what the signature signs. */
export const sighash = (tx, index, scriptCode, value, hashType) => dsha256(sighashPreimage(tx, index, scriptCode, value, hashType));

// ---- Spending the lock -----------------------------------------------------

/** Litecoin Core's least fee rate to relay, in litoshi per vbyte. */
export const MIN_FEE_RATE = 1;

const FINAL = 0xffffffff;
/** The longest signature with its sighash byte, a stand-in while the fee is reckoned: DER of a 33-byte r and a low s. */
const LONGEST = new Uint8Array(72);

function checkAmount(value) {
  const v = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(v) || v <= 0 || v > MAX_MONEY) throw new Error(`the lock's value, ${value}, is not an amount of litoshi`);
  return v;
}

function checkSigner(key, expected, who) {
  if (!equal(secp.publicKey(key), expected)) throw new Error(`this key is not the lock's ${who} key`);
}

const signed = (key, digest, type) => concat(secp.sign(key, digest), Uint8Array.of(type));

/**
 * A transaction spending the lock `txid:vout` of `value` into one output to
 * `to`, its fee `feeRate` litoshi per vbyte of its size with the longest
 * signatures. `stack(signature)` gives the witness before the script with
 * stand-in signatures.
 */
function spend({ txid, vout, value, htlc, to, feeRate, network = 'mainnet' }, { sequence, locktime, stack }) {
  const script = htlcScript(htlc);
  const amount = checkAmount(value);
  const out = destination(to, network);
  const rate = typeof feeRate === 'bigint' ? Number(feeRate) : feeRate;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < MIN_FEE_RATE) {
    throw new Error(`a fee rate of ${feeRate} litoshi per vbyte: Litecoin relays from ${MIN_FEE_RATE}`);
  }
  const tx = {
    version: 2,
    inputs: [{ txid: hex(txidBytes(txid)), vout: checkVout(vout), scriptSig: EMPTY, sequence, witness: [...stack(LONGEST), script] }],
    outputs: [{ value: 0, script: out }],
    locktime,
  };
  const fee = Math.ceil(vsize(tx) * rate);
  if (fee >= amount) throw new Error(`a fee of ${fee} litoshi takes the whole lock of ${amount}`);
  const dust = dustLimit(out);
  if (amount - fee < dust) {
    throw new Error(`after a fee of ${fee} litoshi, ${amount - fee} would be left: below Litecoin's dust limit of ${dust} for this output`);
  }
  tx.outputs[0].value = amount - fee;
  return { tx, script, amount, fee };
}

const finish = ({ tx, fee }) => ({ hex: hex(serializeTx(tx)), txid: txid(tx), fee, vsize: vsize(tx), tx });

/**
 * The seller's claim: spends the lock with the secret, witness
 * `sig(seller) ‖ secret ‖ 01 ‖ script`, SIGHASH_ALL, nLockTime 0 and a final
 * nSequence (no replace-by-fee, so a late refund cannot replace it in
 * mempools). Takes `{ txid, vout, value, htlc, secret, key, to, feeRate,
 * network }`, `key` the seller's; gives `{ hex, txid, fee, vsize, tx }`.
 */
export function claimTx({ secret, key, ...lock }) {
  htlcScript(lock.htlc);
  checkSigner(key, lock.htlc.seller, 'seller');
  checkBytes(secret, 32, 'the secret');
  if (!equal(sha256(secret), lock.htlc.hash)) throw new Error("the secret does not hash to the lock's hash");
  const spent = spend(lock, { sequence: FINAL, locktime: 0, stack: (sig) => [sig, secret, Uint8Array.of(1)] });
  const input = spent.tx.inputs[0];
  input.witness[0] = signed(key, sighash(spent.tx, 0, spent.script, spent.amount, SIGHASH_ALL), SIGHASH_ALL);
  return finish(spent);
}

/**
 * The buyer's refund after T1: witness `sig(buyer) ‖ 01 ‖ (empty) ‖ script`,
 * SIGHASH_ALL, nLockTime T1 and nSequence 0xfffffffe. Litecoin takes it once
 * the median time of the last 11 blocks has passed T1. Takes `{ txid, vout,
 * value, htlc, key, to, feeRate, network }`, `key` the buyer's.
 */
export function refundTx({ key, ...lock }) {
  htlcScript(lock.htlc);
  checkSigner(key, lock.htlc.buyer, 'buyer');
  const locktime = checkT1(lock.htlc.t1);
  const spent = spend(lock, { sequence: 0xfffffffe, locktime, stack: (sig) => [sig, Uint8Array.of(1), EMPTY] });
  spent.tx.inputs[0].witness[0] = signed(key, sighash(spent.tx, 0, spent.script, spent.amount, SIGHASH_ALL), SIGHASH_ALL);
  return finish(spent);
}

/** The digest a release's seller signature signs: version 2, nLockTime 0, nSequence 0xffffffff, NONE|ANYONECANPAY. */
function releaseDigest({ txid, vout, value, htlc }) {
  const script = htlcScript(htlc);
  const tx = {
    version: 2, inputs: [{ txid: hex(txidBytes(txid)), vout: checkVout(vout), scriptSig: EMPTY, sequence: FINAL }], outputs: [], locktime: 0,
  };
  return sighash(tx, 0, script, checkAmount(value), SIGHASH_RELEASE);
}

/**
 * The seller's release signature for the lock `txid:vout` of `value`: DER
 * with its sighash byte 82 (NONE|ANYONECANPAY), over the release input of a
 * version 2 transaction with nLockTime 0 and nSequence 0xffffffff. It lets
 * the coins go wherever the buyer's own signature sends them. Takes
 * `{ txid, vout, value, htlc, key }`, `key` the seller's.
 */
export function releaseSignature({ txid, vout, value, htlc, key }) {
  htlcScript(htlc);
  checkSigner(key, htlc.seller, 'seller');
  return signed(key, releaseDigest({ txid, vout, value, htlc }), SIGHASH_RELEASE);
}

/** Whether `signature` is the seller's release signature for the lock `txid:vout` of `value`, low S and all. */
export function verifyReleaseSignature({ txid, vout, value, htlc, signature }) {
  const digest = releaseDigest({ txid, vout, value, htlc });
  if (!(signature instanceof Uint8Array) || signature.length < 2 || signature[signature.length - 1] !== SIGHASH_RELEASE) return false;
  return secp.verify(signature.subarray(0, -1), digest, htlc.seller);
}

/**
 * The buyer's release: the seller's release `signature` with the buyer's own
 * SIGHASH_ALL one, witness `sig(buyer) ‖ sig(seller) ‖ (empty) ‖ (empty) ‖
 * script`, version 2, nLockTime 0, nSequence 0xffffffff. Checks the seller's
 * signature first. Takes `{ txid, vout, value, htlc, key, signature, to,
 * feeRate, network }`, `key` the buyer's.
 */
export function releaseTx({ key, signature, ...lock }) {
  htlcScript(lock.htlc);
  checkSigner(key, lock.htlc.buyer, 'buyer');
  if (!verifyReleaseSignature({ ...lock, signature })) throw new Error("the seller's signature does not release this lock");
  const spent = spend(lock, { sequence: FINAL, locktime: 0, stack: (sig) => [sig, signature, EMPTY, EMPTY] });
  spent.tx.inputs[0].witness[0] = signed(key, sighash(spent.tx, 0, spent.script, spent.amount, SIGHASH_ALL), SIGHASH_ALL);
  return finish(spent);
}

/**
 * The secret a claim of a lock reveals, from a transaction (parsed, or raw
 * bytes or hex): the first input whose witness is `sig ‖ secret ‖ 01 ‖
 * script`, with a lock's script whose hash the secret matches, and `hash`
 * if given. Null when there is none.
 */
export function secretFromWitness(tx, hash) {
  const t = typeof tx === 'string' || tx instanceof Uint8Array ? parseTx(tx) : tx;
  for (const input of t.inputs) {
    const w = input.witness ?? [];
    if (w.length !== 4 || w[1].length !== 32 || w[2].length !== 1 || w[2][0] !== 1) continue;
    let fields;
    try {
      fields = parseHtlcScript(w[3]);
    } catch {
      continue;
    }
    if (equal(sha256(w[1]), fields.hash) && (!hash || equal(hash, fields.hash))) return w[1].slice();
  }
  return null;
}
