'use strict';

/**
 * One-time backfill: update the stored bidder name on existing bids from the
 * raw account handle (e.g. "sardine2") to the friendly display name
 * (server nickname → global display name → handle, e.g. "Anchovie").
 *
 * New bids already record the display name; this fixes bids placed before that
 * change. Safe to run more than once.
 *
 * Run:  node src/backfill-usernames.js   (or: npm run backfill)
 * Run it from the project directory so it uses the same database as the bot.
 * Recommended: stop the bot first (pm2 stop bid-bot), run this, then start it.
 */

require('dotenv').config();

const { Client, GatewayIntentBits } = require('discord.js');
const { db } = require('./db');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}

// Every distinct bidder, paired with the guild their auction belongs to.
const targets = db
  .prepare(
    `SELECT DISTINCT b.user_id AS user_id, a.guild_id AS guild_id
       FROM bids b
       JOIN auctions a ON a.id = b.auction_id`,
  )
  .all();

// Update only the bids for that user within that guild.
const updateStmt = db.prepare(
  `UPDATE bids SET username = ?
    WHERE user_id = ?
      AND auction_id IN (SELECT id FROM auctions WHERE guild_id = ?)`,
);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async (c) => {
  console.log(`Logged in as ${c.user.tag}. Backfilling ${targets.length} bidder(s)...`);

  let updatedRows = 0;
  let skipped = 0;

  for (const { user_id, guild_id } of targets) {
    let name = null;
    try {
      const guild = await client.guilds.fetch(guild_id);
      try {
        const member = await guild.members.fetch(user_id);
        name = member.displayName; // nickname → global name → username
      } catch {
        // User may have left the guild; fall back to their global name.
        const user = await client.users.fetch(user_id);
        name = user.globalName ?? user.username;
      }
    } catch (err) {
      console.warn(`  skip ${user_id} in guild ${guild_id}: ${err.message}`);
      skipped++;
      continue;
    }

    if (!name) {
      skipped++;
      continue;
    }

    const res = updateStmt.run(name, user_id, guild_id);
    updatedRows += res.changes;
    console.log(`  ${user_id} → ${name} (${res.changes} bid row(s))`);
  }

  console.log(`Done. Updated ${updatedRows} bid row(s); skipped ${skipped} bidder(s).`);
  await client.destroy();
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
