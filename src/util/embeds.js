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
 * @param {object} auction row from the auctions table
 * @returns {EmbedBuilder}
 */
function buildAuctionEmbed(auction) {
  const high = db.getHighestBid(auction.id);
  const bidCount = db.getBidCount(auction.id);

  const embed = new EmbedBuilder()
    .setColor(STATUS_COLORS[auction.status] ?? STATUS_COLORS.active)
    .setTitle(`🏷️ Auction #${auction.id}: ${auction.item_name}`)
    .setFooter({ text: `Auction ID: ${auction.id} • Bid with /bid` });

  if (auction.description) {
    embed.setDescription(auction.description);
  }

  embed.addFields(
    { name: 'Starting bid', value: formatCents(auction.starting_bid_cents), inline: true },
    { name: 'Min. increment', value: formatCents(auction.min_increment_cents), inline: true },
    { name: 'Bids', value: String(bidCount), inline: true },
  );

  if (auction.status === 'active') {
    embed.addFields(
      {
        name: 'Current high bid',
        value: high
          ? `${formatCents(high.amount_cents)} — <@${high.user_id}>`
          : '_No bids yet_',
        inline: false,
      },
      {
        name: 'Next minimum bid',
        value: formatCents(
          high ? high.amount_cents + auction.min_increment_cents : auction.starting_bid_cents,
        ),
        inline: true,
      },
      {
        name: 'Ends',
        value: `${discordFullTime(auction.end_time)} (${discordRelativeTime(auction.end_time)})`,
        inline: false,
      },
    );
  } else if (auction.status === 'ended') {
    embed.addFields({
      name: '🏁 Winner',
      value:
        auction.winner_user_id && auction.winning_amount_cents != null
          ? `<@${auction.winner_user_id}> with ${formatCents(auction.winning_amount_cents)}`
          : '_No bids were placed._',
      inline: false,
    });
    embed.setTitle(`🏁 [ENDED] Auction #${auction.id}: ${auction.item_name}`);
  } else if (auction.status === 'cancelled') {
    embed.addFields({ name: 'Status', value: '❌ Cancelled', inline: false });
    embed.setTitle(`❌ [CANCELLED] Auction #${auction.id}: ${auction.item_name}`);
  }

  return embed;
}

module.exports = { buildAuctionEmbed };
