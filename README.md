# Ting Swap

Swap coins on [Ting](https://github.com/ting-organization/ting), one listing at a
time. A listing says *I give this much of one coin for that much of another.* Its
maker's coins wait in the swap program until someone takes the listing with Ting ID,
paying the maker and getting the coins in the same transaction, or until the maker
withdraws it and has them back.

It is not an exchange with an order book that matches orders: there are no partial
fills, no deposits and no balances in the program. Each listing holds exactly its
own coins, and is taken whole or not at all.

It is two pieces:

- **The swap program** (`program/`, built to `swap.wasm`): a Ting program that keeps
  the listings, holds what they offer, and settles each trade.
  [SPEC.md](SPEC.md) states its rules.
- **The page** (`web/`): a static web client, plain HTML, CSS and JavaScript with no
  build step and no third-party code, that reads the chain from a node and hands each
  action to Ting ID as a call link. It holds no key and no coins, and can be hosted
  anywhere, GitHub Pages included.

Every action is a call of [TCR-1](../ting-id/TCR-1.md), Ting Call Requests: a
sentence in the program's own words, signed by the account that acts. The page and
the scripts share TCR-1's modules with [Ting Canvas](https://github.com/ting-organization/ting-canvas).

## Why it works this way

**One signature a listing.** Listing pays what it offers into the swap's own
account. The payment is a coin transfer bound to the one operation it pays for (a
*bound action*, wiki: programs/conventions), so the coin's check of its signature is
also the approval: Ting ID signs once, and the payment can never be spent on anything
else.

**The taker pays the maker directly.** Taking a listing carries a payment from the
taker's account straight to the maker's, of exactly what the listing asks; the
program then hands the taker the listed coins from its own account. Both happen in
one call: if the listing was taken or withdrawn a moment before, the whole
transaction fails and nothing is paid. The values of a take include what the taker
gets, so Ting ID shows both sides before anyone approves: what leaves the account on
its own line, which it checks itself, and what comes back in the program's words.

**Only the maker withdraws.** Until a listing is taken, its maker can take it down
and have the coins back to the same account. Nobody else can, and nothing else moves
them. A withdrawal moves no coins of the maker's, so it takes a *fee payment*, a
transfer of 0 to the swap's account that pays the miner, or a plain signature.

**Accounts with a time lock are refused.** A Ting ID Savings account makes
everything wait for its delay, so that a stolen key cannot empty it at once. A trade
cannot wait a week, so the swap does not schedule: it refuses an account whose policy
answers with a delay, outright, and the coin already refuses such an account's bound
payments. List and take from a Spending account.

**Coins name themselves.** Anyone can deploy a coin of Ting's coin program and call
it anything, Daler included. The program trades any coin of that program, which it
checks by CodeHash, and nothing else: a contract that only claims to be a coin could
report a payment it never made. The page marks the coins it knows, warns about the
others, shows every coin's ContractId, and marks a coin that copies a known coin's
symbol as an imitation.

**The page trusts nothing it can check.** Before it makes a call link it checks the
CodeHash of the swap program against the code it was written for, and of every coin
against the coin program's, and that the program lists the templates it makes links
for.

## Signing

The page holds no key and no coins: a wallet signs. Each action becomes a
`ting:call` link, as a QR code or a link to open on the phone, its values compressed
as `zvalues` whenever that is shorter. Ting ID shows the action in the program's
words and what leaves the account, signs it with the account the user picks, and
submits it; the page finds the operation in the program's *executed* events and
follows it there. A withdrawal's link carries `from`, so only the maker's account can
sign it, and `coin`, Daler, so that Ting ID can approve it with a fee payment. Each
link also carries the page's address as `return`.

**Your accounts.** Without a key the page still knows who you are if you let it: it
remembers your accounts' addresses in the browser, shows them as *you*, marks your
listings and offers to withdraw them. An account is linked when the page sees a call
it made a link for go through, or when Ting ID sends one back through `return`; the
Ting ID button adds or removes one by hand. An address proves nothing and signs
nothing; it only changes what the page shows.

Ting ID is the wallet that reads these links today; any wallet that implements
TCR-1 does the same, with nothing to change in the page. On a development chain
`scripts/tcr-wallet.mjs` stands in for one.

## Layout

| Path | Contents |
|---|---|
| [SPEC.md](SPEC.md) | The program's rules: coins, records, operations, events, errors, costs |
| `program/` | The program, Rust for `wasm32v1-none`, no dependencies, with its own SHA-256 |
| `swap.wasm` | The program as deployed, packed |
| `tools/` | The packer, and the tests that run the program on Ting's reference VM against the real coin |
| `web/` | The page; `web/js/tcr.js` is TCR-1 on its own, as in Ting Canvas, and `web/js/swap.js` the swap's records, calls and events |
| `scripts/devchain.mjs` | A development chain: deploys everything, funds accounts, fills the market, runs listings end to end |
| `scripts/tcr-wallet.mjs` | A stand-in for a TCR-1 wallet: reads a `ting:call` link, checks it against the program's template list, and completes it on a development chain |
| `scripts/deploy.mjs` | Shows, and with `--submit` sends, the deployment on a network |
| `scripts/serve.py` | Serves `web/` locally without caching |

`tools/` and the scripts build against Ting's reference core and programs, checked
out beside this repository as `../ting-reference`.

## Build and test

```sh
./build.sh
cargo test --release --locked -p ting-swap-tools
```

`build.sh` compiles the program and packs it into `swap.wasm`, checked against
Ting's execution profile; it prints the CodeHash, which `web/js/config.js` must
match. The tests deploy two reference coins and the swap on Ting's reference VM and
go through offers, takes and withdrawals and every way each is refused: fake coins,
wrong amounts, wrong recipients, stale nonces, accounts that answer with a delay,
programs acting as their own account; and that the swap always holds exactly what
its open listings offer.

## A development chain

A node of its own, with its own ports, beside any other node:

```sh
ting --data-dir .devnode init --dev --api --control 127.0.0.1:28450 --p2p 127.0.0.1:28452 --api-bind 127.0.0.1:28451
ting --data-dir .devnode api enable --cors
ting --data-dir .devnode start
ting --data-dir .devnode miner start --threads 1 --spacing 2
node scripts/devchain.mjs setup
```

`setup` deploys the reference P-256 policy and identity registry, two test coins,
Daler (DLR) and Test Gold (GLD), whose supply goes to a faucet, and the swap, and
prints the page's address for them. Serve the page with `python3 scripts/serve.py`
and open it with that query string. `node scripts/devchain.mjs demo` fills the market
with listings from test keys, a trade, a withdrawal and a coin that imitates Daler;
`node scripts/devchain.mjs fund <account> 5 GLD` sends an account test coins; and
`node scripts/tcr-wallet.mjs '<link>'` completes a call link the page shows
(`--key NAME` to act as someone else). `node scripts/devchain.mjs e2e` runs listings
through the page's own modules with real signatures: P-256 test keys and an identity
list, take and withdraw, links are read back as a wallet reads them, and the
identity's Savings account is refused. Stop the miner and the node when done:
`ting --data-dir .devnode miner stop`, `ting --data-dir .devnode stop`.

## Deploying

The swap is not deployed on the production network yet.

```sh
node scripts/deploy.mjs
```

shows the production deployment, and `--submit` sends it. Then put the ContractId
it prints into `web/js/config.js`. A deployment is for good, and the program can
never change; another version is another deployment, with another ContractId.

## Hosting

`web/` is the whole site. `.github/workflows/pages.yml` publishes it to GitHub Pages
when run by hand (Settings → Pages → Source: GitHub Actions); it can run on every push
once the repository is public. Any static host works the same way. The page talks to
`https://node1.ting-node.com` by default, which answers browsers from any origin;
`?node=<url>&swap=<id>&coins=<id>,<id>` points it elsewhere and names more coins as
known.

## Licence

Licensed under either of Apache License, Version 2.0 or MIT license, at your option.
