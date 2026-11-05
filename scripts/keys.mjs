// A P-256 key for the development chain's test accounts, an account of the
// reference policy-p256 (Ting wiki: programs/policies), signed with WebCrypto.
// Its ECDSA hashes what it signs with SHA-256, and Ting's signing digest is
// `H("app/sign-v1", message)`, SHA-256 of a fixed prefix and the message: so
// signing `prefix ‖ message` signs exactly the digest the policy checks.
import { concat, hex, unhex } from '../web/js/bytes.js';
import { hashPrefix, policyAccount } from '../web/js/ting.js';

const SIGN_PREFIX = hashPrefix('app/sign-v1');
/** The order of P-256. */
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' };

export class Key {
  constructor(privateKey, publicKey, jwk) {
    this.privateKey = privateKey;
    /** 65 bytes, uncompressed: the policy params. */
    this.publicKey = publicKey;
    this.jwk = jwk;
  }

  /** A new key, not kept anywhere yet. */
  static async generate() {
    const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
    return Key.fromJwk(await crypto.subtle.exportKey('jwk', pair.privateKey));
  }

  static async fromJwk(jwk) {
    if (jwk?.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) {
      throw new Error('not a P-256 private key');
    }
    const { kty, crv, x, y, d } = jwk;
    const privateKey = await crypto.subtle.importKey('jwk', { kty, crv, x, y, d, ext: true }, ALGORITHM, true, ['sign']);
    const verify = await crypto.subtle.importKey('jwk', { kty, crv, x, y, ext: true }, ALGORITHM, true, ['verify']);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', verify));
    return new Key(privateKey, publicKey, { kty, crv, x, y, d });
  }

  account(policy) {
    return policyAccount(policy, this.publicKey);
  }

  /** This key as a TCR-1 signer, an account of the P-256 policy `policy`. */
  signer(policy) {
    return { policy, params: this.publicKey, account: this.account(policy), witness: (message) => this.sign(message) };
  }

  /** A low-S signature `r ‖ s` over the message's signing digest. */
  async sign(message) {
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.privateKey, concat(SIGN_PREFIX, message)),
    );
    const s = BigInt('0x' + hex(signature.subarray(32)));
    if (s > N / 2n) signature.set(unhex((N - s).toString(16).padStart(64, '0')), 32);
    return signature;
  }
}
