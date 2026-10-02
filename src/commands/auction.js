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

const { parseDollarsToCents, formatCents } = require('../util/money');
const { parseDurationMs, discordRelativeTime } = require('../util/time');
const { buildAuctionEmbed } = require('../util/embeds');
const {
  respondWithActiveAuctions,
  respondWithAllAuctions,
  respondWithBidders,
} = require('../util/autocomplete');
const auctions = require('../services/auctions');

const { ServiceError } = auctions;

const data = new SlashCommandBuilder()
  .setName('auction')
  .setDescription('Create and manage item auctions.')
  // Visible-by-default gate; the services layer enforces it again at runtime.
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName('cancel')
      .setDescription('Cancel an auction with no winner (moderator only).')
      .addIntegerOption((o) =>
        o.setName('item').setDescription('The auction (required)').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('cleanup')
      .setDescription('Delete all ended/cancelled auctions in this server (moderator only).'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('create')
      .setDescription('List a new item for auction (moderator only).')
      .addStringOption((o) =>
        o.setName('item').setDescription('Name of the item (required)').setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('starting_bid')
          .setDescription('Starting bid in dollars, e.g. 25 or 25.00 (required)')
          .setRequired(true),
      )
      .addStringOption((o) =>
        o
          .setName('duration')
          .setDescription('How long bidding stays open, e.g. 2d12h, 48h, 90m (required)')
          .setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('description').setDescription('Description of the item (optional)'),
      )
      .addStringOption((o) =>
        o
          .setName('increment')
          .setDescription('Minimum raise over the current bid, default $5 (optional)'),
      )
      .addIntegerOption((o) =>
        o
          .setName('quantity')
          .setDescription('Number of identical copies as separate auctions, default 1, max 25 (optional)')
          .setMinValue(1)
          .setMaxValue(25),
      )
      .addBooleanOption((o) =>
        o
          .setName('group_bidding')
          .setDescription('One shared auction where the top N bids win; set winners too (optional)'),
      )
      .addIntegerOption((o) =>
        o
          .setName('winners')
          .setDescription('Group bidding only: number of winning slots / items, 2–25 (optional)')
          .setMinValue(2)
          .setMaxValue(25),
      )
      .addStringOption((o) =>
        o
          .setName('warn_before')
          .setDescription('Post an ending-soon reminder this long before the end, e.g. 1h, 30m (default 1h) (optional)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('Permanently delete an auction and its bids (moderator only).')
      .addIntegerOption((o) =>
        o.setName('item').setDescription('The auction (required)').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('editbid')
      .setDescription('Correct the amount of a bidder\'s bid (moderator only).')
      .addIntegerOption((o) =>
        o
          .setName('item')
          .setDescription('The auction (required)')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addIntegerOption((o) =>
        o
          .setName('bidder')
          .setDescription('The bidder whose bid to edit (required)')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addStringOption((o) =>
        o
          .setName('amount')
          .setDescription('The corrected bid in dollars, e.g. 300 or 299.99 (required)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('end')
      .setDescription('End an auction early (moderator only).')
      .addIntegerOption((o) =>
        o.setName('item').setDescription('The auction (required)').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('export')
      .setDescription('Download the bid list as a CSV (moderator only).')
      .addIntegerOption((o) =>
        o
          .setName('item')
          .setDescription('The auction; leave empty to export all auctions in this server (optional)')
          .setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('Show details and recent bids for an auction.')
      .addIntegerOption((o) =>
        o.setName('item').setDescription('The auction (required)').setRequired(true).setAutocomplete(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Show all active auctions in this server.'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('removebid')
      .setDescription('Remove a specific bidder\'s bid from an auction (moderator only).')
      .addIntegerOption((o) =>
        o
          .setName('item')
          .setDescription('The auction (required)')
          .setRequired(true)
          .setAutocomplete(true),
      )
      .addIntegerOption((o) =>
        o
          .setName('bidder')
          .setDescription('The bidder whose bid to remove (required)')
          .setRequired(true)
          .setAutocomplete(true),
      ),
  );

async function autocomplete(interaction) {
  const sub = interaction.options.getSubcommand();
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'bidder') {
    await respondWithBidders(interaction);
  } else if (sub === 'export' || sub === 'delete') {
    await respondWithAllAuctions(interaction);
  } else {
    await respondWithActiveAuctions(interaction);
  }
}

/**
 * The service context for a slash-command interaction. The services check
 * moderator status themselves; passing the interaction's member just saves
 * them a fetch.
 */
function contextFor(interaction) {
  return {
    client: interaction.client,
    guildId: interaction.guildId,
    actorId: interaction.user.id,
    member: interaction.member,
  };
}

/** Ephemeral reply text for a ServiceError. */
function errorText(err) {
  const icon = err.code === 'not_moderator' ? '🚫' : '⚠️';
  const hint = err.code === 'bid_not_found' ? ' Pick the bidder from the list.' : '';
  return `${icon} ${err.message}${hint}`;
}

/**
 * Show a ServiceError on `target` (the command or a confirm-button interaction).
 * Anything else is rethrown for index.js's generic handler.
 */
async function replyError(target, err) {
  if (!(err instanceof ServiceError)) throw err;
  const content = errorText(err);
  if (target.deferred || target.replied) {
    await target.editReply({ content, components: [] });
  } else {
    await target.reply({ content, flags: MessageFlags.Ephemeral });
  }
}

const HANDLERS = {
  create: handleCreate,
  list: handleList,
  info: handleInfo,
  end: handleEnd,
  cancel: handleCancel,
  delete: handleDelete,
  removebid: handleRemoveBid,
  editbid: handleEditBid,
  cleanup: handleCleanup,
  export: handleExport,
};

async function execute(interaction) {
  const handler = HANDLERS[interaction.options.getSubcommand()];
  if (!handler) {
    return interaction.reply({ content: 'Unknown subcommand.', flags: MessageFlags.Ephemeral });
  }
  try {
    await handler(interaction, contextFor(interaction));
  } catch (err) {
    await replyError(interaction, err);
  }
}

/** Trailing note appended to the create confirmation when pinning failed. */
function pinFailureNote(pinned) {
  return pinned
    ? ''
    : ` ⚠️ I couldn't pin the listing — grant me **Manage Messages** ` +
        `(and check the channel isn't at Discord's 50-pin limit).`;
}

async function handleCreate(interaction, ctx) {
  const opt = interaction.options;
  // Absent optional options stay undefined (service default); unparseable ones
  // become null, which the service rejects with a helpful message.
  const optional = (value, parse) => (value === null ? undefined : parse(value));
  const input = {
    channelId: interaction.channelId,
    itemName: opt.getString('item'),
    description: opt.getString('description') ?? null,
    startingBidCents: parseDollarsToCents(opt.getString('starting_bid')),
    durationMs: parseDurationMs(opt.getString('duration')),
    incrementCents: optional(opt.getString('increment'), parseDollarsToCents),
    quantity: opt.getInteger('quantity') ?? undefined,
    groupMode: opt.getBoolean('group_bidding') ?? undefined,
    winners: opt.getInteger('winners'),
    warnBeforeMs: optional(opt.getString('warn_before'), parseDurationMs),
  };

  // Posting several announcement messages can take longer than Discord's 3s
  // reply window, so acknowledge first and edit the reply when done.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const result = await auctions.createAuction(ctx, input);
  const { auctions: created, endTime, warnTime } = result;
  const startingBid = formatCents(input.startingBidCents);
  const warnNote = warnTime
    ? ` A reminder will post ${discordRelativeTime(warnTime)}.`
    : ` _(No ending-soon reminder — the auction is shorter than the reminder lead time.)_`;

  let content;
  if (result.groupMode) {
    const [auction] = created;
    content =
      `✅ Group auction **#${auction.id} — ${input.itemName}** created with **${auction.winners} winner slots**. ` +
      `Starting bid ${startingBid}, ends ${discordRelativeTime(endTime)}.${warnNote}` +
      `${pinFailureNote(result.allPinned)}`;
    if (result.quantityIgnored) content += `\n_(quantity is ignored in group mode — winners controls the slots.)_`;
  } else {
    const idList = created.map((a) => `#${a.id}`).join(', ');
    content =
      (created.length > 1
        ? `✅ Created **${created.length}** auctions for **${input.itemName}** (${idList}). ` +
          `Starting bid ${startingBid} each, all end ${discordRelativeTime(endTime)}.${warnNote}`
        : `✅ Auction **${idList} — ${input.itemName}** created. ` +
          `Starting bid ${startingBid}, ends ${discordRelativeTime(endTime)}.${warnNote}`) +
      pinFailureNote(result.allPinned);
  }

  await interaction.editReply({ content });
}

async function handleList(interaction, ctx) {
  const rows = await auctions.listActiveAuctions(ctx);
  if (rows.length === 0) {
    return interaction.reply({
      content: 'There are no active auctions right now.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🏷️ Active auctions (${rows.length})`);

  for (const { auction: a, highBid: high } of rows.slice(0, 25)) {
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

async function handleInfo(interaction, ctx) {
  const { auction, bidCount, recentBids } = await auctions.getAuctionInfo(
    ctx,
    interaction.options.getInteger('item'),
  );

  const embed = buildAuctionEmbed(auction);
  if (recentBids.length > 0) {
    embed.addFields({
      name: `Recent bids (${bidCount} total)`,
      value: recentBids
        .map((b) => `• <@${b.user_id}> — ${formatCents(b.amount_cents)} (${discordRelativeTime(b.placed_at)})`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleEnd(interaction, ctx) {
  const auctionId = interaction.options.getInteger('item');
  // Announcing the result can take a few seconds; acknowledge first.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await auctions.endAuction(ctx, auctionId);
  await interaction.editReply({ content: `🏁 Auction #${auctionId} ended. The result has been announced.` });
}

async function handleCancel(interaction, ctx) {
  const auctionId = interaction.options.getInteger('item');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await auctions.cancelAuction(ctx, auctionId);
  await interaction.editReply({ content: `❌ Auction #${auctionId} cancelled.` });
}

/**
 * Show a Confirm/Cancel button prompt (ephemeral) and wait for the invoker's
 * choice. Resolves to the (deferred) button interaction if confirmed, or null
 * if the user cancelled or the 30s window elapsed (in which case the reply is
 * already updated). The caller finalises the message via
 * `confirmation.editReply(...)`.
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

  // The action may post to the channel before we answer; buy time past 3s.
  await confirmation.deferUpdate();
  return confirmation;
}

/** Run the confirmed action, showing any ServiceError on the prompt message. */
async function runConfirmed(confirmation, action) {
  try {
    const content = await action();
    await confirmation.editReply({ content, components: [] });
  } catch (err) {
    await replyError(confirmation, err);
  }
}

async function handleDelete(interaction, ctx) {
  const auctionId = interaction.options.getInteger('item');
  const { auction, bidCount } = await auctions.previewDeleteAuction(ctx, auctionId);

  let prompt =
    `🗑️ Delete auction **#${auction.id} — ${auction.item_name}** (${auction.status})?\n` +
    `This permanently removes it and its **${bidCount}** bid(s), and can't be undone.`;
  if (auction.status === 'active') {
    prompt += `\n⚠️ This auction is still **active** — bidders will lose it.`;
  }

  const confirmation = await confirmDestructive(interaction, prompt, 'Delete');
  if (!confirmation) return;

  await runConfirmed(confirmation, async () => {
    const deleted = await auctions.deleteAuction(ctx, auctionId);
    return `🗑️ Deleted auction **#${deleted.auction.id} — ${deleted.auction.item_name}** and its ${deleted.bidCount} bid(s).`;
  });
}

async function handleCleanup(interaction, ctx) {
  const finished = await auctions.previewCleanup(ctx);
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

  await runConfirmed(confirmation, async () => {
    const removed = await auctions.cleanupFinished(ctx);
    return `🧹 Deleted **${removed.length}** finished auction(s). Their old listing messages remain as a record.`;
  });
}

async function handleRemoveBid(interaction, ctx) {
  const auctionId = interaction.options.getInteger('item');
  const bidId = interaction.options.getInteger('bidder');
  const { auction, bid, reinstated } = await auctions.previewRemoveBid(ctx, auctionId, bidId);

  const label = `#${auction.id} — ${auction.item_name}`;
  let prompt =
    `🗑️ Remove **${bid.username}**'s bid of **${formatCents(bid.amount_cents)}** on **${label}**? ` +
    `This can't be undone.`;
  // For group auctions, tell the mod up front whether this reinstates anyone.
  if (auction.group_mode) {
    prompt += reinstated
      ? `\n↩️ This will reinstate **${reinstated.username}** (${formatCents(reinstated.amount_cents)}) to a winning slot.`
      : `\n↩️ No bidder will be reinstated.`;
  }

  const confirmation = await confirmDestructive(interaction, prompt, 'Remove bid');
  if (!confirmation) return;

  await runConfirmed(confirmation, async () => {
    await auctions.removeBid(ctx, auctionId, bidId);
    return `🗑️ Removed **${bid.username}**'s bid of ${formatCents(bid.amount_cents)}.`;
  });
}

async function handleEditBid(interaction, ctx) {
  const auctionId = interaction.options.getInteger('item');
  const bidId = interaction.options.getInteger('bidder');
  const newCents = parseDollarsToCents(interaction.options.getString('amount'));
  const { auction, bid } = await auctions.previewEditBid(ctx, auctionId, bidId, newCents);

  const label = `#${auction.id} — ${auction.item_name}`;
  const prompt =
    `✏️ Change **${bid.username}**'s bid on **${label}** from ` +
    `**${formatCents(bid.amount_cents)}** to **${formatCents(newCents)}**?`;

  const confirmation = await confirmDestructive(interaction, prompt, 'Update bid');
  if (!confirmation) return;

  await runConfirmed(confirmation, async () => {
    await auctions.editBid(ctx, auctionId, bidId, newCents);
    return `✏️ Updated **${bid.username}**'s bid to ${formatCents(newCents)}.`;
  });
}

async function handleExport(interaction, ctx) {
  const auctionId = interaction.options.getInteger('item');
  const { csv, fileName, auctionCount, rowCount } = await auctions.exportBidsCsv(ctx, auctionId);
  if (auctionCount === 0) {
    return interaction.reply({
      content: 'There are no auctions to export in this server.',
      flags: MessageFlags.Ephemeral,
    });
  }

  const attachment = new AttachmentBuilder(Buffer.from(csv, 'utf8'), { name: fileName });
  return interaction.reply({
    content: `📄 Export ready (${rowCount} row(s)).`,
    files: [attachment],
    flags: MessageFlags.Ephemeral,
  });
}

module.exports = { data, execute, autocomplete };
