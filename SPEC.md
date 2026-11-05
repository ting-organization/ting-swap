# The swap program

A market of listings. A listing offers an amount of one coin for an amount of
another: its maker pays what they give into the program's own account, and it
waits there until someone takes the listing, paying the maker what it wants and
receiving what it gives, or the maker withdraws it and has the coins back.

The program is an ordinary Ting program, `swap.wasm`, built from `program/`. Its
behavior is fixed by its bytes: this page describes them, and the tests in
`tools/tests/swap.rs` hold them to it. Like every installed program it never
changes ([upgrades through programs](https://node1.ting-node.com/wiki/applications/upgrades)).

Its operations are calls of **TCR-1, Ting Call Requests** (`ting-id/TCR-1.md`):
each is a template of the program's own, which declares its fields and gives the
sentence that shows them, and its values, approved by the acting account. An
operation that moves coins carries a coin payment from that account, tied to it,
which is also its approval. A wallet that speaks TCR-1, such as Ting ID, does them
from a `ting:call` link, which the page in `web/` makes. This page states what the
swap adds to TCR-1, and the choices TCR-1 leaves to a program.

In the formats below, integers are little-endian and fixed width, `Bytes(x)` is
`u32(len(x)) ‖ x`, `‖` is concatenation and `H` is Ting's domain-separated hash, as
in the Ting wiki's [conventions](https://node1.ting-node.com/wiki/programs/conventions).
Errors are the exact ASCII bytes the program reverts with.

## Coins

The swap trades any coin that runs the coin reference program, whose CodeHash it
holds in its code:

```text
c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6
```

It asks the chain for a contract's CodeHash (wiki: vm/host, code hashes) before it
takes a payment in it, accepts it as a coin a listing wants, or takes a fee payment
in it, and refuses any other contract with `bad coin`. A contract that only claims
to be a coin could report a payment it never made. Every coin of the reference
program keeps the same rules, so the swap needs nothing else from it: the coins a
listing offers sit in the swap's account in that coin, and leave it only through the
coin.

Coins name themselves, and any number of coins can call themselves the same. The
program does not look at names; a page or a wallet shows a coin it does not know by
its ContractId.

## Deployment

The deployment input is the version, the single byte `01`, which the program
stores at the zero key. Any other input reverts `bad deploy input`, empty input
included. The deployment also stores the program's templates, for wallets to read
([templates](#templates)). Every deployment of the same code behaves the same; each
is a market of its own, with its own listings and its own account.

## Records

| Key | Value |
|---|---|
| `00…00` | The version, `01` |
| `01 ‖ u64 id ‖ 00…` | An open listing: `maker(32) ‖ give_coin(32) ‖ u128 give ‖ want_coin(32) ‖ u128 want ‖ u64 listed_at`, 136 bytes |
| `02 ‖ 00…` | `u64` listings ever made, the last one's id; absent means 0 |
| `ff ‖ 00…` | The signing digest of the call that is paying, only while it pays |
| `H("app/call-v1/templates", "")` | The template list (TCR-1): `u64 count ‖ count × Bytes(template)` |
| `H("app/call-v1/nonce", account)` | An account's nonce in the program, `u64` (TCR-1) |

Keys are 32 bytes, zero-padded. Listings are numbered from 1 in the order they are
made, and an id is never used twice. A listing's record exists while it is open: a
take or a withdrawal deletes it. `listed_at` is the block timestamp of the offer.
The program schedules nothing, so it never writes TCR-1's scheduled records.

The swap's account is its contract account, `H("app/account-v1/contract", swap)`.
It holds, in each coin, exactly the sum of what the open listings in that coin give,
plus whatever anyone sent it outside a listing, which nothing can move.

## Templates

| Template | Pays |
|---|---|
| `offer(want:amount): Offer {payment} in exchange for {want}` | A transfer to the swap's account |
| `take(listing:u64,get:amount): Take listing {listing}: pay {payment} and get {get}` | A transfer of what the listing wants, to its maker |
| `withdraw(listing:u64,back:amount): Withdraw listing {listing} and get back {back}` | Nothing, or a fee payment |

The template list holds them in this order. An `amount` is `coin(32) ‖ u128`.

- **Offer.** What the listing gives is the payment, which the sentence shows as
  `{payment}`: its coin and amount become the listing's `give_coin` and `give`.
  `want` is what the listing asks for.
- **Take.** `get` is what the listing gives, so that the wallet shows it; it must be
  the listing's exactly (`listing changed`). What the taker pays is the payment.
- **Withdraw.** `back` is what the listing gives, as for a take.

## Calls

Every call follows TCR-1's *what the program does*. Who may act:

- **A policy account**, `auth = 00 ‖ policy ‖ Bytes(params) ‖ u64 nonce ‖ u64
  valid_until ‖ Bytes(witness)`. With a payment or a fee payment, the payment is the
  approval and the witness is empty (`bad input` otherwise); the program asks no
  policy, and the coin checks the payment. Without one, the program asks the policy
  for the witness over the call's digest.
- **A program, as its own contract account**, `auth = 01`, when it calls the swap
  (`no calling contract` at top level). It carries no payment (`bad input`), so it
  neither offers nor takes (`needs payment`), and since it never made a listing it
  has none to withdraw (`not maker`).

A payment must come from the acting account (`bad payment`), in a coin of the
reference program (`bad coin`), bound to this program and to the call's digest
(`not bound`). The program checks what the operation needs, which costs little,
before the approval, which costs most, as TCR-1 lets a program: a call that would
fail on its own conditions fails before its signature is checked.

### Accounts with a delay

The swap refuses them outright. An offer and a take pay, and the coin refuses a
bound payment from an account with a delay (`payment: delayed binding`), so such an
account can neither list nor take. A withdrawal is approved by a fee payment, which
the coin refuses from such an account in the same way (`payment: delayed fee` when
it carries a fee, `payment: delayed binding` when not), or by the account's witness:
a policy that answers it with a delay, `01 ‖ u64 d`, reverts `not authorized`, as
TCR-1 requires of a program that does not schedule. Nothing waits and nothing is
carried out early.

A listing's maker had no delay when it listed. Should its account gain one later,
for instance a Ting ID slot whose delay its owner raised, the maker cannot withdraw
until the delay is lowered again; the listing can still be taken meanwhile, paying
the maker.

### Offer

The payment must be a transfer to the swap's account (`bad payment`) of more than 0
(`bad amount`), and `want` more than 0 (`bad amount`), in a coin of the reference
program (`bad coin`) other than the payment's (`same coin`). The program runs the
payment, numbers the listing one past the last, and stores it with the acting
account as its maker.

### Take

The listing must be open (`not listed`), `get` its own (`listing changed`), and the
payment a transfer in the coin it wants (`bad coin`), to its maker (`bad payment`),
of exactly what it wants (`wrong amount`). The program runs the payment, which pays
the maker straight from the taker's account, then sends what the listing gives from
its own account to the taker, and deletes the listing. Both happen in the one call:
if anything fails, nothing moves. Anyone may take a listing, its maker included.

### Withdraw

The listing must be open (`not listed`), its maker the acting account (`not
maker`), and `back` its own (`listing changed`). It takes no payment or a fee
payment: `01 ‖ H("app/account-v1/contract", swap) ‖ u128 0`, a transfer of 0 to the
swap's account from the acting account, in any coin of the reference program, which
carries only the fee (TCR-1, fee payments); any other payment reverts `bad payment`.
The program sends what the listing gives back to its maker, from its own account,
and deletes the listing.

## Other inputs

| Input | |
|---|---|
| `00` | The digest of the call that is paying; `not running` otherwise. The coin's query |
| `08 ‖ u64 id` | Returns the listing's 136-byte record, or reverts `not listed`; safe read-only |
| `09` | Returns the `u64` count of listings ever made; safe read-only |
| `H("app/call-v1/run", "") ‖ …` | Reverts `not scheduled`: nothing is ever scheduled |
| `H("app/call-v1/cancel", "") ‖ …` | Reverts `not scheduled` |

An input shorter than 32 bytes is one of the program's own; any longer one starts
with a template's hash, or with the run's or the cancel's. Anything else reverts
`bad input`.

## Events

The swap emits TCR-1's *executed* for every operation, and events of its own, whose
payload starts with one topic for the whole market, a kind and the listing's id:

```text
topic = H("app/swap-v1/event", "")
```

so a page reads the market's whole history with one filtered query, as the node's
`/v1/events?contract=…&topic=…` allows.

| Kind | After the topic, the kind byte and `u64 id` |
|---|---|
| `01` listed | `maker(32) ‖ give_coin(32) ‖ u128 give ‖ want_coin(32) ‖ u128 want` |
| `02` taken | `maker(32) ‖ taker(32) ‖ give_coin(32) ‖ u128 give ‖ want_coin(32) ‖ u128 want` |
| `03` withdrawn | `maker(32) ‖ give_coin(32) ‖ u128 give` |

The coins emit their own transfer events for every movement.

## Errors

| Error | When |
|---|---|
| `bad deploy input` | A deployment input other than `01`, `00` included |
| `bad input` | An input that does not decode exactly; an unknown template; a witness with a payment; a payment for a program's own account |
| `bad coin` | A contract that does not run the coin reference program; a take paid in another coin than the listing wants |
| `same coin` | An offer that wants the coin it pays |
| `bad amount` | An offer that gives or wants 0 |
| `needs payment` | An offer or a take without a payment |
| `bad payment` | A coin input that is not the coin's authorized action of a policy account, or does not decode as one; a payment from another account, of the wrong effect, or to the wrong account; any payment for a withdrawal but a fee payment |
| `not bound` | A payment bound to another program or digest |
| `wrong amount` | A take that pays other than what the listing wants |
| `not listed` | A listing taken, withdrawn or never made |
| `listing changed` | A take's `get` or a withdrawal's `back` that is not the listing's |
| `not maker` | A withdrawal by another account than the listing's maker |
| `expired`, `bad nonce`, `nonce exhausted` | TCR-1's deadline and nonce |
| `not authorized` | A policy that refuses, or answers with a delay |
| `no calling contract` | `auth = 01` at top level |
| `not scheduled` | A run or a cancel |
| `not running` | The query `00` outside a payment |
| `payment: …`, `coin: …` | The coin's refusal, of the payment or of a transfer out of the swap's account |
| `insufficient budget` | Less budget left than the standard reserve, before a child call |
| `too many listings` | The count would pass `2^64 − 1` |
| `corrupt` | A record the program cannot read; its own writes never make one |

## Costs

With P-256 signatures, measured on a development chain by `scripts/devchain.mjs
e2e`; the signature check is most of it.

| Operation | C | S |
|---|---:|---:|
| Offer | 20.4 million | 32 |
| Take | 20.5 million | 39 |
| Withdraw, signed through a Ting ID identity | 21.6 million | 26 |
| Withdraw, approved by a fee payment | 20.6 million | 39 |

Every call checks one signature: the payment's when it pays, the call's when it does
not. A plain coin transfer with the same key costs 19.1 million C. Without the
signature, on the reference VM with a stub policy (`cargo test … costs`), an offer
costs about 2.9 million C, a take 3.0 million and a withdrawal 2.7 million.
