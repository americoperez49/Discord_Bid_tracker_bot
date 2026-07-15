'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
  EmbedBuilder,
} = require('discord.js');

const db = require('../db');
const { parseDollarsToCents, formatCents } = require('../util/money');
const {
  endTimeFromDuration,
  parseDurationMs,
  discordRelativeTime,
} = require('../util/time');
const { buildAuctionEmbed } = require('../util/embeds');
const { buildCsv } = require('../util/csv');
const { isModerator } = require('../util/permissions');
const { respondWithActiveAuctions, respondWithAllAuctions } = require('../util/autocomplete');
const { scheduleAuctionEnd, endAuction } = require('../scheduler');

const DEFAULT_INCREMENT_CENTS = 500; // $5

const data = new SlashCommandBuilder()
  .setName('auction')
  .setDescription('Create and manage item auctions.')
  // Visible-by-default gate; enforced again at runtime for mod-only subcommands.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('List a new item for auction (moderator only).')
      .addStringOption((o) =>
        o.setName('item').setDescription('Name of the item').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('starting_bid')
          .setDescription('Starting bid in dollars, e.g. 25 or 25.00')
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('duration')
          .setDescription('How long bidding stays open, e.g. 2d12h, 48h, 90m')
          .setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('description').setDescription('Optional description of the item'),
      )
      .addStringOption((o) =>
        o
          .setName('increment')
          .setDescription('Minimum raise over the current bid (default $5)'),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show all active auctions in this server.'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Show details and recent bids for an auction.')
      .addIntegerOption((o) =>
        o.setName('item').setDescription('The auction').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('End an auction early (moderator only).')
      .addIntegerOption((o) =>
        o.setName('item').setDescription('The auction').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel an auction with no winner (moderator only).')
      .addIntegerOption((o) =>
        o.setName('item').setDescription('The auction').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('export')
      .setDescription('Download the bid list as a CSV (moderator only).')
      .addIntegerOption((o) =>
        o
          .setName('item')
          .setDescription('The auction (leave empty to export all auctions in this server)')
          .setAutocomplete(true),
      ),
  );

async function autocomplete(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'export') {
    await respondWithAllAuctions(interaction);
  } else {
    await respondWithActiveAuctions(interaction);
  }
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  // Runtime moderator gate for privileged subcommands.
  const modOnly = ['create', 'end', 'cancel', 'export'];
  if (modOnly.includes(sub) && !isModerator(interaction.member)) {
    return interaction.reply({
      content: '🚫 You need the moderator role (or "Manage Server") to use this command.',
      flags: MessageFlags.Ephemeral,
    });
  }

  switch (sub) {
    case 'create':
      return handleCreate(interaction);
    case 'list':
      return handleList(interaction);
    case 'info':
      return handleInfo(interaction);
    case 'end':
      return handleEnd(interaction);
    case 'cancel':
      return handleCancel(interaction);
    case 'export':
      return handleExport(interaction);
    default:
      return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
  }
}

async function handleCreate(interaction) {
  const itemName = interaction.options.getString('item');
  const startingBidCents = parseDollarsToCents(interaction.options.getString('starting_bid'));
  const durationInput = interaction.options.getString('duration');
  const description = interaction.options.getString('description') ?? null;
  const incrementInput = interaction.options.getString('increment');

  if (startingBidCents === null || startingBidCents <= 0) {
    return interaction.reply({
      content: '⚠️ Starting bid must be a positive dollar amount, e.g. `25` or `25.00`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (parseDurationMs(durationInput) === null) {
    return interaction.reply({
      content: '⚠️ Duration is invalid. Use forms like `2d12h`, `48h`, `90m`, or `1w`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  let incrementCents = DEFAULT_INCREMENT_CENTS;
  if (incrementInput) {
    const parsed = parseDollarsToCents(incrementInput);
    if (parsed === null || parsed <= 0) {
      return interaction.reply({
        content: '⚠️ Increment must be a positive dollar amount.',
        flags: MessageFlags.Ephemeral,
      });
    }
    incrementCents = parsed;
  }

  const nowIso = new Date().toISOString();
  const endTime = endTimeFromDuration(durationInput);

  const auction = db.createAuction({
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    message_id: null,
    item_name: itemName,
    description,
    starting_bid_cents: startingBidCents,
    min_increment_cents: incrementCents,
    created_by: interaction.user.id,
    created_at: nowIso,
    end_time: endTime,
  });

  // Post the public announcement, then remember its id so we can keep it updated.
  const message = await interaction.channel.send({ embeds: [buildAuctionEmbed(auction)] });
  db.setAuctionMessageId(auction.id, message.id);
  auction.message_id = message.id;

  scheduleAuctionEnd(auction);

  await interaction.reply({
    content:
      `✅ Auction **#${auction.id} — ${itemName}** created. ` +
      `Starting bid ${formatCents(startingBidCents)}, ends ${discordRelativeTime(endTime)}.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleList(interaction) {
  const auctions = db.getActiveAuctionsForGuild(interaction.guildId);
  if (auctions.length === 0) {
    return interaction.reply({
      content: 'There are no active auctions right now.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🏷️ Active auctions (${auctions.length})`);

  for (const a of auctions.slice(0, 25)) {
    const high = db.getHighestBid(a.id);
    const highText = high
      ? `${formatCents(high.amount_cents)} (<@${high.user_id}>)`
      : `no bids — starts at ${formatCents(a.starting_bid_cents)}`;
    embed.addFields({
      name: `#${a.id} — ${a.item_name}`,
      value: `High: ${highText}\nEnds: ${discordRelativeTime(a.end_time)}`,
    });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleInfo(interaction) {
  const auctionId = interaction.options.getInteger('item');
  const auction = db.getAuction(auctionId);
  if (!auction || auction.guild_id !== interaction.guildId) {
    return interaction.reply({
      content: `⚠️ Auction #${auctionId} not found in this server.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = buildAuctionEmbed(auction);
  const recent = db.getRecentBids(auctionId, 10);
  if (recent.length > 0) {
    embed.addFields({
      name: `Recent bids (${db.getBidCount(auctionId)} total)`,
      value: recent
        .map((b) => `• <@${b.user_id}> — ${formatCents(b.amount_cents)} (${discordRelativeTime(b.placed_at)})`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleEnd(interaction) {
  const auctionId = interaction.options.getInteger('item');
  const auction = db.getAuction(auctionId);
  if (!auction || auction.guild_id !== interaction.guildId) {
    return interaction.reply({
      content: `⚠️ Auction #${auctionId} not found in this server.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (auction.status !== 'active') {
    return interaction.reply({
      content: `⚠️ Auction #${auctionId} is already ${auction.status}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await endAuction(auctionId, 'ended');
  return interaction.reply({
    content: `🏁 Auction #${auctionId} ended. The result has been announced.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleCancel(interaction) {
  const auctionId = interaction.options.getInteger('item');
  const auction = db.getAuction(auctionId);
  if (!auction || auction.guild_id !== interaction.guildId) {
    return interaction.reply({
      content: `⚠️ Auction #${auctionId} not found in this server.`,
      flags: MessageFlags.Ephemeral,
    });
  }
  if (auction.status !== 'active') {
    return interaction.reply({
      content: `⚠️ Auction #${auctionId} is already ${auction.status}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await endAuction(auctionId, 'cancelled');
  return interaction.reply({
    content: `❌ Auction #${auctionId} cancelled.`,
    flags: MessageFlags.Ephemeral,
  });
}

async function handleExport(interaction) {
  const auctionId = interaction.options.getInteger('item');

  let auctions;
  if (auctionId !== null) {
    const a = db.getAuction(auctionId);
    if (!a || a.guild_id !== interaction.guildId) {
      return interaction.reply({
        content: `⚠️ Auction #${auctionId} not found in this server.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    auctions = [a];
  } else {
    auctions = db.getAllAuctionsForGuild(interaction.guildId);
    if (auctions.length === 0) {
      return interaction.reply({
        content: 'There are no auctions to export in this server.',
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  const headers = [
    'auction_id',
    'item_name',
    'auction_status',
    'auction_end_time_utc',
    'bidder_user_id',
    'bidder_username',
    'bid_amount',
    'bid_placed_at_utc',
    'bid_placed_at_readable',
    'is_winning_bid',
  ];

  const rows = [];
  for (const a of auctions) {
    const bids = db.getBidsForAuction(a.id);
    if (bids.length === 0) {
      rows.push([a.id, a.item_name, a.status, a.end_time, '', '(no bids)', '', '', '', '']);
      continue;
    }
    for (const b of bids) {
      const isWinning =
        a.status === 'ended' &&
        a.winner_user_id === b.user_id &&
        a.winning_amount_cents === b.amount_cents;
      rows.push([
        a.id,
        a.item_name,
        a.status,
        a.end_time,
        b.user_id,
        b.username,
        formatCents(b.amount_cents),
        b.placed_at,
        new Date(b.placed_at).toUTCString(),
        isWinning ? 'yes' : 'no',
      ]);
    }
  }

  const csv = buildCsv(headers, rows);
  const fileName =
    auctionId !== null ? `auction-${auctionId}-bids.csv` : `all-auctions-bids.csv`;
  const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: fileName });

  return interaction.reply({
    content: `📄 Export ready (${rows.length} row(s)).`,
    files: [attachment],
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { data, execute, autocomplete };
