//! The HTLC program on Ting's reference VM, paying through the real coin
//! program, with two coins. Accounts sign through stub policies that approve
//! every message, as in tests/swap.rs: one at once, one only after a delay as a
//! savings account does, and one that answers by its witness. The block
//! timestamp is the tests' own to set, so every deadline is tried at its exact
//! boundary. The hashes of secrets come from the reference `sha256` program,
//! not from the HTLC's own code.
use std::fs;
use ting_core::{
    hash::{hash, hash_parts},
    meter::Resources,
    protocol::{Genesis, Payload, Receipt, Status, Transaction},
    state::{State, record_key},
    vm::{Context, Runtime, profile},
};

type Id = [u8; 32];

const BUDGET: Resources = Resources([200_000_000, 4096, 4_000_000, 4_000_000]);

const OFFER: &str = "offer(chain:enum(LTC|BTC),whole:u64,d1:u8,d2:u8,d3:u8,d4:u8,d5:u8,d6:u8,d7:u8,d8:u8,key:bytes,window:duration,fee:amount): Sell {payment} for {whole}.{d1}{d2}{d3}{d4}{d5}{d6}{d7}{d8} {chain}, paid to your {chain} key ({key}). Once a buyer's lock is accepted, the coins are held for them for {window}. The buyer's claim, or a refund, pays a network fee of {fee} out of these coins";
const OFFER_TO: &str = "offer_to(taker:account,chain:enum(LTC|BTC),whole:u64,d1:u8,d2:u8,d3:u8,d4:u8,d5:u8,d6:u8,d7:u8,d8:u8,key:bytes,window:duration,fee:amount): Sell {payment} to {taker} only, for {whole}.{d1}{d2}{d3}{d4}{d5}{d6}{d7}{d8} {chain}, paid to your {chain} key ({key}). Once their lock is accepted, the coins are held for them for {window}. Their claim, or a refund, pays a network fee of {fee} out of these coins";
const ACCEPT: &str = "accept(listing:u64,taker:account,hash:bytes32,until:time,give:amount): Accept a lock for listing {listing}: hold {give} for {taker} until they reveal the secret of {hash}, before their lock ends {until}";
const WITHDRAW: &str =
    "withdraw(listing:u64,back:amount): Withdraw listing {listing} and get back {back}";

/// The CodeHash of the coin reference program, which the program insists on.
const COIN_CODE: &str = "c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6";

const GAP: u64 = 21_600;
const MIN_WINDOW: u64 = 3_600;
const MAX_WINDOW: u64 = 604_800;

/// The block timestamp the tests start at.
const T0: u64 = 1_800_000_000;
/// A listing's usual window: one day.
const WINDOW: u64 = 86_400;
/// What a listing usually wants: 0.025 LTC, in litoshis.
const WANT: u64 = 2_500_000;
/// A listing's usual fee, in its own coin: well within a thousandth of the
/// amounts the tests list.
const FEE: u128 = 10;
/// What each account holds of each coin at the start.
const START: u128 = 1_000_000_000;
/// An offer's fee is at most this share of its coins.
const FEE_SHARE: u128 = 1_000;
const ZERO: Id = [0; 32];

/// Answers `01` to every policy query, and nothing to its deployment.
const INSTANT_POLICY: &str = r#"(module
  (import "ting" "input" (func $input (param i32 i32) (result i32)))
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (data (i32.const 0) "\01")
  (func (export "invoke")
    (call $return (i32.const 0)
      (i32.ne (call $input (i32.const 0) (i32.const 0)) (i32.const 0)))))"#;

/// Answers `01 ‖ u64 100`: authorized only 100 seconds ahead.
const DELAYED_POLICY: &str = r#"(module
  (import "ting" "input" (func $input (param i32 i32) (result i32)))
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (data (i32.const 0) "\01\64\00\00\00\00\00\00\00")
  (func (export "invoke")
    (call $return (i32.const 0)
      (select (i32.const 9) (i32.const 0) (call $input (i32.const 0) (i32.const 0))))))"#;

/// Answers by the witness's length: `01` for none, `00`, a refusal, for one
/// byte, and `01 ‖ u64 100` for more: an account whose answer the test picks
/// by what it signs with.
const SWITCH_POLICY: &str = r#"(module
  (import "ting" "input" (func $input (param i32 i32) (result i32)))
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (data (i32.const 0) "\01\64\00\00\00\00\00\00\00")
  (data (i32.const 16) "\00")
  (func (export "invoke")
    (local $n i32) (local $p i32) (local $m i32) (local $w i32)
    (local.set $n (call $input (i32.const 64) (i32.const 60000)))
    (if (i32.eqz (local.get $n)) (then (call $return (i32.const 0) (i32.const 0)) (return)))
    (local.set $p (i32.load (i32.const 64)))
    (local.set $m (i32.load (i32.add (i32.const 68) (local.get $p))))
    (local.set $w (i32.load (i32.add (i32.const 72) (i32.add (local.get $p) (local.get $m)))))
    (if (i32.eqz (local.get $w)) (then (call $return (i32.const 0) (i32.const 1)) (return)))
    (if (i32.eq (local.get $w) (i32.const 1)) (then (call $return (i32.const 16) (i32.const 1)) (return)))
    (call $return (i32.const 0) (i32.const 9))))"#;

/// Answers `00`: authorizes nothing.
const REFUSING_POLICY: &str = r#"(module
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (func (export "invoke") (call $return (i32.const 0) (i32.const 1))))"#;

/// A contract that claims to be a coin: it succeeds at everything, paying nothing.
const FAKE_COIN: &str = r#"(module
  (import "ting" "return" (func $return (param i32 i32)))
  (memory (export "memory") 1 1)
  (func (export "invoke") (call $return (i32.const 0) (i32.const 0))))"#;

/// Calls `target(32)` with the rest of its input, so that its own contract
/// account acts.
const PROXY: &str = r#"(module
  (import "ting" "input" (func $input (param i32 i32) (result i32)))
  (import "ting" "call" (func $call (param i32 i32 i32 i32 i32) (result i32)))
  (import "ting" "call_result" (func $result (param i32 i32) (result i32)))
  (import "ting" "return" (func $return (param i32 i32)))
  (import "ting" "revert" (func $revert (param i32 i32)))
  (memory (export "memory") 1 1)
  (data (i32.const 0) "\00\2d\31\01\00\00\00\00\00\02\00\00\00\00\00\00\40\0d\03\00\00\00\00\00\40\0d\03\00\00\00\00\00")
  (func (export "invoke")
    (local $n i32) (local $status i32) (local $r i32)
    (local.set $n (call $input (i32.const 64) (i32.const 4096)))
    (if (i32.eqz (local.get $n)) (then (call $return (i32.const 0) (i32.const 0)) (return)))
    (local.set $status (call $call (i32.const 64) (i32.const 96)
      (i32.sub (local.get $n) (i32.const 32)) (i32.const 0) (i32.const 0)))
    (local.set $r (call $result (i32.const 8192) (i32.const 4096)))
    (if (local.get $status)
      (then (call $revert (i32.const 8192) (local.get $r)))
      (else (call $return (i32.const 8192) (local.get $r))))))"#;

fn bytes(b: &[u8]) -> Vec<u8> {
    [&(b.len() as u32).to_le_bytes()[..], b].concat()
}

fn unhex(text: &str) -> Id {
    let mut out = [0; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn template(text: &str) -> Id {
    hash("app/call-v1/template", text.as_bytes())
}

fn contract_account(owner: &Id) -> Id {
    hash("app/account-v1/contract", owner)
}

fn transfer(to: &Id, amount: u128) -> Vec<u8> {
    [&[1][..], to, &amount.to_le_bytes()].concat()
}

fn amount(coin: &Id, value: u128) -> Vec<u8> {
    [&coin[..], &value.to_le_bytes()].concat()
}

/// The head of a call: its template's hash and its values.
fn head(text: &str, values: &[&[u8]]) -> Vec<u8> {
    [&template(text)[..], &values.concat()].concat()
}

/// What an offer states besides its payment.
#[derive(Clone)]
struct Terms {
    /// `offer_to`'s taker; none for an `offer`.
    taker: Option<Id>,
    chain: Vec<u8>,
    want: u64,
    /// The amount's whole coins and eight digits as sent, in place of `want`'s.
    raw_amount: Option<(u64, [u8; 8])>,
    key: Vec<u8>,
    window: u64,
    fee_coin: Id,
    fee: u128,
}

impl Terms {
    fn with(&self, change: impl FnOnce(&mut Terms)) -> Terms {
        let mut terms = self.clone();
        change(&mut terms);
        terms
    }
}

fn offer_head(t: &Terms) -> Vec<u8> {
    // The chain by its enum index; any other name as an index past the last.
    let chain: u8 = match t.chain.as_slice() {
        b"LTC" => 0,
        b"BTC" => 1,
        _ => 0xff,
    };
    // The amount as whole coins and eight decimal digits, as the sentence shows it.
    let (whole, digits) = t.raw_amount.unwrap_or_else(|| {
        let frac = t.want % 100_000_000;
        let mut digits = [0u8; 8];
        for (i, d) in digits.iter_mut().enumerate() {
            *d = (frac / 10u64.pow(7 - i as u32) % 10) as u8;
        }
        (t.want / 100_000_000, digits)
    });
    let rest = [
        vec![chain],
        whole.to_le_bytes().to_vec(),
        digits.to_vec(),
        bytes(&t.key),
        t.window.to_le_bytes().to_vec(),
        amount(&t.fee_coin, t.fee),
    ]
    .concat();
    match t.taker {
        None => head(OFFER, &[&rest]),
        Some(taker) => head(OFFER_TO, &[&taker, &rest]),
    }
}

fn accept_head(id: u64, taker: &Id, hash: &Id, until: u64, coin: &Id, give: u128) -> Vec<u8> {
    head(
        ACCEPT,
        &[
            &id.to_le_bytes(),
            taker,
            hash,
            &until.to_le_bytes(),
            &amount(coin, give),
        ],
    )
}

fn withdraw_head(id: u64, coin: &Id, back: u128) -> Vec<u8> {
    head(WITHDRAW, &[&id.to_le_bytes(), &amount(coin, back)])
}

/// The tag that starts one of the program's own inputs.
fn tag(name: &str) -> Id {
    hash(&format!("app/htlc-v1/{name}"), b"")
}

fn take_input(id: u64, taker: &Id, hash: &Id, t1: u64, lock: &[u8]) -> Vec<u8> {
    [
        &tag("take")[..],
        &id.to_le_bytes(),
        taker,
        hash,
        &t1.to_le_bytes(),
        &bytes(lock),
    ]
    .concat()
}

fn claim_input(id: u64, secret: &Id) -> Vec<u8> {
    [&tag("claim")[..], &id.to_le_bytes(), secret].concat()
}

fn refund_input(id: u64) -> Vec<u8> {
    [&tag("refund")[..], &id.to_le_bytes()].concat()
}

fn release_input(id: u64, data: &[u8]) -> Vec<u8> {
    [&tag("release")[..], &id.to_le_bytes(), &bytes(data)].concat()
}

fn query(op: u8, id: u64) -> Vec<u8> {
    [&[op][..], &id.to_le_bytes()].concat()
}

/// A take's lock for Litecoin: version 1, the lock's transaction and output,
/// and the buyer's key.
fn ltc_lock(n: u8) -> Vec<u8> {
    [&[1][..], &[n; 32], &7u32.to_le_bytes(), &[3], &[n; 32]].concat()
}

/// A release's data for Litecoin: version 1, the lock's output, and the
/// seller's signature.
fn ltc_release(n: u8) -> Vec<u8> {
    [&[1][..], &[n; 32], &7u32.to_le_bytes(), &bytes(&[0x30; 71])].concat()
}

/// A seller's compressed secp256k1 key.
fn seller_key() -> Vec<u8> {
    [&[2][..], &[0x5e; 32]].concat()
}

fn listing_key(id: u64) -> Id {
    let mut key = [0; 32];
    key[0] = 1;
    key[1..9].copy_from_slice(&id.to_le_bytes());
    key
}

fn lock_key(id: u64) -> Id {
    let mut key = listing_key(id);
    key[0] = 3;
    key
}

const COUNT_KEY: Id = {
    let mut key = [0; 32];
    key[0] = 2;
    key
};

fn executed(account: &Id, sequence: u64, head: &[u8]) -> Vec<u8> {
    let mut e = hash("app/call-v1/event/executed", b"").to_vec();
    e.extend(account);
    e.extend(sequence.to_le_bytes());
    e.extend(hash("app/call-v1/operation", head));
    e
}

fn event(kind: u8, id: u64, parts: &[&[u8]]) -> Vec<u8> {
    let mut e = hash("app/htlc-v1/event", b"").to_vec();
    e.push(kind);
    e.extend(id.to_le_bytes());
    for part in parts {
        e.extend(*part);
    }
    e
}

fn listed(id: u64, l: &Listing) -> Vec<u8> {
    event(
        1,
        id,
        &[
            &l.maker,
            &l.coin,
            &l.amount.to_le_bytes(),
            &l.want.to_le_bytes(),
            &l.taker,
            &l.window.to_le_bytes(),
            &l.fee.to_le_bytes(),
            &bytes(&l.chain),
            &bytes(&l.key),
        ],
    )
}

#[track_caller]
fn ok(r: &Receipt) {
    assert_eq!(
        r.status,
        Status::Success,
        "{}",
        String::from_utf8_lossy(&r.result)
    );
}

#[track_caller]
fn reverts(r: &Receipt, reason: &str) {
    assert_eq!(
        r.status,
        Status::Revert,
        "expected a revert with {reason}, got {:?}",
        r.status
    );
    assert_eq!(String::from_utf8_lossy(&r.result), reason);
}

fn read(path: &str) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn wasm(text: &str) -> Vec<u8> {
    ting_swap_tools::pack(&wat::parse_str(text).unwrap()).unwrap()
}

fn htlc() -> Vec<u8> {
    let code = read("../htlc.wasm");
    profile::validate(&code).unwrap();
    code
}

/// Reads records the way the program writes them.
struct Cursor<'a>(&'a [u8]);

impl Cursor<'_> {
    fn take(&mut self, n: usize) -> &[u8] {
        let (out, rest) = self.0.split_at(n);
        self.0 = rest;
        out
    }
    fn id(&mut self) -> Id {
        self.take(32).try_into().unwrap()
    }
    fn u64(&mut self) -> u64 {
        u64::from_le_bytes(self.take(8).try_into().unwrap())
    }
    fn u128(&mut self) -> u128 {
        u128::from_le_bytes(self.take(16).try_into().unwrap())
    }
    fn bytes(&mut self) -> Vec<u8> {
        let len = u32::from_le_bytes(self.take(4).try_into().unwrap()) as usize;
        self.take(len).to_vec()
    }
}

/// An open listing's record, decoded.
#[derive(Clone, Debug, PartialEq)]
struct Listing {
    maker: Id,
    coin: Id,
    amount: u128,
    want: u64,
    taker: Id,
    window: u64,
    fee: u128,
    listed_at: u64,
    chain: Vec<u8>,
    key: Vec<u8>,
}

/// A lock's record, decoded.
#[derive(Clone, Debug, PartialEq)]
struct Lock {
    maker: Id,
    coin: Id,
    amount: u128,
    taker: Id,
    hash: Id,
    t1: u64,
    deadline: u64,
    fee: u128,
}

/// How a test call is made: by which account, with which nonce and deadline,
/// and what it pays, in which coin, from which account.
struct Act<'a> {
    policy: Id,
    who: &'a [u8],
    nonce: Option<u64>,
    valid_until: u64,
    effect: Option<Vec<u8>>,
    coin: Id,
    /// The paying account's policy and params, when not the acting account.
    payer: Option<(Id, &'a [u8])>,
    /// What the call carries as the account's witness, empty by default.
    witness: &'a [u8],
    /// The digest the payment is bound to, when not the call's own.
    bound_to: Option<Id>,
    /// What the payment carries as its payer's witness, empty by default.
    pay_witness: &'a [u8],
    /// The payment's fee, paid to the block's payout account.
    fee: u128,
    /// A payment bound to nothing, `within = 00`.
    unbound: bool,
    /// A payment as a contract account's action, `auth = 01`.
    contract_auth: bool,
}

struct Chain {
    state: State,
    context: Context,
    instant: Id,
    delayed: Id,
    switch: Id,
    /// The reference `sha256` program, which hashes the tests' secrets.
    sha256: Id,
    /// Two coins of the reference program.
    dlr: Id,
    gold: Id,
    htlc: Id,
}

impl Chain {
    /// Alice, Bob and Carol hold `START` of each coin, and so do Dave, of
    /// the switching policy, and Alice's account with a delay. The block
    /// timestamp is `T0`, and the block has no payout account.
    fn new() -> Self {
        let g = Genesis::experimental();
        let mut chain = Chain {
            state: State::default(),
            context: Context::from_genesis(&g),
            instant: ZERO,
            delayed: ZERO,
            switch: ZERO,
            sha256: ZERO,
            dlr: ZERO,
            gold: ZERO,
            htlc: ZERO,
        };
        chain.instant = chain.deploy(wasm(INSTANT_POLICY), Vec::new());
        chain.delayed = chain.deploy(wasm(DELAYED_POLICY), Vec::new());
        chain.switch = chain.deploy(wasm(SWITCH_POLICY), Vec::new());
        chain.sha256 = chain.deploy(
            read("../../ting-reference/programs/sha256.wasm"),
            Vec::new(),
        );
        chain.dlr = chain.coin(b"Daler", b"DLR", 8);
        chain.gold = chain.coin(b"Gold", b"GLD", 2);
        chain.htlc = chain.deploy(htlc(), vec![1]);
        chain.context.height += 1;
        chain.context.timestamp = T0;
        chain
    }

    fn coin(&mut self, name: &[u8], symbol: &[u8], decimals: u8) -> Id {
        let mut coin = vec![1];
        coin.extend(bytes(name));
        coin.extend(bytes(symbol));
        coin.push(decimals);
        coin.extend(u128::MAX.to_le_bytes());
        coin.extend([0; 16 + 8 + 16 + 32]);
        let holders = [
            self.account(b"alice"),
            self.account(b"bob"),
            self.account(b"carol"),
            self.account_of(&self.switch.clone(), b"dave"),
            self.account_of(&self.delayed.clone(), b"alice"),
        ];
        coin.extend((holders.len() as u64).to_le_bytes());
        for who in holders {
            coin.extend(who);
            coin.extend(START.to_le_bytes());
        }
        let code = read("../../ting-reference/programs/coin.wasm");
        assert_eq!(ting_core::hash::hex(&hash("code", &code)), COIN_CODE);
        self.deploy(code, coin)
    }

    fn run(&mut self, payload: Payload) -> Receipt {
        let runtime = Runtime::new(self.state.clone(), self.context.clone());
        let receipt = runtime
            .execute(&Transaction {
                budget: BUDGET,
                payload,
            })
            .unwrap();
        // Against an empty reader, the changes list every record that exists.
        let mut state = State::default();
        for change in runtime.state_changes().unwrap().records {
            if change.after.is_some() {
                state.set(change.key, change.after);
            }
        }
        state.commit();
        self.state = state;
        receipt
    }

    fn deploy(&mut self, code: Vec<u8>, input: Vec<u8>) -> Id {
        let r = self.run(Payload::Deploy { code, input });
        ok(&r);
        r.result.try_into().unwrap()
    }

    fn call(&mut self, input: Vec<u8>) -> Receipt {
        self.run(Payload::Call {
            target: self.htlc,
            input,
        })
    }

    /// SHA-256 of `data`, from the reference program.
    fn sha256(&mut self, data: &[u8]) -> Id {
        let r = self.run(Payload::Call {
            target: self.sha256,
            input: data.to_vec(),
        });
        ok(&r);
        r.result.try_into().unwrap()
    }

    /// Sets the block timestamp.
    fn at(&mut self, timestamp: u64) {
        self.context.timestamp = timestamp;
    }

    /// Producer data naming a payout account (wiki: programs/conventions).
    fn pay_to(&mut self, payout: &Id) {
        self.context.producer = [
            &b"OCP1"[..],
            &1u32.to_le_bytes(),
            &32u32.to_le_bytes(),
            payout,
        ]
        .concat();
    }

    fn storage(&self, contract: Id, key: Id) -> Option<Vec<u8>> {
        Runtime::new(self.state.clone(), self.context.clone()).storage(contract, key)
    }

    /// Writes one of the program's records directly, as no call can.
    fn poke(&mut self, key: Id, value: Vec<u8>) {
        self.state.set(record_key(2, self.htlc, key), Some(value));
        self.state.commit();
    }

    /// The state root: it changes with any record.
    fn root(&self) -> Id {
        self.state.root()
    }

    fn account(&self, who: &[u8]) -> Id {
        self.account_of(&self.instant, who)
    }

    fn account_of(&self, policy: &Id, who: &[u8]) -> Id {
        hash_parts(
            "app/account-v1/policy",
            &[policy, &(who.len() as u32).to_le_bytes(), who],
        )
    }

    fn coin_record(&self, coin: &Id, account: &Id) -> (u128, u64) {
        match self.storage(*coin, *account) {
            None => (0, 0),
            Some(r) => (
                u128::from_le_bytes(r[..16].try_into().unwrap()),
                u64::from_le_bytes(r[32..40].try_into().unwrap()),
            ),
        }
    }

    fn balance(&self, coin: &Id, account: &Id) -> u128 {
        self.coin_record(coin, account).0
    }

    /// What the program's own account holds of `coin`.
    fn held(&self, coin: &Id) -> u128 {
        self.balance(coin, &contract_account(&self.htlc))
    }

    /// An account's nonce in the program (TCR-1).
    fn nonce(&self, account: &Id) -> u64 {
        let key = hash("app/call-v1/nonce", account);
        self.storage(self.htlc, key)
            .map_or(0, |v| u64::from_le_bytes(v.try_into().unwrap()))
    }

    fn listing(&self, id: u64) -> Option<Listing> {
        let r = self.storage(self.htlc, listing_key(id))?;
        let mut c = Cursor(&r);
        let listing = Listing {
            maker: c.id(),
            coin: c.id(),
            amount: c.u128(),
            want: c.u64(),
            taker: c.id(),
            window: c.u64(),
            fee: c.u128(),
            listed_at: c.u64(),
            chain: c.bytes(),
            key: c.bytes(),
        };
        assert!(c.0.is_empty());
        Some(listing)
    }

    fn lock(&self, id: u64) -> Option<Lock> {
        let r = self.storage(self.htlc, lock_key(id))?;
        assert_eq!(r.len(), 176);
        let mut c = Cursor(&r);
        Some(Lock {
            maker: c.id(),
            coin: c.id(),
            amount: c.u128(),
            taker: c.id(),
            hash: c.id(),
            t1: c.u64(),
            deadline: c.u64(),
            fee: c.u128(),
        })
    }

    fn count(&self) -> u64 {
        self.storage(self.htlc, COUNT_KEY)
            .map_or(0, |v| u64::from_le_bytes(v.try_into().unwrap()))
    }

    /// The events of the program's own, and its *executed*, in order.
    fn ours(&self, r: &Receipt) -> Vec<Vec<u8>> {
        r.events
            .iter()
            .filter(|e| e.contract == self.htlc)
            .map(|e| e.payload.clone())
            .collect()
    }

    /// The transfers `coin` reports: `(from, to, amount)`.
    fn transfers(&self, r: &Receipt, coin: &Id) -> Vec<(Id, Id, u128)> {
        let topic = hash("app/coin-v1/event/transfer", b"");
        r.events
            .iter()
            .filter(|e| e.contract == *coin && e.payload[..32] == topic)
            .map(|e| {
                let mut c = Cursor(&e.payload[32..]);
                (c.id(), c.id(), c.u128())
            })
            .collect()
    }

    /// Requires the program's account to hold, in each coin, exactly what the
    /// open listings and the locks hold, plus `extra` of `dlr`; and every
    /// listing's and lock's fee to be at most a thousandth of its coins.
    #[track_caller]
    fn holds_exactly(&self, extra: u128) {
        for id in 1..=self.count() {
            let listing = self.listing(id).map(|l| (l.amount, l.fee));
            let lock = self.lock(id).map(|l| (l.amount, l.fee));
            if let Some((amount, fee)) = listing.or(lock) {
                assert!(fee * FEE_SHARE <= amount);
            }
        }
        for coin in [self.dlr, self.gold] {
            let mut sum = 0;
            for id in 1..=self.count() {
                assert!(self.listing(id).is_none() || self.lock(id).is_none());
                sum += self
                    .listing(id)
                    .filter(|l| l.coin == coin)
                    .map_or(0, |l| l.amount);
                sum += self
                    .lock(id)
                    .filter(|l| l.coin == coin)
                    .map_or(0, |l| l.amount);
            }
            let extra = if coin == self.dlr { extra } else { 0 };
            assert_eq!(self.held(&coin), sum + extra);
        }
    }

    fn act_of<'a>(&self, who: &'a [u8], effect: Option<Vec<u8>>, coin: Id) -> Act<'a> {
        Act {
            policy: self.instant,
            who,
            nonce: None,
            valid_until: 0,
            effect,
            coin,
            payer: None,
            witness: b"",
            bound_to: None,
            pay_witness: b"",
            fee: 0,
            unbound: false,
            contract_auth: false,
        }
    }

    /// The call `act` makes of `head`: signed, and paid when it has an effect.
    fn input(&self, head: &[u8], act: &Act) -> Vec<u8> {
        let account = self.account_of(&act.policy, act.who);
        let nonce = act.nonce.unwrap_or_else(|| self.nonce(&account));
        let operation = hash("app/call-v1/operation", head);
        let chain = Genesis::experimental().chain_id();
        let message = [
            bytes(b"app/call-v1"),
            chain.to_vec(),
            self.htlc.to_vec(),
            account.to_vec(),
            vec![1],
            nonce.to_le_bytes().to_vec(),
            act.valid_until.to_le_bytes().to_vec(),
            operation.to_vec(),
        ]
        .concat();
        let digest = act
            .bound_to
            .unwrap_or_else(|| hash("app/sign-v1", &message));
        let mut input = [
            head,
            &[0],
            &act.policy[..],
            &bytes(act.who),
            &nonce.to_le_bytes(),
            &act.valid_until.to_le_bytes(),
            &bytes(act.witness),
        ]
        .concat();
        match &act.effect {
            None => input.push(0),
            Some(effect) => {
                let (payer_policy, payer) = act.payer.unwrap_or((act.policy, act.who));
                let coin_nonce = self
                    .coin_record(&act.coin, &self.account_of(&payer_policy, payer))
                    .1;
                let mut a = vec![0x10];
                if act.contract_auth {
                    a.push(0x01);
                } else {
                    a.push(0x00);
                    a.extend(payer_policy);
                    a.extend(bytes(payer));
                    a.extend(coin_nonce.to_le_bytes());
                    a.extend(bytes(act.pay_witness));
                }
                a.extend(effect);
                a.extend(act.fee.to_le_bytes());
                a.extend([0; 16 + 8 + 8]);
                if act.unbound {
                    a.push(0);
                } else {
                    a.push(1);
                    a.extend(self.htlc);
                    a.extend(digest);
                }
                input.push(1);
                input.extend(act.coin);
                input.extend(bytes(&a));
            }
        }
        input
    }

    fn act_with(&mut self, head: Vec<u8>, act: Act) -> Receipt {
        let input = self.input(&head, &act);
        self.call(input)
    }

    /// The usual terms: 0.025 LTC to the seller's key, held a day once
    /// accepted, a fee of `FEE` DLR.
    fn terms(&self) -> Terms {
        Terms {
            taker: None,
            chain: b"LTC".to_vec(),
            raw_amount: None,
            want: WANT,
            key: seller_key(),
            window: WINDOW,
            fee_coin: self.dlr,
            fee: FEE,
        }
    }

    /// `who` pays `amount` of `coin` into the program and lists it on `terms`.
    fn offer_with(&mut self, who: &[u8], coin: Id, amount: u128, terms: &Terms) -> Receipt {
        let vault = contract_account(&self.htlc);
        let act = self.act_of(who, Some(transfer(&vault, amount)), coin);
        self.act_with(offer_head(terms), act)
    }

    /// `who` lists `amount` DLR on the usual terms.
    fn offer(&mut self, who: &[u8], amount: u128) -> Receipt {
        let terms = self.terms();
        self.offer_with(who, self.dlr, amount, &terms)
    }

    fn take(&mut self, id: u64, taker: &Id, hash: &Id, t1: u64, lock: &[u8]) -> Receipt {
        self.call(take_input(id, taker, hash, t1, lock))
    }

    /// `who` accepts listing `id` for `taker`, approved by its witness.
    fn accept(&mut self, who: &[u8], id: u64, taker: &Id, hash: &Id, until: u64) -> Receipt {
        let l = self.listing(id).expect("listed");
        let act = self.act_of(who, None, self.dlr);
        self.act_with(accept_head(id, taker, hash, until, &l.coin, l.amount), act)
    }

    fn claim(&mut self, id: u64, secret: &Id) -> Receipt {
        self.call(claim_input(id, secret))
    }

    fn refund(&mut self, id: u64) -> Receipt {
        self.call(refund_input(id))
    }

    fn release(&mut self, id: u64, data: &[u8]) -> Receipt {
        self.call(release_input(id, data))
    }

    /// `who` withdraws listing `id`, approved by its witness.
    fn withdraw(&mut self, who: &[u8], id: u64) -> Receipt {
        let l = self.listing(id).expect("listed");
        let act = self.act_of(who, None, self.dlr);
        self.act_with(withdraw_head(id, &l.coin, l.amount), act)
    }
}

#[test]
fn deployment_takes_version_one_and_lists_the_templates() {
    let mut chain = Chain::new();
    for input in [vec![], vec![0], vec![2], vec![1, 0]] {
        let r = chain.run(Payload::Deploy {
            code: htlc(),
            input,
        });
        reverts(&r, "bad deploy input");
    }
    let list = chain
        .storage(chain.htlc, hash("app/call-v1/templates", b""))
        .unwrap();
    let mut expected = 4u64.to_le_bytes().to_vec();
    for t in [OFFER, OFFER_TO, ACCEPT, WITHDRAW] {
        // TCR-1's limit on a template.
        assert!(t.len() <= 512);
        expected.extend(bytes(t.as_bytes()));
    }
    assert_eq!(list, expected);
    assert_eq!(chain.storage(chain.htlc, ZERO), Some(vec![1]));
    assert_eq!(chain.count(), 0);
    reverts(&chain.call(vec![9, 0]), "bad input");
    let r = chain.call(vec![9]);
    ok(&r);
    assert_eq!(r.result, 0u64.to_le_bytes());
}

#[test]
fn an_offer_puts_the_coins_in_the_program_and_lists_them() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let (alice, bob, carol) = (
        chain.account(b"alice"),
        chain.account(b"bob"),
        chain.account(b"carol"),
    );
    let terms = chain.terms();
    let r = chain.offer_with(b"alice", dlr, 300_000, &terms);
    ok(&r);
    let first = Listing {
        maker: alice,
        coin: dlr,
        amount: 300_000,
        want: WANT,
        taker: ZERO,
        window: WINDOW,
        fee: FEE,
        listed_at: T0,
        chain: b"LTC".to_vec(),
        key: seller_key(),
    };
    assert_eq!(chain.count(), 1);
    assert_eq!(chain.listing(1), Some(first.clone()));
    assert_eq!(chain.balance(&dlr, &alice), START - 300_000);
    assert_eq!(chain.held(&dlr), 300_000);
    assert_eq!(
        chain.ours(&r),
        [listed(1, &first), executed(&alice, 0, &offer_head(&terms))]
    );
    assert_eq!(
        chain.transfers(&r, &dlr),
        [(alice, contract_account(&chain.htlc), 300_000)]
    );

    // A listing for one taker only, in another coin; ids count up.
    chain.at(T0 + 5);
    let to_carol = Terms {
        taker: Some(carol),
        chain: b"BTC".to_vec(),
        want: 1,
        raw_amount: None,
        key: vec![9],
        window: MIN_WINDOW,
        fee_coin: gold,
        fee: 0,
    };
    let r = chain.offer_with(b"bob", gold, 7, &to_carol);
    ok(&r);
    let second = Listing {
        maker: bob,
        coin: gold,
        amount: 7,
        want: 1,
        taker: carol,
        window: MIN_WINDOW,
        fee: 0,
        listed_at: T0 + 5,
        chain: b"BTC".to_vec(),
        key: vec![9],
    };
    assert_eq!(chain.count(), 2);
    assert_eq!(chain.listing(2), Some(second.clone()));
    assert_eq!(chain.held(&gold), 7);
    assert_eq!(
        chain.ours(&r),
        [
            listed(2, &second),
            executed(&bob, 0, &offer_head(&to_carol))
        ]
    );

    // The queries read the same records.
    for id in [1, 2] {
        let r = chain.call(query(8, id));
        ok(&r);
        assert_eq!(
            r.result,
            chain.storage(chain.htlc, listing_key(id)).unwrap()
        );
    }
    reverts(&chain.call(query(8, 3)), "not listed");
    reverts(&chain.call(query(8, 0)), "not listed");
    reverts(&chain.call(query(0x0a, 1)), "not locked");
    let r = chain.call(vec![9]);
    ok(&r);
    assert_eq!(r.result, 2u64.to_le_bytes());
    reverts(&chain.call(vec![8, 1, 0]), "bad input");
    reverts(&chain.call([query(8, 1), vec![0]].concat()), "bad input");
}

#[test]
fn an_offer_is_refused_unless_its_values_are_in_range() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let fake = chain.deploy(wasm(FAKE_COIN), Vec::new());
    let vault = contract_account(&chain.htlc);
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    let refused = |chain: &mut Chain, act: Act, head: Vec<u8>, reason: &str| {
        let before = (
            chain.balance(&dlr, &alice),
            chain.count(),
            chain.nonce(&alice),
        );
        reverts(&chain.act_with(head, act), reason);
        assert_eq!(
            before,
            (
                chain.balance(&dlr, &alice),
                chain.count(),
                chain.nonce(&alice)
            )
        );
    };
    let good = chain.terms();
    let burn = [&[2][..], &300_000u128.to_le_bytes()].concat();
    let pay = transfer(&vault, 300_000);
    // Values out of range, each with a good payment.
    let bad_terms = [
        (good.with(|t| t.want = 0), "bad amount"),
        (
            good.with(|t| t.raw_amount = Some((0, [0, 0, 0, 0, 0, 0, 1, 10]))),
            "bad amount",
        ),
        (
            good.with(|t| t.raw_amount = Some((u64::MAX / 100_000_000 + 1, [0; 8]))),
            "bad amount",
        ),
        (
            good.with(|t| t.raw_amount = Some((0, [0; 8]))),
            "bad amount",
        ),
        (good.with(|t| t.chain = vec![]), "bad chain"),
        (good.with(|t| t.chain = b"ltc".to_vec()), "bad chain"),
        (good.with(|t| t.chain = b"LTC-T".to_vec()), "bad chain"),
        (good.with(|t| t.chain = b"LT C".to_vec()), "bad chain"),
        (good.with(|t| t.chain = "LTÇ".into()), "bad chain"),
        (good.with(|t| t.chain = b"ABCDEFGHI".to_vec()), "bad chain"),
        (good.with(|t| t.key = vec![]), "bad key"),
        (good.with(|t| t.key = vec![2; 66]), "bad key"),
        (good.with(|t| t.window = 0), "bad window"),
        (good.with(|t| t.window = MIN_WINDOW - 1), "bad window"),
        (good.with(|t| t.window = MAX_WINDOW + 1), "bad window"),
        (good.with(|t| t.window = u64::MAX), "bad window"),
        (good.with(|t| t.taker = Some(ZERO)), "bad taker"),
        (good.with(|t| t.fee_coin = gold), "bad coin"),
        (good.with(|t| t.fee_coin = fake), "bad coin"),
        // A thousandth of the 300,000 paid is 300.
        (good.with(|t| t.fee = 301), "bad fee"),
        (good.with(|t| t.fee = 300_000), "bad fee"),
        (good.with(|t| t.fee = u128::MAX), "bad fee"),
    ];
    for (terms, reason) in bad_terms {
        let act = chain.act_of(b"alice", Some(pay.clone()), dlr);
        refused(&mut chain, act, offer_head(&terms), reason);
    }
    // Payments that are not a real coin's transfer into the program.
    let bad_payments = [
        (transfer(&vault, 0), dlr, "bad amount"),
        (pay.clone(), fake, "bad coin"),
        (pay.clone(), [7; 32], "bad coin"),
        (transfer(&bob, 300_000), dlr, "bad payment"),
        (burn, dlr, "bad payment"),
        (
            transfer(&vault, START + 1),
            dlr,
            "payment: insufficient funds",
        ),
    ];
    for (effect, coin, reason) in bad_payments {
        let act = chain.act_of(b"alice", Some(effect), coin);
        refused(&mut chain, act, offer_head(&good), reason);
    }
    let offer = offer_head(&good);
    let act = chain.act_of(b"alice", None, dlr);
    refused(&mut chain, act, offer.clone(), "needs payment");
    let to_bob = offer_head(&good.with(|t| t.taker = Some(bob)));
    let act = chain.act_of(b"alice", None, dlr);
    refused(&mut chain, act, to_bob, "needs payment");
    let mut act = chain.act_of(b"alice", Some(pay.clone()), dlr);
    act.payer = Some((chain.instant, b"bob"));
    refused(&mut chain, act, offer.clone(), "bad payment");
    let mut act = chain.act_of(b"alice", Some(pay.clone()), dlr);
    act.witness = b"sig";
    refused(&mut chain, act, offer.clone(), "bad input");
    let mut act = chain.act_of(b"alice", Some(pay.clone()), dlr);
    act.bound_to = Some([3; 32]);
    refused(&mut chain, act, offer.clone(), "not bound");
    let mut act = chain.act_of(b"alice", Some(pay.clone()), dlr);
    act.unbound = true;
    refused(&mut chain, act, offer.clone(), "not bound");
    let mut act = chain.act_of(b"alice", Some(pay.clone()), dlr);
    act.nonce = Some(4);
    refused(&mut chain, act, offer.clone(), "bad nonce");
    let mut act = chain.act_of(b"alice", Some(pay.clone()), dlr);
    act.valid_until = T0 - 1;
    refused(&mut chain, act, offer.clone(), "expired");
    // An account with a delay cannot pay: the coin refuses its bound actions.
    let mut act = chain.act_of(b"alice", Some(pay.clone()), dlr);
    act.policy = chain.delayed;
    refused(&mut chain, act, offer.clone(), "payment: delayed binding");
    assert_eq!(chain.held(&dlr), 0);
    // An unknown template, values cut short, and bytes after the call.
    let call = chain.input(&offer, &chain.act_of(b"alice", Some(pay.clone()), dlr));
    let mut unknown = call.clone();
    unknown[0] ^= 1;
    reverts(&chain.call(unknown), "bad input");
    reverts(&chain.call(call[..60].to_vec()), "bad input");
    reverts(&chain.call([call, vec![0]].concat()), "bad input");

    // Each limit itself is in range.
    let limits = [
        good.with(|t| t.window = MIN_WINDOW),
        good.with(|t| t.window = MAX_WINDOW),
        good.with(|t| t.chain = b"BTC".to_vec()),
        good.with(|t| t.want = 99_999_999),
        good.with(|t| t.want = 1),
        good.with(|t| t.key = vec![7]),
        good.with(|t| t.key = vec![4; 65]),
        good.with(|t| t.fee = 300),
        good.with(|t| t.fee = 0),
        good.with(|t| t.want = u64::MAX),
        good.with(|t| t.taker = Some(alice)),
    ];
    for (i, terms) in limits.iter().enumerate() {
        ok(&chain.offer_with(b"alice", dlr, 300_000, terms));
        let l = chain.listing(i as u64 + 1).unwrap();
        assert_eq!(
            (l.window, l.chain, l.key, l.fee, l.want),
            (
                terms.window,
                terms.chain.clone(),
                terms.key.clone(),
                terms.fee,
                terms.want
            )
        );
    }
    assert_eq!(chain.count(), limits.len() as u64);
    assert_eq!(chain.held(&dlr), 300_000 * limits.len() as u128);
}

#[test]
fn a_fee_is_at_most_a_thousandth_of_the_coins() {
    let mut chain = Chain::new();
    let dlr = chain.dlr;
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    let miner = chain.account(b"miner");
    chain.pay_to(&miner);
    let vault = contract_account(&chain.htlc);
    let terms = chain.terms();
    let offer = |chain: &mut Chain, amount: u128, fee: u128| {
        chain.offer_with(b"alice", dlr, amount, &terms.with(|t| t.fee = fee))
    };
    // A fee of exactly a thousandth, rounded down, lists; one more does not.
    let mut ids = Vec::new();
    for (amount, fee) in [
        (1_000, 1),
        (2_999, 2),
        (300_000, 300),
        (300_999, 300),
        (999_999, 999),
    ] {
        reverts(&offer(&mut chain, amount, fee + 1), "bad fee");
        ok(&offer(&mut chain, amount, fee));
        ids.push(chain.count());
        assert_eq!(chain.listing(chain.count()).unwrap().fee, fee);
    }
    // Under 1,000 base units, the fee can only be 0.
    for amount in [1, 2, 999] {
        reverts(&offer(&mut chain, amount, 1), "bad fee");
        ok(&offer(&mut chain, amount, 0));
    }
    let free = chain.count();
    // A fee whose thousandfold would wrap past 2^128 is no smaller.
    reverts(
        &offer(&mut chain, 300_000, u128::MAX / FEE_SHARE + 1),
        "bad fee",
    );
    reverts(&offer(&mut chain, 300_000, u128::MAX), "bad fee");
    chain.holds_exactly(0);

    // A claim pays exactly the listing's fee, whoever sends it: the buyer
    // gets the rest, and a fee of 0 leaves them everything.
    let secret: Id = [0x11; 32];
    let hash = chain.sha256(&secret);
    let until = T0 + WINDOW + GAP;
    let (big, small) = (ids[2], ids[0]);
    for id in [big, small, free] {
        ok(&chain.accept(b"alice", id, &bob, &hash, until));
    }
    let r = chain.claim(big, &secret);
    ok(&r);
    assert_eq!(
        chain.transfers(&r, &dlr),
        [(vault, bob, 299_700), (vault, miner, 300)]
    );
    assert_eq!(chain.balance(&dlr, &miner), 300_000 / FEE_SHARE);
    assert_eq!(chain.balance(&dlr, &bob), START + 299_700);
    let r = chain.claim(free, &secret);
    ok(&r);
    assert_eq!(chain.transfers(&r, &dlr), [(vault, bob, 999)]);
    assert_eq!(chain.balance(&dlr, &bob), START + 299_700 + 999);
    // And a refund, out of the maker's coins.
    chain.at(T0 + WINDOW + 1);
    let before = chain.balance(&dlr, &alice);
    ok(&chain.refund(small));
    assert_eq!(chain.balance(&dlr, &alice), before + 999);
    assert_eq!(chain.balance(&dlr, &miner), 300 + 1);
    chain.holds_exactly(0);
}

#[test]
fn the_whole_trade_pays_the_taker_and_the_fee_to_the_block() {
    let mut chain = Chain::new();
    let dlr = chain.dlr;
    let (alice, bob, carol) = (
        chain.account(b"alice"),
        chain.account(b"bob"),
        chain.account(b"carol"),
    );
    let miner = chain.account(b"miner");
    chain.pay_to(&miner);
    let vault = contract_account(&chain.htlc);

    // Alice offers 300,000 base units of DLR for 0.025 LTC.
    ok(&chain.offer(b"alice", 300_000));

    // Bob locks the LTC under the hash of his secret and posts the take.
    let secret: Id = [0x5c; 32];
    let hash = chain.sha256(&secret);
    let t1 = T0 + 60 + WINDOW + GAP + 3_600;
    let lock = ltc_lock(1);
    chain.at(T0 + 30);
    let root = chain.root();
    let r = chain.take(1, &bob, &hash, t1, &lock);
    ok(&r);
    assert_eq!(
        chain.ours(&r),
        [event(
            2,
            1,
            &[&bob, &hash, &t1.to_le_bytes(), &bytes(&lock)]
        )]
    );
    assert_eq!(chain.root(), root);

    // Alice checks the lock and accepts: her coins are now Bob's to claim.
    chain.at(T0 + 60);
    let accept = accept_head(1, &bob, &hash, t1, &dlr, 300_000);
    let r = chain.accept(b"alice", 1, &bob, &hash, t1);
    ok(&r);
    let deadline = T0 + 60 + WINDOW;
    let lock_record = Lock {
        maker: alice,
        coin: dlr,
        amount: 300_000,
        taker: bob,
        hash,
        t1,
        deadline,
        fee: FEE,
    };
    assert_eq!(chain.listing(1), None);
    assert_eq!(chain.lock(1), Some(lock_record));
    assert_eq!(chain.held(&dlr), 300_000);
    assert_eq!(chain.count(), 1);
    assert_eq!(
        chain.ours(&r),
        [
            event(
                3,
                1,
                &[
                    &alice,
                    &bob,
                    &hash,
                    &t1.to_le_bytes(),
                    &deadline.to_le_bytes(),
                    &dlr,
                    &300_000u128.to_le_bytes()
                ]
            ),
            executed(&alice, 1, &accept),
        ]
    );
    let r = chain.call(query(0x0a, 1));
    ok(&r);
    assert_eq!(r.result, chain.storage(chain.htlc, lock_key(1)).unwrap());
    assert_eq!(r.result.len(), 176);
    reverts(&chain.call(query(8, 1)), "not listed");
    // A lock is no listing: it cannot be withdrawn, taken or accepted again.
    let act = chain.act_of(b"alice", None, dlr);
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 300_000), act),
        "not listed",
    );
    reverts(&chain.take(1, &bob, &hash, t1, &lock), "not listed");
    let act = chain.act_of(b"alice", None, dlr);
    reverts(&chain.act_with(accept, act), "not listed");

    // Anyone who knows the secret claims for Bob, here Carol's page: the coins
    // go to Bob, less the listing's fee, which goes to the block's payout
    // account. The claim names no fee of its own: one that does is refused.
    let claim = claim_input(1, &secret);
    reverts(
        &chain.call([claim, 7u128.to_le_bytes().to_vec()].concat()),
        "bad input",
    );
    chain.at(T0 + 600);
    let r = chain.claim(1, &secret);
    ok(&r);
    assert_eq!(chain.lock(1), None);
    assert_eq!(chain.balance(&dlr, &bob), START + 300_000 - FEE);
    assert_eq!(chain.balance(&dlr, &miner), FEE);
    assert_eq!(chain.balance(&dlr, &alice), START - 300_000);
    assert_eq!(chain.balance(&dlr, &carol), START);
    assert_eq!(chain.held(&dlr), 0);
    assert_eq!(
        chain.ours(&r),
        [event(
            4,
            1,
            &[
                &bob,
                &secret,
                &(300_000 - FEE).to_le_bytes(),
                &FEE.to_le_bytes()
            ]
        )]
    );
    assert_eq!(
        chain.transfers(&r, &dlr),
        [(vault, bob, 300_000 - FEE), (vault, miner, FEE)]
    );
    // It ends there.
    reverts(&chain.claim(1, &secret), "not locked");
    reverts(&chain.refund(1), "not locked");
    reverts(&chain.call(query(0x0a, 1)), "not locked");
    chain.at(deadline + 1);
    reverts(&chain.refund(1), "not locked");
}

#[test]
fn a_take_is_checked_and_stores_nothing() {
    let mut chain = Chain::new();
    ok(&chain.offer(b"alice", 300_000));
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    let hash = chain.sha256(&[5; 32]);
    let t1 = T0 + WINDOW + GAP;
    let lock = ltc_lock(2);
    let root = chain.root();

    // At the boundary, so that it can be accepted in the same block.
    let r = chain.take(1, &bob, &hash, t1, &lock);
    ok(&r);
    assert_eq!(
        chain.ours(&r),
        [event(
            2,
            1,
            &[&bob, &hash, &t1.to_le_bytes(), &bytes(&lock)]
        )]
    );
    reverts(&chain.take(1, &bob, &hash, t1 - 1, &lock), "too short");
    reverts(&chain.take(1, &bob, &hash, 0, &lock), "too short");
    // A second later, the same take could no longer be accepted.
    chain.at(T0 + 1);
    reverts(&chain.take(1, &bob, &hash, t1, &lock), "too short");
    ok(&chain.take(1, &bob, &hash, t1 + 1, &lock));
    ok(&chain.take(1, &bob, &hash, u64::MAX, &lock));
    chain.at(T0);

    reverts(&chain.take(2, &bob, &hash, t1, &lock), "not listed");
    reverts(&chain.take(0, &bob, &hash, t1, &lock), "not listed");
    // Nor for the zero account, which could never claim.
    reverts(&chain.take(1, &ZERO, &hash, t1, &lock), "bad taker");
    // The lock is 1 to 256 bytes, and whatever they hold is the maker's to check.
    reverts(&chain.take(1, &bob, &hash, t1, b""), "bad input");
    reverts(&chain.take(1, &bob, &hash, t1, &[7; 257]), "bad input");
    ok(&chain.take(1, &bob, &hash, t1, &[7; 256]));
    ok(&chain.take(1, &bob, &hash, t1, &[7]));
    // A listing for anyone is taken by anyone, its maker included.
    ok(&chain.take(1, &alice, &hash, t1, &lock));
    let input = take_input(1, &bob, &hash, t1, &lock);
    reverts(&chain.call(input[..input.len() - 1].to_vec()), "bad input");
    reverts(&chain.call([input, vec![0]].concat()), "bad input");
    // Nothing a take does is stored.
    assert_eq!(chain.root(), root);

    ok(&chain.withdraw(b"alice", 1));
    reverts(&chain.take(1, &bob, &hash, t1, &lock), "not listed");
}

#[test]
fn an_accept_is_checked_before_it_locks() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    let miner = chain.account(b"miner");
    let vault = contract_account(&chain.htlc);
    let fake = chain.deploy(wasm(FAKE_COIN), Vec::new());
    ok(&chain.offer(b"alice", 300_000));
    let hash = chain.sha256(&[5; 32]);
    // Bob's take at the boundary, an hour ago.
    ok(&chain.take(1, &bob, &hash, T0 + WINDOW + GAP, &ltc_lock(3)));
    chain.at(T0 + 3_600);
    let until = T0 + 3_600 + WINDOW + GAP;
    let refused = |chain: &mut Chain, act: Act, head: Vec<u8>, reason: &str| {
        let nonce = chain.nonce(&alice);
        reverts(&chain.act_with(head, act), reason);
        assert!(chain.listing(1).is_some());
        assert_eq!(chain.lock(1), None);
        assert_eq!(chain.nonce(&alice), nonce);
    };
    let cases = [
        (
            "alice",
            accept_head(2, &bob, &hash, until, &dlr, 300_000),
            "not listed",
        ),
        (
            "bob",
            accept_head(1, &bob, &hash, until, &dlr, 300_000),
            "not maker",
        ),
        (
            "alice",
            accept_head(1, &bob, &hash, until, &dlr, 299_999),
            "listing changed",
        ),
        (
            "alice",
            accept_head(1, &bob, &hash, until, &gold, 300_000),
            "listing changed",
        ),
        // A listing for anyone is not accepted for the zero account, which
        // could never claim it.
        (
            "alice",
            accept_head(1, &ZERO, &hash, until, &dlr, 300_000),
            "bad taker",
        ),
        (
            "alice",
            accept_head(1, &bob, &hash, until - 1, &dlr, 300_000),
            "too short",
        ),
        // The take's own end, which was enough an hour ago, no longer is.
        (
            "alice",
            accept_head(1, &bob, &hash, T0 + WINDOW + GAP, &dlr, 300_000),
            "too short",
        ),
    ];
    for (who, head, reason) in cases {
        let act = chain.act_of(who.as_bytes(), None, dlr);
        refused(&mut chain, act, head, reason);
    }
    let accept = accept_head(1, &bob, &hash, until, &dlr, 300_000);
    // Another policy with the same params is another account.
    let refusing = chain.deploy(wasm(REFUSING_POLICY), Vec::new());
    let mut act = chain.act_of(b"alice", None, dlr);
    act.policy = refusing;
    refused(&mut chain, act, accept.clone(), "not maker");
    // Signed, the maker's account must approve it.
    let mut act = chain.act_of(b"alice", None, dlr);
    act.nonce = Some(5);
    refused(&mut chain, act, accept.clone(), "bad nonce");
    let mut act = chain.act_of(b"alice", None, dlr);
    act.valid_until = T0;
    refused(&mut chain, act, accept.clone(), "expired");
    // A fee payment approves it too, and nothing else does.
    for (effect, coin, reason) in [
        (transfer(&vault, 1), dlr, "bad payment"),
        (transfer(&alice, 0), dlr, "bad payment"),
        (
            [&[2][..], &0u128.to_le_bytes()].concat(),
            dlr,
            "bad payment",
        ),
        (transfer(&vault, 0), fake, "bad coin"),
    ] {
        let act = chain.act_of(b"alice", Some(effect), coin);
        refused(&mut chain, act, accept.clone(), reason);
    }
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), dlr);
    act.witness = b"sig";
    refused(&mut chain, act, accept.clone(), "bad input");
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), dlr);
    act.payer = Some((chain.instant, b"bob"));
    refused(&mut chain, act, accept.clone(), "bad payment");
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), dlr);
    act.contract_auth = true;
    refused(&mut chain, act, accept.clone(), "bad payment");

    // At the boundary, approved by a fee payment in another coin that pays the block.
    chain.pay_to(&miner);
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), gold);
    act.fee = 4;
    let r = chain.act_with(accept.clone(), act);
    ok(&r);
    assert_eq!(chain.listing(1), None);
    assert_eq!(
        chain.lock(1),
        Some(Lock {
            maker: alice,
            coin: dlr,
            amount: 300_000,
            taker: bob,
            hash,
            t1: until,
            deadline: T0 + 3_600 + WINDOW,
            fee: FEE,
        })
    );
    assert_eq!(chain.balance(&gold, &miner), 4);
    assert_eq!(chain.balance(&gold, &alice), START - 4);
    assert_eq!(chain.held(&dlr), 300_000);
    assert_eq!(chain.ours(&r).last(), Some(&executed(&alice, 1, &accept)));
    // Once only.
    let act = chain.act_of(b"alice", None, dlr);
    reverts(&chain.act_with(accept, act), "not listed");
}

#[test]
fn a_claim_needs_the_secret_before_the_deadline() {
    let mut chain = Chain::new();
    let dlr = chain.dlr;
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    let miner = chain.account(b"miner");
    chain.pay_to(&miner);
    // The program hashes with plain SHA-256, as the other chain's lock does.
    let secret: Id = [0; 32];
    let hash = chain.sha256(&secret);
    assert_eq!(
        hash,
        unhex("66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925")
    );
    ok(&chain.offer(b"alice", 300_000));
    let no_fee = chain.terms().with(|t| t.fee = 0);
    ok(&chain.offer_with(b"alice", dlr, 200_000, &no_fee));
    let until = T0 + WINDOW + GAP;
    ok(&chain.accept(b"alice", 1, &bob, &hash, until));
    ok(&chain.accept(b"alice", 2, &bob, &hash, until));
    let deadline = T0 + WINDOW;
    let locked = |chain: &Chain| (chain.lock(1).is_some(), chain.held(&dlr));

    reverts(&chain.claim(3, &secret), "not locked");
    reverts(&chain.claim(0, &secret), "not locked");
    reverts(&chain.claim(1, &[1; 32]), "wrong secret");
    // Not the hash itself either.
    reverts(&chain.claim(1, &hash), "wrong secret");
    chain.at(deadline + 1);
    reverts(&chain.claim(1, &secret), "too late");
    chain.at(u64::MAX);
    reverts(&chain.claim(1, &secret), "too late");
    // A claim names no fee: an input with one, of any amount, is refused.
    let input = claim_input(1, &secret);
    reverts(&chain.call(input[..input.len() - 1].to_vec()), "bad input");
    reverts(&chain.call([input.clone(), vec![0]].concat()), "bad input");
    for fee in [0u128, FEE] {
        let with_fee = [input.clone(), fee.to_le_bytes().to_vec()].concat();
        reverts(&chain.call(with_fee), "bad input");
    }
    assert_eq!(locked(&chain), (true, 500_000));

    // At the deadline itself, paying exactly the listing's fee.
    chain.at(deadline);
    let r = chain.claim(1, &secret);
    ok(&r);
    assert_eq!(
        chain.ours(&r),
        [event(
            4,
            1,
            &[
                &bob,
                &secret,
                &299_990u128.to_le_bytes(),
                &FEE.to_le_bytes()
            ]
        )]
    );
    assert_eq!(chain.balance(&dlr, &bob), START + 299_990);
    assert_eq!(chain.balance(&dlr, &miner), FEE);
    assert_eq!(locked(&chain), (false, 200_000));
    reverts(&chain.claim(1, &secret), "not locked");
    // With a fee of 0, the taker gets it all; the maker gets nothing back.
    ok(&chain.claim(2, &secret));
    assert_eq!(chain.balance(&dlr, &bob), START + 499_990);
    assert_eq!(chain.balance(&dlr, &alice), START - 500_000);
    assert_eq!(chain.held(&dlr), 0);
    chain.at(deadline + 1);
    reverts(&chain.refund(2), "not locked");

    // The zero account cannot be a lock's taker, but the coin's other reserved
    // key can: the coin refuses to pay it, and only a refund ends the lock.
    ok(&chain.offer(b"alice", 100_000));
    reverts(
        &chain.accept(b"alice", 3, &ZERO, &hash, u64::MAX),
        "bad taker",
    );
    let mut reserved = ZERO;
    reserved[31] = 1;
    ok(&chain.accept(b"alice", 3, &reserved, &hash, u64::MAX));
    reverts(&chain.claim(3, &secret), "coin: reserved account");
    assert_eq!(chain.held(&dlr), 100_000);
    chain.at(deadline + 1 + WINDOW + 1);
    ok(&chain.refund(3));
    assert_eq!(chain.balance(&dlr, &alice), START - 500_000 - FEE);
    assert_eq!(chain.balance(&dlr, &miner), 2 * FEE);
}

#[test]
fn a_refund_after_the_deadline_pays_the_maker_back() {
    let mut chain = Chain::new();
    let dlr = chain.dlr;
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    let miner = chain.account(b"miner");
    chain.pay_to(&miner);
    let secret: Id = [9; 32];
    let hash = chain.sha256(&secret);
    ok(&chain.offer(b"alice", 300_000));
    let no_fee = chain.terms().with(|t| t.fee = 0);
    ok(&chain.offer_with(b"alice", dlr, 200_000, &no_fee));
    let until = T0 + WINDOW + GAP;
    ok(&chain.accept(b"alice", 1, &bob, &hash, until));
    ok(&chain.accept(b"alice", 2, &bob, &hash, until));
    let deadline = T0 + WINDOW;

    reverts(&chain.refund(1), "too early");
    // At the deadline itself, the taker can still claim, so the maker cannot refund.
    chain.at(deadline);
    reverts(&chain.refund(1), "too early");
    chain.at(deadline + 1);
    reverts(&chain.refund(3), "not locked");
    // A refund names no fee: an input with one, of any amount, is refused.
    let input = refund_input(1);
    reverts(&chain.call(input[..input.len() - 1].to_vec()), "bad input");
    reverts(&chain.call([input.clone(), vec![0]].concat()), "bad input");
    for fee in [0u128, FEE] {
        let with_fee = [input.clone(), fee.to_le_bytes().to_vec()].concat();
        reverts(&chain.call(with_fee), "bad input");
    }
    reverts(&chain.claim(1, &secret), "too late");
    assert_eq!(chain.held(&dlr), 500_000);

    // Anyone may refund; the coins go back to the maker only, less the
    // listing's fee.
    let r = chain.refund(1);
    ok(&r);
    assert_eq!(
        chain.ours(&r),
        [event(
            5,
            1,
            &[&alice, &299_990u128.to_le_bytes(), &FEE.to_le_bytes()]
        )]
    );
    assert_eq!(chain.lock(1), None);
    assert_eq!(chain.balance(&dlr, &alice), START - 500_000 + 299_990);
    assert_eq!(chain.balance(&dlr, &miner), FEE);
    assert_eq!(chain.balance(&dlr, &bob), START);
    reverts(&chain.refund(1), "not locked");
    reverts(&chain.claim(1, &secret), "not locked");
    // With a fee of 0, the maker gets it all back.
    chain.at(u64::MAX);
    ok(&chain.refund(2));
    assert_eq!(chain.balance(&dlr, &alice), START - FEE);
    assert_eq!(chain.balance(&dlr, &miner), FEE);
    assert_eq!(chain.held(&dlr), 0);
}

#[test]
fn a_listing_for_one_taker_is_taken_and_accepted_for_that_taker_only() {
    let mut chain = Chain::new();
    let dlr = chain.dlr;
    let (alice, bob, carol) = (
        chain.account(b"alice"),
        chain.account(b"bob"),
        chain.account(b"carol"),
    );
    let terms = chain.terms().with(|t| t.taker = Some(bob));
    ok(&chain.offer_with(b"alice", dlr, 300_000, &terms));
    assert_eq!(chain.listing(1).unwrap().taker, bob);
    let secret: Id = [4; 32];
    let hash = chain.sha256(&secret);
    let until = T0 + WINDOW + GAP;
    let lock = ltc_lock(4);
    reverts(&chain.take(1, &carol, &hash, until, &lock), "not for you");
    reverts(&chain.take(1, &ZERO, &hash, until, &lock), "not for you");
    reverts(&chain.take(1, &alice, &hash, until, &lock), "not for you");
    ok(&chain.take(1, &bob, &hash, until, &lock));
    // Nor can its maker accept it for anyone else, the zero account included.
    for taker in [carol, ZERO, alice] {
        reverts(
            &chain.accept(b"alice", 1, &taker, &hash, until),
            "not for you",
        );
    }
    // The checks before: the listing, its maker, its coins.
    reverts(&chain.accept(b"carol", 1, &bob, &hash, until), "not maker");
    ok(&chain.accept(b"alice", 1, &bob, &hash, until));
    ok(&chain.claim(1, &secret));
    assert_eq!(chain.balance(&dlr, &bob), START + 300_000 - FEE);
    // No payout account: the fee stays in the program's account.
    assert_eq!(chain.held(&dlr), FEE);
}

#[test]
fn only_the_maker_withdraws_and_gets_the_coins_back() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let alice = chain.account(b"alice");
    ok(&chain.offer(b"alice", 300_000));
    ok(&chain.offer(b"alice", 200_000));
    reverts(&chain.withdraw(b"bob", 1), "not maker");
    let act = chain.act_of(b"alice", None, dlr);
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 299_999), act),
        "listing changed",
    );
    let act = chain.act_of(b"alice", None, dlr);
    reverts(
        &chain.act_with(withdraw_head(1, &gold, 300_000), act),
        "listing changed",
    );
    let act = chain.act_of(b"alice", None, dlr);
    reverts(
        &chain.act_with(withdraw_head(3, &dlr, 300_000), act),
        "not listed",
    );
    // Another policy with the same params is another account.
    let refusing = chain.deploy(wasm(REFUSING_POLICY), Vec::new());
    let mut act = chain.act_of(b"alice", None, dlr);
    act.policy = refusing;
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 300_000), act),
        "not maker",
    );

    let r = chain.withdraw(b"alice", 1);
    ok(&r);
    assert_eq!(chain.listing(1), None);
    assert_eq!(chain.balance(&dlr, &alice), START - 200_000);
    assert_eq!(chain.held(&dlr), 200_000);
    assert_eq!(
        chain.ours(&r),
        [
            event(6, 1, &[&alice, &dlr, &300_000u128.to_le_bytes()]),
            executed(&alice, 2, &withdraw_head(1, &dlr, 300_000)),
        ]
    );
    let act = chain.act_of(b"alice", None, dlr);
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 300_000), act),
        "not listed",
    );
    let bob = chain.account(b"bob");
    let act = chain.act_of(b"alice", None, dlr);
    reverts(
        &chain.act_with(accept_head(1, &bob, &[1; 32], u64::MAX, &dlr, 300_000), act),
        "not listed",
    );

    // A fee payment approves it too: a transfer of 0 to the program's own
    // account, in a real coin, and nothing else.
    let vault = contract_account(&chain.htlc);
    let fake = chain.deploy(wasm(FAKE_COIN), Vec::new());
    for (effect, coin, reason) in [
        (transfer(&vault, 1), dlr, "bad payment"),
        (transfer(&alice, 0), dlr, "bad payment"),
        (
            [&[2][..], &0u128.to_le_bytes()].concat(),
            dlr,
            "bad payment",
        ),
        (transfer(&vault, 0), fake, "bad coin"),
    ] {
        let act = chain.act_of(b"alice", Some(effect), coin);
        reverts(
            &chain.act_with(withdraw_head(2, &dlr, 200_000), act),
            reason,
        );
    }
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), dlr);
    act.unbound = true;
    reverts(
        &chain.act_with(withdraw_head(2, &dlr, 200_000), act),
        "not bound",
    );
    let miner = chain.account(b"miner");
    chain.pay_to(&miner);
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), gold);
    act.fee = 3;
    ok(&chain.act_with(withdraw_head(2, &dlr, 200_000), act));
    assert_eq!(chain.balance(&dlr, &alice), START);
    assert_eq!(chain.balance(&gold, &alice), START - 3);
    assert_eq!(chain.balance(&gold, &miner), 3);
    assert_eq!(chain.held(&dlr), 0);
}

#[test]
fn a_release_is_posted_for_any_listing_ever_made() {
    let mut chain = Chain::new();
    let bob = chain.account(b"bob");
    let data = ltc_release(1);
    reverts(&chain.release(1, &data), "not listed");
    reverts(&chain.release(0, &data), "not listed");
    ok(&chain.offer(b"alice", 300_000));
    let root = chain.root();
    let r = chain.release(1, &data);
    ok(&r);
    assert_eq!(chain.ours(&r), [event(7, 1, &[&bytes(&data)])]);
    reverts(&chain.release(2, &data), "not listed");
    reverts(&chain.release(0, &data), "not listed");
    reverts(&chain.release(1, b""), "bad input");
    reverts(&chain.release(1, &[1; 257]), "bad input");
    ok(&chain.release(1, &[1; 256]));
    ok(&chain.release(1, &[1]));
    let input = release_input(1, &data);
    reverts(&chain.call(input[..input.len() - 1].to_vec()), "bad input");
    reverts(&chain.call([input, vec![0]].concat()), "bad input");
    // Nothing a release does is stored.
    assert_eq!(chain.root(), root);

    // Open, withdrawn, accepted or claimed: a buyer may still need it.
    ok(&chain.withdraw(b"alice", 1));
    ok(&chain.release(1, &data));
    ok(&chain.offer(b"alice", 200_000));
    let secret: Id = [2; 32];
    let hash = chain.sha256(&secret);
    ok(&chain.accept(b"alice", 2, &bob, &hash, T0 + WINDOW + GAP));
    ok(&chain.release(2, &data));
    ok(&chain.claim(2, &secret));
    ok(&chain.release(2, &data));
    reverts(&chain.release(3, &data), "not listed");
}

#[test]
fn an_account_answering_with_a_delay_is_refused_outright() {
    let mut chain = Chain::new();
    let (dlr, switch) = (chain.dlr, chain.switch);
    let dave = chain.account_of(&switch, b"dave");
    let bob = chain.account(b"bob");
    let vault = contract_account(&chain.htlc);
    // Dave lists while his account answers at once, as a payment's coin asks it.
    let terms = chain.terms();
    let mut act = chain.act_of(b"dave", Some(transfer(&vault, 100_000)), dlr);
    act.policy = switch;
    ok(&chain.act_with(offer_head(&terms), act));
    let lock_hash = chain.sha256(&[3; 32]);
    let accept = accept_head(1, &bob, &lock_hash, T0 + WINDOW + GAP, &dlr, 100_000);
    let withdraw = withdraw_head(1, &dlr, 100_000);
    for head in [&accept, &withdraw] {
        // A witness his policy refuses is refused.
        let mut act = chain.act_of(b"dave", None, dlr);
        act.policy = switch;
        act.witness = b"x";
        reverts(&chain.act_with(head.clone(), act), "not authorized");
        // Signed with a longer witness, his policy answers with a delay: the
        // program schedules nothing, so it refuses, and nothing moves.
        let mut act = chain.act_of(b"dave", None, dlr);
        act.policy = switch;
        act.witness = b"slow";
        reverts(&chain.act_with(head.clone(), act), "not authorized");
        // So does the coin, when his fee payment's own signature answers with one.
        for (fee, reason) in [(0, "payment: delayed binding"), (5, "payment: delayed fee")] {
            let mut act = chain.act_of(b"dave", Some(transfer(&vault, 0)), dlr);
            act.policy = switch;
            act.pay_witness = b"slow";
            act.fee = fee;
            reverts(&chain.act_with(head.clone(), act), reason);
        }
    }
    // An account with a delay cannot list either.
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 100_000)), dlr);
    act.policy = chain.delayed;
    reverts(
        &chain.act_with(offer_head(&terms), act),
        "payment: delayed binding",
    );
    assert!(chain.listing(1).is_some());
    assert_eq!(chain.count(), 1);
    assert_eq!(chain.nonce(&dave), 1);
    assert_eq!(chain.held(&dlr), 100_000);
    // Answering at once, he accepts.
    let mut act = chain.act_of(b"dave", None, dlr);
    act.policy = switch;
    ok(&chain.act_with(accept, act));
    assert!(chain.lock(1).is_some());
    // Nothing is ever scheduled, so there is nothing to run or cancel.
    let run = [
        hash("app/call-v1/run", b"").to_vec(),
        dave.to_vec(),
        0u64.to_le_bytes().to_vec(),
    ]
    .concat();
    reverts(&chain.call(run), "not scheduled");
    let cancel = [hash("app/call-v1/cancel", b"").to_vec(), vec![0; 40]].concat();
    reverts(&chain.call(cancel), "not scheduled");
}

#[test]
fn a_program_account_neither_offers_accepts_nor_withdraws() {
    let mut chain = Chain::new();
    let dlr = chain.dlr;
    let bob = chain.account(b"bob");
    ok(&chain.offer(b"alice", 300_000));
    let proxy = chain.deploy(wasm(PROXY), Vec::new());
    let through = |chain: &mut Chain, call: Vec<u8>| {
        let input = [chain.htlc.to_vec(), call].concat();
        chain.run(Payload::Call {
            target: proxy,
            input,
        })
    };
    let secret: Id = [6; 32];
    let hash = chain.sha256(&secret);
    let until = T0 + WINDOW + GAP;
    let accept = accept_head(1, &bob, &hash, until, &dlr, 300_000);
    reverts(
        &chain.call([accept.clone(), vec![1, 0]].concat()),
        "no calling contract",
    );
    reverts(
        &through(&mut chain, [accept.clone(), vec![1, 0]].concat()),
        "not maker",
    );
    reverts(
        &through(
            &mut chain,
            [withdraw_head(1, &dlr, 300_000), vec![1, 0]].concat(),
        ),
        "not maker",
    );
    let terms = chain.terms();
    for terms in [terms.clone(), terms.with(|t| t.taker = Some(bob))] {
        reverts(
            &through(&mut chain, [offer_head(&terms), vec![1, 0]].concat()),
            "needs payment",
        );
    }
    let with_payment = [accept, vec![1, 1], dlr.to_vec(), bytes(b"")].concat();
    reverts(&through(&mut chain, with_payment), "bad input");
    reverts(
        &chain.call([offer_head(&terms), vec![2, 0]].concat()),
        "bad input",
    );
    reverts(
        &chain.call([offer_head(&terms), vec![1, 2]].concat()),
        "bad input",
    );
    // What needs no signature is the same from a program.
    ok(&through(
        &mut chain,
        take_input(1, &bob, &hash, until, &[1]),
    ));
    ok(&chain.accept(b"alice", 1, &bob, &hash, until));
    ok(&through(&mut chain, claim_input(1, &secret)));
    assert_eq!(chain.balance(&dlr, &bob), START + 300_000 - FEE);
    // The coin's query is answered only while a payment runs, and nothing
    // else short or unknown is an input.
    reverts(&chain.call(vec![0]), "not running");
    for input in [
        vec![],
        vec![1],
        vec![0x0b],
        vec![0, 0],
        vec![8],
        vec![7; 31],
    ] {
        reverts(&chain.call(input), "bad input");
    }
    reverts(&chain.call(vec![7; 32]), "bad input");
    reverts(&chain.call(tag("take").to_vec()), "bad input");
    reverts(&chain.call(tag("lock").to_vec()), "bad input");
}

#[test]
fn a_block_with_no_payout_account_leaves_the_fee_in_the_program() {
    let mut chain = Chain::new();
    let dlr = chain.dlr;
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    let secret: Id = [8; 32];
    let hash = chain.sha256(&secret);
    let terms = chain.terms();
    ok(&chain.offer_with(b"alice", dlr, 300_000, &terms.with(|t| t.fee = 7)));
    ok(&chain.offer_with(b"alice", dlr, 200_000, &terms.with(|t| t.fee = 9)));
    let until = T0 + WINDOW + GAP;
    ok(&chain.accept(b"alice", 1, &bob, &hash, until));
    ok(&chain.accept(b"alice", 2, &bob, &hash, until));
    let r = chain.claim(1, &secret);
    ok(&r);
    assert_eq!(
        chain.ours(&r),
        [event(
            4,
            1,
            &[
                &bob,
                &secret,
                &299_993u128.to_le_bytes(),
                &7u128.to_le_bytes()
            ]
        )]
    );
    assert_eq!(chain.balance(&dlr, &bob), START + 299_993);
    chain.holds_exactly(7);
    chain.at(T0 + WINDOW + 1);
    ok(&chain.refund(2));
    assert_eq!(chain.balance(&dlr, &alice), START - 500_000 + 199_991);
    // What stays is outside every listing and lock, and nothing moves it.
    chain.holds_exactly(16);
    assert_eq!(chain.held(&dlr), 16);
}

#[test]
fn the_program_holds_exactly_its_open_listings_and_locks() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let (alice, bob, carol) = (
        chain.account(b"alice"),
        chain.account(b"bob"),
        chain.account(b"carol"),
    );
    let miner = chain.account(b"miner");
    chain.pay_to(&miner);
    let terms = chain.terms();
    let in_gold = terms.with(|t| {
        t.fee_coin = gold;
        t.fee = 3;
    });
    let (s1, s3, s4) = ([1; 32], [3; 32], [4; 32]);
    let (h1, h3, h4) = (chain.sha256(&s1), chain.sha256(&s3), chain.sha256(&s4));
    let until = |chain: &Chain| chain.context.timestamp + WINDOW + GAP;

    ok(&chain.offer_with(b"alice", dlr, 300_000, &terms.with(|t| t.fee = 9)));
    chain.holds_exactly(0);
    ok(&chain.offer_with(b"bob", dlr, 120_000, &terms.with(|t| t.fee = 5)));
    chain.holds_exactly(0);
    ok(&chain.offer_with(b"carol", gold, 77_000, &in_gold));
    chain.holds_exactly(0);
    ok(&chain.offer_with(
        b"alice",
        gold,
        5,
        &in_gold.with(|t| {
            t.taker = Some(bob);
            t.fee = 0;
        }),
    ));
    chain.holds_exactly(0);
    ok(&chain.take(1, &bob, &h1, until(&chain), &ltc_lock(1)));
    chain.holds_exactly(0);
    ok(&chain.accept(b"alice", 1, &bob, &h1, until(&chain)));
    chain.holds_exactly(0);
    ok(&chain.accept(b"carol", 3, &alice, &h3, until(&chain)));
    chain.holds_exactly(0);
    ok(&chain.withdraw(b"bob", 2));
    chain.holds_exactly(0);
    ok(&chain.claim(1, &s1));
    chain.holds_exactly(0);
    chain.at(T0 + WINDOW + 1);
    reverts(&chain.claim(3, &s3), "too late");
    ok(&chain.refund(3));
    chain.holds_exactly(0);
    ok(&chain.accept(b"alice", 4, &bob, &h4, until(&chain)));
    chain.holds_exactly(0);
    ok(&chain.release(2, &ltc_release(2)));
    chain.holds_exactly(0);
    assert_eq!(chain.held(&gold), 5);
    assert_eq!(chain.held(&dlr), 0);

    // Every account's coins add up to what they started with, give or take trades.
    let total = |coin: &Id| -> u128 {
        [alice, bob, carol, miner]
            .iter()
            .map(|a| chain.balance(coin, a))
            .sum::<u128>()
            + chain.held(coin)
    };
    assert_eq!(total(&dlr), 3 * START);
    assert_eq!(total(&gold), 3 * START);
    assert_eq!(chain.balance(&dlr, &bob), START + 299_991);
    assert_eq!(chain.balance(&gold, &carol), START - 3);
    assert_eq!(chain.balance(&gold, &alice), START - 5);
}

#[test]
fn records_it_cannot_read_and_counters_that_would_overflow() {
    let mut chain = Chain::new();
    let dlr = chain.dlr;
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    ok(&chain.offer(b"alice", 300_000));
    // Listings ever made cannot pass 2^64 − 1; the payment is undone with the call.
    chain.poke(COUNT_KEY, u64::MAX.to_le_bytes().to_vec());
    reverts(&chain.offer(b"alice", 300_000), "too many listings");
    assert_eq!(chain.balance(&dlr, &alice), START - 300_000);
    assert_eq!(chain.nonce(&alice), 1);
    chain.poke(COUNT_KEY, 1u64.to_le_bytes().to_vec());
    // Nor can an account's nonce.
    chain.poke(
        hash("app/call-v1/nonce", &alice),
        u64::MAX.to_le_bytes().to_vec(),
    );
    reverts(&chain.withdraw(b"alice", 1), "nonce exhausted");
    chain.poke(hash("app/call-v1/nonce", &alice), vec![1, 2]);
    let mut act = chain.act_of(b"alice", None, dlr);
    act.nonce = Some(1);
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 300_000), act),
        "corrupt",
    );
    chain.poke(
        hash("app/call-v1/nonce", &alice),
        1u64.to_le_bytes().to_vec(),
    );
    ok(&chain.withdraw(b"alice", 1));
    ok(&chain.offer(b"alice", 300_000));

    // A listing, a lock and the count the program cannot read.
    let good = chain.storage(chain.htlc, listing_key(2)).unwrap();
    for bad in [
        vec![0; 10],
        good[..good.len() - 1].to_vec(),
        [good.clone(), vec![0]].concat(),
        vec![0; 300],
    ] {
        chain.poke(listing_key(2), bad);
        reverts(&chain.call(query(8, 2)), "corrupt");
        reverts(&chain.take(2, &bob, &[1; 32], u64::MAX, &[1]), "corrupt");
        let act = chain.act_of(b"alice", None, dlr);
        reverts(
            &chain.act_with(withdraw_head(2, &dlr, 300_000), act),
            "corrupt",
        );
    }
    chain.poke(listing_key(2), good);
    for bad in [vec![0; 175], vec![0; 177]] {
        chain.poke(lock_key(2), bad);
        reverts(&chain.call(query(0x0a, 2)), "corrupt");
        reverts(&chain.claim(2, &[1; 32]), "corrupt");
        reverts(&chain.refund(2), "corrupt");
    }
    chain.poke(COUNT_KEY, vec![2]);
    reverts(&chain.call(vec![9]), "corrupt");
    reverts(&chain.release(1, &[1]), "corrupt");
    chain.poke(COUNT_KEY, 2u64.to_le_bytes().to_vec());
    chain.poke(ZERO, vec![2]);
    reverts(&chain.call(vec![9]), "corrupt");
}

#[test]
fn costs() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let bob = chain.account(b"bob");
    let miner = chain.account(b"miner");
    chain.pay_to(&miner);
    let vault = contract_account(&chain.htlc);
    let show = |what: &str, r: &Receipt| {
        ok(r);
        let [c, s, d, g] = r.used.0;
        println!("{what:<40} {c:>12} C {s:>4} S {d:>6} D {g:>6} G");
    };
    let secret: Id = [7; 32];
    let hash = chain.sha256(&secret);
    let until = T0 + WINDOW + GAP;
    show("offer", &chain.offer(b"alice", 300_000));
    let to_bob = chain.terms().with(|t| t.taker = Some(bob));
    show(
        "offer_to",
        &chain.offer_with(b"alice", dlr, 300_000, &to_bob),
    );
    show("take", &chain.take(1, &bob, &hash, until, &ltc_lock(1)));
    show(
        "accept, signed",
        &chain.accept(b"alice", 1, &bob, &hash, until),
    );
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), gold);
    act.fee = 1;
    show(
        "accept, approved by a fee payment",
        &chain.act_with(accept_head(2, &bob, &hash, until, &dlr, 300_000), act),
    );
    show("claim, with a fee", &chain.claim(1, &secret));
    chain.at(T0 + WINDOW + 1);
    show("refund, with a fee", &chain.refund(2));
    chain.offer(b"alice", 300_000);
    show("withdraw, signed", &chain.withdraw(b"alice", 3));
    show("release", &chain.release(1, &ltc_release(1)));
}
