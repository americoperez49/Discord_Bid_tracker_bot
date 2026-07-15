'use strict';

const db = require('../db');

/**
 * Respond to an autocomplete interaction on the "item" option with the guild's
 * active auctions, filtered by the user's partial input. Each choice's value is
 * the auction id (as a number).
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

async function respond(interaction, auctions) {
  const focused = interaction.options.getFocused()?.toString().toLowerCase() ?? '';

  const choices = auctions
    .map((a) => ({
      name: `#${a.id} — ${a.item_name}${a.status !== 'active' ? ` [${a.status}]` : ''}`.slice(0, 100),
      value: a.id,
      _haystack: `#${a.id} ${a.item_name}`.toLowerCase(),
    }))
    .filter((c) => focused === '' || c._haystack.includes(focused))
    .slice(0, 25)
    .map(({ name, value }) => ({ name, value }));

  await interaction.respond(choices);
}

module.exports = { respondWithActiveAuctions, respondWithAllAuctions };
