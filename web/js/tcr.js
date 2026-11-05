// TCR-1, Ting Call Requests (ting-id/TCR-1.md): operations a program accepts
// under templates of its own, approved by the acting account, coin payments
// tied to the one approved operation they pay for, call links for a wallet,
// the program's records, and running and cancelling what an account with a
// delay scheduled. Nothing here knows the canvas.
import { concat, Reader, u128, u64, utf8, Writer } from './bytes.js';
import { contractAccount, H } from './ting.js';

const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export const templateHash = (template) => H('app/call-v1/template', utf8(template));
export const operationHash = (head) => H('app/call-v1/operation', head);

/** `T ‖ values`: the operation. */
export const head = (template, values) => concat(templateHash(template), values);

export const RUN = H('app/call-v1/run');
export const CANCEL = H('app/call-v1/cancel');
export const SCHEDULED = H('app/call-v1/event/scheduled');
export const EXECUTED = H('app/call-v1/event/executed');
export const CANCELLED = H('app/call-v1/event/cancelled');

// ---- Records ---------------------------------------------------------------

/** The template list: `u64 count ‖ count × Bytes(template)`. */
export const TEMPLATES_KEY = H('app/call-v1/templates');
export const nonceKey = (account) => H('app/call-v1/nonce', account);
/** A scheduled operation: `u64 execute_at ‖ T ‖ values`. */
export const scheduledKey = (account, sequence) => H('app/call-v1/scheduled', account, u64(sequence));

/** A program's template list as a map from each template's hash, in hex, to its text; throws when malformed. */
export function decodeTemplateList(bytes) {
  if (!bytes) throw new Error('the program has no template list');
  const r = new Reader(bytes);
  const count = r.u64();
  if (count > BigInt(bytes.length)) throw new Error('truncated');
  const list = new Map();
  for (let i = 0n; i < count; i++) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(r.bytes());
    const t = hexOf(templateHash(text));
    if (list.has(t)) throw new Error('a template is listed twice');
    list.set(t, text);
  }
  r.end();
  return list;
}

export const decodeNonce = (bytes) => (bytes ? new Reader(bytes).u64() : 0n);

/** A template's operation name and its text up to and including `"): "`, found by its parentheses alone. */
function declarationOf(template) {
  const open = template.indexOf('(');
  let depth = 0;
  for (let i = open; open > 0 && i < template.length; i++) {
    if (template[i] === '(') depth++;
    else if (template[i] === ')' && --depth === 0) return { operation: template.slice(0, open), declaration: template.slice(0, i + 3) };
  }
  return null;
}

/**
 * Throws unless a program's template list holds `template`, and no other
 * template of the same operation name with another declaration.
 */
export function checkListed(list, template) {
  if (!list.has(hexOf(templateHash(template)))) throw new Error('the program does not list this template');
  const mine = declarationOf(template);
  for (const other of list.values()) {
    const d = declarationOf(other);
    if (mine && d && d.operation === mine.operation && d.declaration !== mine.declaration) {
      throw new Error(`the program lists ${mine.operation} with two declarations`);
    }
  }
}

// ---- Calls -----------------------------------------------------------------

/** What the acting account approves for an operation, and its signing digest. */
export function callMessage({ chain, program, account, nonce, validUntil, head }) {
  const message = new Writer().bytes(utf8('app/call-v1')).put(chain).put(program).put(account)
    .u8(1).u64(nonce).u64(validUntil).put(operationHash(head)).finish();
  return { message, digest: H('app/sign-v1', message) };
}

/**
 * A fee payment's effect: a transfer of 0 to the program's own account, which
 * moves nothing and carries the fee (TCR-1, fee payments).
 */
export const feeEffect = (program) => concat(Uint8Array.of(1), contractAccount(program), u128(0n));

/**
 * A call: the operation `head`, by `signer`'s policy account with its `nonce`
 * in the program. With a payment, `{ coin, coinNonce, effect, fee }`, the
 * payment comes from the same account, bound to the call's digest, and is the
 * approval: the call's own witness is empty. An operation that moves no coins
 * may take a fee payment, of `feeEffect(program)`. Without one, the signer's
 * witness over the digest approves it. A signer is
 * `{ policy, params, account, witness(message) }`.
 */
export async function signCall({ signer, chain, program, nonce, validUntil = 0n, head, payment }) {
  const { message, digest } = callMessage({ chain, program, account: signer.account, nonce, validUntil, head });
  const witness = payment ? new Uint8Array() : await signer.witness(message);
  const w = new Writer().put(head).u8(0).put(signer.policy).bytes(signer.params).u64(nonce).u64(validUntil).bytes(witness);
  if (!payment) return w.u8(0).finish();
  const coinInput = await coinPayment({ signer, chain, program, digest, validUntil, ...payment });
  return w.u8(1).put(payment.coin).bytes(coinInput).finish();
}

/** The coin's authorized action, operation `10`, bound to `program` and `digest`. */
async function coinPayment({ signer, chain, program, digest, validUntil, coin, coinNonce, effect, fee = 0n }) {
  const action = new Writer().put(effect).u128(fee).u128(0n).u64(0n).u64(validUntil)
    .u8(1).put(program).put(digest).finish();
  const message = new Writer().bytes(utf8('app/coin-v1')).put(chain).put(coin).put(signer.account)
    .u8(0x10).u64(coinNonce).put(action).finish();
  const witness = await signer.witness(message);
  return new Writer().u8(0x10).u8(0).put(signer.policy).bytes(signer.params).u64(coinNonce)
    .bytes(witness).put(action).finish();
}

/** Cancels scheduled operations of the signer's account, by sequence. */
export async function cancelCall({ signer, chain, program, validUntil = 0n, sequences }) {
  const list = new Writer().u64(sequences.length);
  for (const s of sequences) list.u64(s);
  const tail = list.finish();
  const message = new Writer().bytes(utf8('app/call-v1')).put(chain).put(program).put(signer.account)
    .u8(2).u64(validUntil).put(tail).finish();
  const witness = await signer.witness(message);
  return new Writer().put(CANCEL).put(signer.policy).bytes(signer.params).u64(validUntil).bytes(witness)
    .put(tail).finish();
}

export const runCall = (account, sequence) => concat(RUN, account, u64(sequence));

// ---- Links -----------------------------------------------------------------

const base64url = (bytes) => {
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding, refusing bits left over in its last character. */
const fromBase64url = (text) => {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new Error('not base64url');
  const spare = [0, 0, 15, 3][text.length % 4];
  if (spare && BASE64URL.indexOf(text.at(-1)) & spare) throw new Error('base64url with bits left over');
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

/** The most bytes `zvalues` may unpack to. */
export const ZVALUES_MAX = 65536;

async function through(stream, bytes, limit = Infinity) {
  const writer = stream.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = stream.readable.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      reader.cancel().catch(() => {});
      throw new Error(`unpacks to more than ${limit} bytes`);
    }
    chunks.push(value);
  }
  return concat(...chunks);
}

/** Values compressed with raw DEFLATE (RFC 1951), as `zvalues` carries them. */
export const packValues = (values) => through(new CompressionStream('deflate-raw'), values);

/** `zvalues` unpacked, refusing data that does not end exactly or unpacks past the limit. */
export async function unpackValues(packed) {
  try {
    return await through(new DecompressionStream('deflate-raw'), packed, ZVALUES_MAX);
  } catch (e) {
    throw new Error(`zvalues that ${/unpacks/.test(e.message) ? e.message : 'do not decompress exactly'}`);
  }
}

/**
 * Whether an address may be a link's `return`: one with an origin as TOCS-1
 * defines it (https, or http on the user's own computer) and no `#`.
 */
export function returnAddress(address) {
  const m = /^([a-zA-Z]+):\/\/([a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\])(:[0-9]{1,5})?([/?][\x21-\x7e]*)?$/.exec(address);
  if (!m || address.includes('#')) return false;
  const scheme = m[1].toLowerCase(), host = m[2].toLowerCase();
  const port = m[3] ? Number(m[3].slice(1)) : null;
  if (port != null && (port < 1 || port > 65535)) return false;
  return scheme === 'https' || (scheme === 'http' && ['localhost', '127.0.0.1', '[::1]'].includes(host));
}

/**
 * A call link, `ting:call?net=…&program=…&template=…`, with the values as
 * `values` or, when it is shorter, compressed as `zvalues`; a payment as
 * `coin` and `burn`, or `coin`, `to` and `amount`, in decimal, or `coin`
 * alone, the coin the program takes fee payments in; `from`, `delayed`, and
 * `return`, the page the wallet offers to open once it sent the call.
 */
export async function callLink({ chainHex, program, template, values, coin, burn, to, amount, from, delayed, returnTo }) {
  const fields = [`net=${chainHex.slice(0, 8)}`, `program=${hexOf(program)}`, `template=${encodeURIComponent(template)}`];
  if (values.length) {
    const plain = base64url(values);
    const packed = base64url(await packValues(values));
    fields.push(packed.length < plain.length ? `zvalues=${packed}` : `values=${plain}`);
  }
  if (coin) fields.push(`coin=${hexOf(coin)}`);
  if (burn) fields.push(`burn=${burn}`);
  if (to) fields.push(`to=${hexOf(to)}`, `amount=${amount}`);
  if (from) fields.push(`from=${hexOf(from)}`);
  if (delayed) fields.push('delayed=1');
  if (returnTo && returnAddress(returnTo)) fields.push(`return=${encodeURIComponent(returnTo)}`);
  return `ting:call?${fields.join('&')}`;
}

/**
 * A call link's fields, read as every Ting link is (ting-id/LINKS.md, reading),
 * with its values unpacked, `valueBytes`, and its template read, `parsed`.
 * Throws when it breaks a rule a wallet checks without the chain.
 */
export async function readLink(text) {
  const m = String(text).match(/^ting:(?:\/\/)?call\?(.*)$/i);
  if (!m) throw new Error('not a call link');
  const fields = {};
  for (const pair of m[1].split('&')) {
    const at = pair.indexOf('=');
    const name = (at < 0 ? pair : pair.slice(0, at)).toLowerCase();
    if (name in fields) throw new Error(`${name} given twice`);
    fields[name] = decodeURIComponent(at < 0 ? '' : pair.slice(at + 1));
  }
  for (const f of ['net', 'program', 'template']) if (!fields[f]) throw new Error(`no ${f}`);
  const hex64 = /^[0-9a-f]{64}$/i;
  if (!/^[0-9a-f]{8}$/i.test(fields.net) || !hex64.test(fields.program)) throw new Error('a malformed net or program');
  for (const f of ['coin', 'to', 'from']) if (fields[f] != null && !hex64.test(fields[f])) throw new Error(`a malformed ${f}`);
  const amountOk = (a) => /^\d+(\.\d+)?$/.test(a) && /[1-9]/.test(a);
  const paid = fields.burn != null || fields.to != null || fields.amount != null;
  if (paid) {
    if (fields.coin == null) throw new Error('a payment without its coin');
    if ((fields.burn != null) === (fields.to != null || fields.amount != null)) throw new Error('a payment that is neither a burn nor a transfer');
    if (fields.burn == null && (fields.to == null || fields.amount == null)) throw new Error('a transfer without its account or amount');
    if (!amountOk(fields.burn ?? fields.amount)) throw new Error('a payment that is not an amount above 0');
  }
  if (fields.delayed != null && (fields.delayed !== '1' || paid)) throw new Error('delayed is 1, and only without a payment');
  if (fields.values != null && fields.zvalues != null) throw new Error('both values and zvalues');
  if (fields.return != null && !returnAddress(fields.return)) throw new Error('a return address without an https origin, or with a #');
  fields.parsed = parseTemplate(fields.template);
  if (fields.parsed.payment && !paid) throw new Error('the template shows {payment} and the link has no payment');
  if (paid && !fields.parsed.payment) throw new Error('a payment for a template that does not show {payment}');
  fields.valueBytes = fields.zvalues != null
    ? await unpackValues(fromBase64url(fields.zvalues))
    : fromBase64url(fields.values ?? '');
  return fields;
}

// ---- Events ----------------------------------------------------------------

/** A *scheduled* event after its topic: `account ‖ u64 sequence ‖ u64 execute_at ‖ T ‖ values`. */
export function decodeScheduled(r) {
  const account = r.id(), sequence = r.u64(), executeAt = Number(r.u64());
  const head = r.take(r.data.length - r.at);
  if (head.length < 32) throw new Error('truncated');
  return { account, sequence, executeAt, head, t: head.subarray(0, 32), values: head.subarray(32) };
}

/** An *executed* event after its topic: `account ‖ u64 sequence ‖ operation`. */
export const decodeExecuted = (r) => ({ account: r.id(), sequence: r.u64(), operation: r.id() });

/** A *cancelled* event after its topic: `account ‖ u64 sequence`. */
export const decodeCancelled = (r) => ({ account: r.id(), sequence: r.u64() });

// ---- Text ------------------------------------------------------------------

/** Code points that can hide or reorder what is shown (TOCS-1, text). */
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u3164\uffa0\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ud800-\udfff\ufdd0-\ufdef\ufeff\u{e0000}-\u{e007f}]/u;

/** A noncharacter: U+FDD0–U+FDEF, matched above, and every U+xxFFFE and U+xxFFFF. */
const nonCharacter = (cp) => (cp & 0xfffe) === 0xfffe;

/**
 * Why a text breaks TOCS-1's text rules, which a template's text values keep,
 * or null: not in Normalization Form C, a code point that hides or reorders
 * text, or, for a line, empty or with white space at either end.
 */
export function textProblem(text, { line = true } = {}) {
  if (text !== text.normalize('NFC')) return 'it is not in Normalization Form C';
  if (HIDDEN.test(text) || [...text].some((c) => nonCharacter(c.codePointAt(0)))) {
    return 'it holds a character that can hide or reorder text';
  }
  if (line && !text) return 'it is empty';
  if (line && /^\s|\s$/u.test(text)) return 'it starts or ends with white space';
  return null;
}

// ---- Templates -------------------------------------------------------------

/** The longest template, declaration and sentence together. */
export const TEMPLATE_MAX = 512;

const SCALARS = new Set(['u8', 'u16', 'u32', 'u64', 'u128', 'amount', 'coin', 'account', 'bytes32', 'time', 'duration', 'text', 'bytes']);

/**
 * A template read by TCR-1's grammar, `operation(fields): sentence`, and held
 * to its rules: `{ text, operation, declaration, fields, sentence, payment }`,
 * where each field is `{ name, type }`, a type is a scalar's name, an enum
 * `{ enum: labels }` or a list `{ list: fields }`, and the sentence is parts
 * `{ text }`, `{ slot: name }` or `{ payment: true }`. Throws saying what is wrong.
 */
export function parseTemplate(template) {
  const problem = textProblem(template);
  if (problem) throw new Error(`the template cannot be shown: ${problem}`);
  if (utf8(template).length > TEMPLATE_MAX) throw new Error(`the template is longer than ${TEMPLATE_MAX} bytes`);
  let at = 0;
  const fail = (why) => { throw new Error(`the template ${why}`); };
  const expect = (s) => {
    if (!template.startsWith(s, at)) fail(`has no “${s}” where one belongs`);
    at += s.length;
  };
  const name = () => {
    const m = /^[a-z][a-z0-9_]*/.exec(template.slice(at));
    if (!m || m[0].length > 32) fail('has a name that is not one');
    at += m[0].length;
    return m[0];
  };
  const scalar = () => {
    if (template.startsWith('enum(', at)) {
      at += 5;
      const labels = [];
      for (;;) {
        const m = /^[^|(){}:,]+/.exec(template.slice(at));
        if (!m) fail('has an empty enum label');
        const label = m[0];
        if (/^\s|\s$/u.test(label)) fail(`has an enum label with spaces at its ends: “${label}”`);
        if (labels.includes(label)) fail(`has the enum label “${label}” twice`);
        labels.push(label);
        at += label.length;
        if (template[at] === '|') at++;
        else break;
      }
      expect(')');
      return { enum: labels };
    }
    const m = /^[a-z0-9]+/.exec(template.slice(at));
    if (!m || !SCALARS.has(m[0])) fail(`has a type it does not know at “${template.slice(at, at + 12)}”`);
    at += m[0].length;
    return m[0];
  };
  const fieldsOf = (inList) => {
    const fields = [];
    if (template[at] === ')') return fields;
    for (;;) {
      const n = name();
      if (n === 'payment') fail('declares a field named payment');
      if (fields.some((f) => f.name === n)) fail(`declares ${n} twice`);
      expect(':');
      let type;
      if (!inList && template.startsWith('list(', at)) {
        at += 5;
        const listed = fieldsOf(true);
        if (!listed.length) fail('has an empty list');
        expect(')');
        type = { list: listed };
      } else {
        type = scalar();
      }
      fields.push({ name: n, type });
      if (template[at] !== ',') return fields;
      at++;
    }
  };
  const operation = name();
  expect('(');
  const fields = fieldsOf(false);
  expect(')');
  expect(': ');
  const declaration = template.slice(0, at);
  const sentence = [];
  let payment = false;
  for (const m of template.slice(at).matchAll(/\{([^{}]*)\}|[^{}]+|[{}]/g)) {
    if (m[0] === '{' || m[0] === '}') fail('has a { or } outside a slot');
    if (m[1] == null) sentence.push({ text: m[0] });
    else if (m[1] === 'payment') {
      payment = true;
      sentence.push({ payment: true });
    } else {
      if (!fields.some((f) => f.name === m[1])) fail(`shows ${m[1]}, which it does not declare`);
      sentence.push({ slot: m[1] });
    }
  }
  if (!sentence.length) fail('has no sentence');
  for (const f of fields) if (!sentence.some((p) => p.slot === f.name)) fail(`never shows ${f.name}`);
  return { text: template, operation, declaration, fields, sentence, payment };
}

const leastBytes = (type) => {
  if (type.enum) return 1;
  if (type.list) return 8;
  return { u8: 1, u16: 2, u32: 4, u64: 8, u128: 16, amount: 48, coin: 32, account: 32, bytes32: 32, time: 8, duration: 8, text: 4, bytes: 4 }[type];
};

function readType(type, r) {
  if (type.enum) {
    const index = r.u8();
    if (index >= type.enum.length) throw new Error('an enum index past its last label');
    return { index, label: type.enum[index] };
  }
  if (type.list) {
    const count = r.u64();
    const each = type.list.reduce((n, f) => n + leastBytes(f.type), 0);
    if (count > BigInt(Math.floor((r.data.length - r.at) / each))) throw new Error('a list longer than its bytes');
    return Array.from({ length: Number(count) }, () => Object.fromEntries(type.list.map((f) => [f.name, readType(f.type, r)])));
  }
  switch (type) {
    case 'u8': return r.u8();
    case 'u16': return r.u16();
    case 'u32': return r.u32();
    case 'u64': return r.u64();
    case 'u128': return r.u128();
    case 'amount': return { coin: r.id(), amount: r.u128() };
    case 'coin': case 'account': case 'bytes32': return r.id();
    case 'time': case 'duration': return Number(r.u64());
    case 'text': {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(r.bytes());
      const problem = textProblem(text, { line: false }) ?? (/^\s|\s$/u.test(text) ? 'it starts or ends with white space' : null);
      if (problem) throw new Error(`a text that cannot be shown: ${problem}`);
      return text;
    }
    case 'bytes': return r.bytes();
    default: throw new Error(`unknown type ${type}`);
  }
}

/**
 * An operation's values decoded exactly as its template declares them:
 * `{ template, value, parts }`, `value` holding each field by name and `parts`
 * the sentence, each slot with its field's `type` and `value`. Throws when
 * they do not decode.
 */
export function decodeValues(template, values) {
  const t = typeof template === 'string' ? parseTemplate(template) : template;
  const r = new Reader(values);
  const value = {};
  for (const f of t.fields) value[f.name] = readType(f.type, r);
  r.end();
  const typeOf = (n) => t.fields.find((f) => f.name === n).type;
  return { template: t, value, parts: t.sentence.map((p) => (p.slot ? { ...p, type: typeOf(p.slot), value: value[p.slot] } : p)) };
}
