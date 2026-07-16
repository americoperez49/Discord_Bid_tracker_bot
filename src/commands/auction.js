'use strict';

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  MessageFlags,
  AttachmentBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
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
const { scheduleAuctionEnd, endAuction, cancelScheduled } = require('../scheduler');

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
      )
      .addIntegerOption((o) =>
        o
          .setName('quantity')
          .setDescription('How many identical copies to list as separate auctions (default 1, max 25)')
          .setMinValue(1)
          .setMaxValue(25),
      )
      .addBooleanOption((o) =>
        o
          .setName('group_bidding')
          .setDescription('One shared auction where the top N bids win (one bid per person). Set winners too.'),
      )
      .addIntegerOption((o) =>
        o
          .setName('winners')
          .setDescription('Group bidding only: number of winning slots / items (2–25)')
          .setMinValue(2)
          .setMaxValue(25),
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
      .setName('delete')
      .setDescription('Permanently delete an auction and its bids (moderator only).')
      .addIntegerOption((o) =>
        o.setName('item').setDescription('The auction').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cleanup')
      .setDescription('Delete all ended/cancelled auctions in this server (moderator only).'),
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
  if (sub === 'export' || sub === 'delete') {
    await respondWithAllAuctions(interaction);
  } else {
    await respondWithActiveAuctions(interaction);
  }
}

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  // Runtime moderator gate for privileged subcommands.
  const modOnly = ['create', 'end', 'cancel', 'export', 'delete', 'cleanup'];
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
    case 'delete':
      return handleDelete(interaction);
    case 'cleanup':
      return handleCleanup(interaction);
    case 'export':
      return handleExport(interaction);
    default:
      return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
  }
}

async function handleCreate(interaction) {
  const baseName = interaction.options.getString('item');
  const startingBidCents = parseDollarsToCents(interaction.options.getString('starting_bid'));
  const durationInput = interaction.options.getString('duration');
  const description = interaction.options.getString('description') ?? null;
  const incrementInput = interaction.options.getString('increment');
  const quantity = interaction.options.getInteger('quantity') ?? 1;
  const groupMode = interaction.options.getBoolean('group_bidding') ?? false;
  const winners = interaction.options.getInteger('winners');

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

  if (groupMode && (winners === null || winners < 2)) {
    return interaction.reply({
      content:
        '⚠️ For group bidding, set `winners` to the number of winning slots (2–25). ' +
        'Example: 4 identical cases → `group_bidding: True`, `winners: 4`.',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Posting several announcement messages can take longer than Discord's 3s
  // reply window, so acknowledge first and edit the reply when done.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const nowIso = new Date().toISOString();
  const endTime = endTimeFromDuration(durationInput);

  const base = {
    guild_id: interaction.guildId,
    channel_id: interaction.channelId,
    message_id: null,
    description,
    starting_bid_cents: startingBidCents,
    min_increment_cents: incrementCents,
    created_by: interaction.user.id,
    created_at: nowIso,
    end_time: endTime,
  };

  // Group bidding: one shared auction with N winner slots (quantity is ignored).
  if (groupMode) {
    const auction = db.createAuction({ ...base, item_name: baseName, group_mode: 1, winners });
    const message = await interaction.channel.send({ embeds: [buildAuctionEmbed(auction)] });
    db.setAuctionMessageId(auction.id, message.id);
    auction.message_id = message.id;
    scheduleAuctionEnd(auction);

    let content =
      `✅ Group auction **#${auction.id} — ${baseName}** created with **${winners} winner slots**. ` +
      `Starting bid ${formatCents(startingBidCents)}, ends ${discordRelativeTime(endTime)}.`;
    if (quantity > 1) content += `\n_(quantity is ignored in group mode — winners controls the slots.)_`;
    await interaction.editReply({ content });
    return;
  }

  // Normal mode: `quantity` independent auctions.
  const created = [];
  for (let i = 1; i <= quantity; i++) {
    // When listing multiple copies, make each one's name distinct.
    const itemName = quantity > 1 ? `${baseName} (${i} of ${quantity})` : baseName;

    const auction = db.createAuction({ ...base, item_name: itemName });

    // Post the public announcement, then remember its id so we can keep it updated.
    const message = await interaction.channel.send({ embeds: [buildAuctionEmbed(auction)] });
    db.setAuctionMessageId(auction.id, message.id);
    auction.message_id = message.id;

    scheduleAuctionEnd(auction);
    created.push(auction);
  }

  const idList = created.map((a) => `#${a.id}`).join(', ');
  const content =
    quantity > 1
      ? `✅ Created **${quantity}** auctions for **${baseName}** (${idList}). ` +
        `Starting bid ${formatCents(startingBidCents)} each, all end ${discordRelativeTime(endTime)}.`
      : `✅ Auction **${idList} — ${baseName}** created. ` +
        `Starting bid ${formatCents(startingBidCents)}, ends ${discordRelativeTime(endTime)}.`;

  await interaction.editReply({ content });
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

/**
 * Show a Confirm/Cancel button prompt (ephemeral) and wait for the invoker's
 * choice. Resolves to the button interaction if confirmed, or null if the user
 * cancelled or the 30s window elapsed (in which case the reply is already
 * updated). The caller finalises the message via `confirmation.update(...)`.
 */
async function confirmDestructive(interaction, promptContent, confirmLabel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm').setLabel(confirmLabel).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  const reply = await interaction.reply({
    content: promptContent,
    components: [row],
    flags: MessageFlags.Ephemeral,
    fetchReply: true,
  });

  let confirmation;
  try {
    confirmation = await reply.awaitMessageComponent({
      filter: (i) => i.user.id === interaction.user.id,
      time: 30_000,
    });
  } catch {
    await interaction.editReply({ content: '⏱️ Timed out — nothing was deleted.', components: [] });
    return null;
  }

  if (confirmation.customId !== 'confirm') {
    await confirmation.update({ content: '✋ Cancelled — nothing was deleted.', components: [] });
    return null;
  }

  return confirmation;
}

/** Best-effort removal of an auction's public announcement message. */
async function deleteAnnouncement(interaction, auction) {
  if (!auction.message_id) return;
  try {
    const channel =
      auction.channel_id === interaction.channelId
        ? interaction.channel
        : await interaction.client.channels.fetch(auction.channel_id).catch(() => null);
    if (!channel?.isTextBased()) return;
    const msg = await channel.messages.fetch(auction.message_id).catch(() => null);
    if (msg) await msg.delete();
  } catch {
    /* message may already be gone — ignore */
  }
}

async function handleDelete(interaction) {
  const auctionId = interaction.options.getInteger('item');
  const auction = db.getAuction(auctionId);
  if (!auction || auction.guild_id !== interaction.guildId) {
    return interaction.reply({
      content: `⚠️ Auction #${auctionId} not found in this server.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const bidCount = db.getBidCount(auctionId);
  let prompt =
    `🗑️ Delete auction **#${auction.id} — ${auction.item_name}** (${auction.status})?\n` +
    `This permanently removes it and its **${bidCount}** bid(s), and can't be undone.`;
  if (auction.status === 'active') {
    prompt += `\n⚠️ This auction is still **active** — bidders will lose it.`;
  }

  const confirmation = await confirmDestructive(interaction, prompt, 'Delete');
  if (!confirmation) return;

  cancelScheduled(auctionId);
  db.deleteAuction(auctionId);

  await confirmation.update({
    content: `🗑️ Deleted auction **#${auction.id} — ${auction.item_name}** and its ${bidCount} bid(s).`,
    components: [],
  });

  // Remove the public listing message after confirming (best-effort).
  deleteAnnouncement(interaction, auction).catch(() => {});
}

async function handleCleanup(interaction) {
  const finished = db.getFinishedAuctionsForGuild(interaction.guildId);
  if (finished.length === 0) {
    return interaction.reply({
      content: 'There are no ended or cancelled auctions to clean up.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const prompt =
    `🧹 Delete all **${finished.length}** ended/cancelled auction(s) in this server ` +
    `(and their bids)? This can't be undone. Active auctions are not affected.`;

  const confirmation = await confirmDestructive(interaction, prompt, `Delete ${finished.length}`);
  if (!confirmation) return;

  const removed = db.deleteFinishedAuctionsForGuild(interaction.guildId);

  await confirmation.update({
    content: `🧹 Deleted **${removed.length}** finished auction(s). Their old listing messages remain as a record.`,
    components: [],
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
  ];

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
      rows.push([a.id, a.item_name, type, slots, a.status, a.end_time, '', '(no bids)', '', '', '', '']);
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
