'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db');
const { parseDollarsToCents, formatCents } = require('../util/money');
const { discordRelativeTime } = require('../util/time');
const { buildAuctionEmbed } = require('../util/embeds');
const { respondWithActiveAuctions } = require('../util/autocomplete');

const data = new SlashCommandBuilder()
  .setName('bid')
  .setDescription('Place a bid on an active auction.')
  .addIntegerOption((opt) =>
    opt
      .setName('item')
      .setDescription('The auction to bid on')
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((opt) =>
    opt
      .setName('amount')
      .setDescription('Your bid in dollars, e.g. 50 or 49.99')
      .setRequired(true),
  );

async function autocomplete(interaction) {
  await respondWithActiveAuctions(interaction);
}

async function execute(interaction) {
  const auctionId = interaction.options.getInteger('item');
  const rawAmount = interaction.options.getString('amount');

  const amountCents = parseDollarsToCents(rawAmount);
  if (amountCents === null || amountCents <= 0) {
    return interaction.reply({
      content: `⚠️ "${rawAmount}" isn't a valid amount. Try something like \`50\` or \`49.99\`.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const bidder = { id: interaction.user.id, username: interaction.user.username };
  const result = db.placeBid(auctionId, bidder, amountCents);

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
  const label = `#${auction.id} — ${auction.item_name}`;
  const nextMin = db.nextMinBidCents(auction);

  // Confirm to the bidder (ephemeral).
  const confirm = auction.group_mode
    ? `✅ Bid of **${formatCents(amountCents)}** placed on group auction **${label}**. ` +
      `You're currently in a winning slot (${db.getFilledSlots(auction)}/${auction.winners} filled). ` +
      `Next minimum bid is **${formatCents(nextMin)}**.`
    : `✅ Bid of **${formatCents(amountCents)}** placed on **${label}**. You're the current high bidder!`;
  await interaction.reply({ content: confirm, flags: MessageFlags.Ephemeral });

  // Refresh the public announcement embed.
  await refreshAnnouncement(interaction, auction);

  // Public note about the new bid.
  await interaction.channel
    ?.send({
      content: `📈 <@${bidder.id}> bid **${formatCents(amountCents)}** on **${label}**.`,
      allowedMentions: { parse: [] },
    })
    .catch(() => {});

  // In group mode, ping anyone who was displaced so they know to re-bid.
  if (auction.group_mode && result.kicked) {
    await interaction.channel
      ?.send({
        content:
          `⚠️ <@${result.kicked.user_id}>, you were outbid on **${label}** and lost your slot. ` +
          `Bid again (min **${formatCents(nextMin)}**) to reclaim one before it ends!`,
        allowedMentions: { users: [result.kicked.user_id] },
      })
      .catch(() => {});
  }
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
