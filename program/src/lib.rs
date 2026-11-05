//! Ting Swap: listings that offer an amount of one coin for an amount of
//! another. The maker's coins wait in the program's own account until someone
//! takes the listing, paying the maker, or the maker withdraws it. SPEC.md
//! states the rules; this file follows it.
//!
//! Every operation is a call of TCR-1, Ting Call Requests: a template of the
//! program's own and its values, approved by the acting account. An operation
//! that moves coins carries a coin payment from the acting account, bound to
//! the call's signing digest (wiki: programs/conventions, bound actions): the
//! payment pays for that one operation, and the coin's check of it is the
//! approval. The program holds nothing for an account with a delay: it
//! refuses delayed answers outright (TCR-1, now or later).
#![no_std]

extern crate alloc;

mod host;
mod sha256;

use alloc::{vec, vec::Vec};
use core::alloc::{GlobalAlloc, Layout};
use core::arch::wasm32;
use host::fail;
use sha256::{tagged, tagged_const};

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

// ---- The coins it trades ----------------------------------------------------------

/// The CodeHash of the coin reference program (Ting wiki: programs). The swap
/// calls a contract as a coin, and accepts a payment from one, only when it
/// runs this code: a contract that only claims to be a coin could report a
/// payment it never made.
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

// ---- TCR-1 ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq)]
enum Op {
    Offer,
    Take,
    Withdraw,
}

/// The program's templates (TCR-1): each declares its operation and fields,
/// then says what it does in the words a wallet shows. A call names one by its
/// hash.
const TEMPLATES: [(Op, &[u8]); 3] = [
    (
        Op::Offer,
        b"offer(want:amount): Offer {payment} in exchange for {want}",
    ),
    (
        Op::Take,
        b"take(listing:u64,get:amount): Take listing {listing}: pay {payment} and get {get}",
    ),
    (
        Op::Withdraw,
        b"withdraw(listing:u64,back:amount): Withdraw listing {listing} and get back {back}",
    ),
];

const TEMPLATE_HASHES: [[u8; 32]; 3] = {
    let mut out = [[0; 32]; 3];
    let mut i = 0;
    while i < 3 {
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

// ---- Layout ----------------------------------------------------------------------

/// Every event of the swap's own begins with this topic, so a page reads the
/// whole market's history with one filtered query.
const TOPIC: [u8; 32] = tagged_const(b"app/swap-v1/event", b"");
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

/// `maker(32) ‖ give_coin(32) ‖ u128 give ‖ want_coin(32) ‖ u128 want ‖ u64 listed_at`
const LISTING_BYTES: usize = 32 + 32 + 16 + 32 + 16 + 8;

fn listing_key(id: u64) -> [u8; 32] {
    let mut key = ZERO;
    key[0] = 1;
    key[1..9].copy_from_slice(&id.to_le_bytes());
    key
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

fn emit(parts: &[&[u8]]) {
    let mut payload = Vec::new();
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

    fn end(&self) {
        if self.at != self.bytes.len() {
            fail(self.error);
        }
    }
}

// ---- Listings --------------------------------------------------------------------

struct Listing {
    maker: [u8; 32],
    give_coin: [u8; 32],
    give: u128,
    want_coin: [u8; 32],
    want: u128,
    listed_at: u64,
}

impl Listing {
    fn load(id: u64) -> Option<Self> {
        let mut buf = [0u8; LISTING_BYTES];
        match host::get_into(&listing_key(id), &mut buf) {
            None => return None,
            Some(LISTING_BYTES) => {}
            Some(_) => fail(b"corrupt"),
        }
        let mut r = Reader::new(&buf, b"corrupt");
        Some(Listing {
            maker: r.array(),
            give_coin: r.array(),
            give: r.u128(),
            want_coin: r.array(),
            want: r.u128(),
            listed_at: r.u64(),
        })
    }

    fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(LISTING_BYTES);
        out.extend_from_slice(&self.maker);
        out.extend_from_slice(&self.give_coin);
        out.extend_from_slice(&self.give.to_le_bytes());
        out.extend_from_slice(&self.want_coin);
        out.extend_from_slice(&self.want.to_le_bytes());
        out.extend_from_slice(&self.listed_at.to_le_bytes());
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
/// a coin action of a contract account, with no fee and no binding.
fn send(coin: &[u8; 32], to: &[u8; 32], amount: u128) {
    let mut input = vec![0x10, 0x01, 0x01];
    input.extend_from_slice(to);
    input.extend_from_slice(&amount.to_le_bytes());
    input.extend_from_slice(&[0; 16 + 16 + 8 + 8 + 1]);
    let (status, result) = host::call_child(coin, &input, host::ORDINARY);
    if status != 0 {
        fail(&[b"coin: ".as_slice(), &result].concat());
    }
}

/// Asks a policy, read-only, whether it authorizes `message` now. A delay is
/// refused: the swap holds nothing for an account with one.
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
    // Inputs shorter than a hash are the program's own; the rest begin with
    // a template's hash, or TCR-1's run or cancel.
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
            _ => fail(b"bad input"),
        }
    }
    match input[..32].try_into().unwrap() {
        // The swap schedules nothing, so there is never anything to run or cancel.
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

/// One operation's values, decoded as its template declares them.
struct Call {
    op: Op,
    /// The listing a take or a withdrawal names; 0 for an offer.
    listing: u64,
    /// The `amount` field: what an offer wants, what a take gets, what a
    /// withdrawal gets back.
    coin: [u8; 32],
    amount: u128,
}

impl Call {
    /// Reads the template hash and the values after it, in the order the
    /// template declares them.
    fn decode(r: &mut Reader) -> Self {
        let hash: [u8; 32] = r.array();
        let Some(i) = TEMPLATE_HASHES.iter().position(|t| *t == hash) else {
            fail(b"bad input");
        };
        let op = TEMPLATES[i].0;
        let listing = if op == Op::Offer { 0 } else { r.u64() };
        Call {
            op,
            listing,
            coin: r.array(),
            amount: r.u128(),
        }
    }

    /// The operations that move the actor's coins, and so carry a payment; a
    /// withdrawal takes a fee payment or none.
    fn pays(&self) -> bool {
        matches!(self.op, Op::Offer | Op::Take)
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
    if call.op == Op::Offer && call.amount == 0 {
        fail(b"bad amount");
    }

    let Some((policy, params, nonce, valid_until, witness)) = signer else {
        // A program acting as its own account: no nonce, no deadline and no
        // payment. It cannot pay, so it neither offers nor takes, and never
        // made a listing to withdraw.
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
        emit(&[&EXECUTED, &account, &0u64.to_le_bytes(), &operation]);
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
    // checks its signature over a message that holds `digest`. A withdrawal
    // takes a fee payment, a transfer of 0 to the swap's own account that
    // carries only the fee (TCR-1, fee payments).
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
    emit(&[&EXECUTED, &account, &nonce.to_le_bytes(), &operation]);
    host::finish(&[])
}

/// Checks what the operation needs: for an offer, its coins and its payment
/// into the swap's account; for a take or a withdrawal, the listing it names,
/// which it returns.
fn prepare(
    me: &[u8; 32],
    call: &Call,
    account: &[u8; 32],
    payment: Option<&Payment>,
) -> Option<Listing> {
    match call.op {
        Op::Offer => {
            let payment = payment.unwrap();
            if payment.to != Some(contract_account(me)) {
                fail(b"bad payment");
            }
            if payment.amount == 0 {
                fail(b"bad amount");
            }
            if call.coin == payment.coin {
                fail(b"same coin");
            }
            check_coin(&call.coin);
            None
        }
        Op::Take => {
            let payment = payment.unwrap();
            let Some(listing) = Listing::load(call.listing) else {
                fail(b"not listed");
            };
            if call.coin != listing.give_coin || call.amount != listing.give {
                fail(b"listing changed");
            }
            if payment.coin != listing.want_coin {
                fail(b"bad coin");
            }
            if payment.to != Some(listing.maker) {
                fail(b"bad payment");
            }
            if payment.amount != listing.want {
                fail(b"wrong amount");
            }
            Some(listing)
        }
        Op::Withdraw => {
            let Some(listing) = Listing::load(call.listing) else {
                fail(b"not listed");
            };
            if listing.maker != *account {
                fail(b"not maker");
            }
            if call.coin != listing.give_coin || call.amount != listing.give {
                fail(b"listing changed");
            }
            Some(listing)
        }
    }
}

/// Does the operation for `account`, once it is approved and paid.
fn finish(call: &Call, account: &[u8; 32], payment: Option<&Payment>, listing: Option<Listing>) {
    match (call.op, listing) {
        (Op::Offer, None) => {
            let payment = payment.unwrap();
            let Some(id) = count().checked_add(1) else {
                fail(b"too many listings");
            };
            let listing = Listing {
                maker: *account,
                give_coin: payment.coin,
                give: payment.amount,
                want_coin: call.coin,
                want: call.amount,
                listed_at: host::now(),
            };
            host::set(&listing_key(id), &listing.encode());
            host::set(&COUNT_KEY, &id.to_le_bytes());
            emit(&[
                &TOPIC,
                &[1],
                &id.to_le_bytes(),
                account,
                &listing.give_coin,
                &listing.give.to_le_bytes(),
                &listing.want_coin,
                &listing.want.to_le_bytes(),
            ]);
        }
        (Op::Take, Some(listing)) => {
            // The listing goes first: nothing can find it open while its coins move.
            host::delete(&listing_key(call.listing));
            send(&listing.give_coin, account, listing.give);
            emit(&[
                &TOPIC,
                &[2],
                &call.listing.to_le_bytes(),
                &listing.maker,
                account,
                &listing.give_coin,
                &listing.give.to_le_bytes(),
                &listing.want_coin,
                &listing.want.to_le_bytes(),
            ]);
        }
        (Op::Withdraw, Some(listing)) => {
            host::delete(&listing_key(call.listing));
            send(&listing.give_coin, &listing.maker, listing.give);
            emit(&[
                &TOPIC,
                &[3],
                &call.listing.to_le_bytes(),
                &listing.maker,
                &listing.give_coin,
                &listing.give.to_le_bytes(),
            ]);
        }
        _ => fail(b"corrupt"),
    }
}
