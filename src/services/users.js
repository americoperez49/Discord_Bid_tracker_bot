'use strict';

/**
 * Per-user views of a guild's auctions: a user's bids, the open auctions
 * they're in, and the auctions they've won.
 *
 * Takes the same ctx as services/auctions.js. Who may look:
 *  - a user may view their own data, including their hidden max bids;
 *  - a moderator may view anyone's, but never another user's max bid.
 */

const db = require('../db');
const { isModerator } = require('../util/permissions');
const { ServiceError, resolveGuild } = require('./auctions');

/**
 * Check the actor may view `userId`'s data in the guild.
 * @returns {Promise<{includeMax: boolean}>} whether max bids may be shown.
 */
async function authorizeView(ctx, userId) {
  if (typeof userId !== 'string' || !/^\d+$/.test(userId)) {
    throw new ServiceError('invalid_input', 'User ID must be a Discord user ID.');
  }
  const guild = await resolveGuild(ctx);
  if (userId === ctx.actorId) return { includeMax: true };

  const member = await guild.members.fetch({ user: ctx.actorId, force: true }).catch(() => null);
  if (!member || !isModerator(member)) {
    throw new ServiceError('forbidden', "Only moderators can view another user's auctions.");
  }
  return { includeMax: false };
}

/** Every bid the user has placed in the guild, newest first. */
async function getUserBids(ctx, userId) {
  await authorizeView(ctx, userId);
  return db.getUserBidsInGuild(ctx.guildId, userId);
}

/**
 * Open auctions the user has bid on, soonest-ending first, with where they
 * stand: 'leading' / 'in_slot' or 'outbid'. `maxCents` is the user's hidden max,
 * present only when they are viewing themselves.
 */
async function getUserActiveAuctions(ctx, userId) {
  const { includeMax } = await authorizeView(ctx, userId);

  return db.getUserActiveAuctionsInGuild(ctx.guildId, userId).map((auction) => {
    const entry = { auction, nextMinBidCents: db.nextMinBidCents(auction) };

    if (auction.group_mode) {
      const slotBid = db.getActiveBidForUser(auction.id, userId);
      entry.standing = slotBid ? 'in_slot' : 'outbid';
      entry.bidCents = slotBid ? slotBid.amount_cents : auction.user_high_cents;
      entry.filledSlots = db.getFilledSlots(auction);
    } else {
      const high = db.getHighestBid(auction.id);
      entry.standing = high?.user_id === userId ? 'leading' : 'outbid';
      entry.bidCents = auction.user_high_cents;
      entry.highBidCents = high ? high.amount_cents : null;
    }

    if (includeMax) entry.maxCents = db.getProxy(auction.id, userId)?.max_cents ?? null;
    return entry;
  });
}

/** Ended auctions the user won, most recent first, with the amount they won at. */
async function getUserWins(ctx, userId) {
  await authorizeView(ctx, userId);
  return db.getUserWinsInGuild(ctx.guildId, userId);
}

/**
 * The guilds (that the bot is in) where the user is a member, and whether they
 * moderate each — for a server picker. Fetches the member fresh in each guild.
 */
async function listGuildsForUser(client, userId) {
  const guilds = [];
  for (const guild of client.guilds.cache.values()) {
    const member = await guild.members.fetch({ user: userId, force: true }).catch(() => null);
    if (member) guilds.push({ guild, isModerator: isModerator(member) });
  }
  return guilds;
}

module.exports = { getUserBids, getUserActiveAuctions, getUserWins, listGuildsForUser };
