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
    winning_amount_cents INTEGER
  );

  CREATE TABLE IF NOT EXISTS bids (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    auction_id  INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
    user_id     TEXT    NOT NULL,
    username    TEXT    NOT NULL,
    amount_cents INTEGER NOT NULL,
    placed_at   TEXT    NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids(auction_id);
  CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status);
`);

// --- Prepared statements ---
const stmts = {
  insertAuction: db.prepare(`
    INSERT INTO auctions
      (guild_id, channel_id, message_id, item_name, description,
       starting_bid_cents, min_increment_cents, created_by, created_at, end_time, status)
    VALUES
      (@guild_id, @channel_id, @message_id, @item_name, @description,
       @starting_bid_cents, @min_increment_cents, @created_by, @created_at, @end_time, 'active')
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
    INSERT INTO bids (auction_id, user_id, username, amount_cents, placed_at)
    VALUES (@auction_id, @user_id, @username, @amount_cents, @placed_at)
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
};

/**
 * Create a new auction. Returns the created row (with its new id).
 */
function createAuction(data) {
  const info = stmts.insertAuction.run(data);
  return stmts.getAuction.get(info.lastInsertRowid);
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

/**
 * Atomically validate and record a bid.
 *
 * Runs inside a transaction so the "read current highest -> validate -> insert"
 * sequence cannot interleave with a competing bid (better-sqlite3 is synchronous,
 * so the transaction body runs to completion before any other bid is processed).
 *
 * @returns {{ok: true, bid: object, previousHigh: object|null}
 *          | {ok: false, reason: string, requiredCents?: number,
 *             endTime?: string, status?: string}}
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

  const currentHigh = stmts.getHighestBid.get(auctionId) ?? null;
  const requiredCents = currentHigh
    ? currentHigh.amount_cents + auction.min_increment_cents
    : auction.starting_bid_cents;

  if (amountCents < requiredCents) {
    return { ok: false, reason: 'too_low', requiredCents };
  }

  const info = stmts.insertBid.run({
    auction_id: auctionId,
    user_id: bidder.id,
    username: bidder.username,
    amount_cents: amountCents,
    placed_at: nowIso,
  });

  const bid = { id: Number(info.lastInsertRowid), auction_id: auctionId,
    user_id: bidder.id, username: bidder.username,
    amount_cents: amountCents, placed_at: nowIso };

  return { ok: true, bid, previousHigh: currentHigh };
});

function placeBid(auctionId, bidder, amountCents, nowIso = new Date().toISOString()) {
  return placeBidTxn(auctionId, bidder, amountCents, nowIso);
}

/**
 * Mark an auction ended/cancelled, recording the winner (if any).
 * @param {number} auctionId
 * @param {'ended'|'cancelled'} status
 * @returns {{auction: object, winner: object|null}|null} null if not active.
 */
function finalizeAuction(auctionId, status) {
  const winner = status === 'ended' ? getHighestBid(auctionId) : null;
  const changed = stmts.finalizeAuction.run(
    status,
    winner?.user_id ?? null,
    winner?.amount_cents ?? null,
    auctionId,
  );
  if (changed.changes === 0) return null; // already finalized or gone
  return { auction: stmts.getAuction.get(auctionId), winner };
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

module.exports = {
  db,
  DB_PATH,
  createAuction,
  setAuctionMessageId,
  getAuction,
  getActiveAuctionsForGuild,
  getAllActiveAuctions,
  getAllAuctionsForGuild,
  getHighestBid,
  getBidCount,
  getBidsForAuction,
  getRecentBids,
  placeBid,
  finalizeAuction,
  deleteAuction,
  getFinishedAuctionsForGuild,
  deleteFinishedAuctionsForGuild,
};
