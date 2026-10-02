'use strict';

/**
 * Moderator actions on auctions, independent of how they were requested.
 *
 * Both the /auction slash command and the HTTP API call these functions, so
 * every caller gets the same rules. Each function takes a context:
 *
 *   ctx = { client, guildId, actorId, member? }
 *
 * `actorId` is the Discord user performing the action. Every function checks
 * that this user is a moderator of `guildId` before doing anything else, so no
 * caller can skip the check. `member` is optional and must only ever be the
 * GuildMember Discord supplied with an interaction (it saves a fetch); when it
 * is absent the member is fetched fresh from Discord.
 *
 * Failures throw a ServiceError with a stable `code` (for the API) and a
 * human-readable `message` (for Discord replies).
 */

const { PermissionFlagsBits } = require('discord.js');
const db = require('../db');
const { formatCents } = require('../util/money');
const { buildAuctionEmbed } = require('../util/embeds');
const { buildCsv } = require('../util/csv');
const { isModerator } = require('../util/permissions');
const { scheduleAuctionEnd, endAuction: finishAuction, cancelScheduled } = require('../scheduler');

const DEFAULT_INCREMENT_CENTS = 500; // $5
const DEFAULT_WARN_BEFORE_MS = 60 * 60 * 1000; // 1 hour
const MAX_QUANTITY = 25;
const MIN_WINNERS = 2;
const MAX_WINNERS = 25;

class ServiceError extends Error {
  /**
   * @param {string} code    stable machine-readable reason, e.g. 'auction_not_found'
   * @param {string} message human-readable explanation
   */
  constructor(code, message) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
  }
}

const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

// --- Actor / permission checks ---------------------------------------------

async function resolveGuild(ctx) {
  const guild =
    ctx.client.guilds.cache.get(ctx.guildId) ??
    (ctx.guildId ? await ctx.client.guilds.fetch(ctx.guildId).catch(() => null) : null);
  if (!guild) throw new ServiceError('guild_not_found', 'That server was not found, or the bot is not in it.');
  return guild;
}

async function resolveMember(ctx, guild) {
  // An interaction's member comes straight from Discord and is current. Anything
  // else is fetched with force: without the privileged GuildMembers intent the
  // bot never hears about role changes, so a cached member could be stale.
  if (ctx.member && ctx.member.id === ctx.actorId && ctx.member.guild?.id === guild.id) {
    return ctx.member;
  }
  if (!ctx.actorId) return null;
  return guild.members.fetch({ user: ctx.actorId, force: true }).catch(() => null);
}

/**
 * Ensure the actor is a moderator of the guild. Returns the guild.
 * Also exported so the slash command can check before showing a confirm prompt.
 */
async function assertModerator(ctx) {
  const guild = await resolveGuild(ctx);
  const member = await resolveMember(ctx, guild);
  if (!member) throw new ServiceError('not_member', 'That user is not a member of this server.');
  if (!isModerator(member)) {
    throw new ServiceError(
      'not_moderator',
      'You need the moderator role (or "Manage Server") to use this command.',
    );
  }
  return guild;
}

// --- Lookups ---------------------------------------------------------------

function getGuildAuction(guildId, auctionId) {
  const auction = Number.isInteger(auctionId) ? db.getAuction(auctionId) : null;
  if (!auction || auction.guild_id !== guildId) {
    throw new ServiceError('auction_not_found', `Auction #${auctionId} not found in this server.`);
  }
  return auction;
}

function getAuctionBid(auction, bidId) {
  const bid = Number.isInteger(bidId) ? db.getBid(bidId) : null;
  if (!bid || bid.auction_id !== auction.id) {
    throw new ServiceError('bid_not_found', 'That bid was not found on this auction.');
  }
  return bid;
}

function assertActive(auction) {
  if (auction.status !== 'active') {
    throw new ServiceError('not_active', `Auction #${auction.id} is already ${auction.status}.`);
  }
}

// --- Discord message helpers -----------------------------------------------

async function fetchTextChannel(client, channelId) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.isTextBased() ? channel : null;
}

/** A text channel (or thread) in this guild that the bot can post embeds in. */
async function resolvePostableChannel(guild, channelId) {
  const channel = typeof channelId === 'string' ? await fetchTextChannel(guild.client, channelId) : null;
  if (!channel || channel.guildId !== guild.id) {
    throw new ServiceError('channel_unavailable', `Channel ${channelId} is not a text channel in this server.`);
  }
  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  const send = channel.isThread()
    ? PermissionFlagsBits.SendMessagesInThreads
    : PermissionFlagsBits.SendMessages;
  if (perms && !perms.has([PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.EmbedLinks])) {
    throw new ServiceError(
      'channel_unavailable',
      `I can't post in <#${channel.id}>. I need View Channel, Send Messages and Embed Links there.`,
    );
  }
  return channel;
}

/** Pin a message, returning whether it succeeded (needs Manage Messages). */
async function tryPin(message) {
  try {
    await message.pin();
    return true;
  } catch {
    return false;
  }
}

/** Edit the auction's announcement message so its embed reflects current state. */
async function refreshAnnouncement(client, auction) {
  if (!auction?.message_id) return;
  try {
    const channel = await fetchTextChannel(client, auction.channel_id);
    const msg = await channel?.messages.fetch(auction.message_id).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildAuctionEmbed(auction)] });
  } catch {
    /* non-fatal */
  }
}

/** Best-effort removal of an auction's public announcement message. */
async function deleteAnnouncement(client, auction) {
  if (!auction.message_id) return;
  try {
    const channel = await fetchTextChannel(client, auction.channel_id);
    const msg = await channel?.messages.fetch(auction.message_id).catch(() => null);
    if (msg) await msg.delete();
  } catch {
    /* message may already be gone — ignore */
  }
}

/** Post a no-ping moderator note in the auction's channel (best-effort). */
async function postModNote(client, auction, content) {
  const channel = await fetchTextChannel(client, auction.channel_id);
  await channel?.send({ content, allowedMentions: { parse: [] } }).catch(() => {});
}

// --- Create ----------------------------------------------------------------

/**
 * Create one auction (or `quantity` copies, or one group auction) and post its
 * listing in `channelId`.
 *
 * Optional fields left `undefined` take their defaults. A `null` numeric field
 * means the caller couldn't parse the user's input, and is rejected.
 *
 * @param {object} ctx
 * @param {object} input
 * @param {string} input.channelId
 * @param {string} input.itemName
 * @param {string|null} [input.description]
 * @param {number} input.startingBidCents
 * @param {number} input.durationMs
 * @param {number} [input.incrementCents=500]
 * @param {number} [input.quantity=1]        normal mode only
 * @param {boolean} [input.groupMode=false]
 * @param {number|null} [input.winners]      group mode only, 2–25
 * @param {number} [input.warnBeforeMs=1h]
 * @returns {Promise<{auctions: object[], groupMode: boolean, endTime: string,
 *   warnTime: string|null, allPinned: boolean, quantityIgnored: boolean}>}
 */
async function createAuction(ctx, input) {
  const guild = await assertModerator(ctx);
  const {
    channelId,
    itemName,
    description = null,
    startingBidCents,
    durationMs,
    incrementCents = DEFAULT_INCREMENT_CENTS,
    quantity = 1,
    groupMode = false,
    winners = null,
    warnBeforeMs = DEFAULT_WARN_BEFORE_MS,
  } = input;

  if (typeof itemName !== 'string' || itemName.trim() === '') {
    throw new ServiceError('invalid_input', 'Item name is required.');
  }
  if (description !== null && typeof description !== 'string') {
    throw new ServiceError('invalid_input', 'Description must be text.');
  }
  if (!isPositiveInt(startingBidCents)) {
    throw new ServiceError('invalid_input', 'Starting bid must be a positive dollar amount, e.g. `25` or `25.00`.');
  }
  if (!isPositiveInt(durationMs)) {
    throw new ServiceError('invalid_input', 'Duration is invalid. Use forms like `2d12h`, `48h`, `90m`, or `1w`.');
  }
  if (!isPositiveInt(incrementCents)) {
    throw new ServiceError('invalid_input', 'Increment must be a positive dollar amount.');
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new ServiceError('invalid_input', `Quantity must be a whole number from 1 to ${MAX_QUANTITY}.`);
  }
  if (typeof groupMode !== 'boolean') {
    throw new ServiceError('invalid_input', 'Group bidding must be true or false.');
  }
  if (groupMode && !(Number.isInteger(winners) && winners >= MIN_WINNERS && winners <= MAX_WINNERS)) {
    throw new ServiceError(
      'invalid_input',
      `For group bidding, set \`winners\` to the number of winning slots (${MIN_WINNERS}–${MAX_WINNERS}). ` +
        'Example: 4 identical cases → `group_bidding: True`, `winners: 4`.',
    );
  }
  if (!isPositiveInt(warnBeforeMs)) {
    throw new ServiceError('invalid_input', '`warn_before` is invalid. Use forms like `1h`, `30m`, `2h`, or `1d`.');
  }

  const channel = await resolvePostableChannel(guild, channelId);

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const endTime = new Date(now + durationMs).toISOString();

  // Ending-soon reminder time. Skip it if it would land in the past (auction is
  // shorter than the requested lead time).
  const warnMs = now + durationMs - warnBeforeMs;
  const warnTime = warnMs > Date.now() ? new Date(warnMs).toISOString() : null;

  const base = {
    guild_id: guild.id,
    channel_id: channel.id,
    message_id: null,
    description,
    starting_bid_cents: startingBidCents,
    min_increment_cents: incrementCents,
    created_by: ctx.actorId,
    created_at: nowIso,
    end_time: endTime,
    warn_time: warnTime,
  };

  // Insert the row, post its listing, then start its timers. If the post fails,
  // remove the row so no listing-less auction is left running.
  const list = async (row) => {
    const auction = db.createAuction(row);
    let message;
    try {
      message = await channel.send({ embeds: [buildAuctionEmbed(auction)] });
    } catch {
      db.deleteAuction(auction.id);
      throw new ServiceError('channel_unavailable', `I couldn't post the listing in <#${channel.id}>.`);
    }
    db.setAuctionMessageId(auction.id, message.id);
    auction.message_id = message.id;
    scheduleAuctionEnd(auction);
    return { auction, pinned: await tryPin(message) };
  };

  const created = [];
  let allPinned = true;

  if (groupMode) {
    // One shared auction with N winner slots (quantity is ignored).
    const { auction, pinned } = await list({ ...base, item_name: itemName, group_mode: 1, winners });
    created.push(auction);
    allPinned = pinned;
  } else {
    for (let i = 1; i <= quantity; i++) {
      // When listing multiple copies, make each one's name distinct.
      const name = quantity > 1 ? `${itemName} (${i} of ${quantity})` : itemName;
      const { auction, pinned } = await list({ ...base, item_name: name });
      created.push(auction);
      if (!pinned) allPinned = false;
    }
  }

  return {
    auctions: created,
    groupMode,
    endTime,
    warnTime,
    allPinned,
    quantityIgnored: groupMode && quantity > 1,
  };
}

// --- Read ------------------------------------------------------------------

/** Active auctions in the guild (soonest-ending first), each with its high bid. */
async function listActiveAuctions(ctx) {
  await assertModerator(ctx);
  return db.getActiveAuctionsForGuild(ctx.guildId).map((auction) => ({
    auction,
    highBid: db.getHighestBid(auction.id),
  }));
}

/** One auction's details and its most recent bids. */
async function getAuctionInfo(ctx, auctionId, { recentLimit = 10 } = {}) {
  await assertModerator(ctx);
  const auction = getGuildAuction(ctx.guildId, auctionId);
  return {
    auction,
    bidCount: db.getBidCount(auction.id),
    recentBids: db.getRecentBids(auction.id, recentLimit),
  };
}

// --- End / cancel ----------------------------------------------------------

async function closeAuction(ctx, auctionId, status) {
  await assertModerator(ctx);
  assertActive(getGuildAuction(ctx.guildId, auctionId));
  const auction = await finishAuction(auctionId, status);
  // Null means it was finalised elsewhere (e.g. its timer fired) in the meantime.
  if (!auction) throw new ServiceError('not_active', `Auction #${auctionId} has already finished.`);
  return auction;
}

/** End an auction now and announce the winner(s). Returns the finalised auction. */
function endAuction(ctx, auctionId) {
  return closeAuction(ctx, auctionId, 'ended');
}

/** Cancel an auction with no winner. Returns the finalised auction. */
function cancelAuction(ctx, auctionId) {
  return closeAuction(ctx, auctionId, 'cancelled');
}

// --- Delete / cleanup ------------------------------------------------------

/** What deleting `auctionId` would remove, for a confirmation prompt. */
async function previewDeleteAuction(ctx, auctionId) {
  await assertModerator(ctx);
  const auction = getGuildAuction(ctx.guildId, auctionId);
  return { auction, bidCount: db.getBidCount(auction.id) };
}

/** Permanently delete an auction and its bids, and remove its listing message. */
async function deleteAuction(ctx, auctionId) {
  await assertModerator(ctx);
  const auction = getGuildAuction(ctx.guildId, auctionId);
  const bidCount = db.getBidCount(auction.id);

  cancelScheduled(auction.id);
  db.deleteAuction(auction.id);

  // Removing the listing is best-effort and needn't hold up the caller.
  deleteAnnouncement(ctx.client, auction).catch(() => {});
  return { auction, bidCount };
}

/** The ended/cancelled auctions a cleanup would delete. */
async function previewCleanup(ctx) {
  await assertModerator(ctx);
  return db.getFinishedAuctionsForGuild(ctx.guildId);
}

/** Delete every ended/cancelled auction in the guild. Returns the removed rows. */
async function cleanupFinished(ctx) {
  await assertModerator(ctx);
  return db.deleteFinishedAuctionsForGuild(ctx.guildId);
}

// --- Bid corrections -------------------------------------------------------

/**
 * What removing a bid would do, for a confirmation prompt. `reinstated` is the
 * group-auction bid that would get its winning slot back, or null.
 */
async function previewRemoveBid(ctx, auctionId, bidId) {
  await assertModerator(ctx);
  const auction = getGuildAuction(ctx.guildId, auctionId);
  const bid = getAuctionBid(auction, bidId);
  return { auction, bid, reinstated: auction.group_mode ? db.reinstatementFor(bid.id) : null };
}

/** Remove one bid, refresh the listing, and post a moderator note. */
async function removeBid(ctx, auctionId, bidId) {
  await assertModerator(ctx);
  const auction = getGuildAuction(ctx.guildId, auctionId);
  const bid = getAuctionBid(auction, bidId);

  const result = db.removeBid(bid.id);
  if (!result) throw new ServiceError('bid_not_found', 'That bid was not found on this auction.');

  const updated = db.getAuction(auction.id);
  await refreshAnnouncement(ctx.client, updated);

  const restoredNote = result.restored
    ? ` **${result.restored.username}** is back in a winning slot.`
    : '';
  await postModNote(
    ctx.client,
    updated,
    `🛠️ A moderator removed **${bid.username}**'s bid of ` +
      `**${formatCents(bid.amount_cents)}** on **#${auction.id} — ${auction.item_name}**.${restoredNote}`,
  );

  return { auction: updated, bid, restored: result.restored };
}

/** Validate a bid edit without applying it, for a confirmation prompt. */
async function previewEditBid(ctx, auctionId, bidId, newAmountCents) {
  await assertModerator(ctx);
  const auction = getGuildAuction(ctx.guildId, auctionId);
  const bid = getAuctionBid(auction, bidId);
  assertBidAmount(newAmountCents);
  return { auction, bid };
}

function assertBidAmount(cents) {
  if (!isPositiveInt(cents)) {
    throw new ServiceError('invalid_input', 'Amount must be a positive dollar value, e.g. `300` or `299.99`.');
  }
}

/** Correct a bid's amount, refresh the listing, and post a moderator note. */
async function editBid(ctx, auctionId, bidId, newAmountCents) {
  await assertModerator(ctx);
  const auction = getGuildAuction(ctx.guildId, auctionId);
  const bid = getAuctionBid(auction, bidId);
  assertBidAmount(newAmountCents);

  const result = db.editBidAmount(bid.id, newAmountCents);
  if (!result) throw new ServiceError('bid_not_found', 'That bid was not found on this auction.');

  await refreshAnnouncement(ctx.client, result.auction);
  await postModNote(
    ctx.client,
    result.auction,
    `🛠️ A moderator changed **${bid.username}**'s bid on **#${auction.id} — ${auction.item_name}** from ` +
      `**${formatCents(result.oldAmountCents)}** to **${formatCents(newAmountCents)}**.`,
  );

  return { auction: result.auction, bid: result.bid, oldAmountCents: result.oldAmountCents };
}

// --- Export ----------------------------------------------------------------

const EXPORT_HEADERS = [
  'auction_id',
  'item_name',
  'auction_type',
  'winner_slots',
  'auction_status',
  'auction_end_time_utc',
  'bidder_user_id',
  'bidder_username',
  'bid_amount',
  'bid_placed_at_utc',
  'bid_placed_at_readable',
  'is_winning_bid',
  'displaced_bidder',
  'displaced_bid_amount',
  'auto_bid',
];

/**
 * Build the bids CSV for one auction, or for every auction in the guild when
 * `auctionId` is null.
 * @returns {Promise<{csv: string, fileName: string, auctionCount: number, rowCount: number}>}
 */
async function exportBidsCsv(ctx, auctionId = null) {
  await assertModerator(ctx);
  const auctions =
    auctionId !== null ? [getGuildAuction(ctx.guildId, auctionId)] : db.getAllAuctionsForGuild(ctx.guildId);

  const rows = [];
  for (const a of auctions) {
    const type = a.group_mode ? 'group' : 'single';
    const slots = a.group_mode ? a.winners : 1;
    // Export newest bid first. placed_at is an ISO UTC string, so a
    // lexicographic sort is also chronological (descending = newest first).
    const bids = db
      .getBidsForAuction(a.id)
      .slice()
      .sort((x, y) => (x.placed_at < y.placed_at ? 1 : x.placed_at > y.placed_at ? -1 : 0));
    if (bids.length === 0) {
      rows.push([a.id, a.item_name, type, slots, a.status, a.end_time, '', '(no bids)', '', '', '', '', '', '', '']);
      continue;
    }
    for (const b of bids) {
      // Group winners are the bids still active at close; normal auctions have
      // the single recorded top bid.
      const isWinning =
        a.status === 'ended' &&
        (a.group_mode
          ? b.active === 1
          : a.winner_user_id === b.user_id && a.winning_amount_cents === b.amount_cents);
      // Which bidder (if any) this bid knocked out of a winning slot when placed.
      const displaced = b.displaced_bid_id != null ? db.getBid(b.displaced_bid_id) : null;
      rows.push([
        a.id,
        a.item_name,
        type,
        slots,
        a.status,
        a.end_time,
        b.user_id,
        b.username,
        formatCents(b.amount_cents),
        b.placed_at,
        new Date(b.placed_at).toUTCString(),
        isWinning ? 'yes' : 'no',
        displaced ? displaced.username : '',
        displaced ? formatCents(displaced.amount_cents) : '',
        b.auto ? 'yes' : 'no',
      ]);
    }
  }

  return {
    csv: buildCsv(EXPORT_HEADERS, rows),
    fileName: auctionId !== null ? `auction-${auctionId}-bids.csv` : 'all-auctions-bids.csv',
    auctionCount: auctions.length,
    rowCount: rows.length,
  };
}

module.exports = {
  ServiceError,
  assertModerator,
  createAuction,
  listActiveAuctions,
  getAuctionInfo,
  endAuction,
  cancelAuction,
  previewDeleteAuction,
  deleteAuction,
  previewCleanup,
  cleanupFinished,
  previewRemoveBid,
  removeBid,
  previewEditBid,
  editBid,
  exportBidsCsv,
};
