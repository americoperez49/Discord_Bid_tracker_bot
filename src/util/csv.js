'use strict';

/**
 * Minimal RFC-4180-style CSV builder (no external dependency).
 */

/**
 * Escape a single field: wrap in quotes when it contains a comma, quote,
 * or newline, and double any embedded quotes.
 * @param {*} value
 * @returns {string}
 */
function escapeField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Build a CSV string from a header row and data rows.
 * @param {string[]} headers
 * @param {Array<Array<*>>} rows
 * @returns {string} CSV text (CRLF line endings, with a leading UTF-8 BOM
 *   so Excel opens accented names correctly).
 */
function buildCsv(headers, rows) {
  const lines = [headers, ...rows].map((row) => row.map(escapeField).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

module.exports = { buildCsv, escapeField };
