'use strict';

const db = require('./db');
const { formatCents } = require('./util/money');
const { buildAuctionEmbed } = require('./util/embeds');

// Backstop sweep interval: catches auctions whose setTimeout was lost, whose
// timer exceeded the ~24.8-day setTimeout limit, or that expired while offline.
const SWEEP_INTERVAL_MS = 15 * 1000;
// setTimeout overflows past this; anything further out relies on the sweep.
const MAX_TIMEOUT_MS = 2_147_483_000;

/** @type {Map<number, NodeJS.Timeout>} auctionId -> pending end timer */
const timers = new Map();

let clientRef = null;

/**
 * Initialise the scheduler: end anything already overdue, reschedule the rest,
 * and start the periodic backstop sweep.
 * @param {import('discord.js').Client} client
 */
function initScheduler(client) {
  clientRef = client;

  const active = db.getAllActiveAuctions();
  const now = Date.now();
  for (const auction of active) {
    if (new Date(auction.end_time).getTime() <= now) {
      // Expired while the bot was offline — end immediately.
      endAuction(auction.id, 'ended').catch((err) =>
        console.error(`Failed to end overdue auction #${auction.id}:`, err),
      );
    } else {
      scheduleAuctionEnd(auction);
    }
  }

  setInterval(runSweep, SWEEP_INTERVAL_MS).unref?.();
  console.log(`Scheduler initialised: ${active.length} active auction(s) loaded.`);
}

/**
 * Schedule (or reschedule) the end timer for a single auction.
 * @param {object} auction
 */
function scheduleAuctionEnd(auction) {
  clearAuctionTimer(auction.id);

  const delay = new Date(auction.end_time).getTime() - Date.now();
  if (delay <= 0) {
    endAuction(auction.id, 'ended').catch((err) =>
      console.error(`Failed to end auction #${auction.id}:`, err),
    );
    return;
  }

  // The sweep handles delays beyond the setTimeout ceiling.
  const timer = setTimeout(() => {
    timers.delete(auction.id);
    endAuction(auction.id, 'ended').catch((err) =>
      console.error(`Failed to end auction #${auction.id}:`, err),
    );
  }, Math.min(delay, MAX_TIMEOUT_MS));

  timers.set(auction.id, timer);
}

function clearAuctionTimer(auctionId) {
  const timer = timers.get(auctionId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(auctionId);
  }
}

/** Periodic backstop: end any active auction whose time has passed. */
function runSweep() {
  const now = Date.now();
  for (const auction of db.getAllActiveAuctions()) {
    if (new Date(auction.end_time).getTime() <= now && !timers.has(auction.id)) {
      endAuction(auction.id, 'ended').catch((err) =>
        console.error(`Sweep failed to end auction #${auction.id}:`, err),
      );
    }
  }
}

/**
 * Finalise an auction and announce the outcome in its channel.
 * @param {number} auctionId
 * @param {'ended'|'cancelled'} status
 * @returns {Promise<object|null>} the finalised auction row, or null if it was
 *   already finalised / no longer active.
 */
async function endAuction(auctionId, status = 'ended') {
  clearAuctionTimer(auctionId);

  const result = db.finalizeAuction(auctionId, status);
  if (!result) return null; // already ended/cancelled elsewhere

  const { auction, winners } = result;

  if (clientRef) {
    try {
      await announceOutcome(auction, winners, status);
    } catch (err) {
      console.error(`Failed to announce outcome for auction #${auctionId}:`, err);
    }
  }

  return auction;
}

/**
 * Edit the original announcement embed and post a result message that pings
 * everyone who bid. `winners` is an array: one entry for a normal auction, up
 * to `auction.winners` entries for a group auction.
 */
async function announceOutcome(auction, winners, status) {
  const channel = await clientRef.channels.fetch(auction.channel_id).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  // Refresh the original announcement message to its final state.
  if (auction.message_id) {
    const msg = await channel.messages.fetch(auction.message_id).catch(() => null);
    if (msg) {
      await msg.edit({ embeds: [buildAuctionEmbed(auction)] }).catch(() => {});
    }
  }

  const bidders = new Set(db.getBidsForAuction(auction.id).map((b) => b.user_id));
  const mentions = [...bidders].map((id) => `<@${id}>`).join(' ');
  const label = `#${auction.id} — ${auction.item_name}`;

  let content;
  if (status === 'cancelled') {
    content = `❌ **Auction ${label}** was cancelled.`;
    if (mentions) content += `\n${mentions}`;
  } else if (winners.length === 0) {
    content = `🏁 **Auction ${label}** has ended with no bids.`;
  } else if (auction.group_mode) {
    const lines = winners
      .map((w, i) => `**${i + 1}.** <@${w.user_id}> — ${formatCents(w.amount_cents)}`)
      .join('\n');
    content =
      `🏁 **Group auction ${label}** has ended!\n` +
      `🏆 **${winners.length} winner${winners.length === 1 ? '' : 's'}** (one item each):\n${lines}` +
      (mentions ? `\n\nThanks to all bidders: ${mentions}` : '');
  } else {
    content =
      `🏁 **Auction ${label}** has ended!\n` +
      `🏆 Winner: <@${winners[0].user_id}> with **${formatCents(winners[0].amount_cents)}**.\n` +
      (mentions ? `Thanks to all bidders: ${mentions}` : '');
  }

  await channel.send({
    content,
    allowedMentions: { users: [...bidders] },
  });
}

/**
 * Cancel a pending end timer (used when an auction is deleted). Safe to call
 * even if no timer is scheduled for the id.
 * @param {number} auctionId
 */
function cancelScheduled(auctionId) {
  clearAuctionTimer(auctionId);
}

module.exports = { initScheduler, scheduleAuctionEnd, endAuction, cancelScheduled };
