'use strict';

const { PermissionFlagsBits } = require('discord.js');

/**
 * Whether a member may run moderator commands (create/end/cancel/export).
 *
 * A member qualifies if they have the "Manage Server" permission, OR they
 * hold the configured MOD_ROLE_ID (if one is set in the environment).
 *
 * @param {import('discord.js').GuildMember|null} member
 * @returns {boolean}
 */
function isModerator(member) {
  if (!member) return false;

  const modRoleId = process.env.MOD_ROLE_ID;
  if (modRoleId && member.roles?.cache?.has(modRoleId)) {
    return true;
  }

  return member.permissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

module.exports = { isModerator };
