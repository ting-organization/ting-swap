# Ting Swap

Trade DLR on [Ting](https://github.com/ting-organization/ting) for LTC on Litecoin,
with nobody sending first. The buyer locks the LTC on Litecoin under the hash of a
secret only their page knows; the seller's page checks the lock and the seller locks
the DLR on Ting for that buyer under the same hash. The buyer's page claims the DLR,
which reveals the secret, and the seller's page uses it to claim the LTC. If anything
stalls, each side gets its coins back after a deadline. No server sits in between,
and nobody holds anyone's coins: a program on Ting and a script on Litecoin do.

**For now this is a test setup.** The page runs only against the Ting development
chain and Litecoin regtest or testnet, and the program is deployed on the development
chain only. See *A test setup* below to run a whole trade on your computer.

It is three pieces:

- **The HTLC program** (`htlc/`, built to `htlc.wasm`): listings, locks, claims and
  refunds on Ting. It never sees Litecoin. [HTLC.md](HTLC.md) states its rules, the
  Litecoin script and what the page does.
- **The Litecoin side** (`web/js/ltc.js`, `web/js/secp256k1.js`): the lock's script and
  address, and the claim, refund and release transactions, built and signed in the
  browser, with no third-party code.
- **The page** (`web/`): a static web client, plain HTML, CSS and JavaScript with no
  build step and no third-party code. It reads Ting from a node and Litecoin from an
  Esplora-style explorer, keeps each trade's Litecoin key and secret in the browser,
  and hands each Ting action that needs a signature to Ting ID as a TCR-1 call link.

The repository also holds **the on-chain swap program** (`program/`, `swap.wasm`,
[SPEC.md](SPEC.md)): coin-for-coin listings on Ting itself, deployed on the production
network. Its page is set aside for now and may come back beside this one; the last
version of it is in this repository's history, in `web/js/app.js` before the Litecoin
page replaced it.

## A trade

| Step | Who | What |
|---|---|---|
| List | Seller, in Ting ID | The DLR go into the program, with the LTC wanted, the seller's Litecoin key for this trade, and the network fee the buyer's claim will pay |
| Lock | Buyer | Pays the LTC from their own Litecoin wallet to an address only this trade uses; their page posts the take on Ting by itself, with no signature and no fee |
| Accept | Seller, in Ting ID | Once their page has checked the lock on Litecoin, the DLR are held for that buyer for the lock window |
| Claim the DLR | Buyer's page, by itself | Reveals the secret; the DLR go to the buyer, less the listing's fee |
| Claim the LTC | Seller's page, by itself | Uses the secret to take the LTC to the seller's address |

The seller's deadline on Ting always ends at least 6 hours before the buyer's lock on
Litecoin does, so the seller has time to claim after the secret appears. A seller who
accepts one buyer's lock, or withdraws the listing, has their page release every other
lock at once, so that those buyers take their LTC back without waiting.

## Why it works this way

**The lock names the trade.** The Litecoin script carries a tag of the program, the
listing and the buyer's Ting account. The seller's page rebuilds the address from what
the take says and finds the LTC there, or refuses it: a copied take that names another
account points at an address with nothing in it, and one lock cannot serve two
listings. So the take needs no signature.

**The buyer needs no DLR.** The claim is sent by the buyer's page with no wallet. The
program pays its network fee out of the locked DLR: the listing's fee, which the
seller's page sets at three times what a claim pays now and the seller approves with
the offer. A claim pays exactly that fee, so a miner that puts in its own copy of the
claim gets that fee and nothing more. The program refuses a fee above a thousandth of
the coins, and the buyer's page shows the fee, and what the buyer will receive, before
they lock.

**The amounts read as amounts.** TCR-1 shows an integer as it is, so the offer states
the LTC as whole coins and eight one-digit fields: Ting ID shows *Sell 10 DLR for
0.50000000 LTC*.

**The page trusts nothing it can check.** Before it makes a call link it checks the
program's CodeHash and template list and the coin's CodeHash. Before accepting it checks
the lock on Litecoin itself: the script, the amount, the confirmations, that it is
unspent and lasts long enough. Before claiming it checks that the accept names this
buyer's account, hash and lock end exactly.

**Keys live in the browser.** Each trade's Litecoin key and secret derive from one seed
kept in the browser; its backup code finds the trades again in another browser.
Discord's in-app browser can lose what a page stores, so the page asks to be opened in
the real browser first.

**For trading over chat.** *Copy for sharing* copies an overview of the trade for a
chat: the amounts, the LTC in dollars at litecoinspace.org's price, where the trade
stands, and its link. It never holds a key or the secret, and the page never gives DLR
a dollar value.

## Layout

| Path | Contents |
|---|---|
| [HTLC.md](HTLC.md) | The HTLC program's rules, the Litecoin script and transactions, and the page |
| `htlc/` | The HTLC program, Rust for `wasm32v1-none`, no dependencies |
| `htlc.wasm` | The HTLC program, packed |
| `web/` | The page: `js/ltc-app.js` the page itself, `js/htlc.js` the program's records, calls and events, `js/ltc.js` and `js/secp256k1.js` Litecoin, `js/ltc-keys.js` the seed and the trades, `js/fees.js` what a claim pays now, `js/tcr.js` TCR-1 |
| `tools/` | The packer, and the tests that run both programs on Ting's reference VM against the real coin |
| `scripts/test-ltc.mjs` | The Litecoin side against BIP 173/350/143, RFC 6979 and Litecoin Core's own test vectors, and every spending path checked by OpenSSL |
| `scripts/ltc-dev.mjs` | A Litecoin regtest chain, with an Esplora-style API and a dev wallet page |
| `scripts/htlc-dev.mjs` | The HTLC program on the Ting development chain, and the page's address for it |
| `scripts/htlc-e2e.mjs` | Trades across both development chains, every Litecoin transaction checked by Litecoin Core |
| [SPEC.md](SPEC.md), `program/`, `swap.wasm` | The on-chain swap program |
| `scripts/devchain.mjs`, `scripts/tcr-wallet.mjs`, `scripts/deploy.mjs`, `scripts/chain.mjs`, `scripts/keys.mjs` | The on-chain swap program's development chain, stand-in wallet and deployment |
| `scripts/serve.py` | Serves `web/` locally without caching |

`tools/` and the scripts build against Ting's reference core and programs, checked
out beside this repository as `../ting-reference`.

## Build and test

```sh
./build.sh
cargo test --release --locked -p ting-swap-tools
node scripts/test-ltc.mjs
```

`build.sh` compiles both programs and packs them into `htlc.wasm` and `swap.wasm`,
checked against Ting's execution profile, and prints their CodeHashes: the page
checks htlc.wasm's (`HTLC_CODE` in `web/js/ltc-app.js`). The VM tests go through
every operation of each program and every way each is refused, its timing to the
second, and that each program always holds exactly what its listings and locks do.

The CodeHash is that of a build on macOS or Linux: a build on Windows writes its
source paths with `\` and gets another one. On macOS, if linking fails with
`unknown architecture arm64e.x1-macos`, the command-line tools' newest SDK is ahead
of their linker: `export SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk`
(or the SDK matching the system) fixes it.

## A test setup

Everything runs on your computer, on ports of its own, beside any other node:

- **Ting:** the development chain of [Ting ID Web](https://github.com/ting-organization/ting-id-web)'s kit, checked out beside this repository, which also serves the wallet. In `../ting-id-web`:

  ```sh
  node kit/scripts/devchain.mjs start && node kit/scripts/devchain.mjs setup
  ./build.sh && node scripts/dev.mjs
  python3 kit/scripts/serve.py 8766
  ```

- **Litecoin:** [Litecoin Core](https://github.com/litecoin-project/litecoin/releases) unpacked into `.devltc/` (ignored by git), so that `.devltc/litecoin-*/bin/litecoind` exists. Then:

  ```sh
  node scripts/ltc-dev.mjs start
  node scripts/ltc-dev.mjs serve
  ```

  The second serves the API and a dev wallet page at <http://127.0.0.1:28472/>, with wallets `alice` and `bob`, buttons to mine blocks, and `time` to move the clock forward for refunds.

- **The program and the page:**

  ```sh
  node scripts/htlc-dev.mjs setup
  python3 scripts/serve.py 8770
  ```

  `setup` deploys `htlc.wasm` and prints the page's address, with its query string; `node scripts/htlc-dev.mjs fund <account> <DLR>` sends test DLR from the faucet. `node scripts/htlc-e2e.mjs` runs a trade, a declined lock released early, and with `--refund` a Litecoin refund after its lock ends.

To trade by hand, open the page in two browsers, one for the seller and one for the
buyer: each keeps its own keys, as two people would. The seller signs in Ting ID Web
at <http://localhost:8766/web/>; the buyer pays from the dev wallet page.

## Hosting

`web/` is the whole site. `.github/workflows/pages.yml` publishes it to GitHub Pages
on every push to `main` that changes it (Settings → Pages → Source: GitHub Actions).
Any static host works the same way. Until the HTLC program is deployed on the
production network and the page is set up for it, a published page shows only that
it runs on test chains.

## The on-chain swap program

Coin-for-coin listings on Ting: a listing's coins wait in the program until someone
takes it, paying its maker in the same transaction, or its maker withdraws it.
[SPEC.md](SPEC.md) states its rules, and `tools/tests/swap.rs` holds it to them. It
runs on the production network as
`e5376baad8ced3b25f2c09f3687270b3b86ef275718828b35f195afd1e983b77`, CodeHash
`97fdffbedaff0aa485e5536f089fe3306436ae54b8ed6691b3641bad9af0f1e0`.

`node scripts/deploy.mjs` shows its production deployment, and `--submit` sends it.
`node scripts/devchain.mjs setup` deploys it on a development chain of its own with
test coins (`demo` fills a market, `e2e` runs listings through with real signatures),
and `node scripts/tcr-wallet.mjs '<link>'` completes a call link there as a wallet
would.

## Licence

Licensed under either of Apache License, Version 2.0 or MIT license, at your option.
