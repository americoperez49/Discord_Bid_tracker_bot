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

/**
 * A compact card for a single accepted bid, for the live channel feed. Names are
 * shown as display-name text (not mentions) so they always render and don't ping.
 * The caller pings the outbid user via the message content, not this embed.
 *
 * @param {object} auction        the auction row (post-bid state)
 * @param {string} bidderName     display name of the bidder
 * @param {number} amountCents    the accepted bid amount
 * @param {{username: string}|null} outbid  the displaced/previous leader bid row, if any
 * @returns {EmbedBuilder}
 */
function buildBidFeedEmbed(auction, bidderName, amountCents, outbid) {
  const embed = new EmbedBuilder()
    .setColor(STATUS_COLORS.active)
    .setTitle(`📈 New bid · #${auction.id} — ${auction.item_name}`.slice(0, 256))
    .setDescription(`**${bidderName}** bid **${formatCents(amountCents)}**`);

  if (auction.group_mode) {
    embed.addFields({
      name: 'Winning slots',
      value: `${db.getFilledSlots(auction)}/${auction.winners} filled`,
      inline: true,
    });
  }

  embed.addFields(
    { name: 'Next minimum bid', value: formatCents(db.nextMinBidCents(auction)), inline: true },
    { name: 'Ends', value: discordRelativeTime(auction.end_time), inline: true },
  );

  if (outbid) {
    embed.addFields({
      name: auction.group_mode ? 'Lost a slot' : 'Outbid',
      value: outbid.username,
      inline: false,
    });
  }

  return embed;
}

/**
 * A card announcing an auction's outcome (ended or cancelled), for the channel.
 * Winner/bidder names are shown as text; the caller pings the winner(s) via the
 * message content.
 *
 * @param {object} auction   the finalised auction row
 * @param {object[]} winners winning bid rows (0..N), highest first
 * @param {'ended'|'cancelled'} status
 * @returns {EmbedBuilder}
 */
function buildOutcomeEmbed(auction, winners, status) {
  const label = `#${auction.id} — ${auction.item_name}`;
  const embed = new EmbedBuilder().setColor(STATUS_COLORS[status] ?? STATUS_COLORS.ended);

  if (status === 'cancelled') {
    embed.setTitle(`❌ Auction ${label} was cancelled`.slice(0, 256));
  } else {
    embed.setTitle(`🏁 Auction ${label} has ended`.slice(0, 256));
    if (winners.length === 0) {
      embed.setDescription('No bids were placed.');
    } else if (auction.group_mode) {
      embed.addFields({
        name: `🏆 Winners (${winners.length})`,
        value: winners
          .map((w, i) => `**${i + 1}.** ${w.username} — ${formatCents(w.amount_cents)}`)
          .join('\n')
          .slice(0, 1024),
      });
    } else {
      embed.addFields({
        name: '🏆 Winner',
        value: `**${winners[0].username}** — ${formatCents(winners[0].amount_cents)}`,
      });
    }
  }

  return embed;
}

module.exports = { buildAuctionEmbed, buildBidFeedEmbed, buildOutcomeEmbed };
