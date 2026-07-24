# Discord Bid Tracker Bot

A Discord bot for running **item auctions**. A moderator lists an item with a starting bid
and a closing time; members bid via slash commands; every bid must be at least **$5 higher**
than the current high bid (the first bid may equal the starting bid). The bot records who bid,
how much, and the exact time, announces the winner when the auction closes, and lets a
moderator download the full bid list as a CSV.

Multiple auctions can run at the same time — each has its own short ID, and `/bid` offers an
autocomplete dropdown of the currently-active items.

## Commands

| Command | Who | What it does |
| --- | --- | --- |
| `/auction create item: starting_bid: duration: [description] [increment] [quantity] [group_bidding] [winners]` | Moderator | List an item. `duration` looks like `2d12h`, `48h`, `90m`, `1w`. `increment` overrides the default $5 minimum raise. `quantity` (1–25, default 1) lists that many identical copies as separate auctions; when >1, each copy's name is suffixed `(1 of N)`, `(2 of N)`, … `group_bidding`/`winners` enable a single shared multi-winner auction — see below. `warn_before` (default `1h`) posts a no-ping "ending soon" reminder that long before the auction closes; skipped automatically if the auction is shorter than the lead time. |
| `/bid item: amount: [max_bid:]` | Anyone | Bid on an active auction. `item` autocompletes to active auctions; `amount` is dollars (`50`, `49.99`). `max_bid` (normal auctions only) sets a hidden ceiling — the bot auto-bids up to it on your behalf when you're outbid. |
| `/auction list` | Anyone | List active auctions with current high bid and time left. |
| `/auction info item:` | Anyone | Show one auction's details and recent bids. |
| `/auction end item:` | Moderator | End an auction immediately and announce the winner. |
| `/auction cancel item:` | Moderator | Cancel an auction (no winner). |
| `/auction delete item:` | Moderator | Permanently delete one auction and its bids (with a confirmation button); also removes its listing message. |
| `/auction cleanup` | Moderator | Permanently delete all ended/cancelled auctions in the server at once (confirmation button); active auctions are untouched. |
| `/auction removebid item: bidder:` | Moderator | Remove a specific bidder's bid (pick the bidder from a `Name — $amount` dropdown; confirmation button). In a group auction, restores whoever that bid had knocked out of a winning slot. |
| `/auction editbid item: bidder: amount:` | Moderator | Correct a bidder's bid amount (same dropdown + confirmation). In a group auction the bid stays in its slot at the corrected amount. |
| `/auction export [item:]` | Moderator | Download bids as a CSV. Omit `item` to export every auction in the server. |

> Tip: the `/bid` item dropdown shows each item's price and current leader inline — `Current Bid $300.00 (Sam)`, or `Starting Bid $25.00` when there are no bids yet — so you can bid without running `/auction list`. Once you've picked an item, the **amount** field suggests the next minimum bid as a single one-tap value (e.g. `$305.00 — next minimum bid`); you can still type any amount.

## Max (proxy) bidding

On a normal auction, pass `max_bid` to `/bid` to set a **hidden maximum**. The bot then
bids the minimum needed to keep you in the lead, only going as high as your max:

- If someone bids under your max, the bot **auto-bids** for you (the feed shows `🤖 Auto-bid`)
  and the challenger is told they're outbid — you never overpay.
- If two maxes collide, the **higher max wins**, priced just over the loser's max; equal maxes
  go to whoever set theirs **first**.
- If a bid exceeds your max, you're genuinely outbid and pinged. Your max is never shown
  publicly. To raise your ceiling, `/bid` again with a higher `max_bid`.

Max bids work in **group auctions** too: if you're displaced from a winning slot, the bot
auto-bids the minimum needed to reclaim one, up to your max — a whole displacement war resolves
instantly and is posted as a single `🤖 Auto-bids resolved …` summary (only knocked-out bidders
are pinged). Every step is still recorded individually in the CSV export (flagged `auto_bid`,
with who each bid displaced), so you get the full blow-by-blow history.

## Group (multi-winner) bidding

Set `group_bidding: True` and `winners: N` on `/auction create` to run **one shared auction for N identical items** where the **top N bids all win** (one item each). Example: 4 cases of booster boxes → `starting_bid: 100`, `group_bidding: True`, `winners: 4`.

Rules:
- Each person may hold **one** active bid at a time. You can only bid again after being **outbid** (you can't bid against yourself).
- While winner slots are still open, the minimum bid is the **starting bid** — up to N people can sit at the same amount.
- Once all N slots are full, the minimum becomes **(lowest winning bid) + increment**. A qualifying bid displaces the **most recent** bidder at the lowest amount (LIFO), who gets pinged and can bid again.
- Any amount at or above the minimum is allowed (you can jump higher, not just step by the increment).
- The `/bid` dropdown shows `Min Bid $X (f/N winners)`, and when the auction ends all N winners are announced and flagged in the CSV export.

"Moderator" = anyone with the **Manage Server** permission, or the role set in `MOD_ROLE_ID`.

## Setup

### 1. Create the bot application
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → **Reset Token** → copy the token (this is `DISCORD_TOKEN`).
3. **General Information** tab → copy the **Application ID** (this is `CLIENT_ID`).
4. No privileged intents are required.

### 2. Invite the bot to your server
Under **OAuth2 → URL Generator**, tick scopes **`bot`** and **`applications.commands`**, and
bot permissions **Send Messages**, **Embed Links**, **Read Message History**, and
**Manage Messages**. Open the generated URL and add the bot to your server. (Or replace
`CLIENT_ID` in this URL:)

```
https://discord.com/oauth2/authorize?client_id=CLIENT_ID&permissions=92160&scope=bot%20applications.commands
```

> **Read Message History** lets the bot fetch its own past messages to **edit** them (live
> bid-total updates, and the "ending soon" reminder that becomes an "ended" note at close).
> **Manage Messages** lets it **pin** each new auction listing (auto-pinned on creation).
> Editing/deleting its *own* messages needs no special permission. The bot needs these in the
> specific channel where auctions run, if that channel has permission overrides. Without
> Manage Messages the bot still works — it just can't pin, and says so when you create one.

### 3. Configure and install
```bash
cp .env.example .env      # then edit .env with your token, client id, and test guild id
npm install
```

> `better-sqlite3` is a native module. `npm install` downloads a prebuilt binary for common
> platforms. If a build is triggered instead, you need build tools (on Windows, install a
> recent Node.js LTS which bundles them, or run `npm install --global windows-build-tools`).

### 4. Register commands and run
```bash
npm run deploy    # registers slash commands (instant if GUILD_ID is set)
npm start         # starts the bot
```

Set `GUILD_ID` in `.env` to your test server's ID for instant command updates. Leave it blank
to register globally once you go to production (global registration can take up to ~1 hour to
appear).

## Data & persistence

Auctions and bids are stored in a SQLite database at `./data/auctions.sqlite` (override with
`DB_PATH`). This survives restarts: on startup the bot ends any auctions that expired while it
was offline and reschedules the rest. Money is stored as integer cents to avoid rounding
errors. Times are stored in UTC and shown using Discord's timestamp markup, so every viewer
sees the closing time in their own local timezone.

## Hosting for free, 24/7

Timed auctions only close on time if the bot stays online. Discord bots keep a persistent
gateway connection, so "sleep on idle" free tiers (Render free web service, Replit) will drop
the connection and can miss closing times — avoid them.

- **Recommended: [Oracle Cloud "Always Free"](https://www.oracle.com/cloud/free/) ARM VM.**
  Genuinely free indefinitely and always on. Create an "Always Free" Ampere VM, install
  Node.js 20+, copy the project over, `npm ci`, set up `.env`, then keep it running with
  [`pm2`](https://pm2.keymetrics.io/):
  ```bash
  npm install -g pm2
  pm2 start src/index.js --name bid-bot
  pm2 save && pm2 startup   # restart on reboot
  ```
  The SQLite file lives on the VM's persistent disk.
- **Alternative: [Fly.io](https://fly.io/)** free allowance — works, but attach a small volume
  so the SQLite file persists across deploys.

The bot also runs unchanged on your own PC with `npm start` (auctions only progress while it
is on).

## Project layout

```
src/
  index.js            bot bootstrap, event wiring, scheduler init
  deploy-commands.js  registers slash commands with Discord
  db.js               SQLite schema + queries (atomic bid transaction)
  scheduler.js        closes auctions on time, reschedules after restarts
  commands/
    auction.js        /auction create|list|info|end|cancel|export
    bid.js            /bid
  util/
    money.js          dollars <-> integer cents
    time.js           duration parsing + Discord timestamps
    csv.js            CSV export builder
    embeds.js         auction announcement embed
    permissions.js    moderator check
    autocomplete.js   active-auction autocomplete
```
