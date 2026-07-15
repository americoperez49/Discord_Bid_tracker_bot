'use strict';

/**
 * Money helpers. All money is stored internally as integer cents to avoid
 * floating-point rounding errors, and displayed to users as dollars.
 */

/**
 * Parse a user-supplied dollar amount into integer cents.
 * Accepts numbers or strings like "50", "$50", "49.99", "1,250.50".
 * @param {string|number} input
 * @returns {number|null} integer cents, or null if the input is invalid.
 */
function parseDollarsToCents(input) {
  if (input === null || input === undefined) return null;

  let str = String(input).trim();
  if (str === '') return null;

  // Strip currency symbol and thousands separators.
  str = str.replace(/[$\s]/g, '').replace(/,/g, '');

  // Must look like a plain (optionally decimal) number, non-negative.
  if (!/^\d+(\.\d{1,2})?$/.test(str)) return null;

  const [whole, frac = ''] = str.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));

  if (!Number.isFinite(cents) || cents < 0) return null;
  return cents;
}

/**
 * Format integer cents as a "$X.XX" string.
 * @param {number} cents
 * @returns {string}
 */
function formatCents(cents) {
  const value = (Number(cents) / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `$${value}`;
}

module.exports = { parseDollarsToCents, formatCents };
