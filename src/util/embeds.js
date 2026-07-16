'use strict';

const { EmbedBuilder } = require('discord.js');
const { formatCents } = require('./money');
const { discordFullTime, discordRelativeTime } = require('./time');
const db = require('../db');

const STATUS_COLORS = {
  active: 0x2ecc71, // green
  ended: 0x95a5a6, // grey
  cancelled: 0xe74c3c, // red
};

/**
 * Build the announcement embed for an auction, reflecting its current state.
 * Handles both normal single-winner auctions and group multi-winner auctions.
 * @param {object} auction row from the auctions table
 * @returns {EmbedBuilder}
 */
function buildAuctionEmbed(auction) {
  return auction.group_mode ? buildGroupEmbed(auction) : buildNormalEmbed(auction);
}

/** Format a list of winning bids as "1. @user — $110" lines (capped length). */
function formatWinningBids(bids) {
  if (bids.length === 0) return '_No bids yet_';
  return bids
    .map((b, i) => `**${i + 1}.** <@${b.user_id}> — ${formatCents(b.amount_cents)}`)
    .join('\n')
    .slice(0, 1024);
}

function buildNormalEmbed(auction) {
  const high = db.getHighestBid(auction.id);
  const bidCount = db.getBidCount(auction.id);

  const embed = new EmbedBuilder()
    .setColor(STATUS_COLORS[auction.status] ?? STATUS_COLORS.active)
    .setTitle(`🏷️ Auction #${auction.id}: ${auction.item_name}`)
    .setFooter({ text: `Auction ID: ${auction.id} • Bid with /bid` });

  if (auction.description) embed.setDescription(auction.description);

  embed.addFields(
    { name: 'Starting bid', value: formatCents(auction.starting_bid_cents), inline: true },
    { name: 'Min. increment', value: formatCents(auction.min_increment_cents), inline: true },
    { name: 'Bids', value: String(bidCount), inline: true },
  );

  if (auction.status === 'active') {
    embed.addFields(
      {
        name: 'Current high bid',
        value: high ? `${formatCents(high.amount_cents)} — <@${high.user_id}>` : '_No bids yet_',
        inline: false,
      },
      { name: 'Next minimum bid', value: formatCents(db.nextMinBidCents(auction)), inline: true },
      {
        name: 'Ends',
        value: `${discordFullTime(auction.end_time)} (${discordRelativeTime(auction.end_time)})`,
        inline: false,
      },
    );
  } else if (auction.status === 'ended') {
    embed.setTitle(`🏁 [ENDED] Auction #${auction.id}: ${auction.item_name}`);
    embed.addFields({
      name: '🏁 Winner',
      value:
        auction.winner_user_id && auction.winning_amount_cents != null
          ? `<@${auction.winner_user_id}> with ${formatCents(auction.winning_amount_cents)}`
          : '_No bids were placed._',
      inline: false,
    });
  } else if (auction.status === 'cancelled') {
    embed.setTitle(`❌ [CANCELLED] Auction #${auction.id}: ${auction.item_name}`);
    embed.addFields({ name: 'Status', value: '❌ Cancelled', inline: false });
  }

  return embed;
}

function buildGroupEmbed(auction) {
  const winning = db.getActiveBids(auction.id); // highest first
  const filled = winning.length;
  const W = auction.winners;

  const embed = new EmbedBuilder()
    .setColor(STATUS_COLORS[auction.status] ?? STATUS_COLORS.active)
    .setTitle(`🎁 Group Auction #${auction.id}: ${auction.item_name} (${W} winners)`)
    .setFooter({ text: `Auction ID: ${auction.id} • Bid with /bid • One bid per person` });

  if (auction.description) embed.setDescription(auction.description);

  embed.addFields(
    { name: 'Starting bid', value: formatCents(auction.starting_bid_cents), inline: true },
    { name: 'Min. increment', value: formatCents(auction.min_increment_cents), inline: true },
    { name: 'Winner slots', value: `${filled}/${W} filled`, inline: true },
  );

  if (auction.status === 'active') {
    embed.addFields(
      { name: `Current winning bids (top ${W})`, value: formatWinningBids(winning), inline: false },
      { name: 'Next minimum bid', value: formatCents(db.nextMinBidCents(auction)), inline: true },
      {
        name: 'Ends',
        value: `${discordFullTime(auction.end_time)} (${discordRelativeTime(auction.end_time)})`,
        inline: false,
      },
    );
  } else if (auction.status === 'ended') {
    embed.setTitle(`🏁 [ENDED] Group Auction #${auction.id}: ${auction.item_name}`);
    embed.addFields({
      name: `🏆 Winners (${filled})`,
      value: formatWinningBids(winning),
      inline: false,
    });
  } else if (auction.status === 'cancelled') {
    embed.setTitle(`❌ [CANCELLED] Group Auction #${auction.id}: ${auction.item_name}`);
    embed.addFields({ name: 'Status', value: '❌ Cancelled', inline: false });
  }

  return embed;
}

module.exports = { buildAuctionEmbed };
