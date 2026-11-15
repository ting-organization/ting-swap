//! Ting Swap's HTLC: listings that offer coins on Ting for an amount on
//! another chain, settled by a secret. The maker's coins wait in the program's
//! own account; once the buyer has locked the amount on the other chain under
//! the hash of a secret, the maker locks the coins here for the buyer under the
//! same hash, until a deadline. The buyer's claim reveals the secret and pays
//! the buyer; after the deadline a refund pays the maker back. HTLC.md states
//! the rules; this file follows it. The program never sees the other chain.
//!
//! The maker's operations are calls of TCR-1, Ting Call Requests, as in Ting
//! Swap: a template of the program's own and its values, approved by the
//! acting account. An offer carries a coin payment from the acting account,
//! bound to the call's signing digest (wiki: programs/conventions, bound
//! actions): the payment pays for that one operation, and the coin's check of
//! it is the approval. The program holds nothing for an account with a delay:
//! it refuses delayed answers outright (TCR-1, now or later). Takes, claims,
//! refunds and releases need no signature: anyone may submit them, and none
//! can send coins anywhere but where the lock says.
#![no_std]

extern crate alloc;

mod host;
mod sha256;

use alloc::{vec, vec::Vec};
use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32;
use host::fail;
use sha256::{sha256, tagged, tagged_const};

// ---- Memory ----------------------------------------------------------------------

/// Memory starts at one page and grows only when a transaction needs more
/// (wiki: applications/writing-programs, keeping it cheap). Nothing is freed:
/// an invocation is short.
struct Bump;

static mut NEXT: usize = 0;
static mut END: usize = 0;

unsafe extern "C" {
    static __heap_base: u8;
}

unsafe impl GlobalAlloc for Bump {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe {
            if NEXT == 0 {
                NEXT = &raw const __heap_base as usize;
                END = wasm32::memory_size::<0>() * 65536;
            }
            let start = (NEXT + layout.align() - 1) & !(layout.align() - 1);
            let Some(end) = start.checked_add(layout.size()) else {
                return core::ptr::null_mut();
            };
            if end > END {
                let pages = (end - END).div_ceil(65536);
                if wasm32::memory_grow::<0>(pages) == usize::MAX {
                    return core::ptr::null_mut();
                }
                END += pages * 65536;
            }
            NEXT = end;
            start as *mut u8
        }
    }

    unsafe fn dealloc(&self, _: *mut u8, _: Layout) {}
}

#[global_allocator]
static ALLOCATOR: Bump = Bump;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}

// ---- The coins it holds -----------------------------------------------------------

/// The CodeHash of the coin reference program (Ting wiki: programs). The
/// program calls a contract as a coin, and accepts a payment from one, only
/// when it runs this code: a contract that only claims to be a coin could
/// report a payment it never made.
const COIN_CODE: [u8; 32] =
    unhex("c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6");

const fn unhex(text: &str) -> [u8; 32] {
    const fn digit(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => panic!("not lowercase hex"),
        }
    }
    let t = text.as_bytes();
    assert!(t.len() == 64);
    let mut out = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        out[i] = digit(t[2 * i]) << 4 | digit(t[2 * i + 1]);
        i += 1;
    }
    out
}

/// Reverts `bad coin` unless `coin` runs the coin reference program.
fn check_coin(coin: &[u8; 32]) {
    if host::code_of(coin) != Some(COIN_CODE) {
        fail(b"bad coin");
    }
}

// ---- Time ----------------------------------------------------------------------------

/// The least time between a lock's deadline here and its end on the other
/// chain, `t1`: a maker who sees the secret appear here at the last moment
/// still has this long to claim there.
const GAP: u64 = 21_600;
/// The least and the most a listing may hold its coins once accepted. Claims
/// and refunds go by the block timestamp, and Ting's nodes admit a block
/// stamped up to 2 hours ahead of their clocks: a seller who mines could put a
/// refund in a block stamped just past the deadline, leave out the buyer's
/// pending claim, keep the coins and claim the other chain's with the secret
/// the claim made public. The least window, 6 hours, is comfortably above that
/// clock slack plus the time a claim needs to get into a block.
const MIN_WINDOW: u64 = 21_600;
const MAX_WINDOW: u64 = 604_800;

/// An offer's fee is at most a `FEE_SHARE`th of the coins it pays in. The fee
/// is fixed: a claim or a refund pays exactly it to the miner of its block.
/// Once the buyer's claim is in the pool its secret is public, so a miner, the
/// seller included if it mines, can put its own copy of the claim in its block,
/// but that copy pays the same fee and the coins still go to the taker. The
/// thousandth is a ceiling against a listing whose fee would eat its coins.
const FEE_SHARE: u128 = 1_000;

/// The deadline a lock made now gets: the block timestamp plus the listing's
/// window. A claim may come up to it, a refund only after it.
fn deadline(window: u64) -> u64 {
    host::now().saturating_add(window)
}

/// Reverts `too short` unless a lock made now, of `window`, would end at least
/// `GAP` before `t1`.
fn check_gap(window: u64, t1: u64) {
    if t1 < deadline(window).saturating_add(GAP) {
        fail(b"too short");
    }
}

// ---- Takers --------------------------------------------------------------------------

/// Reverts unless a take or an accept may name `taker` for a listing whose
/// own is `allowed`: a listing for one taker only that one (`not for you`), a
/// listing for anyone any account but the zero account (`bad taker`), which
/// the coin never pays, so that a claim could never succeed.
fn check_taker(allowed: &[u8; 32], taker: &[u8; 32]) {
    if *allowed != ZERO && taker != allowed {
        fail(b"not for you");
    }
    if *taker == ZERO {
        fail(b"bad taker");
    }
}

// ---- TCR-1 ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Offer,
    OfferTo,
    Accept,
    Withdraw,
}

/// The program's templates (TCR-1): each declares its operation and fields,
/// then says what it does in the words a wallet shows. A call names one by its
/// hash.
const TEMPLATES: [(Op, &[u8]); 4] = [
    (
        Op::Offer,
        b"offer(chain:enum(LTC|BTC),whole:u64,d1:u8,d2:u8,d3:u8,d4:u8,d5:u8,d6:u8,d7:u8,d8:u8,key:bytes,window:duration,fee:amount): Sell {payment} for {whole}.{d1}{d2}{d3}{d4}{d5}{d6}{d7}{d8} {chain}, paid to your {chain} key ({key}). Once a buyer's lock is accepted, the coins are held for them for {window}. The buyer's claim, or a refund, pays a network fee of {fee} out of these coins",
    ),
    (
        Op::OfferTo,
        b"offer_to(taker:account,chain:enum(LTC|BTC),whole:u64,d1:u8,d2:u8,d3:u8,d4:u8,d5:u8,d6:u8,d7:u8,d8:u8,key:bytes,window:duration,fee:amount): Sell {payment} to {taker} only, for {whole}.{d1}{d2}{d3}{d4}{d5}{d6}{d7}{d8} {chain}, paid to your {chain} key ({key}). Once their lock is accepted, the coins are held for them for {window}. Their claim, or a refund, pays a network fee of {fee} out of these coins",
    ),
    (
        Op::Accept,
        b"accept(listing:u64,taker:account,hash:bytes32,until:time,give:amount): Accept a lock for listing {listing}: hold {give} for {taker} until they reveal the secret of {hash}, before their lock ends {until}",
    ),
    (
        Op::Withdraw,
        b"withdraw(listing:u64,back:amount): Withdraw listing {listing} and get back {back}",
    ),
];

const TEMPLATE_HASHES: [[u8; 32]; 4] = {
    let mut out = [[0; 32]; 4];
    let mut i = 0;
    while i < 4 {
        out[i] = tagged_const(b"app/call-v1/template", TEMPLATES[i].1);
        i += 1;
    }
    out
};

const CALL_TAG: &[u8] = b"app/call-v1";
const TAG_OPERATION: &[u8] = b"app/call-v1/operation";
const TAG_NONCE: &[u8] = b"app/call-v1/nonce";
const TAG_SIGN: &[u8] = b"app/sign-v1";
const RUN: [u8; 32] = tagged_const(b"app/call-v1/run", b"");
const CANCEL: [u8; 32] = tagged_const(b"app/call-v1/cancel", b"");
const EXECUTED: [u8; 32] = tagged_const(b"app/call-v1/event/executed", b"");
/// The template list: `u64 count ‖ count × Bytes(template)`, for wallets to read.
const TEMPLATES_KEY: [u8; 32] = tagged_const(b"app/call-v1/templates", b"");

// ---- The program's own inputs ----------------------------------------------------------

/// The tags of the inputs that need no signature.
const TAKE: [u8; 32] = tagged_const(b"app/htlc-v1/take", b"");
const CLAIM: [u8; 32] = tagged_const(b"app/htlc-v1/claim", b"");
const REFUND: [u8; 32] = tagged_const(b"app/htlc-v1/refund", b"");
const RELEASE: [u8; 32] = tagged_const(b"app/htlc-v1/release", b"");

// ---- Layout ----------------------------------------------------------------------

/// Every event of the program's own begins with this topic, so a page reads
/// the whole market's history with one filtered query.
const TOPIC: [u8; 32] = tagged_const(b"app/htlc-v1/event", b"");
const LISTED: u8 = 1;
const TAKEN: u8 = 2;
const ACCEPTED: u8 = 3;
const CLAIMED: u8 = 4;
const REFUNDED: u8 = 5;
const WITHDRAWN: u8 = 6;
const RELEASED: u8 = 7;

const TAG_POLICY: &[u8] = b"app/account-v1/policy";
const TAG_CONTRACT: &[u8] = b"app/account-v1/contract";

const ZERO: [u8; 32] = [0; 32];
/// The deployment's version byte, `01`.
const CONFIG_KEY: [u8; 32] = ZERO;
/// Holds the digest of the call that is paying, only while it pays.
const DIGEST_KEY: [u8; 32] = {
    let mut key = ZERO;
    key[0] = 0xff;
    key
};
/// How many listings were ever made: the last one's id.
const COUNT_KEY: [u8; 32] = {
    let mut key = ZERO;
    key[0] = 2;
    key
};

/// The other chains an offer may name, by the index of its `chain` enum: the
/// name the listing stores. Each counts its coin in hundred-millionths, which
/// an offer's amount is in.
const CHAINS: [&[u8]; 2] = [b"LTC", b"BTC"];
/// Base units in one coin of the other chain.
const UNITS: u64 = 100_000_000;
/// The longest chain name a listing stores.
const MAX_CHAIN: usize = 8;
/// The maker's key on the other chain, 1 to this many bytes.
const MAX_KEY: usize = 65;
/// A take's lock and a release's data, 1 to this many bytes.
const MAX_DATA: usize = 256;

/// The longest listing: `maker(32) ‖ coin(32) ‖ u128 amount ‖ u64 want ‖
/// taker(32) ‖ u64 window ‖ u128 fee ‖ u64 listed_at ‖ Bytes(chain) ‖
/// Bytes(key)`.
const LISTING_MAX: usize = 32 + 32 + 16 + 8 + 32 + 8 + 16 + 8 + 4 + MAX_CHAIN + 4 + MAX_KEY;
/// `maker(32) ‖ coin(32) ‖ u128 amount ‖ taker(32) ‖ hash(32) ‖ u64 t1 ‖ u64
/// deadline ‖ u128 fee`
const LOCK_BYTES: usize = 32 + 32 + 16 + 32 + 32 + 8 + 8 + 16;

fn record_key(kind: u8, id: u64) -> [u8; 32] {
    let mut key = ZERO;
    key[0] = kind;
    key[1..9].copy_from_slice(&id.to_le_bytes());
    key
}

fn listing_key(id: u64) -> [u8; 32] {
    record_key(1, id)
}

fn lock_key(id: u64) -> [u8; 32] {
    record_key(3, id)
}

fn policy_account(policy: &[u8], params: &[u8]) -> [u8; 32] {
    tagged(
        TAG_POLICY,
        &[policy, &(params.len() as u32).to_le_bytes(), params],
    )
}

fn contract_account(owner: &[u8; 32]) -> [u8; 32] {
    tagged(TAG_CONTRACT, &[owner])
}

fn framed(bytes: &[u8]) -> Vec<u8> {
    [&(bytes.len() as u32).to_le_bytes()[..], bytes].concat()
}

/// Emits one of the program's own events: the topic, the kind, the listing's
/// id and the rest.
fn emit(kind: u8, id: u64, parts: &[&[u8]]) {
    let mut payload = Vec::new();
    payload.extend_from_slice(&TOPIC);
    payload.push(kind);
    payload.extend_from_slice(&id.to_le_bytes());
    for part in parts {
        payload.extend_from_slice(part);
    }
    host::emit_event(&payload);
}

// ---- Decoding --------------------------------------------------------------------

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
    error: &'static [u8],
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8], error: &'static [u8]) -> Self {
        Self {
            bytes,
            at: 0,
            error,
        }
    }

    fn take(&mut self, n: usize) -> &'a [u8] {
        if n > self.bytes.len() - self.at {
            fail(self.error);
        }
        let out = &self.bytes[self.at..self.at + n];
        self.at += n;
        out
    }

    fn array<const N: usize>(&mut self) -> [u8; N] {
        let mut out = [0; N];
        out.copy_from_slice(self.take(N));
        out
    }

    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }

    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.array())
    }

    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.array())
    }

    fn u128(&mut self) -> u128 {
        u128::from_le_bytes(self.array())
    }

    fn bytes(&mut self) -> &'a [u8] {
        let len = self.u32() as usize;
        self.take(len)
    }

    /// `Bytes(x)` of 1 to `max` bytes; `bad input` otherwise.
    fn data(&mut self, max: usize) -> &'a [u8] {
        let data = self.bytes();
        if data.is_empty() || data.len() > max {
            fail(b"bad input");
        }
        data
    }

    fn end(&self) {
        if self.at != self.bytes.len() {
            fail(self.error);
        }
    }
}

// ---- Listings and locks ------------------------------------------------------------

struct Listing {
    maker: [u8; 32],
    coin: [u8; 32],
    amount: u128,
    want: u64,
    /// The one account that may take it, or zero for anyone.
    taker: [u8; 32],
    window: u64,
    /// What a claim or a refund pays the miner of its block, out of `amount`.
    fee: u128,
    listed_at: u64,
    chain: Vec<u8>,
    key: Vec<u8>,
}

impl Listing {
    fn load(id: u64) -> Option<Self> {
        let mut buf = [0u8; LISTING_MAX];
        let len = match host::get_into(&listing_key(id), &mut buf) {
            None => return None,
            Some(len) if len <= LISTING_MAX => len,
            Some(_) => fail(b"corrupt"),
        };
        let mut r = Reader::new(&buf[..len], b"corrupt");
        let listing = Listing {
            maker: r.array(),
            coin: r.array(),
            amount: r.u128(),
            want: r.u64(),
            taker: r.array(),
            window: r.u64(),
            fee: r.u128(),
            listed_at: r.u64(),
            chain: r.bytes().to_vec(),
            key: r.bytes().to_vec(),
        };
        r.end();
        Some(listing)
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(LISTING_MAX);
        out.extend_from_slice(&self.maker);
        out.extend_from_slice(&self.coin);
        out.extend_from_slice(&self.amount.to_le_bytes());
        out.extend_from_slice(&self.want.to_le_bytes());
        out.extend_from_slice(&self.taker);
        out.extend_from_slice(&self.window.to_le_bytes());
        out.extend_from_slice(&self.fee.to_le_bytes());
        out.extend_from_slice(&self.listed_at.to_le_bytes());
        out.extend_from_slice(&framed(&self.chain));
        out.extend_from_slice(&framed(&self.key));
        out
    }
}

/// An accepted listing's coins, held for its taker under a hash until a
/// deadline. It keeps its listing's id.
struct Lock {
    maker: [u8; 32],
    coin: [u8; 32],
    amount: u128,
    taker: [u8; 32],
    hash: [u8; 32],
    t1: u64,
    deadline: u64,
    /// What a claim or a refund pays the miner of its block, out of `amount`.
    fee: u128,
}

impl Lock {
    fn load(id: u64) -> Option<Self> {
        let mut buf = [0u8; LOCK_BYTES];
        match host::get_into(&lock_key(id), &mut buf) {
            None => return None,
            Some(LOCK_BYTES) => {}
            Some(_) => fail(b"corrupt"),
        }
        let mut r = Reader::new(&buf, b"corrupt");
        Some(Lock {
            maker: r.array(),
            coin: r.array(),
            amount: r.u128(),
            taker: r.array(),
            hash: r.array(),
            t1: r.u64(),
            deadline: r.u64(),
            fee: r.u128(),
        })
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(LOCK_BYTES);
        out.extend_from_slice(&self.maker);
        out.extend_from_slice(&self.coin);
        out.extend_from_slice(&self.amount.to_le_bytes());
        out.extend_from_slice(&self.taker);
        out.extend_from_slice(&self.hash);
        out.extend_from_slice(&self.t1.to_le_bytes());
        out.extend_from_slice(&self.deadline.to_le_bytes());
        out.extend_from_slice(&self.fee.to_le_bytes());
        out
    }
}

fn count() -> u64 {
    let mut value = [0u8; 8];
    match host::get_into(&COUNT_KEY, &mut value) {
        None => 0,
        Some(8) => u64::from_le_bytes(value),
        Some(_) => fail(b"corrupt"),
    }
}

// ---- Payments through the coin ---------------------------------------------------------

/// A signed coin action, `10 ‖ auth ‖ action`, from a policy account, in `coin`.
struct Payment<'a> {
    coin: [u8; 32],
    raw: &'a [u8],
    payer: [u8; 32],
    /// The recipient of a transfer; none for a burn, which no operation takes.
    to: Option<[u8; 32]>,
    amount: u128,
}

/// Decodes a coin action exactly as the coin will, and requires it to be bound
/// to this program and to `digest`.
fn payment<'a>(coin: [u8; 32], raw: &'a [u8], me: &[u8; 32], digest: &[u8; 32]) -> Payment<'a> {
    let mut r = Reader::new(raw, b"bad payment");
    if r.u8() != 0x10 || r.u8() != 0x00 {
        fail(b"bad payment");
    }
    let policy = r.take(32);
    let params = r.bytes();
    r.u64();
    r.bytes();
    let to = match r.u8() {
        1 => Some(r.array()),
        2 => None,
        _ => fail(b"bad payment"),
    };
    let amount = r.u128();
    // fee, tip, not_before and valid_until are the coin's to check
    r.take(16 + 16 + 8 + 8);
    if r.u8() != 1 || r.array::<32>() != *me || r.array::<32>() != *digest {
        fail(b"not bound");
    }
    r.end();
    Payment {
        coin,
        raw,
        payer: policy_account(policy, params),
        to,
        amount,
    }
}

/// Runs a payment, answering the coin's query for the digest meanwhile.
fn pay(payment: &Payment, digest: &[u8; 32]) {
    host::set(&DIGEST_KEY, digest);
    let (status, result) = host::call_child(&payment.coin, payment.raw, host::ORDINARY);
    host::delete(&DIGEST_KEY);
    if status != 0 {
        fail(&[b"payment: ".as_slice(), &result].concat());
    }
}

/// Sends `amount` of `coin` from this program's own contract account to `to`:
/// a coin action of a contract account, with no binding. It also pays `fee`,
/// to the payout account of the block that includes it; a block with none
/// pays nothing, and the fee stays in the program's account.
fn send(coin: &[u8; 32], to: &[u8; 32], amount: u128, fee: u128) {
    let mut input = vec![0x10, 0x01, 0x01];
    input.extend_from_slice(to);
    input.extend_from_slice(&amount.to_le_bytes());
    input.extend_from_slice(&fee.to_le_bytes());
    input.extend_from_slice(&[0; 16 + 8 + 8 + 1]);
    let (status, result) = host::call_child(coin, &input, host::ORDINARY);
    if status != 0 {
        fail(&[b"coin: ".as_slice(), &result].concat());
    }
}

/// Asks a policy, read-only, whether it authorizes `message` now. A delay is
/// refused: the program holds nothing for an account with one.
fn authorize(policy: &[u8; 32], params: &[u8], message: &[u8], witness: &[u8]) {
    let input = [framed(params), framed(message), framed(witness)].concat();
    let (status, result) = host::call_child(policy, &input, host::READ_ONLY);
    if status != 0 || result.as_slice() != [1] {
        fail(b"not authorized");
    }
}

fn nonce_of(account: &[u8; 32]) -> ([u8; 32], u64) {
    let key = tagged(TAG_NONCE, &[account]);
    let mut value = [0u8; 8];
    match host::get_into(&key, &mut value) {
        None => (key, 0),
        Some(8) => (key, u64::from_le_bytes(value)),
        Some(_) => fail(b"corrupt"),
    }
}

// ---- Entry ---------------------------------------------------------------------------

#[unsafe(no_mangle)]
pub extern "C" fn invoke() {
    let input = host::read_input();
    if input == [0x00] {
        let mut out = [0u8; 32];
        if host::get_into(&DIGEST_KEY, &mut out) == Some(32) {
            host::finish(&out);
        }
        // Read only when the answer is a failure, so that a payment's query stays cheap.
        if host::get_into(&CONFIG_KEY, &mut []).is_none() {
            fail(b"bad deploy input");
        }
        fail(b"not running");
    }
    let mut version = [0u8; 1];
    match host::get_into(&CONFIG_KEY, &mut version) {
        None => deploy(&input),
        Some(1) if version == [1] => {}
        Some(_) => fail(b"corrupt"),
    }
    // Inputs shorter than a hash are the program's queries; the rest begin with
    // a tag of the program's own, a template's hash, or TCR-1's run or cancel.
    if input.len() < 32 {
        let mut r = Reader::new(&input, b"bad input");
        match r.u8() {
            0x08 => {
                let id = r.u64();
                r.end();
                match Listing::load(id) {
                    Some(listing) => host::finish(&listing.encode()),
                    None => fail(b"not listed"),
                }
            }
            0x09 => {
                r.end();
                host::finish(&count().to_le_bytes())
            }
            0x0a => {
                let id = r.u64();
                r.end();
                match Lock::load(id) {
                    Some(lock) => host::finish(&lock.encode()),
                    None => fail(b"not locked"),
                }
            }
            _ => fail(b"bad input"),
        }
    }
    let rest = &input[32..];
    match input[..32].try_into().unwrap() {
        TAKE => take(rest),
        CLAIM => claim(rest),
        REFUND => refund(rest),
        RELEASE => release(rest),
        // The program schedules nothing, so there is never anything to run or cancel.
        RUN | CANCEL => fail(b"not scheduled"),
        _ => call(&host::self_id(), &input),
    }
}

/// Stores the version, and the template list for wallets to read.
fn deploy(input: &[u8]) -> ! {
    if input != [1] {
        fail(b"bad deploy input");
    }
    host::set(&CONFIG_KEY, &[1]);
    let mut list = (TEMPLATES.len() as u64).to_le_bytes().to_vec();
    for (_, text) in TEMPLATES {
        list.extend_from_slice(&framed(text));
    }
    host::set(&TEMPLATES_KEY, &list);
    host::finish(&[])
}

// ---- Takes, claims, refunds and releases -------------------------------------------------

/// `u64 id ‖ taker(32) ‖ hash(32) ‖ u64 t1 ‖ Bytes(lock)`: a buyer's lock on
/// the other chain, for the maker to check and accept. It stores nothing.
fn take(input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    let id = r.u64();
    let taker: [u8; 32] = r.array();
    let hash: [u8; 32] = r.array();
    let t1 = r.u64();
    let lock = r.data(MAX_DATA);
    r.end();
    let Some(listing) = Listing::load(id) else {
        fail(b"not listed");
    };
    check_taker(&listing.taker, &taker);
    // So that the take can still be accepted.
    check_gap(listing.window, t1);
    emit(
        TAKEN,
        id,
        &[&taker, &hash, &t1.to_le_bytes(), &framed(lock)],
    );
    host::finish(&[])
}

/// `u64 id ‖ secret(32)`: the lock's coins to its taker, its fee to the
/// block's producer, revealing the secret. Anyone who knows it may claim.
fn claim(input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    let id = r.u64();
    let secret: [u8; 32] = r.array();
    r.end();
    let Some(lock) = Lock::load(id) else {
        fail(b"not locked");
    };
    if host::now() > lock.deadline {
        fail(b"too late");
    }
    if sha256(&secret) != lock.hash {
        fail(b"wrong secret");
    }
    // The lock goes first: nothing can find it while its coins move. An offer
    // keeps the fee at a thousandth of the amount at most, so the subtraction
    // cannot wrap.
    host::delete(&lock_key(id));
    let (fee, paid) = (lock.fee, lock.amount - lock.fee);
    send(&lock.coin, &lock.taker, paid, fee);
    emit(
        CLAIMED,
        id,
        &[
            &lock.taker,
            &secret,
            &paid.to_le_bytes(),
            &fee.to_le_bytes(),
        ],
    );
    host::finish(&[])
}

/// `u64 id`: after the deadline, the lock's coins back to its maker, its fee to
/// the block's producer. Anyone may refund.
fn refund(input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    let id = r.u64();
    r.end();
    let Some(lock) = Lock::load(id) else {
        fail(b"not locked");
    };
    if host::now() <= lock.deadline {
        fail(b"too early");
    }
    host::delete(&lock_key(id));
    let (fee, paid) = (lock.fee, lock.amount - lock.fee);
    send(&lock.coin, &lock.maker, paid, fee);
    emit(
        REFUNDED,
        id,
        &[&lock.maker, &paid.to_le_bytes(), &fee.to_le_bytes()],
    );
    host::finish(&[])
}

/// `u64 id ‖ Bytes(data)`: what lets a buyer whose take was not accepted have
/// their lock back early, posted for them to find. It stores nothing.
fn release(input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    let id = r.u64();
    let data = r.data(MAX_DATA);
    r.end();
    if id == 0 || id > count() {
        fail(b"not listed");
    }
    emit(RELEASED, id, &[&framed(data)]);
    host::finish(&[])
}

// ---- Signed operations -----------------------------------------------------------------

/// One operation's values, decoded as its template declares them.
struct Call<'a> {
    op: Op,
    /// The listing an accept or a withdrawal names; 0 for an offer.
    listing: u64,
    /// The one account an `offer_to` is for, or an accept holds the coins for;
    /// zero for an offer for anyone and for a withdrawal.
    taker: [u8; 32],
    /// An offer's other chain, the amount it wants there, the maker's key
    /// there, and how long it holds the coins once accepted.
    chain: &'a [u8],
    want: u64,
    key: &'a [u8],
    window: u64,
    /// An accept's hash and the end of the buyer's lock on the other chain.
    hash: [u8; 32],
    until: u64,
    /// The `amount` field: an offer's fee, what an accept holds, what a
    /// withdrawal gets back.
    coin: [u8; 32],
    amount: u128,
}

impl<'a> Call<'a> {
    /// Reads the template hash and the values after it, in the order the
    /// template declares them.
    fn decode(r: &mut Reader<'a>) -> Self {
        let hash: [u8; 32] = r.array();
        let Some(i) = TEMPLATE_HASHES.iter().position(|t| *t == hash) else {
            fail(b"bad input");
        };
        let mut call = Call {
            op: TEMPLATES[i].0,
            listing: 0,
            taker: ZERO,
            chain: &[],
            want: 0,
            key: &[],
            window: 0,
            hash: ZERO,
            until: 0,
            coin: ZERO,
            amount: 0,
        };
        match call.op {
            Op::Offer | Op::OfferTo => {
                if call.op == Op::OfferTo {
                    call.taker = r.array();
                }
                // The chain by its enum index, empty when there is none (`bad
                // chain`); the amount as whole coins and eight decimal digits,
                // 0 when a digit is not one or it does not fit (`bad amount`).
                call.chain = CHAINS.get(r.u8() as usize).copied().unwrap_or(&[]);
                let whole = r.u64();
                let digits: [u8; 8] = r.array();
                call.want = digits
                    .iter()
                    .try_fold(0u64, |frac, &d| (d <= 9).then(|| frac * 10 + d as u64))
                    .and_then(|frac| whole.checked_mul(UNITS)?.checked_add(frac))
                    .unwrap_or(0);
                call.key = r.bytes();
                call.window = r.u64();
            }
            Op::Accept => {
                call.listing = r.u64();
                call.taker = r.array();
                call.hash = r.array();
                call.until = r.u64();
            }
            Op::Withdraw => call.listing = r.u64(),
        }
        call.coin = r.array();
        call.amount = r.u128();
        call
    }

    /// The operations that move the actor's coins, and so carry a payment; an
    /// accept or a withdrawal takes a fee payment or none.
    fn pays(&self) -> bool {
        matches!(self.op, Op::Offer | Op::OfferTo)
    }

    /// An offer's values that need nothing else to check.
    fn check(&self) {
        if !self.pays() {
            return;
        }
        if self.want == 0 {
            fail(b"bad amount");
        }
        if self.chain.is_empty() {
            fail(b"bad chain");
        }
        if self.key.is_empty() || self.key.len() > MAX_KEY {
            fail(b"bad key");
        }
        if self.window < MIN_WINDOW || self.window > MAX_WINDOW {
            fail(b"bad window");
        }
        if self.op == Op::OfferTo && self.taker == ZERO {
            fail(b"bad taker");
        }
    }
}

/// `T ‖ values ‖ auth ‖ payments`. `auth` is `00 ‖ policy(32) ‖ Bytes(params)
/// ‖ u64 nonce ‖ u64 valid_until ‖ Bytes(witness)` for a policy account, or
/// `01` for the calling program's own account; `payments` is `00`, or `01 ‖
/// coin(32) ‖ Bytes(coin input)`.
fn call(me: &[u8; 32], input: &[u8]) -> ! {
    let mut r = Reader::new(input, b"bad input");
    let call = Call::decode(&mut r);
    let head = &input[..r.at];
    let operation = tagged(TAG_OPERATION, &[head]);
    let signer = match r.u8() {
        0x00 => Some((r.array::<32>(), r.bytes(), r.u64(), r.u64(), r.bytes())),
        0x01 => None,
        _ => fail(b"bad input"),
    };
    let paid = match r.u8() {
        0x00 => None,
        0x01 => Some((r.array::<32>(), r.bytes())),
        _ => fail(b"bad input"),
    };
    r.end();
    call.check();

    let Some((policy, params, nonce, valid_until, witness)) = signer else {
        // A program acting as its own account: no nonce, no deadline and no
        // payment. It cannot pay, so it never offers, and never made a
        // listing to accept or withdraw.
        if paid.is_some() {
            fail(b"bad input");
        }
        let Some(caller) = host::caller() else {
            fail(b"no calling contract");
        };
        if call.pays() {
            fail(b"needs payment");
        }
        let account = contract_account(&caller);
        let listing = prepare(me, &call, &account, None);
        finish(&call, &account, None, listing);
        emit_executed(&account, 0, &operation);
        host::finish(&[]);
    };

    if call.pays() && paid.is_none() {
        fail(b"needs payment");
    }
    if valid_until != 0 && host::now() > valid_until {
        fail(b"expired");
    }
    let account = policy_account(&policy, params);
    let (nonce_key, stored) = nonce_of(&account);
    if nonce != stored {
        fail(b"bad nonce");
    }
    let mut message = framed(CALL_TAG);
    for part in [
        &host::chain_id()[..],
        me,
        &account,
        &[0x01],
        &nonce.to_le_bytes(),
        &valid_until.to_le_bytes(),
        &operation,
    ] {
        message.extend_from_slice(part);
    }
    let digest = tagged(TAG_SIGN, &[&message]);
    // A payment comes from the acting account, and is its approval: the coin
    // checks its signature over a message that holds `digest`. An accept or a
    // withdrawal takes a fee payment, a transfer of 0 to the program's own
    // account that carries only the fee (TCR-1, fee payments).
    let payment = paid.map(|(coin, raw)| {
        check_coin(&coin);
        let payment = payment(coin, raw, me, &digest);
        if payment.payer != account {
            fail(b"bad payment");
        }
        if !call.pays() && !(payment.to == Some(contract_account(me)) && payment.amount == 0) {
            fail(b"bad payment");
        }
        if !witness.is_empty() {
            fail(b"bad input");
        }
        payment
    });

    // What the operation needs, checked before the approval, which costs most.
    let listing = prepare(me, &call, &account, payment.as_ref());

    if payment.is_none() {
        authorize(&policy, params, &message, witness);
    }
    let Some(next) = nonce.checked_add(1) else {
        fail(b"nonce exhausted");
    };
    host::set(&nonce_key, &next.to_le_bytes());
    if let Some(payment) = &payment {
        pay(payment, &digest);
    }
    finish(&call, &account, payment.as_ref(), listing);
    emit_executed(&account, nonce, &operation);
    host::finish(&[])
}

fn emit_executed(account: &[u8; 32], sequence: u64, operation: &[u8; 32]) {
    let payload = [&EXECUTED[..], account, &sequence.to_le_bytes(), operation].concat();
    host::emit_event(&payload);
}

/// Checks what the operation needs: for an offer, its payment into the
/// program's account and its fee; for an accept or a withdrawal, the
/// listing it names, which it returns.
fn prepare(
    me: &[u8; 32],
    call: &Call,
    account: &[u8; 32],
    payment: Option<&Payment>,
) -> Option<Listing> {
    match call.op {
        Op::Offer | Op::OfferTo => {
            let payment = payment.unwrap();
            if payment.to != Some(contract_account(me)) {
                fail(b"bad payment");
            }
            if payment.amount == 0 {
                fail(b"bad amount");
            }
            if call.coin != payment.coin {
                fail(b"bad coin");
            }
            // `fee * FEE_SHARE <= amount`, in a form that cannot overflow.
            if call.amount > payment.amount / FEE_SHARE {
                fail(b"bad fee");
            }
            None
        }
        Op::Accept => {
            let Some(listing) = Listing::load(call.listing) else {
                fail(b"not listed");
            };
            if listing.maker != *account {
                fail(b"not maker");
            }
            if call.coin != listing.coin || call.amount != listing.amount {
                fail(b"listing changed");
            }
            check_taker(&listing.taker, &call.taker);
            check_gap(listing.window, call.until);
            Some(listing)
        }
        Op::Withdraw => {
            let Some(listing) = Listing::load(call.listing) else {
                fail(b"not listed");
            };
            if listing.maker != *account {
                fail(b"not maker");
            }
            if call.coin != listing.coin || call.amount != listing.amount {
                fail(b"listing changed");
            }
            Some(listing)
        }
    }
}

/// Does the operation for `account`, once it is approved and paid.
fn finish(call: &Call, account: &[u8; 32], payment: Option<&Payment>, listing: Option<Listing>) {
    match (call.op, listing) {
        (Op::Offer | Op::OfferTo, None) => {
            let payment = payment.unwrap();
            let Some(id) = count().checked_add(1) else {
                fail(b"too many listings");
            };
            let listing = Listing {
                maker: *account,
                coin: payment.coin,
                amount: payment.amount,
                want: call.want,
                taker: call.taker,
                window: call.window,
                fee: call.amount,
                listed_at: host::now(),
                chain: call.chain.to_vec(),
                key: call.key.to_vec(),
            };
            host::set(&listing_key(id), &listing.encode());
            host::set(&COUNT_KEY, &id.to_le_bytes());
            emit(
                LISTED,
                id,
                &[
                    account,
                    &listing.coin,
                    &listing.amount.to_le_bytes(),
                    &listing.want.to_le_bytes(),
                    &listing.taker,
                    &listing.window.to_le_bytes(),
                    &listing.fee.to_le_bytes(),
                    &framed(&listing.chain),
                    &framed(&listing.key),
                ],
            );
        }
        (Op::Accept, Some(listing)) => {
            // The listing becomes the lock, under the same id: nothing can
            // withdraw it any more, and only a claim or a refund ends it.
            let lock = Lock {
                maker: listing.maker,
                coin: listing.coin,
                amount: listing.amount,
                taker: call.taker,
                hash: call.hash,
                t1: call.until,
                deadline: deadline(listing.window),
                fee: listing.fee,
            };
            host::delete(&listing_key(call.listing));
            host::set(&lock_key(call.listing), &lock.encode());
            emit(
                ACCEPTED,
                call.listing,
                &[
                    &lock.maker,
                    &lock.taker,
                    &lock.hash,
                    &lock.t1.to_le_bytes(),
                    &lock.deadline.to_le_bytes(),
                    &lock.coin,
                    &lock.amount.to_le_bytes(),
                ],
            );
        }
        (Op::Withdraw, Some(listing)) => {
            host::delete(&listing_key(call.listing));
            send(&listing.coin, &listing.maker, listing.amount, 0);
            emit(
                WITHDRAWN,
                call.listing,
                &[&listing.maker, &listing.coin, &listing.amount.to_le_bytes()],
            );
        }
        _ => fail(b"corrupt"),
    }
}
