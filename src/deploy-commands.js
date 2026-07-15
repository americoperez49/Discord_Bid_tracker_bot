'use strict';

/**
 * Registers slash commands with Discord.
 *
 *   - If GUILD_ID is set, commands are registered to that single guild and
 *     appear instantly (best for development/testing).
 *   - If GUILD_ID is empty, commands are registered globally (can take up to
 *     ~1 hour to propagate).
 *
 * Run with:  npm run deploy
 */

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes } = require('discord.js');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or CLIENT_ID in environment.');
  process.exit(1);
}

const commands = [];
const commandsDir = path.join(__dirname, 'commands');
for (const file of fs.readdirSync(commandsDir).filter((f) => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (command?.data) commands.push(command.data.toJSON());
}

const rest = new REST().setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log(`Registering ${commands.length} command(s)...`);
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
      console.log(`✅ Registered to guild ${GUILD_ID} (instant).`);
    } else {
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
      console.log('✅ Registered globally (may take up to ~1 hour to appear).');
    }
  } catch (err) {
    console.error('Failed to register commands:', err);
    process.exit(1);
  }
})();
