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
| `/auction cancel item:` | Moderator | Cancel an auction (no winner). |
| `/auction cleanup` | Moderator | Permanently delete all ended/cancelled auctions in the server at once (confirmation button); active auctions are untouched. |
| `/auction create …` | Moderator | List an item for auction. Options are detailed under [Creating an auction](#creating-an-auction) below. |
| `/auction delete item:` | Moderator | Permanently delete one auction and its bids (with a confirmation button); also removes its listing message. |
| `/auction editbid item: bidder: amount:` | Moderator | Correct a bidder's bid amount (same dropdown + confirmation). In a group auction the bid stays in its slot at the corrected amount. |
| `/auction end item:` | Moderator | End an auction immediately and announce the winner. |
| `/auction export [item:]` | Moderator | Download bids as a CSV. Omit `item` to export every auction in the server. |
| `/auction info item:` | Moderator | Show one auction's details and recent bids. |
| `/auction list` | Moderator | List active auctions with current high bid and time left. |
| `/auction removebid item: bidder:` | Moderator | Remove a specific bidder's bid (pick the bidder from a `Name — $amount` dropdown; confirmation button). In a group auction, restores whoever that bid had knocked out of a winning slot. |
| `/bid item: amount: [max_bid:]` | Anyone | Bid on an active auction. `item` autocompletes to active auctions; `amount` is dollars (`50`, `49.99`). `max_bid` (normal auctions only) sets a hidden ceiling — the bot auto-bids up to it on your behalf when you're outbid. |

> Tip: the `/bid` item dropdown shows each item's price and current leader inline — `Current Bid $300.00 (Sam)`, or `Starting Bid $25.00` when there are no bids yet — so you can bid without running `/auction list`. Once you've picked an item, the **amount** field suggests the next minimum bid as a single one-tap value (e.g. `$305.00 — next minimum bid`); you can still type any amount.

## Creating an auction

`/auction create` takes these options:

**Required**
- **`item`** — the item's name.
- **`starting_bid`** — opening price in dollars (e.g. `25`, `25.00`).
- **`duration`** — how long bidding stays open: `2d12h`, `48h`, `90m`, `1w`, etc.

**Optional**
- **`description`** — a short blurb shown on the listing.
- **`increment`** — minimum raise over the current bid (default **$5**).
- **`quantity`** — 1–25 (default 1). Lists that many identical copies as separate auctions; when >1, each copy's name is suffixed `(1 of N)`, `(2 of N)`, …
- **`group_bidding`** + **`winners`** — run one shared multi-winner auction instead (see [Group (multi-winner) bidding](#group-multi-winner-bidding)).
- **`warn_before`** — default **1h**. Posts a no-ping "ending soon" reminder that long before the auction closes; skipped automatically if the auction is shorter than the lead time.

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

## HTTP API (for Rogue App)

The bot can serve a small JSON API so another application ("Rogue App") can run the same
moderator actions and look up a user's own bids. It runs inside the bot process and is **off**
unless `API_ENABLED=true` (see `.env.example` for every setting).

### Authentication

Every request (except `/v1/health`) needs **both** headers:

| Header | Proves |
| --- | --- |
| `X-Api-Key: <API_KEY>` | the request comes from Rogue App's server |
| `Authorization: Bearer <token>` | the signed-in user. The token is the user's Discord OAuth2 access token from Rogue App's "Sign in with Discord" (scope `identify`). |

The bot checks the token with Discord (`GET /oauth2/@me`) and rejects it unless it's valid,
was issued to `ROGUE_APP_CLIENT_ID`, and has the `identify` scope. Results are cached for up
to 60 seconds, keyed by a hash of the token. The user Discord reports is the one acting.

- **Moderator routes** require that user to be a moderator of the server, using the same rule
  as the slash commands (Manage Server, or `MOD_ROLE_ID`), checked fresh from Discord.
- **User routes**: a user can see their own data, including their hidden max bids. A
  moderator can see anyone's data in their server, but never another user's max bids.

Keep the API on `127.0.0.1` unless Rogue App runs on another machine. In that case, put it
behind HTTPS (e.g. a reverse proxy), because every request carries a user's token.

### Conventions

- Everything is under `/v1`. Request and response bodies are JSON.
- Money is **integer cents**, and times are ISO 8601 UTC.
- Durations use the slash-command format: `"2d12h"`, `"90m"`.
- Errors look like `{ "error": { "code": "not_moderator", "message": "…" } }`:

| Status | Codes |
| --- | --- |
| 400 | `invalid_input`, `invalid_json`, `unknown_field`, `channel_unavailable` |
| 401 | `invalid_api_key`, `missing_token`, `token_invalid` (refresh the token and retry), `wrong_application`, `missing_identify_scope` |
| 403 | `not_moderator`, `not_member`, `forbidden` |
| 404 | `not_found`, `guild_not_found`, `auction_not_found`, `bid_not_found` |
| 409 | `not_active` (auction already ended or cancelled) |
| 413 / 415 | `payload_too_large` / `unsupported_media_type` |
| 503 | `discord_unavailable` (retry shortly), `channel_not_configured` |

### Routes

`:g` is a Discord server (guild) ID. In user routes, `:userId` may be `me`.

| Method & path | Who | Does |
| --- | --- | --- |
| `GET /v1/health` | API key only | `{ ok, discordReady }` |
| `GET /v1/guilds` | anyone | Servers the bot shares with the user, with `isModerator` for each |
| `POST /v1/guilds/:g/auctions` | Moderator | `/auction create`. Posts in `AUCTION_CHANNEL_ID`. Body below. |
| `GET /v1/guilds/:g/auctions?status=` | Moderator | `/auction list`. `status` is `active` (default), `ended`, `cancelled` or `all`. |
| `GET /v1/guilds/:g/auctions/:id?bidsLimit=` | Moderator | `/auction info`, with the most recent bids (default 25, max 500) |
| `POST /v1/guilds/:g/auctions/:id/end` | Moderator | `/auction end` |
| `POST /v1/guilds/:g/auctions/:id/cancel` | Moderator | `/auction cancel` |
| `DELETE /v1/guilds/:g/auctions/:id` | Moderator | `/auction delete` |
| `POST /v1/guilds/:g/cleanup` | Moderator | `/auction cleanup` |
| `DELETE /v1/guilds/:g/auctions/:id/bids/:bidId` | Moderator | `/auction removebid` |
| `PATCH /v1/guilds/:g/auctions/:id/bids/:bidId` | Moderator | `/auction editbid`, body `{ "amountCents": 30000 }` |
| `GET /v1/guilds/:g/export.csv?auctionId=` | Moderator | `/auction export`, as a CSV download |
| `GET /v1/guilds/:g/users/:userId/bids` | self / Moderator | Every bid the user placed in the server |
| `GET /v1/guilds/:g/users/:userId/active` | self / Moderator | Open auctions they're in, with `standing` (`leading`, `in_slot` or `outbid`) and, for themselves only, `maxCents` |
| `GET /v1/guilds/:g/users/:userId/wins` | self / Moderator | Ended auctions they won, with `amountCents` |

Create body (unknown fields are rejected):

```json
{
  "itemName": "MTG Fallout Commander Deck",
  "startingBidCents": 2500,
  "duration": "2d12h",
  "description": "Sealed",
  "incrementCents": 500,
  "quantity": 1,
  "groupMode": false,
  "winners": null,
  "warnBefore": "1h"
}
```

Only `itemName`, `startingBidCents` and `duration` are required. The others default as in
[Creating an auction](#creating-an-auction), and `null` also means "use the default".

### Testing the API with rogue-cli

Until Rogue App exists, `tools/rogue-cli` stands in for it. It plays Rogue App's server: it
signs you in with Discord in your browser, saves your token, refreshes it when it expires,
and sends every request with the API key plus your token.

**One-time setup**

1. In the [Discord Developer Portal](https://discord.com/developers/applications), pick the
   application that will play Rogue App. This can be your test bot's application or a separate
   one. Under **OAuth2**:
   - add the redirect `http://localhost:53134/callback`;
   - copy the **Client ID** and **Client Secret**.
2. In the test bot's `.env`, turn the API on: `API_ENABLED=true`, an `API_KEY`,
   `ROGUE_APP_CLIENT_ID` (that application's Client ID) and `AUCTION_CHANNEL_ID`. Restart the bot.
3. Give the CLI the client secret, either in `.env` or in a separate `.env.rogue-cli`. Both are
   git-ignored, and the CLI reads `.env.rogue-cli` first, then `.env`:
   ```
   ROGUE_APP_CLIENT_SECRET=...
   ```
   The CLI reuses `API_KEY`, `API_PORT`, `ROGUE_APP_CLIENT_ID` and `GUILD_ID` from `.env`. It
   defaults to the API at `http://127.0.0.1:3000` and the server in `GUILD_ID`. Override them
   with `ROGUE_CLI_API_URL` / `ROGUE_CLI_GUILD_ID`, or with `--api-url` / `--guild`.

**Use**

```bash
npm run rogue -- help                     # every command and option
npm run rogue -- login                    # sign in (opens your browser)
npm run rogue -- login -p member          # a second saved login, e.g. a non-moderator account
npm run rogue -- health
npm run rogue -- create --item "MTG Deck" --starting-bid 25 --duration 2h
npm run rogue -- list
npm run rogue -- active                   # your own open auctions (with your max)
npm run rogue -- active 1234567890 -p member   # someone else's, as a non-moderator → 403
npm run rogue -- end 18
npm run rogue -- export --auction 18
```

Dollar amounts are typed the same way as in the slash commands (`25`, `25.00`). Responses are
printed as JSON, and the command exits with code 1 on any HTTP error. To test rejections, use
`--no-key`, `--api-key wrong`, `--no-token`, or `raw`, which sends any request exactly as written:

```bash
npm run rogue -- raw POST /v1/guilds/123/auctions '{"itemName":"x","startingBidCents":-5,"duration":"1h"}'
```

`-v` prints each request, with the key and token hidden. Saved tokens live in `.rogue-cli/`
(git-ignored). They're real Discord credentials for those accounts, so `logout` revokes them.

## Project layout

```
src/
  index.js            bot bootstrap, event wiring, scheduler init
  deploy-commands.js  registers slash commands with Discord
  db.js               SQLite schema + queries (atomic bid transaction)
  scheduler.js        closes auctions on time, reschedules after restarts
  commands/
    auction.js        /auction subcommands (thin wrappers over services/auctions.js)
    bid.js            /bid
  services/
    auctions.js       moderator actions shared by /auction and the HTTP API
    users.js          per-user views (own bids, open auctions, wins)
  api/
    server.js         HTTP API routes (node:http, under /v1)
    auth.js           API key + Discord token verification
    serialize.js      database rows -> API JSON
tools/
  rogue-cli/          stand-in for Rogue App, for testing the API (npm run rogue)
  util/
    money.js          dollars <-> integer cents
    time.js           duration parsing + Discord timestamps
    csv.js            CSV export builder
    embeds.js         auction announcement embed
    permissions.js    moderator check
    autocomplete.js   active-auction autocomplete
```
