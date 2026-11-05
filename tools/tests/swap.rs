//! The swap program on Ting's reference VM, paying through the real coin
//! program, with two coins to trade. Accounts sign through stub policies that
//! approve every message: one at once, one only after a delay as a savings
//! account does, and one that answers with a delay only when it is given a
//! witness, so that the same account can list without a delay and later answer
//! with one. Accounts are told apart by their policy and params, which is all
//! the swap and the coin see of who signed. The dev-chain run
//! (scripts/devchain.mjs e2e) checks real signatures and identities.
use std::fs;
use ting_core::{
    hash::{hash, hash_parts},
    meter::Resources,
    protocol::{Genesis, Payload, Receipt, Status, Transaction},
    state::State,
    vm::{Context, Runtime, profile},
};

type Id = [u8; 32];

const BUDGET: Resources = Resources([200_000_000, 4096, 4_000_000, 4_000_000]);

const OFFER: &str = "offer(want:amount): Offer {payment} in exchange for {want}";
const TAKE: &str =
    "take(listing:u64,get:amount): Take listing {listing}: pay {payment} and get {get}";
const WITHDRAW: &str =
    "withdraw(listing:u64,back:amount): Withdraw listing {listing} and get back {back}";

/// The CodeHash of the coin reference program, which the swap insists on.
const COIN_CODE: &str = "c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6";

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

fn offer_head(want_coin: &Id, want: u128) -> Vec<u8> {
    head(OFFER, &[&amount(want_coin, want)])
}

fn take_head(id: u64, give_coin: &Id, give: u128) -> Vec<u8> {
    head(TAKE, &[&id.to_le_bytes(), &amount(give_coin, give)])
}

fn withdraw_head(id: u64, give_coin: &Id, give: u128) -> Vec<u8> {
    head(WITHDRAW, &[&id.to_le_bytes(), &amount(give_coin, give)])
}

fn listing_key(id: u64) -> Id {
    let mut key = [0; 32];
    key[0] = 1;
    key[1..9].copy_from_slice(&id.to_le_bytes());
    key
}

fn executed(account: &Id, sequence: u64, head: &[u8]) -> Vec<u8> {
    let mut e = hash("app/call-v1/event/executed", b"").to_vec();
    e.extend(account);
    e.extend(sequence.to_le_bytes());
    e.extend(hash("app/call-v1/operation", head));
    e
}

fn swap_event(kind: u8, id: u64, parts: &[&[u8]]) -> Vec<u8> {
    let mut e = hash("app/swap-v1/event", b"").to_vec();
    e.push(kind);
    e.extend(id.to_le_bytes());
    for part in parts {
        e.extend(*part);
    }
    e
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

fn swap() -> Vec<u8> {
    let code = read("../swap.wasm");
    profile::validate(&code).unwrap();
    code
}

/// A listing's record, decoded.
#[derive(Debug, PartialEq)]
struct Listing {
    maker: Id,
    give_coin: Id,
    give: u128,
    want_coin: Id,
    want: u128,
    listed_at: u64,
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
    /// Two coins of the reference program, to trade one for the other.
    dlr: Id,
    gold: Id,
    swap: Id,
}

impl Chain {
    /// Alice, Bob and Carol hold 1,000,000 of each coin, and so do Dave, of
    /// the switching policy, and Alice's account with a delay.
    fn new() -> Self {
        let g = Genesis::experimental();
        let mut chain = Chain {
            state: State::default(),
            context: Context::from_genesis(&g),
            instant: [0; 32],
            delayed: [0; 32],
            switch: [0; 32],
            dlr: [0; 32],
            gold: [0; 32],
            swap: [0; 32],
        };
        chain.instant = chain.deploy(wasm(INSTANT_POLICY), Vec::new());
        chain.delayed = chain.deploy(wasm(DELAYED_POLICY), Vec::new());
        chain.switch = chain.deploy(wasm(SWITCH_POLICY), Vec::new());
        chain.dlr = chain.coin(b"Daler", b"DLR", 8);
        chain.gold = chain.coin(b"Gold", b"GLD", 2);
        chain.swap = chain.deploy(swap(), vec![1]);
        chain.context.height += 1;
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
            coin.extend(1_000_000u128.to_le_bytes());
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
            target: self.swap,
            input,
        })
    }

    fn storage(&self, contract: Id, key: Id) -> Option<Vec<u8>> {
        Runtime::new(self.state.clone(), self.context.clone()).storage(contract, key)
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

    /// What the swap's own account holds of `coin`.
    fn held(&self, coin: &Id) -> u128 {
        self.balance(coin, &contract_account(&self.swap))
    }

    /// An account's nonce in the swap (TCR-1).
    fn nonce(&self, account: &Id) -> u64 {
        let key = hash("app/call-v1/nonce", account);
        self.storage(self.swap, key)
            .map_or(0, |v| u64::from_le_bytes(v.try_into().unwrap()))
    }

    fn listing(&self, id: u64) -> Option<Listing> {
        let r = self.storage(self.swap, listing_key(id))?;
        assert_eq!(r.len(), 136);
        let id32 = |at: usize| -> Id { r[at..at + 32].try_into().unwrap() };
        Some(Listing {
            maker: id32(0),
            give_coin: id32(32),
            give: u128::from_le_bytes(r[64..80].try_into().unwrap()),
            want_coin: id32(80),
            want: u128::from_le_bytes(r[112..128].try_into().unwrap()),
            listed_at: u64::from_le_bytes(r[128..136].try_into().unwrap()),
        })
    }

    fn count(&self) -> u64 {
        let mut key = [0; 32];
        key[0] = 2;
        self.storage(self.swap, key)
            .map_or(0, |v| u64::from_le_bytes(v.try_into().unwrap()))
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
            self.swap.to_vec(),
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
                    a.extend(self.swap);
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

    /// `who` offers `give` of `give_coin` for `want` of `want_coin`.
    fn offer(
        &mut self,
        who: &[u8],
        give_coin: Id,
        give: u128,
        want_coin: Id,
        want: u128,
    ) -> Receipt {
        let vault = contract_account(&self.swap);
        let act = self.act_of(who, Some(transfer(&vault, give)), give_coin);
        self.act_with(offer_head(&want_coin, want), act)
    }

    /// `who` takes listing `id`, paying its maker.
    fn take(&mut self, who: &[u8], id: u64) -> Receipt {
        let l = self.listing(id).expect("listed");
        let act = self.act_of(who, Some(transfer(&l.maker, l.want)), l.want_coin);
        self.act_with(take_head(id, &l.give_coin, l.give), act)
    }

    /// `who` withdraws listing `id`, approved by its witness.
    fn withdraw(&mut self, who: &[u8], id: u64) -> Receipt {
        let l = self.listing(id).expect("listed");
        let act = self.act_of(who, None, self.dlr);
        self.act_with(withdraw_head(id, &l.give_coin, l.give), act)
    }
}

#[test]
fn deployment_takes_version_one_and_lists_the_templates() {
    let mut chain = Chain::new();
    for input in [vec![], vec![0], vec![2], vec![1, 0]] {
        let r = chain.run(Payload::Deploy {
            code: swap(),
            input,
        });
        reverts(&r, "bad deploy input");
    }
    let list = chain
        .storage(chain.swap, hash("app/call-v1/templates", b""))
        .unwrap();
    let mut expected = 3u64.to_le_bytes().to_vec();
    for t in [OFFER, TAKE, WITHDRAW] {
        expected.extend(bytes(t.as_bytes()));
    }
    assert_eq!(list, expected);
    assert_eq!(chain.storage(chain.swap, [0; 32]), Some(vec![1]));
    assert_eq!(chain.count(), 0);
}

#[test]
fn an_offer_puts_the_coins_in_the_swap_and_lists_them() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let alice = chain.account(b"alice");
    let r = chain.offer(b"alice", dlr, 300, gold, 50);
    ok(&r);
    assert_eq!(chain.count(), 1);
    assert_eq!(
        chain.listing(1),
        Some(Listing {
            maker: alice,
            give_coin: dlr,
            give: 300,
            want_coin: gold,
            want: 50,
            listed_at: chain.context.timestamp
        })
    );
    assert_eq!(chain.balance(&dlr, &alice), 1_000_000 - 300);
    assert_eq!(chain.held(&dlr), 300);
    let ours: Vec<_> = r
        .events
        .iter()
        .filter(|e| e.contract == chain.swap)
        .map(|e| e.payload.clone())
        .collect();
    assert_eq!(
        ours,
        [
            swap_event(
                1,
                1,
                &[
                    &alice,
                    &dlr,
                    &300u128.to_le_bytes(),
                    &gold,
                    &50u128.to_le_bytes()
                ]
            ),
            executed(&alice, 0, &offer_head(&gold, 50)),
        ]
    );
    // Ids count up and are never reused.
    ok(&chain.offer(b"bob", gold, 7, dlr, 70));
    assert_eq!(chain.count(), 2);
    assert_eq!(chain.listing(2).unwrap().maker, chain.account(b"bob"));
    assert_eq!(chain.held(&gold), 7);
    // The queries read the same records.
    let r = chain.call([&[8][..], &1u64.to_le_bytes()].concat());
    ok(&r);
    assert_eq!(r.result, chain.storage(chain.swap, listing_key(1)).unwrap());
    reverts(
        &chain.call([&[8][..], &9u64.to_le_bytes()].concat()),
        "not listed",
    );
    let r = chain.call(vec![9]);
    ok(&r);
    assert_eq!(r.result, 2u64.to_le_bytes());
}

#[test]
fn an_offer_is_refused_unless_it_pays_a_real_coin_into_the_swap() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let fake = chain.deploy(wasm(FAKE_COIN), Vec::new());
    let vault = contract_account(&chain.swap);
    let bob = chain.account(b"bob");
    let refused = |chain: &mut Chain, act: Act, head: Vec<u8>, reason: &str| {
        let before = (chain.balance(&dlr, &chain.account(b"alice")), chain.count());
        reverts(&chain.act_with(head, act), reason);
        assert_eq!(
            before,
            (chain.balance(&dlr, &chain.account(b"alice")), chain.count())
        );
    };
    let base =
        |chain: &Chain, effect: Vec<u8>, coin: Id| chain.act_of(b"alice", Some(effect), coin);
    let burn = [&[2][..], &10u128.to_le_bytes()].concat();
    let cases: [(Vec<u8>, Id, Vec<u8>, &str); 9] = [
        (
            transfer(&vault, 10),
            dlr,
            offer_head(&gold, 0),
            "bad amount",
        ),
        (transfer(&vault, 0), dlr, offer_head(&gold, 5), "bad amount"),
        (transfer(&vault, 10), dlr, offer_head(&dlr, 5), "same coin"),
        (transfer(&vault, 10), dlr, offer_head(&fake, 5), "bad coin"),
        (
            transfer(&vault, 10),
            dlr,
            offer_head(&[7; 32], 5),
            "bad coin",
        ),
        (transfer(&vault, 10), fake, offer_head(&gold, 5), "bad coin"),
        (transfer(&bob, 10), dlr, offer_head(&gold, 5), "bad payment"),
        (burn, dlr, offer_head(&gold, 5), "bad payment"),
        (
            transfer(&vault, 2_000_000),
            dlr,
            offer_head(&gold, 5),
            "payment: insufficient funds",
        ),
    ];
    for (effect, coin, head, reason) in cases {
        let act = base(&chain, effect, coin);
        refused(&mut chain, act, head, reason);
    }
    let act = chain.act_of(b"alice", None, dlr);
    refused(&mut chain, act, offer_head(&gold, 5), "needs payment");
    let mut act = base(&chain, transfer(&vault, 10), dlr);
    act.payer = Some((chain.instant, b"bob"));
    refused(&mut chain, act, offer_head(&gold, 5), "bad payment");
    let mut act = base(&chain, transfer(&vault, 10), dlr);
    act.witness = b"sig";
    refused(&mut chain, act, offer_head(&gold, 5), "bad input");
    let mut act = base(&chain, transfer(&vault, 10), dlr);
    act.bound_to = Some([3; 32]);
    refused(&mut chain, act, offer_head(&gold, 5), "not bound");
    let mut act = base(&chain, transfer(&vault, 10), dlr);
    act.nonce = Some(4);
    refused(&mut chain, act, offer_head(&gold, 5), "bad nonce");
    let mut act = base(&chain, transfer(&vault, 10), dlr);
    act.valid_until = chain.context.timestamp - 1;
    refused(&mut chain, act, offer_head(&gold, 5), "expired");
    // An account with a delay cannot pay: the coin refuses its bound actions.
    let mut act = base(&chain, transfer(&vault, 10), dlr);
    act.policy = chain.delayed;
    refused(
        &mut chain,
        act,
        offer_head(&gold, 5),
        "payment: delayed binding",
    );
    assert_eq!(chain.held(&dlr), 0);
    // An unknown template, values cut short, and bytes after the call.
    let mut call = chain.input(
        &offer_head(&gold, 5),
        &base(&chain, transfer(&vault, 10), dlr),
    );
    call[0] ^= 1;
    reverts(&chain.call(call), "bad input");
    let call = chain.input(
        &offer_head(&gold, 5),
        &base(&chain, transfer(&vault, 10), dlr),
    );
    reverts(&chain.call(call[..60].to_vec()), "bad input");
    reverts(&chain.call([call, vec![0]].concat()), "bad input");
}

#[test]
fn a_take_pays_the_maker_and_hands_over_the_listed_coins() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    ok(&chain.offer(b"alice", dlr, 300, gold, 50));
    let vault = contract_account(&chain.swap);
    let refused = |chain: &mut Chain, effect: Vec<u8>, coin: Id, head: Vec<u8>, reason: &str| {
        let act = chain.act_of(b"bob", Some(effect), coin);
        reverts(&chain.act_with(head, act), reason);
        assert!(chain.listing(1).is_some());
    };
    refused(
        &mut chain,
        transfer(&alice, 49),
        gold,
        take_head(1, &dlr, 300),
        "wrong amount",
    );
    refused(
        &mut chain,
        transfer(&alice, 51),
        gold,
        take_head(1, &dlr, 300),
        "wrong amount",
    );
    refused(
        &mut chain,
        transfer(&vault, 50),
        gold,
        take_head(1, &dlr, 300),
        "bad payment",
    );
    refused(
        &mut chain,
        transfer(&alice, 50),
        dlr,
        take_head(1, &dlr, 300),
        "bad coin",
    );
    refused(
        &mut chain,
        transfer(&alice, 50),
        gold,
        take_head(1, &dlr, 301),
        "listing changed",
    );
    refused(
        &mut chain,
        transfer(&alice, 50),
        gold,
        take_head(1, &gold, 300),
        "listing changed",
    );
    refused(
        &mut chain,
        transfer(&alice, 50),
        gold,
        take_head(2, &dlr, 300),
        "not listed",
    );
    let act = chain.act_of(b"bob", None, gold);
    reverts(
        &chain.act_with(take_head(1, &dlr, 300), act),
        "needs payment",
    );

    let call = chain.input(
        &take_head(1, &dlr, 300),
        &chain.act_of(b"bob", Some(transfer(&alice, 50)), gold),
    );
    let r = chain.call(call.clone());
    ok(&r);
    assert_eq!(chain.listing(1), None);
    assert_eq!(chain.balance(&dlr, &bob), 1_000_000 + 300);
    assert_eq!(chain.balance(&gold, &bob), 1_000_000 - 50);
    assert_eq!(chain.balance(&dlr, &alice), 1_000_000 - 300);
    assert_eq!(chain.balance(&gold, &alice), 1_000_000 + 50);
    assert_eq!(chain.held(&dlr), 0);
    let ours: Vec<_> = r
        .events
        .iter()
        .filter(|e| e.contract == chain.swap)
        .map(|e| e.payload.clone())
        .collect();
    assert_eq!(
        ours,
        [
            swap_event(
                2,
                1,
                &[
                    &alice,
                    &bob,
                    &dlr,
                    &300u128.to_le_bytes(),
                    &gold,
                    &50u128.to_le_bytes()
                ]
            ),
            executed(&bob, 0, &take_head(1, &dlr, 300)),
        ]
    );
    // A listing is taken once: the same call again is stale, a new one finds nothing.
    reverts(&chain.call(call), "bad nonce");
    let act = chain.act_of(b"carol", Some(transfer(&alice, 50)), gold);
    reverts(&chain.act_with(take_head(1, &dlr, 300), act), "not listed");
    // Its maker can take their own listing, paying themselves.
    ok(&chain.offer(b"alice", dlr, 10, gold, 1));
    ok(&chain.take(b"alice", 2));
    assert_eq!(chain.balance(&dlr, &alice), 1_000_000 - 300);
}

#[test]
fn only_the_maker_withdraws_and_gets_the_coins_back() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let alice = chain.account(b"alice");
    ok(&chain.offer(b"alice", dlr, 300, gold, 50));
    ok(&chain.offer(b"alice", dlr, 200, gold, 40));
    reverts(&chain.withdraw(b"bob", 1), "not maker");
    let act = chain.act_of(b"alice", None, dlr);
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 299), act),
        "listing changed",
    );
    let act = chain.act_of(b"alice", None, dlr);
    reverts(
        &chain.act_with(withdraw_head(3, &dlr, 300), act),
        "not listed",
    );
    // Another policy with the same params is another account.
    let refusing = chain.deploy(wasm(REFUSING_POLICY), Vec::new());
    let mut act = chain.act_of(b"alice", None, dlr);
    act.policy = refusing;
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 300), act),
        "not maker",
    );

    let r = chain.withdraw(b"alice", 1);
    ok(&r);
    assert_eq!(chain.listing(1), None);
    assert_eq!(chain.balance(&dlr, &alice), 1_000_000 - 200);
    assert_eq!(chain.held(&dlr), 200);
    assert_eq!(
        r.events.iter().filter(|e| e.contract == chain.swap).count(),
        2
    );
    assert_eq!(
        r.events
            .iter()
            .find(|e| e.contract == chain.swap)
            .unwrap()
            .payload,
        swap_event(3, 1, &[&alice, &dlr, &300u128.to_le_bytes()])
    );
    reverts(&chain.withdraw(b"bob", 2), "not maker");
    let act = chain.act_of(b"alice", None, dlr);
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 300), act),
        "not listed",
    );

    // A fee payment approves it too: a transfer of 0 to the swap's own
    // account, in a real coin, and nothing else.
    let vault = contract_account(&chain.swap);
    let fake = chain.deploy(wasm(FAKE_COIN), Vec::new());
    for (effect, coin, reason) in [
        (transfer(&vault, 1), dlr, "bad payment"),
        (transfer(&alice, 0), dlr, "bad payment"),
        (transfer(&vault, 0), fake, "bad coin"),
    ] {
        let act = chain.act_of(b"alice", Some(effect), coin);
        reverts(&chain.act_with(withdraw_head(2, &dlr, 200), act), reason);
    }
    // Nor a burn of nothing, a payment bound to no program, or one that claims
    // to be the swap's own action.
    let burn0 = [&[2][..], &0u128.to_le_bytes()].concat();
    let act = chain.act_of(b"alice", Some(burn0), dlr);
    reverts(
        &chain.act_with(withdraw_head(2, &dlr, 200), act),
        "bad payment",
    );
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), dlr);
    act.unbound = true;
    reverts(
        &chain.act_with(withdraw_head(2, &dlr, 200), act),
        "not bound",
    );
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), dlr);
    act.contract_auth = true;
    reverts(
        &chain.act_with(withdraw_head(2, &dlr, 200), act),
        "bad payment",
    );
    let act = chain.act_of(b"alice", Some(transfer(&vault, 0)), gold);
    ok(&chain.act_with(withdraw_head(2, &dlr, 200), act));
    assert_eq!(chain.balance(&dlr, &alice), 1_000_000);
    assert_eq!(chain.balance(&gold, &alice), 1_000_000);
    assert_eq!(chain.held(&dlr), 0);
}

#[test]
fn an_account_answering_with_a_delay_is_refused_outright() {
    let mut chain = Chain::new();
    let (dlr, gold, switch) = (chain.dlr, chain.gold, chain.switch);
    let dave = chain.account_of(&switch, b"dave");
    let vault = contract_account(&chain.swap);
    // Dave lists while his account answers at once, as a payment's coin asks it.
    let mut act = chain.act_of(b"dave", Some(transfer(&vault, 100)), dlr);
    act.policy = switch;
    ok(&chain.act_with(offer_head(&gold, 5), act));
    // A witness his policy refuses is refused.
    let mut act = chain.act_of(b"dave", None, dlr);
    act.policy = switch;
    act.witness = b"x";
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 100), act),
        "not authorized",
    );
    // Signed with a longer witness, his policy answers with a delay: the swap
    // schedules nothing, so it refuses, and nothing moves.
    let mut act = chain.act_of(b"dave", None, dlr);
    act.policy = switch;
    act.witness = b"slow";
    reverts(
        &chain.act_with(withdraw_head(1, &dlr, 100), act),
        "not authorized",
    );
    // So does the coin, when his fee payment's own signature answers with one.
    for (fee, reason) in [(0, "payment: delayed binding"), (5, "payment: delayed fee")] {
        let mut act = chain.act_of(b"dave", Some(transfer(&vault, 0)), dlr);
        act.policy = switch;
        act.pay_witness = b"slow";
        act.fee = fee;
        reverts(&chain.act_with(withdraw_head(1, &dlr, 100), act), reason);
    }
    // An account with a delay cannot take a listing either.
    let mut act = chain.act_of(b"alice", Some(transfer(&dave, 5)), gold);
    act.policy = chain.delayed;
    reverts(
        &chain.act_with(take_head(1, &dlr, 100), act),
        "payment: delayed binding",
    );
    assert!(chain.listing(1).is_some());
    assert_eq!(chain.nonce(&dave), 1);
    assert_eq!(chain.held(&dlr), 100);
    // Answering at once, he withdraws.
    let mut act = chain.act_of(b"dave", None, dlr);
    act.policy = switch;
    ok(&chain.act_with(withdraw_head(1, &dlr, 100), act));
    assert_eq!(chain.balance(&dlr, &dave), 1_000_000);
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
fn payments_pay_their_fee_to_the_block_and_nothing_else_leaves() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let miner = chain.account(b"miner");
    // Producer data naming a payout account (wiki: programs/conventions).
    chain.context.producer = [
        &b"OCP1"[..],
        &1u32.to_le_bytes(),
        &32u32.to_le_bytes(),
        &miner,
    ]
    .concat();
    let (alice, bob) = (chain.account(b"alice"), chain.account(b"bob"));
    let vault = contract_account(&chain.swap);
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 300)), dlr);
    act.fee = 7;
    ok(&chain.act_with(offer_head(&gold, 50), act));
    let mut act = chain.act_of(b"bob", Some(transfer(&alice, 50)), gold);
    act.fee = 3;
    ok(&chain.act_with(take_head(1, &dlr, 300), act));
    ok(&chain.offer(b"alice", dlr, 40, gold, 1));
    let mut act = chain.act_of(b"alice", Some(transfer(&vault, 0)), dlr);
    act.fee = 11;
    ok(&chain.act_with(withdraw_head(2, &dlr, 40), act));
    assert_eq!(chain.balance(&dlr, &miner), 7 + 11);
    assert_eq!(chain.balance(&gold, &miner), 3);
    assert_eq!(chain.balance(&dlr, &alice), 1_000_000 - 300 - 7 - 11);
    assert_eq!(chain.balance(&gold, &alice), 1_000_000 + 50);
    assert_eq!(chain.balance(&dlr, &bob), 1_000_000 + 300);
    assert_eq!(chain.balance(&gold, &bob), 1_000_000 - 50 - 3);
    assert_eq!((chain.held(&dlr), chain.held(&gold)), (0, 0));
}

#[test]
fn a_program_account_neither_offers_takes_nor_withdraws() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    ok(&chain.offer(b"alice", dlr, 300, gold, 50));
    let proxy = chain.deploy(wasm(PROXY), Vec::new());
    let through = |chain: &mut Chain, call: Vec<u8>| {
        let input = [chain.swap.to_vec(), call].concat();
        chain.run(Payload::Call {
            target: proxy,
            input,
        })
    };
    let withdraw = withdraw_head(1, &dlr, 300);
    reverts(
        &chain.call([withdraw.clone(), vec![1, 0]].concat()),
        "no calling contract",
    );
    reverts(
        &through(&mut chain, [withdraw.clone(), vec![1, 0]].concat()),
        "not maker",
    );
    reverts(
        &through(&mut chain, [offer_head(&gold, 5), vec![1, 0]].concat()),
        "needs payment",
    );
    reverts(
        &through(&mut chain, [take_head(1, &dlr, 300), vec![1, 0]].concat()),
        "needs payment",
    );
    let with_payment = [withdraw, vec![1, 1], chain.dlr.to_vec(), bytes(b"")].concat();
    reverts(&through(&mut chain, with_payment), "bad input");
    // The coin's query is answered only while a payment runs.
    reverts(&chain.call(vec![0]), "not running");
}

#[test]
fn the_swap_holds_exactly_what_its_open_listings_offer() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    ok(&chain.offer(b"alice", dlr, 300, gold, 50));
    ok(&chain.offer(b"bob", dlr, 120, gold, 9));
    ok(&chain.offer(b"carol", gold, 77, dlr, 1000));
    ok(&chain.offer(b"alice", gold, 5, dlr, 1));
    ok(&chain.take(b"carol", 1));
    ok(&chain.withdraw(b"alice", 4));
    ok(&chain.take(b"alice", 3));
    let open: Vec<_> = (1..=chain.count())
        .filter_map(|id| chain.listing(id))
        .collect();
    assert_eq!(open.len(), 1);
    for coin in [dlr, gold] {
        let listed: u128 = open
            .iter()
            .filter(|l| l.give_coin == coin)
            .map(|l| l.give)
            .sum();
        assert_eq!(chain.held(&coin), listed);
    }
    // Every account's coins add up to what they started with, give or take trades.
    let total = |coin: &Id| -> u128 {
        [b"alice".as_slice(), b"bob", b"carol"]
            .iter()
            .map(|w| chain.balance(coin, &chain.account(w)))
            .sum::<u128>()
            + chain.held(coin)
    };
    assert_eq!(total(&dlr), 3_000_000);
    assert_eq!(total(&gold), 3_000_000);
}

#[test]
fn costs() {
    let mut chain = Chain::new();
    let (dlr, gold) = (chain.dlr, chain.gold);
    let show = |what: &str, r: &Receipt| {
        ok(r);
        let [c, s, d, g] = r.used.0;
        println!("{what:<40} {c:>12} C {s:>4} S {d:>6} D {g:>6} G");
    };
    show("offer", &chain.offer(b"alice", dlr, 300, gold, 50));
    show("take", &chain.take(b"bob", 1));
    chain.offer(b"alice", dlr, 300, gold, 50);
    show("withdraw, signed", &chain.withdraw(b"alice", 2));
}
