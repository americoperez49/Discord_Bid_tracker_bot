'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(__dirname, '..', 'data', 'auctions.sqlite');

// Ensure the containing directory exists before opening the file.
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS auctions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id            TEXT    NOT NULL,
    channel_id          TEXT    NOT NULL,
    message_id          TEXT,
    item_name           TEXT    NOT NULL,
    description         TEXT,
    starting_bid_cents  INTEGER NOT NULL,
    min_increment_cents INTEGER NOT NULL DEFAULT 500,
    created_by          TEXT    NOT NULL,
    created_at          TEXT    NOT NULL,
    end_time            TEXT    NOT NULL,
    status              TEXT    NOT NULL DEFAULT 'active',
    winner_user_id      TEXT,
    winning_amount_cents INTEGER,
    group_mode          INTEGER NOT NULL DEFAULT 0,
    winners             INTEGER NOT NULL DEFAULT 1,
    warn_time           TEXT,
    warned              INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS bids (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id  INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    user_id     TEXT    NOT NULL,
    username    TEXT    NOT NULL,
    amount_cents INTEGER NOT NULL,
    placed_at   TEXT    NOT NULL,
    active      INTEGER NOT NULL DEFAULT 1,
    displaced_bid_id INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id);
  CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
`);

// --- Migrations: add columns to databases created before these features. ---
// Must run before any index/query that references the new columns, since an
// existing table won't have them yet (CREATE TABLE IF NOT EXISTS is a no-op).
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('auctions', 'group_mode', 'group_mode INTEGER NOT NULL DEFAULT 0');
ensureColumn('auctions', 'winners', 'winners INTEGER NOT NULL DEFAULT 1');
ensureColumn('bids', 'active', 'active INTEGER NOT NULL DEFAULT 1');
// Records which bid a group bid displaced (LIFO), so a moderator removing that
// bid can restore the bidder it knocked out of a winning slot.
ensureColumn('bids', 'displaced_bid_id', 'displaced_bid_id INTEGER');
// Ending-soon reminder: when to post the warning, and whether it has been sent.
ensureColumn('auctions', 'warn_time', 'warn_time TEXT');
ensureColumn('auctions', 'warned', 'warned INTEGER NOT NULL DEFAULT 0');

// Index on the (now-guaranteed) `active` column, after the migration above.
db.exec(`CREATE INDEX IF NOT EXISTS idx_bids_active ON bids(auction_id, active);`);

// --- Prepared statements ---
const stmts = {
  insertAuction: db.prepare(`
    INSERT INTO auctions
      (guild_id, channel_id, message_id, item_name, description,
       starting_bid_cents, min_increment_cents, created_by, created_at, end_time, status,
       group_mode, winners, warn_time)
    VALUES
      (@guild_id, @channel_id, @message_id, @item_name, @description,
       @starting_bid_cents, @min_increment_cents, @created_by, @created_at, @end_time, 'active',
       @group_mode, @winners, @warn_time)
  `),
  setMessageId: db.prepare(`UPDATE auctions SET message_id = ? WHERE id = ?`),
  getAuction: db.prepare(`SELECT * FROM auctions WHERE id = ?`),
  getActiveAuctionsForGuild: db.prepare(`
    SELECT * FROM auctions WHERE guild_id = ? AND status = 'active' ORDER BY end_time ASC
  `),
  getAllActiveAuctions: db.prepare(`SELECT * FROM auctions WHERE status = 'active'`),
  getAllAuctionsForGuild: db.prepare(`
    SELECT * FROM auctions WHERE guild_id = ? ORDER BY id DESC
  `),
  getHighestBid: db.prepare(`
    SELECT * FROM bids WHERE auction_id = ? ORDER BY amount_cents DESC, id ASC LIMIT 1
  `),
  countBids: db.prepare(`SELECT COUNT(*) AS n FROM bids WHERE auction_id = ?`),
  getBidsForAuction: db.prepare(`
    SELECT * FROM bids WHERE auction_id = ? ORDER BY amount_cents DESC, placed_at ASC
  `),
  getRecentBids: db.prepare(`
    SELECT * FROM bids WHERE auction_id = ? ORDER BY id DESC LIMIT ?
  `),
  insertBid: db.prepare(`
    INSERT INTO bids (auction_id, user_id, username, amount_cents, placed_at, active)
    VALUES (@auction_id, @user_id, @username, @amount_cents, @placed_at, @active)
  `),
  finalizeAuction: db.prepare(`
    UPDATE auctions
       SET status = ?, winner_user_id = ?, winning_amount_cents = ?
     WHERE id = ? AND status = 'active'
  `),
  deleteAuction: db.prepare(`DELETE FROM auctions WHERE id = ?`),
  getFinishedForGuild: db.prepare(`
    SELECT * FROM auctions
     WHERE guild_id = ? AND status IN ('ended', 'cancelled')
     ORDER BY id
  `),
  deleteFinishedForGuild: db.prepare(`
    DELETE FROM auctions WHERE guild_id = ? AND status IN ('ended', 'cancelled')
  `),
  // Group-mode: the current "winning set" is the active=1 bids.
  getActiveBidsAsc: db.prepare(`
    SELECT * FROM bids WHERE auction_id = ? AND active = 1
     ORDER BY amount_cents ASC, placed_at ASC
  `),
  getActiveBidsDesc: db.prepare(`
    SELECT * FROM bids WHERE auction_id = ? AND active = 1
     ORDER BY amount_cents DESC, placed_at ASC
  `),
  getActiveBidForUser: db.prepare(`
    SELECT * FROM bids WHERE auction_id = ? AND user_id = ? AND active = 1 LIMIT 1
  `),
  // The bid to displace when a full winning set is beaten: lowest amount, and
  // among ties at that amount the most recently placed (LIFO).
  getLowestActiveToKick: db.prepare(`
    SELECT * FROM bids WHERE auction_id = ? AND active = 1
     ORDER BY amount_cents ASC, placed_at DESC LIMIT 1
  `),
  // Set the ending-soon warning as sent, exactly once (guards against the timer
  // and the sweep both firing).
  markWarned: db.prepare(`UPDATE auctions SET warned = 1 WHERE id = ? AND warned = 0`),
  deactivateBid: db.prepare(`UPDATE bids SET active = 0 WHERE id = ?`),
  activateBid: db.prepare(`UPDATE bids SET active = 1 WHERE id = ?`),
  setDisplacedBidId: db.prepare(`UPDATE bids SET displaced_bid_id = ? WHERE id = ?`),
  getBid: db.prepare(`SELECT * FROM bids WHERE id = ?`),
  deleteBid: db.prepare(`DELETE FROM bids WHERE id = ?`),
  updateBidAmount: db.prepare(`UPDATE bids SET amount_cents = ? WHERE id = ?`),
  // Each bidder's most recent bid on an auction (one row per user), for the
  // moderator bidder picker.
  getLatestBidsPerUser: db.prepare(`
    SELECT b.* FROM bids b
    JOIN (SELECT user_id, MAX(id) AS max_id FROM bids WHERE auction_id = ? GROUP BY user_id) m
      ON b.id = m.max_id
    ORDER BY b.amount_cents DESC, b.placed_at ASC
  `),
};

/**
 * Create a new auction. `group_mode` (0/1) and `winners` default to a normal
 * single-winner auction when not supplied. Returns the created row.
 */
function createAuction(data) {
  const info = stmts.insertAuction.run({
    group_mode: 0,
    winners: 1,
    warn_time: null,
    ...data,
  });
  return stmts.getAuction.get(info.lastInsertRowid);
}

/**
 * Mark an auction's ending-soon warning as sent — but only if it hasn't been
 * already. Returns true if this call is the one that flipped it (so the caller
 * should post the warning), false if it was already warned.
 * @param {number} auctionId
 * @returns {boolean}
 */
function markWarnedOnce(auctionId) {
  return stmts.markWarned.run(auctionId).changes > 0;
}

function setAuctionMessageId(auctionId, messageId) {
  stmts.setMessageId.run(messageId, auctionId);
}

function getAuction(auctionId) {
  return stmts.getAuction.get(auctionId);
}

function getActiveAuctionsForGuild(guildId) {
  return stmts.getActiveAuctionsForGuild.all(guildId);
}

function getAllActiveAuctions() {
  return stmts.getAllActiveAuctions.all();
}

function getAllAuctionsForGuild(guildId) {
  return stmts.getAllAuctionsForGuild.all(guildId);
}

function getHighestBid(auctionId) {
  return stmts.getHighestBid.get(auctionId) ?? null;
}

function getBidCount(auctionId) {
  return stmts.countBids.get(auctionId).n;
}

function getBidsForAuction(auctionId) {
  return stmts.getBidsForAuction.all(auctionId);
}

function getRecentBids(auctionId, limit = 5) {
  return stmts.getRecentBids.all(auctionId, limit);
}

/** Group-mode: current winning bids, highest first. */
function getActiveBids(auctionId) {
  return stmts.getActiveBidsDesc.all(auctionId);
}

/**
 * The minimum amount the next bid must reach.
 *  - Normal: current high bid + increment, or the starting bid if no bids yet.
 *  - Group: the starting bid while winning slots remain open; once all `winners`
 *    slots are full, the lowest winning bid + increment.
 * @param {object} auction
 * @returns {number} minimum acceptable bid, in cents.
 */
function nextMinBidCents(auction) {
  if (!auction.group_mode) {
    const high = stmts.getHighestBid.get(auction.id);
    return high ? high.amount_cents + auction.min_increment_cents : auction.starting_bid_cents;
  }
  const active = stmts.getActiveBidsAsc.all(auction.id);
  if (active.length < auction.winners) return auction.starting_bid_cents;
  return active[0].amount_cents + auction.min_increment_cents;
}

/** Group-mode: how many of the `winners` slots are currently filled. */
function getFilledSlots(auction) {
  return stmts.getActiveBidsAsc.all(auction.id).length;
}

// --- Bidding ---------------------------------------------------------------

/** Normal single-winner bid (append-only history; highest bid wins). */
function normalBid(auction, bidder, amountCents, nowIso) {
  const currentHigh = stmts.getHighestBid.get(auction.id) ?? null;
  const requiredCents = currentHigh
    ? currentHigh.amount_cents + auction.min_increment_cents
    : auction.starting_bid_cents;

  if (amountCents < requiredCents) {
    return { ok: false, reason: 'too_low', requiredCents };
  }

  const info = stmts.insertBid.run({
    auction_id: auction.id,
    user_id: bidder.id,
    username: bidder.username,
    amount_cents: amountCents,
    placed_at: nowIso,
    active: 1,
  });

  return {
    ok: true,
    groupMode: false,
    bid: {
      id: Number(info.lastInsertRowid),
      auction_id: auction.id,
      user_id: bidder.id,
      username: bidder.username,
      amount_cents: amountCents,
      placed_at: nowIso,
    },
    previousHigh: currentHigh,
  };
}

/**
 * Group multi-winner bid.
 *  - A bidder may hold only one active (winning) bid at a time.
 *  - While fewer than `winners` slots are filled, the minimum is the starting
 *    bid (ties allowed).
 *  - Once full, the minimum is the lowest winning bid + increment; the new bid
 *    displaces the most-recently-placed bid at the lowest amount (LIFO), who is
 *    "outbid" and free to bid again.
 */
function groupBid(auction, bidder, amountCents, nowIso) {
  const active = stmts.getActiveBidsAsc.all(auction.id); // lowest first
  const mine = active.find((b) => b.user_id === bidder.id);
  if (mine) {
    return { ok: false, reason: 'already_bidding', groupMode: true, currentCents: mine.amount_cents };
  }

  const full = active.length >= auction.winners;
  const requiredCents = full
    ? active[0].amount_cents + auction.min_increment_cents
    : auction.starting_bid_cents;

  if (amountCents < requiredCents) {
    return { ok: false, reason: 'too_low', requiredCents, groupMode: true };
  }

  const info = stmts.insertBid.run({
    auction_id: auction.id,
    user_id: bidder.id,
    username: bidder.username,
    amount_cents: amountCents,
    placed_at: nowIso,
    active: 1,
  });

  const bid = {
    id: Number(info.lastInsertRowid),
    auction_id: auction.id,
    user_id: bidder.id,
    username: bidder.username,
    amount_cents: amountCents,
    placed_at: nowIso,
  };

  // If we've exceeded capacity, displace the lowest winning bid (LIFO on ties).
  // When the set was full, requiredCents > lowest, so the new bid is never the
  // one displaced.
  let kicked = null;
  if (active.length + 1 > auction.winners) {
    kicked = stmts.getLowestActiveToKick.get(auction.id);
    stmts.deactivateBid.run(kicked.id);
    // Remember who this bid displaced so it can be restored if the bid is
    // later removed by a moderator.
    stmts.setDisplacedBidId.run(kicked.id, bid.id);
  }

  return { ok: true, groupMode: true, bid, kicked, nextMinCents: nextMinBidCents(auction) };
}

/**
 * Atomically validate and record a bid, dispatching to the normal or group
 * algorithm. Runs in a transaction so the read/validate/insert/displace
 * sequence cannot interleave with a competing bid.
 *
 * @returns success `{ok:true, groupMode, bid, previousHigh?|kicked?, nextMinCents?}`
 *   or failure `{ok:false, reason, requiredCents?, currentCents?, endTime?, status?}`.
 */
const placeBidTxn = db.transaction((auctionId, bidder, amountCents, nowIso) => {
  const auction = stmts.getAuction.get(auctionId);
  if (!auction) return { ok: false, reason: 'not_found' };
  if (auction.status !== 'active') {
    return { ok: false, reason: 'not_active', status: auction.status };
  }
  if (new Date(auction.end_time).getTime() <= new Date(nowIso).getTime()) {
    return { ok: false, reason: 'expired', endTime: auction.end_time };
  }

  return auction.group_mode
    ? groupBid(auction, bidder, amountCents, nowIso)
    : normalBid(auction, bidder, amountCents, nowIso);
});

function placeBid(auctionId, bidder, amountCents, nowIso = new Date().toISOString()) {
  return placeBidTxn(auctionId, bidder, amountCents, nowIso);
}

/**
 * Mark an auction ended/cancelled and determine the winner(s).
 *  - Normal ended: the single highest bid.
 *  - Group ended: all currently-active (winning) bids, highest first.
 * @param {number} auctionId
 * @param {'ended'|'cancelled'} status
 * @returns {{auction: object, winners: object[]}|null} null if not active.
 */
const finalizeTxn = db.transaction((auctionId, status) => {
  const auction = stmts.getAuction.get(auctionId);
  if (!auction || auction.status !== 'active') return null;

  let winners = [];
  if (status === 'ended') {
    if (auction.group_mode) {
      winners = stmts.getActiveBidsDesc.all(auctionId);
    } else {
      const high = stmts.getHighestBid.get(auctionId);
      winners = high ? [high] : [];
    }
  }

  const primary = winners[0] ?? null;
  stmts.finalizeAuction.run(
    status,
    primary?.user_id ?? null,
    primary?.amount_cents ?? null,
    auctionId,
  );
  return { auction: stmts.getAuction.get(auctionId), winners };
});

function finalizeAuction(auctionId, status) {
  return finalizeTxn(auctionId, status);
}

/**
 * Permanently delete an auction and (via ON DELETE CASCADE) all of its bids.
 * @param {number} auctionId
 * @returns {number} number of auction rows removed (0 or 1).
 */
function deleteAuction(auctionId) {
  return stmts.deleteAuction.run(auctionId).changes;
}

function getFinishedAuctionsForGuild(guildId) {
  return stmts.getFinishedForGuild.all(guildId);
}

/**
 * Permanently delete every ended/cancelled auction in a guild (and their bids).
 * @param {string} guildId
 * @returns {object[]} the auction rows that were removed.
 */
function deleteFinishedAuctionsForGuild(guildId) {
  const rows = stmts.getFinishedForGuild.all(guildId);
  stmts.deleteFinishedForGuild.run(guildId);
  return rows;
}

/** A single bid row by id (or undefined). */
function getBid(bidId) {
  return stmts.getBid.get(bidId);
}

/** Each bidder's most recent bid on an auction — one row per user. */
function getLatestBidsPerUser(auctionId) {
  return stmts.getLatestBidsPerUser.all(auctionId);
}

/**
 * Moderator: remove a single bid.
 *  - Normal auction: just delete it (the next-highest bid becomes current).
 *  - Group auction: if the removed bid was active and had displaced someone,
 *    restore that bidder to their winning slot (unless they've since re-bid and
 *    are active again).
 * @param {number} bidId
 * @returns {{auction: object, removed: object, restored: object|null}|null}
 *   null if the bid no longer exists.
 */
/**
 * Read-only preview: the bid that WOULD be reinstated to a winning slot if
 * `bidId` were removed, or null if none. Only group-auction bids that are
 * currently active and displaced someone reinstate anyone — and only if that
 * displaced bid still exists, is inactive, and its user isn't already active.
 * `removeBid` uses this so the preview and the actual result always agree.
 * @param {number} bidId
 * @returns {object|null}
 */
function reinstatementFor(bidId) {
  const removed = stmts.getBid.get(bidId);
  if (!removed) return null;
  const auction = stmts.getAuction.get(removed.auction_id);
  if (!auction?.group_mode || removed.active !== 1 || removed.displaced_bid_id == null) return null;
  const displaced = stmts.getBid.get(removed.displaced_bid_id);
  if (displaced && displaced.active === 0 && !stmts.getActiveBidForUser.get(auction.id, displaced.user_id)) {
    return displaced;
  }
  return null;
}

const removeBidTxn = db.transaction((bidId) => {
  const removed = stmts.getBid.get(bidId);
  if (!removed) return null;
  const auction = stmts.getAuction.get(removed.auction_id);

  const restored = reinstatementFor(bidId);
  if (restored) stmts.activateBid.run(restored.id);

  stmts.deleteBid.run(bidId);
  return { auction, removed, restored };
});

function removeBid(bidId) {
  return removeBidTxn(bidId);
}

/**
 * Moderator: set a bid's amount. Group auctions keep the bid in place (winning
 * bids stay winning at the corrected amount; kicked bidders are not re-admitted).
 * @param {number} bidId
 * @param {number} newAmountCents
 * @returns {{auction: object, bid: object, oldAmountCents: number}|null}
 */
const editBidAmountTxn = db.transaction((bidId, newAmountCents) => {
  const before = stmts.getBid.get(bidId);
  if (!before) return null;
  stmts.updateBidAmount.run(newAmountCents, bidId);
  return {
    auction: stmts.getAuction.get(before.auction_id),
    bid: stmts.getBid.get(bidId),
    oldAmountCents: before.amount_cents,
  };
});

function editBidAmount(bidId, newAmountCents) {
  return editBidAmountTxn(bidId, newAmountCents);
}

module.exports = {
  db,
  DB_PATH,
  createAuction,
  markWarnedOnce,
  setAuctionMessageId,
  getAuction,
  getActiveAuctionsForGuild,
  getAllActiveAuctions,
  getAllAuctionsForGuild,
  getHighestBid,
  getBidCount,
  getBidsForAuction,
  getRecentBids,
  getActiveBids,
  nextMinBidCents,
  getFilledSlots,
  placeBid,
  finalizeAuction,
  deleteAuction,
  getFinishedAuctionsForGuild,
  deleteFinishedAuctionsForGuild,
  getBid,
  getLatestBidsPerUser,
  reinstatementFor,
  removeBid,
  editBidAmount,
};
