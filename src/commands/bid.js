'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { parseDollarsToCents, formatCents } = require('../util/money');
const { discordRelativeTime } = require('../util/time');
const { buildAuctionEmbed, buildBidFeedEmbed } = require('../util/embeds');
const { respondWithActiveAuctions, respondWithBidAmounts } = require('../util/autocomplete');

const data = new SlashCommandBuilder()
  .setName('bid')
  .setDescription('Place a bid on an active auction.')
  .addIntegerOption((opt) =>
    opt
      .setName('item')
      .setDescription('The auction to bid on (required)')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('amount')
      .setDescription('Your bid in dollars, e.g. 50 or 49.99 — suggests the next minimum (required)')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('max_bid')
      .setDescription('Optional max — the bot auto-bids up to this for you if outbid (normal auctions) (optional)'),
  );

async function autocomplete(interaction) {
  // The command has two autocompleting options; respond based on which one the
  // user is currently editing.
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'amount') {
    await respondWithBidAmounts(interaction);
  } else {
    await respondWithActiveAuctions(interaction);
  }
}

// Leading blank line (zero-width space) that separates each feed card.
const FEED_SPACER = '​';

async function execute(interaction) {
  const auctionId = interaction.options.getInteger('item');
  const rawAmount = interaction.options.getString('amount');
  const rawMax = interaction.options.getString('max_bid');

  const amountCents = parseDollarsToCents(rawAmount);
  if (amountCents === null || amountCents <= 0) {
    return interaction.reply({
      content: `⚠️ "${rawAmount}" isn't a valid amount. Try something like \`50\` or \`49.99\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  let maxCents = null;
  if (rawMax) {
    maxCents = parseDollarsToCents(rawMax);
    if (maxCents === null || maxCents <= 0) {
      return interaction.reply({
        content: `⚠️ "${rawMax}" isn't a valid max bid. Try something like \`100\` or \`99.99\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    if (maxCents < amountCents) {
      return interaction.reply({
        content: `⚠️ Your max bid (${formatCents(maxCents)}) must be at least your bid (${formatCents(amountCents)}).`,
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // Record the bidder's friendly display name (server nickname → global display
  // name → account handle), not the raw account username.
  const displayName =
    interaction.member?.displayName ?? interaction.user.globalName ?? interaction.user.username;
  const bidder = { id: interaction.user.id, username: displayName };
  const result = db.placeBid(auctionId, bidder, amountCents, maxCents);

  if (!result.ok) {
    let content;
    switch (result.reason) {
      case 'not_found':
        content = `⚠️ Auction #${auctionId} doesn't exist.`;
        break;
      case 'not_active':
        content = `⚠️ Auction #${auctionId} is not active (status: ${result.status}).`;
        break;
      case 'expired':
        content = `⏰ Auction #${auctionId} has already ended (${discordRelativeTime(result.endTime)}).`;
        break;
      case 'already_bidding':
        content =
          `⚠️ You already have an active winning bid of **${formatCents(result.currentCents)}** ` +
          `on this group auction. You can only bid again if you get outbid.`;
        break;
      case 'already_leading':
        content =
          `⚠️ You're already the high bidder at **${formatCents(result.currentCents)}**. ` +
          `To raise your ceiling, set a higher \`max_bid\`.`;
        break;
      case 'too_low':
        content =
          `⚠️ Your bid of ${formatCents(amountCents)} is too low. ` +
          `The minimum bid is **${formatCents(result.requiredCents)}**.`;
        break;
      default:
        content = '⚠️ Could not place your bid.';
    }
    return interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  const auction = db.getAuction(auctionId);
  return auction.group_mode
    ? finishGroupBid(interaction, auction, bidder, maxCents, result)
    : finishProxyBid(interaction, auction, bidder, maxCents, result);
}

/** Handle the reply/feed for a group-auction bid (with proxy/max support). */
async function finishGroupBid(interaction, auction, bidder, maxCents, result) {
  const label = `#${auction.id} — ${auction.item_name}`;
  const { winnersCount: W, filled } = result;

  // Ephemeral confirmation.
  let confirm;
  if (result.selfRaise) {
    confirm =
      `✅ Max updated — you're still in a winning slot on **${label}** at ` +
      `**${formatCents(result.bidderAmountCents)}**. I'll auto-bid up to your max.`;
  } else if (result.bidderInSlot) {
    confirm = `✅ You're in a winning slot on **${label}** at **${formatCents(result.bidderAmountCents)}** (${filled}/${W} filled).`;
    if (maxCents && result.bidderAmountCents != null && maxCents > result.bidderAmountCents) {
      confirm += ` I'll auto-bid up to your max.`;
    }
  } else {
    const lowest = result.winners.length
      ? result.winners[result.winners.length - 1].amount_cents
      : null;
    confirm =
      `⚠️ You were outbid on **${label}** — you're not in a winning slot.` +
      (lowest != null
        ? ` The lowest winning bid is **${formatCents(lowest)}**. Bid higher (or raise your max) to get in.`
        : '');
  }
  await interaction.reply({ content: confirm, flags: MessageFlags.Ephemeral });

  await refreshAnnouncement(interaction, auction);

  // A raise of your own hidden max changes nothing publicly — no feed post.
  if (result.selfRaise) return;

  const outIds = result.newlyOut.map((o) => o.user_id);

  if (result.autoHappened) {
    // One quiet summary line; every intermediate step is already in the DB.
    const amounts = result.winners.map((w) => formatCents(w.amount_cents)).join(', ');
    let content = `${FEED_SPACER}🤖 Auto-bids resolved on **${label}** — winning bids: ${amounts} (${filled}/${W} filled).`;
    if (outIds.length) {
      content += `\n${outIds.map((id) => `<@${id}>`).join(' ')} — you've been outbid; bid again to reclaim a slot.`;
    }
    await interaction.channel?.send({ content, allowedMentions: { users: outIds } }).catch(() => {});
    return;
  }

  // No proxy war — a plain entry/displacement. Use the readable bid card.
  const outbid = result.newlyOut[0] ?? null;
  const embed = buildBidFeedEmbed(auction, bidder.username, result.bidderAmountCents, outbid);
  const content = outbid
    ? `${FEED_SPACER}\n⚠️ <@${outbid.user_id}> — you've been outbid, bid again to reclaim your spot!`
    : FEED_SPACER;
  await interaction.channel
    ?.send({
      content,
      embeds: [embed],
      allowedMentions: outbid ? { users: [outbid.user_id] } : { parse: [] },
    })
    .catch(() => {});
}

/** Handle the reply/feed for a normal (proxy/max) auction bid. */
async function finishProxyBid(interaction, auction, bidder, maxCents, result) {
  const label = `#${auction.id} — ${auction.item_name}`;
  const iLead = result.leaderId === bidder.id;

  // Ephemeral confirmation to the bidder.
  let confirm;
  if (result.selfRaise) {
    confirm =
      `✅ Max updated — you're still the high bidder on **${label}** at ` +
      `**${formatCents(result.priceCents)}**. I'll auto-bid up to your max.`;
  } else if (iLead) {
    confirm = `✅ You're the high bidder on **${label}** at **${formatCents(result.priceCents)}**.`;
    if (maxCents && maxCents > result.priceCents) confirm += ` I'll auto-bid up to your max.`;
  } else {
    confirm =
      `⚠️ You were outbid on **${label}** — the current high bid is ` +
      `**${formatCents(result.priceCents)}**. Bid higher to take the lead.`;
  }
  await interaction.reply({ content: confirm, flags: MessageFlags.Ephemeral });

  await refreshAnnouncement(interaction, auction);

  // A raise of your own hidden max changes nothing publicly — no feed post.
  if (result.selfRaise) return;

  // One feed card for the resulting standing; ping whoever was outbid (if any).
  const outbid = result.outbidUserId
    ? { user_id: result.outbidUserId, username: result.outbidUsername }
    : null;
  const embed = buildBidFeedEmbed(
    auction,
    result.bid.username,
    result.priceCents,
    outbid,
    Boolean(result.auto),
  );
  const content = outbid
    ? `${FEED_SPACER}\n⚠️ <@${outbid.user_id}> — you've been outbid, bid again to reclaim the lead!`
    : FEED_SPACER;
  await interaction.channel
    ?.send({
      content,
      embeds: [embed],
      allowedMentions: outbid ? { users: [outbid.user_id] } : { parse: [] },
    })
    .catch(() => {});
}

/** Edit the original announcement message so its high bid stays current. */
async function refreshAnnouncement(interaction, auction) {
  if (!auction.message_id) return;
  try {
    const channel =
      auction.channel_id === interaction.channelId
        ? interaction.channel
        : await interaction.client.channels.fetch(auction.channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;
    const msg = await channel.messages.fetch(auction.message_id).catch(() => null);
    if (msg) await msg.edit({ embeds: [buildAuctionEmbed(auction)] });
  } catch {
    /* non-fatal: the embed will still be correct on next view */
  }
}

module.exports = { data, execute, autocomplete };
