'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { Client, GatewayIntentBits, Collection, Events, MessageFlags } = require('discord.js');
const { initScheduler } = require('./scheduler');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const client = new Client({
  // Auctions run entirely through slash commands, so no privileged intents needed.
  intents: [GatewayIntentBits.Guilds],
});

// --- Load command modules ---
client.commands = new Collection();
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (command?.data?.name && typeof command.execute === 'function') {
    client.commands.set(command.data.name, command);
  } else {
    console.warn(`Skipping ${file}: missing "data" or "execute" export.`);
  }
}

// --- Interaction handling: slash commands + autocomplete ---
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = client.commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
    } else if (interaction.isAutocomplete()) {
      const command = client.commands.get(interaction.commandName);
      if (command?.autocomplete) await command.autocomplete(interaction);
    }
  } catch (err) {
    console.error(`Error handling interaction ${interaction.commandName}:`, err);
    if (interaction.isRepliable()) {
      const payload = {
        content: '⚠️ Something went wrong handling that command.',
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  initScheduler(client);
});

client.login(process.env.DISCORD_TOKEN);
