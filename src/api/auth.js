'use strict';

/**
 * Request authentication for the HTTP API. Every request must carry both:
 *
 *   X-Api-Key: <API_KEY>                    proves the caller is Rogue App's server
 *   Authorization: Bearer <Discord token>   the signed-in user's own OAuth2 token
 *
 * The Discord token is checked with Discord itself (GET /oauth2/@me): it must be
 * valid, issued to Rogue App's application (ROGUE_APP_CLIENT_ID), and carry the
 * `identify` scope. The user ID Discord returns is the request's actor.
 */

const crypto = require('node:crypto');

const DISCORD_API = 'https://discord.com/api/v10';
const CACHE_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 1000;
const DISCORD_TIMEOUT_MS = 5000;

class AuthError extends Error {
  /**
   * @param {number} status HTTP status to send
   * @param {string} code   stable machine-readable reason
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest();

/** Constant-time check of the X-Api-Key header against the configured key. */
function checkApiKey(req, apiKey) {
  const supplied = req.headers['x-api-key'];
  if (typeof supplied !== 'string' || !crypto.timingSafeEqual(sha256(supplied), sha256(apiKey))) {
    throw new AuthError(401, 'invalid_api_key', 'Missing or invalid X-Api-Key header.');
  }
}

/** The bearer token from the Authorization header. */
function bearerToken(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
  if (!match) {
    throw new AuthError(401, 'missing_token', "Send the user's Discord access token as 'Authorization: Bearer <token>'.");
  }
  return match[1];
}

// Recently verified tokens, keyed by a hash of the token (never the token
// itself): sha256 hex -> { userId, expiresAt }.
const tokenCache = new Map();

function cacheGet(key) {
  const hit = tokenCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    tokenCache.delete(key);
    return null;
  }
  return hit.userId;
}

function cacheSet(key, userId, expiresAt) {
  if (tokenCache.size >= MAX_CACHE_ENTRIES) {
    // Drop expired entries first; if still full, drop the oldest insertion.
    const now = Date.now();
    for (const [k, v] of tokenCache) if (v.expiresAt <= now) tokenCache.delete(k);
    if (tokenCache.size >= MAX_CACHE_ENTRIES) tokenCache.delete(tokenCache.keys().next().value);
  }
  tokenCache.set(key, { userId, expiresAt });
}

/**
 * Verify a user's Discord access token and return their Discord user ID.
 * @param {string} token
 * @param {string} clientId Rogue App's Discord application (client) ID
 * @returns {Promise<string>}
 */
async function verifyDiscordToken(token, clientId) {
  const key = sha256(token).toString('hex');
  const cached = cacheGet(key);
  if (cached) return cached;

  let res;
  try {
    res = await fetch(`${DISCORD_API}/oauth2/@me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
  } catch {
    throw new AuthError(503, 'discord_unavailable', "Couldn't reach Discord to verify the token. Try again.");
  }

  if (res.status === 401) {
    throw new AuthError(401, 'token_invalid', 'The Discord token is invalid or expired. Refresh it and try again.');
  }
  if (res.status === 429 || res.status >= 500) {
    throw new AuthError(503, 'discord_unavailable', 'Discord is rate-limiting or unavailable. Try again shortly.');
  }
  if (!res.ok) {
    throw new AuthError(401, 'token_invalid', 'Discord did not accept the token.');
  }

  const info = await res.json().catch(() => null);
  if (info?.application?.id !== clientId) {
    throw new AuthError(401, 'wrong_application', 'The Discord token was not issued to Rogue App.');
  }
  if (!info.user?.id || !Array.isArray(info.scopes) || !info.scopes.includes('identify')) {
    throw new AuthError(401, 'missing_identify_scope', "The Discord token needs the 'identify' scope.");
  }

  // Never cache past the token's own expiry.
  const tokenExpiry = Date.parse(info.expires);
  const expiresAt = Math.min(Date.now() + CACHE_MS, Number.isNaN(tokenExpiry) ? Infinity : tokenExpiry);
  cacheSet(key, info.user.id, expiresAt);
  return info.user.id;
}

/**
 * Authenticate a request: API key first (cheap, and keeps strangers from making
 * the bot call Discord), then the user's Discord token.
 * @returns {Promise<string>} the actor's Discord user ID
 */
async function authenticate(req, config) {
  checkApiKey(req, config.apiKey);
  return verifyDiscordToken(bearerToken(req), config.rogueClientId);
}

module.exports = { AuthError, authenticate, checkApiKey, verifyDiscordToken };
