# Cross-chain swaps: the HTLC program

DLR for LTC, with no one sending first and no server in between. A coin holder on Ting
lists coins for an amount on another chain. A buyer locks that amount on the other chain
under the hash of a secret only they know. The seller checks the lock and locks the
coins on Ting for the buyer under the same hash. The buyer claims the coins on Ting,
which reveals the secret, and the seller uses it to claim the other chain's coins. If
anything stalls, each side gets its coins back after a deadline.

It is three pieces:

- **The program** (`htlc/`, built to `htlc.wasm`): listings, locks, claims and refunds
  on Ting. It never sees the other chain. This page states its rules.
- **The Litecoin script and transactions** (`web/js/ltc.js`): the lock on Litecoin and
  the transactions that spend it, built and signed by the page.
- **The page** (`web/`, the Litecoin tab): checks the other chain, keeps the keys and
  the secret, and hands each Ting action to a wallet as a TCR-1 call link.

In the formats below, integers are little-endian and fixed width, `Bytes(x)` is
`u32(len(x)) ‖ x`, `‖` is concatenation and `H` is Ting's domain-separated hash, as in
the Ting wiki's conventions and as `program/src/sha256.rs` computes it. `SHA-256` is
plain SHA-256. Errors are the exact ASCII bytes the program reverts with.

## The trade

| Step | Who | On | What |
|---|---|---|---|
| Offer | Seller | Ting | Pays the coins into the program; states the other chain, the amount wanted there, the seller's key there, and the lock window |
| Lock | Buyer | Litecoin | Pays the wanted amount to a script: the seller with the secret, or the buyer after T1 |
| Take | Buyer's page | Ting | Posts the hash, T1, the buyer's Ting account and where the lock is. Anyone may post; nothing is stored |
| Accept | Seller | Ting | After checking the lock, locks the coins for the buyer under the hash until T2 = now + window, with T2 + 6 h ≤ T1 |
| Claim | Buyer's page, or anyone with the secret | Ting | Reveals the secret; the coins go to the buyer |
| Claim | Seller's page | Litecoin | Spends the lock with the secret |
| Refund | Anyone | Ting | After T2, the coins go back to the seller |
| Refund | Buyer | Litecoin | After T1, the lock goes back to the buyer |
| Release | Seller's page | Ting | Lets a buyer whose take is not accepted have their lock back before T1 |

The deadline on Ting always ends at least 6 hours before the one on the other chain, so
a seller who sees the secret appear on Ting at the last moment still has time to claim.

## The program

### Deployment

The deployment input is the version, the single byte `01`, stored at the zero key. Any
other input reverts `bad deploy input`. The deployment also stores the template list.

### Constants

| Name | Value |
|---|---|
| `GAP` | 21,600 s (6 h): the least time between T2 and T1 |
| `MIN_WINDOW` | 21,600 s (6 h): well above Ting's 2 h clock slack, see the claims below |
| `MAX_WINDOW` | 604,800 s (7 days) |
| `FEE_SHARE` | 1,000: an offer's fee is at most a thousandth of its coins |
| Coin CodeHash | `c675a4b753b61b50ae4b63cde122171f8f2bfb9a05a92df895633ca8c351e4d6` |

### Records

| Key | Value |
|---|---|
| `00…00` | The version, `01` |
| `01 ‖ u64 id ‖ 00…` | An open listing: `maker(32) ‖ coin(32) ‖ u128 amount ‖ u64 want ‖ taker(32) ‖ u64 window ‖ u128 fee ‖ u64 listed_at ‖ Bytes(chain) ‖ Bytes(key)` |
| `02 ‖ 00…` | `u64` listings ever made, the last one's id; absent means 0 |
| `03 ‖ u64 id ‖ 00…` | An accepted listing's lock: `maker(32) ‖ coin(32) ‖ u128 amount ‖ taker(32) ‖ hash(32) ‖ u64 t1 ‖ u64 deadline ‖ u128 fee`, 176 bytes |
| `ff ‖ 00…` | The signing digest of the call that is paying, only while it pays |
| `H("app/call-v1/templates", "")` | The template list (TCR-1) |
| `H("app/call-v1/nonce", account)` | An account's nonce in the program (TCR-1) |

- **Ids.** Listings are numbered from 1 and never reused. A lock keeps its listing's id.
- **Taker.** A listing's `taker` is the one account allowed to take it, or 32 zero bytes
  for anyone.
- **Chain and key.** `chain` names the other chain: `LTC` or `BTC`, the label of the
  offer's `chain` enum. Both count their coin in hundred-millionths, as `want` is.
  `key` is the seller's public key there, 1 to 65 bytes, which the program does not read.
- **Lifetime.** A listing's record exists while it is open; an accept turns it into a
  lock, and a withdrawal deletes it. A lock's record exists until a claim or a refund.
- **The program's account** is `H("app/account-v1/contract", program)`. In each coin it
  holds exactly the open listings' and the locks' amounts, plus the fees of claims and
  refunds in blocks with no payout account and whatever anyone sent it outside them,
  which nothing can move.

### Templates

| Template | Pays |
|---|---|
| `offer(chain:enum(LTC\|BTC),whole:u64,d1:u8,d2:u8,d3:u8,d4:u8,d5:u8,d6:u8,d7:u8,d8:u8,key:bytes,window:duration,fee:amount): Sell {payment} for {whole}.{d1}{d2}{d3}{d4}{d5}{d6}{d7}{d8} {chain}, paid to your {chain} key ({key}). Once a buyer's lock is accepted, the coins are held for them for {window}. The buyer's claim, or a refund, pays a network fee of {fee} out of these coins` | A transfer to the program's account |
| `offer_to(taker:account,chain:enum(LTC\|BTC),whole:u64,d1:u8,d2:u8,d3:u8,d4:u8,d5:u8,d6:u8,d7:u8,d8:u8,key:bytes,window:duration,fee:amount): Sell {payment} to {taker} only, for {whole}.{d1}{d2}{d3}{d4}{d5}{d6}{d7}{d8} {chain}, paid to your {chain} key ({key}). Once their lock is accepted, the coins are held for them for {window}. Their claim, or a refund, pays a network fee of {fee} out of these coins` | A transfer to the program's account |
| `accept(listing:u64,taker:account,hash:bytes32,until:time,give:amount): Accept a lock for listing {listing}: hold {give} for {taker} until they reveal the secret of {hash}, before their lock ends {until}` | Nothing, or a fee payment |
| `withdraw(listing:u64,back:amount): Withdraw listing {listing} and get back {back}` | Nothing, or a fee payment |

The template list holds them in this order. An `amount` is `coin(32) ‖ u128`, `bytes`
is `Bytes(…)`, `duration` and `time` are `u64` seconds, and an `enum` is its label's
index as a `u8`.

An offer's amount is written so that a wallet shows it as a decimal number: TCR-1 shows
an integer as it is, so `want` in base units would read as `50000000`. The offer states
it as whole coins, `whole`, and the eight decimal digits after the point, `d1` to `d8`,
each a `u8` from 0 to 9, and the sentence joins them with a point: `0.50000000 LTC`.
The program reads `want = whole · 100,000,000 + d1d2…d8`.

Who may act, payments, fee payments, nonces, deadlines, the *executed* event, and the
refusal of accounts with a delay are exactly as in Ting Swap's SPEC.md, *Calls*.

- **Offer, offer_to.** The payment must be a transfer to the program's account
  (`bad payment`) of more than 0 (`bad amount`) in a coin of the reference program
  (`bad coin`). Each digit must be from 0 to 9, `want` must fit a `u64`,
  and it must be more than 0 (`bad amount`). `chain` must be the index of one of the
  enum's labels (`bad chain`), and `key` 1 to 65 bytes (`bad key`). `window` must be from
  `MIN_WINDOW` to `MAX_WINDOW` (`bad window`). `fee` must be in the payment's coin
  (`bad coin`) and at most a thousandth of its amount, `fee · FEE_SHARE ≤ amount`
  (`bad fee`), so an amount under 1,000 base units takes only a fee of 0. `offer_to`'s
  taker must not be 32 zero bytes (`bad taker`). The program runs the payment, numbers
  the listing one past the last, and stores it.
- **Accept.** The listing must be open (`not listed`), the acting account its maker
  (`not maker`), and `give` its coin and amount (`listing changed`). A listing for one
  taker accepts only that taker (`not for you`), and a listing for anyone any taker but
  32 zero bytes (`bad taker`). With `deadline = now + window`, `until` must be at least
  `deadline + GAP` (`too short`). The program deletes the listing and stores the lock.
- **Withdraw.** As in Ting Swap: an open listing, by its maker, `back` its own; the
  coins go back to the maker. An accepted listing is a lock and cannot be withdrawn.

### Inputs of the program's own

The other operations need no signature, so anyone may submit them. Each begins with a
32-byte tag; a short input is a query.

| Input | |
|---|---|
| `TAKE ‖ u64 id ‖ taker(32) ‖ hash(32) ‖ u64 t1 ‖ Bytes(lock)` | A take |
| `CLAIM ‖ u64 id ‖ secret(32)` | A claim |
| `REFUND ‖ u64 id` | A refund |
| `RELEASE ‖ u64 id ‖ Bytes(data)` | A release |
| `00` | The digest of the call that is paying; `not running` otherwise. The coin's query |
| `08 ‖ u64 id` | The listing's record, or `not listed`; safe read-only |
| `09` | The `u64` count of listings ever made; safe read-only |
| `0a ‖ u64 id` | The lock's 176-byte record, or `not locked`; safe read-only |

with `TAKE = H("app/htlc-v1/take", "")`, `CLAIM = H("app/htlc-v1/claim", "")`,
`REFUND = H("app/htlc-v1/refund", "")` and `RELEASE = H("app/htlc-v1/release", "")`.
TCR-1's run and cancel revert `not scheduled`. Anything else reverts `bad input`.

- **Take.** The listing must be open (`not listed`) and, if it is for one taker, this one
  (`not for you`); if it is for anyone, the taker must not be 32 zero bytes (`bad taker`),
  which could never claim. `t1` must be at least `now + window + GAP` (`too short`), so
  that the take can still be accepted. `lock` must be 1 to 256 bytes (`bad input`). The
  program stores nothing and emits *taken*. Whether a lock is really behind it is for the
  seller's page to check.
- **Claim.** The lock must exist (`not locked`), the block timestamp be at most its
  deadline (`too late`), and `SHA-256(secret)` its hash (`wrong secret`). The program
  deletes the lock, then sends `amount − fee` to the taker with the lock's `fee` as the
  coin action's fee, paid to the block's producer.
- **Refund.** The lock must exist (`not locked`) and the block timestamp be past its
  deadline (`too early`). The program deletes the lock and sends `amount − fee` to the
  maker with the lock's `fee` as the fee.
- **Release.** `id` must be a listing ever made (`not listed`) and `data` 1 to 256 bytes
  (`bad input`). The program stores nothing and emits *released*.

Claims and refunds go by the block timestamp, and Ting's nodes admit a block stamped up to
2 hours ahead of their clocks. A seller who mines could therefore put a refund in a block
stamped just past the deadline while the buyer's claim is still pending, leave the claim
out, keep the coins and claim the other chain's with the secret the claim made public.
`MIN_WINDOW` is 6 hours, well above those 2 hours plus the time a claim needs to get into
a block, so a block stamped ahead right after an accept is still before the deadline. And
the buyer's page sends no *first* claim once the deadline is less than 2 hours, plus a
margin, away: past that point a claim could be overtaken by such a refund. A claim already
sent has made the secret public, so the page keeps sending it until it is in.

A fee is paid by the coin to the payout account of the block that includes the call. A
block with no payout account pays nothing, and the fee stays in the program's account.

The fee is the listing's, fixed when it is offered: a claim or a refund names none, and
pays exactly that one. Once the buyer's claim is in the pool its secret is public, so a
miner, or a seller who mines, can put its own copy of the claim in its block, but that
copy pays the same fee and the coins still go to the taker: the miner gets that fee and
nothing more. The thousandth is a ceiling against listings whose fee would eat the
coins: at most that much of them goes to a claim's or a refund's miner.

### Events

Every event of the program's own begins with one topic, a kind and the listing's id:

```text
topic = H("app/htlc-v1/event", "")
```

| Kind | After the topic, the kind byte and `u64 id` |
|---|---|
| `01` listed | `maker(32) ‖ coin(32) ‖ u128 amount ‖ u64 want ‖ taker(32) ‖ u64 window ‖ u128 fee ‖ Bytes(chain) ‖ Bytes(key)` |
| `02` taken | `taker(32) ‖ hash(32) ‖ u64 t1 ‖ Bytes(lock)` |
| `03` accepted | `maker(32) ‖ taker(32) ‖ hash(32) ‖ u64 t1 ‖ u64 deadline ‖ coin(32) ‖ u128 amount` |
| `04` claimed | `taker(32) ‖ secret(32) ‖ u128 paid ‖ u128 fee` |
| `05` refunded | `maker(32) ‖ u128 paid ‖ u128 fee` |
| `06` withdrawn | `maker(32) ‖ coin(32) ‖ u128 amount` |
| `07` released | `Bytes(data)` |

The signed operations also emit TCR-1's *executed*, and the coins their transfer events.

### Errors

| Error | When |
|---|---|
| `bad deploy input` | A deployment input other than `01` |
| `bad input` | An input that does not decode exactly; an unknown template or tag; a witness with a payment; a payment for a program's own account; a lock or release data of 0 or more than 256 bytes |
| `bad coin` | A contract that does not run the coin reference program; a fee in another coin than the payment |
| `bad amount`, `bad chain`, `bad key`, `bad window` | An offer's values out of range |
| `bad fee` | An offer's fee above a thousandth of its payment: `fee · FEE_SHARE > amount` |
| `bad taker` | An `offer_to` for 32 zero bytes; a take or an accept naming 32 zero bytes as the taker of a listing for anyone |
| `needs payment`, `bad payment`, `not bound` | As in Ting Swap; an accept, like a withdrawal, takes no payment or a fee payment |
| `not listed` | No open listing with that id (a release: no listing ever made) |
| `not locked` | No lock with that id |
| `not maker` | An accept or a withdrawal by another account than the maker |
| `not for you` | A take or an accept for another taker than the listing's |
| `listing changed` | An accept's `give` or a withdrawal's `back` that is not the listing's |
| `too short` | A take or an accept whose `t1` is less than `GAP` after the deadline it would get |
| `too late` | A claim after the deadline |
| `too early` | A refund up to the deadline |
| `wrong secret` | A claim whose secret does not hash to the lock's hash |
| `expired`, `bad nonce`, `nonce exhausted`, `not authorized`, `no calling contract` | TCR-1, as in Ting Swap |
| `not scheduled`, `not running` | As in Ting Swap |
| `payment: …`, `coin: …` | The coin's refusal, of the payment or of a transfer out of the program's account: `coin: reserved account` for a claim of a lock accepted for the coin's reserved key `00…01`, which only a refund ends |
| `insufficient budget`, `too many listings`, `corrupt` | As in Ting Swap |

## The Litecoin side

### The lock

The buyer pays the wanted amount to the P2WSH address of this witness script, version 1:

```text
<tag> OP_DROP
OP_IF
  OP_SIZE <32> OP_EQUALVERIFY OP_SHA256 <hash> OP_EQUALVERIFY <seller> OP_CHECKSIG
OP_ELSE
  OP_IF
    <t1> OP_CHECKLOCKTIMEVERIFY OP_DROP <buyer> OP_CHECKSIG
  OP_ELSE
    <seller> OP_CHECKSIGVERIFY <buyer> OP_CHECKSIG
  OP_ENDIF
OP_ENDIF
```

- `tag = H("app/htlc-v1/ltc-lock", program(32) ‖ u64 id ‖ taker(32))`: the program's
  ContractId, the listing and the buyer's Ting account. The lock pays only the take that
  names them, so a copied take with another account points at an address with nothing in
  it, and one lock cannot serve two listings.
- `hash` is the take's hash, `seller` the listing's key and `buyer` the buyer's key, both
  33-byte compressed secp256k1 keys.
- `t1` is the take's T1, a Unix time, as a minimally encoded script number. Litecoin
  compares it with the median time of the last 11 blocks.
- The address is bech32 with the prefix `ltc` (mainnet), `tltc` (testnet) or `rltc`
  (regtest).

The take's `lock` bytes for Litecoin are
`01 ‖ txid(32) ‖ u32 vout ‖ buyer(33)`: the script version, the lock's transaction id
in the byte order explorers show, the output's index, and the buyer's key.

### Spending it

| Path | Witness | Transaction |
|---|---|---|
| Claim, by the seller | `sig(seller) ‖ secret ‖ 01 ‖ script` | Any; `SIGHASH_ALL` |
| Refund, by the buyer after T1 | `sig(buyer) ‖ 01 ‖ (empty) ‖ script` | `nLockTime = t1`, the input's `nSequence = 0xfffffffe`; `SIGHASH_ALL` |
| Release, both | `sig(buyer) ‖ sig(seller) ‖ (empty) ‖ (empty) ‖ script` | Version 2, `nLockTime = 0`, `nSequence = 0xffffffff`; the buyer signs `SIGHASH_ALL`, the seller `SIGHASH_NONE | SIGHASH_ANYONECANPAY` |

Signatures are DER with a low S and the sighash byte, over BIP 143's digest.

A release lets a buyer have the lock back before T1. The seller signs only the input,
with `SIGHASH_NONE | SIGHASH_ANYONECANPAY`, so the signature lets the coins go wherever
the buyer's own signature sends them, and is useless without it. The seller's page posts
it on Ting, as the release data `01 ‖ txid(32) ‖ u32 vout ‖ Bytes(signature)`.

## The page

`web/index.html`, with `web/js/ltc-app.js` and `web/js/ltc-keys.js`. For now it is a test
setup: it runs only when its node is on the Ting development chain and its Litecoin
network is regtest or testnet, and it checks the program's CodeHash
(`69012957b35f411457652e9c44004ada21396c3b038c2d86f32bfde339c331c7`, htlc.wasm's), its
template list and the coin's CodeHash before it makes any call link.
`node scripts/htlc-dev.mjs url` prints its address with the query string it reads:
`node`, `htlc`, `coins` (the DLR coin), `wallet` (Ting ID Web), `ltc` (the explorer),
`ltcnet`, `confs` (Litecoin confirmations before accepting, default 1) and `tconfs` (Ting
blocks over an accept before claiming, default 30; the development address says 3);
optionally `ltcfee` (litoshi per vbyte; else the explorer's fastest rate, from 2 to
1,000) and `price` (where the LTC price for the USD estimates comes from, or `off`). The
node, the explorer, the wallet and the price source must be https, or plain http on this
computer only; the page refuses anything else, and `index.html` carries a Content
Security Policy: scripts from the page's own site only, and reads from https or this
computer.

- **What a claim pays now.** As Ting ID works out its fees: the median of what recent
  paying transactions in the coin paid for a whole block's worth of room, times the share
  of a block a claim takes (2.8 million C, 20 S, 900 D, 100 G), to two significant digits,
  read from the last 200 blocks at most and kept for ten minutes (`web/js/fees.js`). It is
  0 when nothing paid lately, as on a development chain whose miner has no payout account.
- **The run fee.** The page sets a listing's fee itself, and the seller approves it with
  the offer: three times what a claim pays now, so that the claim goes in even if fees
  rise while the trade runs, at least 0.00001 DLR, and at most a thousandth of the coins,
  the program's limit. The buyer's claim, or a refund, pays exactly that fee. The buyer's
  page shows the fee and what the buyer receives before locking, warns when the fee is
  more than ten times what the page would set now, and refuses a listing whose fee is
  above a thousandth, whatever program made it.

- **Keys.** Every key and secret the page makes derives from one seed per browser: 32
  random bytes, kept in the browser's storage and nowhere else. Its backup code is the
  seed in bech32 with the prefix `tingswap` (67 characters, a checksum that catches a
  mistyped character). Counter `n` gives secret n, `HMAC-SHA256(seed, "htlc-v1/secret" ‖
  u32 n)`, and key n, `HMAC-SHA256(seed, "htlc-v1/key" ‖ u32 n)` read as a big-endian
  number. When that number is 0 or at least the group's order N, counter n has no key and
  is skipped, for its secret too; it is never reduced. A seller's listing uses key n, a
  buyer's lock key n and secret n. The page stores no secret and no key, only the trade
  and its `n`; a secret leaves the browser only inside the claim.
- **One counter, one trade.** If two of a buyer's locks shared a secret, the first claim
  would make it public and the second seller could take the second lock without
  accepting. So before a trade takes a counter, the page reads the program's events and
  skips every counter whose key a listed event already shows, or whose secret's hash a
  taken event does, and every counter a trade of this browser holds: a backup code in use
  in two browsers, or a restore that could not see a lock, does not hand one out twice.
  It moves the next counter past the one it takes before it hands it out, under a Web
  Lock across the browser's tabs; a browser without Web Locks notes the counter as its
  tab's, waits a moment, and takes another if a second tab noted the same.
- **Restore.** From a backup code, the page reads every event of the program and, counter
  by counter from 0, looks for listed events whose `key` is key n's public key (seller
  trades) and taken events whose hash is `SHA-256(secret n)` (buyer trades), until 20
  counters in a row find nothing. Keys and hashes are public once on chain, and anyone
  can list again with a key or post a take again with a hash: the seller trade is the
  first listing with the key, which came before anyone could copy it, with its maker; the
  buyer trade is the earliest take with the hash and this seed's key whose rebuilt lock
  address the explorer has seen paid (the earliest, marked unchecked, when the explorer
  cannot say). What the chain does not hold comes back blank: a seller's payout address
  (the trade asks for it before claiming), and a lock that was paid but whose take never
  reached Ting. Another browser's code replaces this one's and its trades only when the
  user says they wrote this one down.
- **Selling.** The seller gives the DLR amount, the LTC wanted, a payout address (checked
  for the network), and under *More options* the window (6 to 168 h, default 12) and
  optionally one buyer's account (`offer_to`); the fee it sets itself. The page shows the
  rate and the sentence the wallet will show, takes a counter, keeps the trade, and hands
  the offer to Ting ID as a call link. It finds the listing by its key in the listed
  events and, once Ting ID reported it, by the transaction and the account that made it;
  without either, by the first listing with the key, also when the call is approved later.
- **Locking.** The buyer gives the Ting account that receives the DLR and, optionally, a
  refund address. The page refuses a listing whose window is under 6 hours (see the
  claims above: too little room for a first claim). It takes a counter, sets
  `t1 = now + window + GAP + 18 h`, keeps the trade, and shows the lock address with
  `litecoin:<address>?amount=…`. It watches the address, and once an output of at least
  the wanted amount is there, in a block or not, posts the take itself: an input of the
  program's own, with no signature and no fee. The buyer's take is the earliest that
  matches its secret's hash, account, T1 and key, and the output its page posted.
- **Checks before accepting.** The seller's page rebuilds the script from the take and
  the listing, and accepts only if the output it names exists, pays exactly that script's
  address at least the wanted amount, has enough confirmations, and is unspent, and if
  `t1` leaves the program's gap and 10 minutes more. It shows the result for each take,
  and offers the accept, a call link, only for a take that passes, checked again at the
  click.
- **Accepts and releases.** A release lets a buyer take the lock back; an accept holds
  the DLR for them. Both for one lock would give the buyer both sides. The seller's page
  refuses to accept a lock it released or sent a release of, and notes which lock each
  accept link it shows is for: while the listing is open, that link can still be
  approved, so the page does not release that lock, by hand or by itself. It never
  releases the accepted lock. Once a listing is accepted or withdrawn, it releases the
  other locks by itself. Release data is posted without a signature of the program's, so
  anyone can post some: the pages count a release only when its signature verifies against
  the script rebuilt from the take and the output's value as Litecoin has it, and use the
  first that does.
- **Before claiming.** The buyer's page claims only once the accept names its taker, hash
  and T1 exactly, is buried under `tconfs` Ting blocks, and the lock record, read from the
  chain's state just before (`03 ‖ id`), names the same: an accept a reorganization
  dropped is not claimed for. It sends a *first* claim only while the deadline is more
  than 2 hours and 30 minutes away (the program's claims, above); a claim it sent, which
  made the secret public, it sends again until it is buried. Past that point it says why it
  does not claim, and the buyer refunds the LTC after T1.
- **Burying, and reorganizations.** Ting has no fixed finality. A seller who sees the
  claim's secret in the pool could out-mine the blocks since the accept and put a
  withdrawal in its place, at the same TCR-1 nonce, so that the accept can never come
  back: the claim fails, and the seller keeps the DLR and has the secret. Burying the
  accept under `tconfs` blocks, 30 by default (about half an hour of Ting's minute
  blocks), makes that cost those blocks' work; a larger trade may warrant more. The page
  reads the events of the last 100 blocks again in every read, so that an event a
  reorganization dropped is dropped from the page too, and counts depths from the blocks
  the node has now.
- **The seller's LTC claim.** On the claimed event, the seller's page sweeps, in one
  transaction to the payout address, the accepted lock (the one it made the accept link
  for, or else the first matching take that holds the wanted amount) and every other
  output the secret opens: other takes matching the accept, and outputs at the accepted
  lock's address. Outputs other than the accepted one wait until they are in a block, so
  that an unconfirmed output nobody vouches for cannot hold the claim back; one worth less
  than its share of the fee is left out, as dust. If Litecoin refuses the sweep, it
  claims the accepted lock alone. It sends a claim again while the explorer does not know
  it, gives up one Litecoin refuses outright and claims what is left anew, and warns when
  a claim has waited more than 30 minutes for a block: the claim cannot be sped up (it does
  not signal replace-by-fee, and has no output of the seller's to pay more from), and it
  must be in a block before T1.
- **The way back.** After the deadline anyone may send the refund on Ting; the page offers
  it. A buyer whose lock the seller released takes it back at once. After T1, by
  Litecoin's median time past, the buyer's page refunds every output in a block at the lock
  address in one transaction: offered whenever LTC sits there, including an underpaid
  lock, a payment whose take was refused or came too late, and what is left after the
  swap. A release or refund is kept only once Litecoin took it, and sent again while the
  explorer does not know it.
- **Reading.** Every 4 seconds while a trade of this browser is open, or a trade is on
  screen, whatever the view, the page reads Ting, then Litecoin, then runs each open
  trade's automatic steps; one trade's failure is that trade's alone. Each Litecoin read
  is on its own: one that fails stops no other. Once a listing is accepted, the page reads
  only the outputs that matter to its claims and its own locks first; the other takes'
  outputs, which cost nothing to post, at most 8 a round, those never read first, an
  output Litecoin did not have again only after 5 minutes, and one that pays another
  script, or is spent in a block, never again. The page keeps every trade's state in the
  browser so that a reload loses nothing, shows a node's or an explorer's error with a
  retry, and acts on nothing it could not read. Numbers and ids from the node or the
  explorer are checked before they reach the page.
- **Explorer.** The page reads Litecoin from an Esplora-style API: litecoinspace.org, or
  `scripts/ltc-dev.mjs` on a regtest chain.

## Before production

The page is a test setup. Before it handles real coins:

- **Pin the configuration.** The link chooses the node, the program, the coin, the
  explorer and the confirmations today, and a shared link carries them along: a scammer's
  link could name their own coin called DLR, or their own explorer, which makes a seller's
  page accept a lock that does not exist. Pin the node, program, coin and explorer per
  network in `config.js`, and ignore overrides there, or make them very loud.
- **Share links without the query string.** On production, a trade link, and a call
  link's `return`, should be the page's own address and the trade, not `location.search`.
- **Serve it from its own domain.** The seed sits in the browser's storage, and every
  project page under `ting-organization.github.io` shares one origin: any of them, or an
  XSS in any, could read it. Serve the page from a domain of its own, as Ting ID Web is,
  for instance a CNAME like `swap.ting-project.com`.
- **Released locks and public secrets.** The lock's script has no `OP_CODESEPARATOR`, so
  the seller's `SIGHASH_NONE | SIGHASH_ANYONECANPAY` release signature also satisfies
  `<seller> OP_CHECKSIG` in the claim branch: once that lock's secret is public, anyone
  can sweep a released lock its buyer has not taken back, to anywhere. Unique secrets
  prevent it (one counter, one trade); a version 2 script could separate the branches.
- **Fee bumping.** An LTC claim cannot be sped up: it does not signal replace-by-fee, and
  has no output of the seller's for a child to pay more from. The page warns after 30
  minutes, but a claim stuck past T1 can be refunded by the buyer.
