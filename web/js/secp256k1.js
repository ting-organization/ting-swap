// secp256k1 for the Litecoin side of a swap: public keys, ECDSA signatures in
// DER with a low S and RFC 6979 nonces, and their verification. The curve
// arithmetic and the nonces are adapted from Ting ID Web (web/js/phrase.js on
// its main branch), made synchronous: HMAC-SHA256 runs on this page's own
// SHA-256, so signing never waits on a promise.
//
// A private key is 32 bytes or a bigint, from 1 to N − 1. The arithmetic is
// BigInt, which is not constant-time; keys live in a page that runs nothing
// but its own code.
import { concat } from './bytes.js';
import { sha256 } from './sha256.js';

/** The field's prime and the group's order. */
export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** The generator, in Jacobian coordinates (x, y, z) for x/z², y/z³. */
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  1n,
];

/** A big-endian number. */
export const toBig = (bytes) => bytes.reduce((v, b) => (v << 8n) | BigInt(b), 0n);

/** A number as `length` big-endian bytes. */
export function fromBig(v, length = 32) {
  const out = new Uint8Array(length);
  for (let i = length - 1; i >= 0; i--, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

const mod = (a, m = P) => {
  const r = a % m;
  return r < 0n ? r + m : r;
};

function inv(a, m = P) {
  let [t, next, r, rest] = [0n, 1n, m, mod(a, m)];
  while (rest) {
    const q = r / rest;
    [t, next] = [next, t - q * next];
    [r, rest] = [rest, r - q * rest];
  }
  return mod(t, m);
}

function pow(base, exponent, m = P) {
  let r = 1n;
  for (let b = mod(base, m), e = exponent; e; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
}

/** Doubling on y² = x³ + 7; `null` is the point at infinity. */
function double(p) {
  if (!p || p[1] === 0n) return null;
  const [x, y, z] = p;
  const a = (x * x) % P;
  const b = (y * y) % P;
  const c = (b * b) % P;
  const d = mod(2n * ((x + b) * (x + b) - a - c));
  const e = 3n * a;
  const x3 = mod(e * e - 2n * d);
  return [x3, mod(e * (d - x3) - 8n * c), (2n * y * z) % P];
}

function add(p, q) {
  if (!p) return q;
  if (!q) return p;
  const [x1, y1, z1] = p;
  const [x2, y2, z2] = q;
  const z1z1 = (z1 * z1) % P;
  const z2z2 = (z2 * z2) % P;
  const u1 = (x1 * z2z2) % P;
  const u2 = (x2 * z1z1) % P;
  const s1 = (((y1 * z2) % P) * z2z2) % P;
  const s2 = (((y2 * z1) % P) * z1z1) % P;
  if (u1 === u2) return s1 === s2 ? double(p) : null;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  const hh = (h * h) % P;
  const hhh = (h * hh) % P;
  const v = (u1 * hh) % P;
  const x3 = mod(r * r - hhh - 2n * v);
  return [x3, mod(r * (v - x3) - s1 * hhh), (((h * z1) % P) * z2) % P];
}

function affine(p) {
  const zi = inv(p[2]);
  const zi2 = (zi * zi) % P;
  return [(p[0] * zi2) % P, (((p[1] * zi2) % P) * zi) % P];
}

/** 2^i·G for i below 256, made the first time they are needed. */
let powers = null;

/** k·G, Jacobian, or null for k = 0. */
function mulG(k) {
  if (!powers) {
    powers = [];
    for (let i = 0, q = G; i < 256; i++, q = double(q)) powers.push(q);
  }
  let r = null;
  for (let i = 0; k; i++, k >>= 1n) if (k & 1n) r = add(r, powers[i]);
  return r;
}

/** k·p for a Jacobian point p. */
function mul(p, k) {
  let r = null;
  for (let q = p; k; k >>= 1n, q = double(q)) if (k & 1n) r = add(r, q);
  return r;
}

/** A private key as a bigint, checked to be from 1 to N − 1. */
export function scalar(secret) {
  let k = secret;
  if (secret instanceof Uint8Array) {
    if (secret.length !== 32) throw new Error('a private key is 32 bytes');
    k = toBig(secret);
  }
  if (typeof k !== 'bigint' || k <= 0n || k >= N) throw new Error('not a private key');
  return k;
}

const compressed = ([x, y]) => concat(Uint8Array.of(y & 1n ? 3 : 2), fromBig(x));

/** The 33-byte compressed public key of a private key. */
export const publicKey = (secret) => compressed(affine(mulG(scalar(secret))));

/**
 * The point of a public key, `[x, y]`, from 33 bytes compressed (02 or 03)
 * or 65 uncompressed (04); throws unless it is on the curve.
 */
export function parsePublicKey(key) {
  const fail = (why) => {
    throw new Error(`not a public key: ${why}`);
  };
  if (!(key instanceof Uint8Array)) fail('not bytes');
  if (key.length === 33 && (key[0] === 2 || key[0] === 3)) {
    const x = toBig(key.subarray(1));
    if (x >= P) fail('x is out of range');
    const yy = mod(x * x * x + 7n);
    let y = pow(yy, (P + 1n) / 4n);
    if ((y * y) % P !== yy) fail('no point has that x');
    if ((y & 1n) !== BigInt(key[0] & 1)) y = P - y;
    return [x, y];
  }
  if (key.length === 65 && key[0] === 4) {
    const x = toBig(key.subarray(1, 33));
    const y = toBig(key.subarray(33));
    if (x >= P || y >= P || mod(y * y - x * x * x - 7n) !== 0n) fail('not on the curve');
    return [x, y];
  }
  fail(key.length === 33 || key.length === 65 ? `a key cannot start with ${key[0]}` : `${key.length} bytes`);
}

/** Whether `key` is a public key on the curve, compressed or not. */
export function isPublicKey(key) {
  try {
    parsePublicKey(key);
    return true;
  } catch {
    return false;
  }
}

/** A public key in its 33-byte compressed form. */
export const compressPublicKey = (key) => compressed(parsePublicKey(key));

/** HMAC-SHA256 (RFC 2104). */
export function hmacSha256(key, data) {
  const block = new Uint8Array(64);
  block.set(key.length > 64 ? sha256(key) : key);
  const inner = block.map((b) => b ^ 0x36);
  const outer = block.map((b) => b ^ 0x5c);
  return sha256(concat(outer, sha256(concat(inner, data))));
}

/**
 * The nonces RFC 6979 draws, with HMAC-SHA256, for the private key `secret`
 * (a bigint) and the 32-byte `digest` on a curve of 256-bit `order`, one
 * after the other: a signature takes the first, and the next only when the
 * first gives r or s of 0.
 */
export function* nonces(secret, digest, order = N) {
  const x = fromBig(secret);
  const h = fromBig(toBig(digest) % order);
  let v = new Uint8Array(32).fill(1);
  let k = hmacSha256(new Uint8Array(32), concat(v, Uint8Array.of(0), x, h));
  v = hmacSha256(k, v);
  k = hmacSha256(k, concat(v, Uint8Array.of(1), x, h));
  v = hmacSha256(k, v);
  for (;;) {
    v = hmacSha256(k, v);
    const t = toBig(v);
    if (t > 0n && t < order) yield t;
    k = hmacSha256(k, concat(v, Uint8Array.of(0)));
    v = hmacSha256(k, v);
  }
}

function derInteger(v) {
  let b = fromBig(v);
  let i = 0;
  while (i < 31 && b[i] === 0) i++;
  b = b.subarray(i);
  if (b[0] & 0x80) b = concat(Uint8Array.of(0), b);
  return concat(Uint8Array.of(2, b.length), b);
}

/** `r` and `s` as a DER signature: `30 len 02 len r 02 len s`, each integer minimal. */
export function encodeDer(r, s) {
  const body = concat(derInteger(r), derInteger(s));
  return concat(Uint8Array.of(0x30, body.length), body);
}

/**
 * `{ r, s }` of a DER signature without its sighash byte, read under BIP 66's
 * strict rules, with r and s from 1 to N − 1 and s low (at most N/2), as
 * Litecoin relays them; throws otherwise.
 */
export function parseDer(der) {
  const fail = (why) => {
    throw new Error(`not a strict DER signature: ${why}`);
  };
  if (!(der instanceof Uint8Array)) fail('not bytes');
  const n = der.length;
  if (n < 8 || n > 72) fail(`${n} bytes`);
  if (der[0] !== 0x30) fail('no sequence');
  if (der[1] !== n - 2) fail('the sequence length is wrong');
  const lenR = der[3];
  if (5 + lenR >= n) fail('r is too long');
  const lenS = der[5 + lenR];
  if (lenR + lenS + 6 !== n) fail('the lengths do not add up');
  if (der[2] !== 2 || lenR === 0) fail('r is not an integer');
  if (der[4] & 0x80) fail('r is negative');
  if (lenR > 1 && der[4] === 0 && !(der[5] & 0x80)) fail('r is padded');
  if (der[4 + lenR] !== 2 || lenS === 0) fail('s is not an integer');
  if (der[6 + lenR] & 0x80) fail('s is negative');
  if (lenS > 1 && der[6 + lenR] === 0 && !(der[7 + lenR] & 0x80)) fail('s is padded');
  const r = toBig(der.subarray(4, 4 + lenR));
  const s = toBig(der.subarray(6 + lenR));
  if (r === 0n || r >= N) fail('r is out of range');
  if (s === 0n || s >= N) fail('s is out of range');
  if (s > N >> 1n) fail('s is high');
  return { r, s };
}

function checkDigest(digest) {
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new Error('a digest is 32 bytes');
}

/** Signs a 32-byte digest: DER, with an RFC 6979 nonce and a low S, the same every time. */
export function sign(secret, digest) {
  const d = scalar(secret);
  checkDigest(digest);
  const e = toBig(digest) % N;
  for (const k of nonces(d, digest)) {
    const r = affine(mulG(k))[0] % N;
    if (r === 0n) continue;
    let s = (inv(k, N) * (e + r * d)) % N;
    if (s === 0n) continue;
    if (s > N >> 1n) s = N - s;
    return encodeDer(r, s);
  }
}

/**
 * Whether `signature`, DER without its sighash byte, signs the 32-byte
 * `digest` for `key`. A signature that is not strict DER with a low S is
 * false; a key that is not on the curve throws.
 */
export function verify(signature, digest, key) {
  const [x, y] = parsePublicKey(key);
  checkDigest(digest);
  let rs;
  try {
    rs = parseDer(signature);
  } catch {
    return false;
  }
  const { r, s } = rs;
  const w = inv(s, N);
  const point = add(mulG(((toBig(digest) % N) * w) % N), mul([x, y, 1n], (r * w) % N));
  return point !== null && affine(point)[0] % N === r;
}
