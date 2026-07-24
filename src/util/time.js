'use strict';

/**
 * Time helpers: parse human durations into a future end time, and render
 * Discord timestamp markup (which each viewer sees in their own local zone).
 */

const UNIT_MS = {
  w: 7 * 24 * 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
};

/**
 * Parse a compact duration string like "2d12h", "48h", "90m", "1w", "30s".
 * Units may be combined and appear in any order; whitespace is ignored.
 * @param {string} input
 * @returns {number|null} duration in milliseconds (> 0), or null if invalid.
 */
function parseDurationMs(input) {
  if (input === null || input === undefined) return null;
  const str = String(input).trim().toLowerCase().replace(/\s+/g, '');
  if (str === '') return null;

  // One or more <number><unit> pairs, nothing else.
  const pattern = /^(\d+(?:w|d|h|m|s))+$/;
  if (!pattern.test(str)) return null;

  let totalMs = 0;
  const partRe = /(\d+)(w|d|h|m|s)/g;
  let match;
  while ((match = partRe.exec(str)) !== null) {
    totalMs += Number(match[1]) * UNIT_MS[match[2]];
  }

  return totalMs > 0 ? totalMs : null;
}

/**
 * Compute an ISO (UTC) end time from "now" plus a duration string.
 * @param {string} durationInput
 * @param {number} [nowMs=Date.now()]
 * @returns {string|null} ISO 8601 UTC string, or null if the duration is invalid.
 */
function endTimeFromDuration(durationInput, nowMs = Date.now()) {
  const ms = parseDurationMs(durationInput);
  if (ms === null) return null;
  return new Date(nowMs + ms).toISOString();
}

/**
 * Unix seconds for an ISO timestamp (used in Discord timestamp markup).
 * @param {string} isoString
 * @returns {number}
 */
function unixSeconds(isoString) {
  return Math.floor(new Date(isoString).getTime() / 1000);
}

/**
 * Discord long date/time markup, e.g. "<t:1699999999:F>".
 * Renders in each viewer's local timezone.
 */
function discordFullTime(isoString) {
  return `<t:${unixSeconds(isoString)}:F>`;
}

/**
 * Discord relative markup, e.g. "<t:1699999999:R>" -> "in 3 hours".
 * Note: this self-updates in the client, so it will read "X ago" once the time
 * passes — use {@link formatDuration} for a fixed snapshot that won't count.
 */
function discordRelativeTime(isoString) {
  return `<t:${unixSeconds(isoString)}:R>`;
}

/**
 * Format a millisecond span as a short, static human string, e.g.
 * "1 hour", "1 hour 30 minutes", "2 minutes", "45 seconds". Uses at most the
 * two largest non-zero units. Returns "moments" for spans under a second.
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
  if (ms < 1000) return 'moments';
  const units = [
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
    ['second', 1000],
  ];
  const parts = [];
  let rem = ms;
  for (const [name, size] of units) {
    const n = Math.floor(rem / size);
    if (n > 0) {
      parts.push(`${n} ${name}${n === 1 ? '' : 's'}`);
      rem -= n * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || 'moments';
}

module.exports = {
  parseDurationMs,
  endTimeFromDuration,
  unixSeconds,
  discordFullTime,
  discordRelativeTime,
  formatDuration,
};
