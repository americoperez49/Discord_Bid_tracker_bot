'use strict';

/**
 * Shape database rows into the API's JSON. Money is always integer cents and
 * times are ISO 8601 UTC strings. Hidden max bids are never included here;
 * the per-user routes add a user's own max explicitly.
 */

const db = require('../db');

function auctionJson(a) {
  return {
    id: a.id,
    guildId: a.guild_id,
    channelId: a.channel_id,
    messageId: a.message_id,
    itemName: a.item_name,
    description: a.description,
    status: a.status,
    groupMode: Boolean(a.group_mode),
    winners: a.winners,
    startingBidCents: a.starting_bid_cents,
    incrementCents: a.min_increment_cents,
    createdBy: a.created_by,
    createdAt: a.created_at,
    endTime: a.end_time,
    warnTime: a.warn_time,
    winnerUserId: a.winner_user_id,
    winningAmountCents: a.winning_amount_cents,
  };
}

function bidJson(b) {
  return {
    id: b.id,
    auctionId: b.auction_id,
    userId: b.user_id,
    username: b.username,
    amountCents: b.amount_cents,
    placedAt: b.placed_at,
    auto: Boolean(b.auto),
  };
}

/** An auction plus its current standing: high bid, next minimum, slots. */
function auctionWithStanding(a, highBid = db.getHighestBid(a.id)) {
  const json = {
    ...auctionJson(a),
    bidCount: db.getBidCount(a.id),
    highBid: highBid ? bidJson(highBid) : null,
  };
  if (a.status === 'active') json.nextMinBidCents = db.nextMinBidCents(a);
  if (a.group_mode) {
    // The bids holding winning slots (at close, these are the winners).
    const winning = db.getActiveBids(a.id);
    json.filledSlots = winning.length;
    json.winningBids = winning.map(bidJson);
  }
  return json;
}

module.exports = { auctionJson, bidJson, auctionWithStanding };
