// Bytes, hex and Ting's canonical encodings: fixed-width little-endian
// integers and length-framed byte strings (Ting wiki: data/encoding).

export function hex(bytes) {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function unhex(text) {
  if (typeof text !== 'string' || text.length % 2 || /[^0-9a-f]/i.test(text)) {
    throw new Error('not hex');
  }
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.substr(i * 2, 2), 16);
  return out;
}

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const utf8 = (text) => new TextEncoder().encode(text);

export function fromUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function little(value, width) {
  let v = BigInt(value);
  if (v < 0n || v >> BigInt(width * 8)) throw new Error(`${value} does not fit ${width} bytes`);
  const out = new Uint8Array(width);
  for (let i = 0; i < width; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export const u16 = (v) => little(v, 2);
export const u32 = (v) => little(v, 4);
export const u64 = (v) => little(v, 8);
export const u128 = (v) => little(v, 16);

/** `Bytes(x) = u32(len(x)) ‖ x` */
export const framed = (bytes) => concat(u32(bytes.length), bytes);

export class Writer {
  constructor() {
    this.parts = [];
  }
  u8(v) { this.parts.push(Uint8Array.of(v)); return this; }
  u16(v) { this.parts.push(u16(v)); return this; }
  u32(v) { this.parts.push(u32(v)); return this; }
  u64(v) { this.parts.push(u64(v)); return this; }
  u128(v) { this.parts.push(u128(v)); return this; }
  put(bytes) { this.parts.push(bytes); return this; }
  bytes(bytes) { this.parts.push(framed(bytes)); return this; }
  finish() { return concat(...this.parts); }
}

export class Reader {
  constructor(data) {
    this.data = data;
    this.at = 0;
  }
  take(n) {
    if (n > this.data.length - this.at) throw new Error('truncated');
    const out = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return out;
  }
  int(width) {
    const b = this.take(width);
    let v = 0n;
    for (let i = width - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }
  u8() { return this.take(1)[0]; }
  u16() { return Number(this.int(2)); }
  u32() { return Number(this.int(4)); }
  u64() { return this.int(8); }
  u128() { return this.int(16); }
  id() { return this.take(32); }
  bytes() { return this.take(this.u32()); }
  get done() { return this.at === this.data.length; }
  end() { if (!this.done) throw new Error('trailing bytes'); }
}
