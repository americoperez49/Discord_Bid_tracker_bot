'use strict';

const db = require('../db');
const { formatCents } = require('./money');

// Discord limits an autocomplete choice's display name to 100 characters.
const MAX_CHOICE_NAME = 100;

/**
 * Respond to an autocomplete interaction on the "item" option with the guild's
 * active auctions, filtered by the user's partial input. Each choice shows the
 * current bid so users can pick without running /auction list first.
 *
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
async function respondWithActiveAuctions(interaction) {
  await respond(interaction, interaction.guildId ? db.getActiveAuctionsForGuild(interaction.guildId) : []);
}

/**
 * Like {@link respondWithActiveAuctions} but includes auctions of any status
 * (used by /auction export, which can target ended auctions too).
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
async function respondWithAllAuctions(interaction) {
  await respond(interaction, interaction.guildId ? db.getAllAuctionsForGuild(interaction.guildId) : []);
}

/**
 * Build the display label for one auction choice, e.g.
 *   "#12 — Signed Poster (1 of 3) — Current Bid $300.00 (Sam)"
 *   "#13 — Signed Poster (2 of 3) — Starting Bid $25.00"   (no bids yet)
 *   "#5 — Old Item [ended] — Current Bid $40.00 (Sam)"
 * The item name is truncated if needed so the whole label fits in 100 chars.
 */
function buildChoiceName(auction) {
  let bidText;
  if (auction.group_mode) {
    // e.g. "Min Bid $110 (4/4 winners)"
    bidText = `Min Bid ${formatCents(db.nextMinBidCents(auction))} (${db.getFilledSlots(auction)}/${auction.winners} winners)`;
  } else {
    const high = db.getHighestBid(auction.id);
    // Show who currently holds the high bid (username capped so it doesn't
    // crowd out the item name in the 100-char label).
    bidText = high
      ? `Current Bid ${formatCents(high.amount_cents)} (${high.username.slice(0, 20)})`
      : `Starting Bid ${formatCents(auction.starting_bid_cents)}`;
  }

  const prefix = `#${auction.id} — `;
  const statusTag = auction.status !== 'active' ? ` [${auction.status}]` : '';
  const suffix = ` — ${bidText}`;

  const room = MAX_CHOICE_NAME - prefix.length - statusTag.length - suffix.length;
  let name = auction.item_name;
  if (name.length > room) {
    name = room > 1 ? name.slice(0, room - 1) + '…' : name.slice(0, Math.max(0, room));
  }

  return (prefix + name + statusTag + suffix).slice(0, MAX_CHOICE_NAME);
}

async function respond(interaction, auctions) {
  const focused = interaction.options.getFocused()?.toString().toLowerCase() ?? '';

  const choices = auctions
    .filter((a) => {
      if (focused === '') return true;
      return `#${a.id} ${a.item_name}`.toLowerCase().includes(focused);
    })
    .slice(0, 25)
    .map((a) => ({ name: buildChoiceName(a), value: a.id }));

  await interaction.respond(choices);
}

/** A parseable dollar string for a cents amount ("305", "305.50"). */
function centsToInputValue(cents) {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/**
 * Suggest a single bid amount for the `amount` option, one tap to fill:
 *  - If the user is already the current high bidder (or a current winner in a
 *    group auction), suggest their *current bid* — so they can keep it and just
 *    raise their `max_bid` rather than out-bid themselves.
 *  - Otherwise, suggest the next minimum bid.
 * Reads the already-selected `item`; offers nothing if none is chosen yet.
 *
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
async function respondWithBidAmounts(interaction) {
  const auctionId = interaction.options.getInteger('item');
  const auction = auctionId != null ? db.getAuction(auctionId) : null;

  if (!auction || auction.status !== 'active' || auction.guild_id !== interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  const userId = interaction.user.id;
  let myCurrentCents = null;
  if (auction.group_mode) {
    const mine = db.getActiveBids(auctionId).find((b) => b.user_id === userId);
    if (mine) myCurrentCents = mine.amount_cents;
  } else {
    const high = db.getHighestBid(auctionId);
    if (high && high.user_id === userId) myCurrentCents = high.amount_cents;
  }

  if (myCurrentCents != null) {
    await interaction.respond([
      { name: `${formatCents(myCurrentCents)} — your current bid`, value: centsToInputValue(myCurrentCents) },
    ]);
    return;
  }

  const minCents = db.nextMinBidCents(auction);
  await interaction.respond([
    { name: `${formatCents(minCents)} — next minimum bid`, value: centsToInputValue(minCents) },
  ]);
}

/**
 * Suggest bidders for the moderator remove/edit commands: one entry per bidder
 * on the already-selected `item` auction, shown as "Name — $amount". The choice
 * value is that bidder's most-recent bid id, so the command targets an exact bid.
 *
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
async function respondWithBidders(interaction) {
  const auctionId = interaction.options.getInteger('item');
  const auction = auctionId != null ? db.getAuction(auctionId) : null;
  if (!auction || auction.guild_id !== interaction.guildId) {
    await interaction.respond([]);
    return;
  }

  // For removebid on a group auction, show whether removing each bid would
  // reinstate a previously-displaced bidder.
  const showReinstate =
    interaction.options.getSubcommand(false) === 'removebid' && auction.group_mode;

  const focused = interaction.options.getFocused()?.toString().toLowerCase() ?? '';
  const choices = db
    .getLatestBidsPerUser(auctionId)
    .filter((b) => focused === '' || b.username.toLowerCase().includes(focused))
    .slice(0, 25)
    .map((b) => {
      let name = `${b.username} — ${formatCents(b.amount_cents)}`;
      if (showReinstate) {
        const r = db.reinstatementFor(b.id);
        name += r ? ` · reinstates ${r.username}` : ' · reinstates no one';
      }
      return { name: name.slice(0, 100), value: b.id };
    });

  await interaction.respond(choices);
}

module.exports = {
  respondWithActiveAuctions,
  respondWithAllAuctions,
  respondWithBidAmounts,
  respondWithBidders,
};
