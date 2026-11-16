# The watchtower

A small Node.js service beside Ting Swap's Litecoin page. It reads the HTLC program on
Ting and the locks on Litecoin, and:

- **keeps a Discord feed** of the listings: one message per listing, edited as it moves
  from open to locked, accepted, and swapped, withdrawn or refunded, on one line: its
  rate, an estimate in dollars per DLR and in all (from LTC's price when it was posted),
  the time to claim and its status, colored by status, with a link to the page;
- **reminds those who watch a listing**, by direct message, at the steps that need them:
  a seller when a buyer locked LTC and before the time to accept ends, a buyer when
  their lock is accepted and before the claim cut-off, a seller after the buyer's claim
  until the LTC is claimed, and either side when the trade ends or a refund is due;
- **finishes the seller's signed claim** once the buyer's claim on Ting makes the secret
  public, and sends it to Litecoin, again while the explorer does not know it, until
  the lock is spent ([HTLC.md](../HTLC.md), "Spending it"). It does so only when Litecoin
  shows which lock the accept was for: every take matching the accept read, and exactly
  one output paying its script at least the wanted amount (a copy of the take naming the
  same output counts once). With two outputs, the pages decide, and the seller is told
  to open theirs;
- **sends the DLR refund** on Ting once an accepted listing's deadline has passed, by the
  clock and by Ting's tip, with no claim.

It holds no key, and anything it sends anyone may send: a signed claim pays only the
seller's address, and a refund only the maker. Nothing depends on it. The pages do every
step themselves; the watchtower only reminds, and sends sooner what the pages would.

It has no dependencies: Node.js 22 or later, the page's own `web/js` modules, Discord's
REST API, and Discord's interactions endpoint for the commands and buttons.

## Running it

```sh
node watchtower/src/main.mjs --dry-run
```

reads production as `LTC_PRODUCTION` in `web/js/config.js` pins it (node1, the HTLC
program, Daler, Litecoin mainnet through litecoinspace.org), checks the program's and the
coin's CodeHashes as the page does, and prints what it would post, message and send,
sending nothing and keeping nothing: it writes no state file, so the run after it posts
and sends everything. Without `--dry-run`, it sends claims and refunds; without
`DISCORD_TOKEN` it still only prints the feed and the reminders, and keeps no feed
message or reminder as done, so that they go out once the token is there.

Each round reads Ting, then at most 12 Litecoin outputs (two requests each), by the
page's rules: one Litecoin did not have again after 5 minutes, one that pays another
script or is spent in a block never again, the lock a claimed listing's signed claim
spends every round until a spend of it is in a block, and the rest every 10 minutes, the
least recently read first. The lock a claimed listing's signed claim spends comes
first. Then a claimed listing's locks never read, since its claim waits for all of them:
shared out among the claimed listings, those with the fewest first (a real trade's one
ahead of a listing with copies of its take posted for nothing), in turns, two a round
each at most. Then accepted listings' locks, and open listings' takes, which anyone can
post for free, last. Then it sends claims and refunds. The feed and the reminders
run apart from that, so that a slow Discord never holds them up, and no request waits
longer than 20 seconds.

A test setup names the development chain and a regtest or testnet explorer, like the
page's address does:

```sh
node watchtower/src/main.mjs --node http://127.0.0.1:28451 --htlc <ContractId> --coin <ContractId> --ltc http://127.0.0.1:28472/api --ltcnet regtest
```

Settings, as environment variables:

| Variable | |
|---|---|
| `DISCORD_TOKEN` | The bot's token. Without it, Discord calls are printed, not made |
| `DISCORD_APPLICATION_ID` | The application, for registering the commands |
| `DISCORD_PUBLIC_KEY` | The application's public key, which signs each interaction; without it there is no interactions endpoint |
| `DISCORD_CHANNEL` | The feed channel's id |
| `PAGE_URL` | The page the feed links to; `https://ting-organization.github.io/ting-swap/` by default |
| `FEED_MIN_LTC` | The least LTC a listing must want to get a feed message, so that dust listings cannot flood the channel; `0.01` by default. Any listing can still be watched with `/watch` |
| `STATE_FILE` | Where it keeps who watches what, what it sent and the outputs it read; `watchtower-state.json` |
| `PORT`, `HOST` | The interactions endpoint, `127.0.0.1:8787` by default, behind an HTTPS proxy |
| `POLL_SECONDS` | Seconds between rounds, 15 by default |
| `DRY_RUN=1` | The same as `--dry-run` |

The state file holds nothing secret; losing it loses only that bookkeeping (watchers,
the feed's message ids, the reminders sent, the outputs read). It keeps only the
outputs still of use (open listings', and accepted or withdrawn ones' until a day past
T1), and is written only when it changed. Of open and withdrawn listings it writes only
outputs that pay their lock's script: one missing or paying another script, most often
from a take posted for nothing, stays in memory and is read once more after a restart,
so that such takes do not grow the file. A feed message a moderator deletes is posted
anew.

## Discord

1. Create an application in Discord's developer portal, with a bot. Keep the token out
   of the repository: in the service's environment file.
2. Invite the bot to the server with the `bot` and `applications.commands` scopes and the
   permissions to view the feed channel, send messages and embed links.
3. Run the watchtower with `DISCORD_PUBLIC_KEY`, serve its endpoint over HTTPS (for
   instance `reverse_proxy 127.0.0.1:8787` under a path in Caddy), and set that URL as the
   application's *Interactions Endpoint URL*: Discord checks it with a signed ping.
4. Register the commands once: `node watchtower/src/main.mjs register` with the token and
   the application id.

People then watch a listing with the feed message's **Remind me: seller** or **Remind me:
buyer** button, or `/watch listing:42 role:seller`; `/unwatch` and `/watching` do what
they say. Watching asks for nothing but the listing: everything the reminders say is
public on the two chains. The bot can message only those who allow direct messages from
the server's members, and says so when it cannot. Watching answers at once with a reply
only its user sees, which says the bot is working, and replaces it with the answer once
the first direct message is sent, so Discord's 3 seconds are never missed.

## Tests

```sh
node --test "watchtower/test/*.test.mjs"
```

They build a listing's events with the page's own encodings and real keys, and check:
- which listings the watchtower reads;
- that it finds the seller's signed claim only when it verifies, and sends exactly the
  claim the seller's key makes, only when exactly one output pays, never before the
  buyer's claim, and never again once the lock is spent;
- that it sends a refund only past the deadline with the lock still there;
- which outputs it reads when, within its budget, however many takes are posted;
- which reminders are due when, and that only one Discord really sent counts as sent;
- the feed message, and that a deleted one is posted anew;
- the interactions' signature check, and the commands and buttons.
