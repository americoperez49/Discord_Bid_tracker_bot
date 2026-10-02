#!/usr/bin/env node
'use strict';

/**
 * rogue-cli: a command-line stand-in for Rogue App, for testing the auction
 * bot's HTTP API. It plays Rogue App's server: it signs you in with Discord,
 * keeps your token, and sends each request with the API key + your token.
 *
 *   npm run rogue -- help
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { parseArgs } = require('node:util');

const ROOT = path.join(__dirname, '..', '..');
// CLI-only settings may live in .env.rogue-cli; the bot's .env fills the rest
// (API_KEY, API_PORT, GUILD_ID, ...). Earlier files win.
require('dotenv').config({ path: path.join(ROOT, '.env.rogue-cli'), quiet: true });
require('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true });

const { parseDollarsToCents } = require('../../src/util/money');
const auth = require('./auth');

const HELP = `rogue-cli — test the auction bot's HTTP API as if you were Rogue App.

Usage: npm run rogue -- <command> [args] [options]

Sign-in (one saved login per --profile, default "default"):
  login [--no-browser]           Sign in with Discord in your browser
  logout                         Revoke and forget the profile's token
  profiles                       List saved profiles and their Discord accounts
  whoami                         Show the Discord account for the profile

API:
  health                         GET  /v1/health (API key only)
  guilds                         GET  /v1/guilds
  list [--status S]              GET  auctions (active|ended|cancelled|all)
  info <auctionId> [--bids-limit N]
  create --item NAME --starting-bid DOLLARS --duration 2d12h
         [--description TEXT] [--increment DOLLARS] [--quantity N]
         [--group --winners N] [--warn-before 1h]
  end <auctionId>
  cancel <auctionId>
  delete <auctionId> [--yes]
  cleanup [--yes]
  removebid <auctionId> <bidId>
  editbid <auctionId> <bidId> <dollars>
  export [--auction ID] [--out FILE]   Save the CSV (FILE "-" prints it)
  bids [userId|me]               A user's bids        (default: me)
  active [userId|me]             Their open auctions  (default: me)
  wins [userId|me]               Auctions they won    (default: me)
  raw <METHOD> <path> [jsonBody] Any request, e.g. raw POST /v1/guilds/123/auctions '{"itemName":"x"}'

Options:
  -p, --profile NAME   Saved login to use (test as a moderator and as a regular user)
  -g, --guild ID       Server ID (default: ROGUE_CLI_GUILD_ID, then GUILD_ID)
  --api-url URL        API base (default: ROGUE_CLI_API_URL, then http://API_HOST:API_PORT)
  --api-key KEY        Override the API key (e.g. a wrong one, to test rejection)
  --no-key             Send no API key
  --no-token           Send no Discord token
  -v, --verbose        Print each request before sending it
  -h, --help           Show this help`;

const OPTIONS = {
  profile: { type: 'string', short: 'p', default: 'default' },
  guild: { type: 'string', short: 'g' },
  'api-url': { type: 'string' },
  'api-key': { type: 'string' },
  'no-key': { type: 'boolean' },
  'no-token': { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
  'no-browser': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  status: { type: 'string' },
  'bids-limit': { type: 'string' },
  item: { type: 'string' },
  'starting-bid': { type: 'string' },
  duration: { type: 'string' },
  description: { type: 'string' },
  increment: { type: 'string' },
  quantity: { type: 'string' },
  group: { type: 'boolean' },
  winners: { type: 'string' },
  'warn-before': { type: 'string' },
  auction: { type: 'string' },
  out: { type: 'string' },
};

class UsageError extends Error {}

// --- argument helpers ------------------------------------------------------

function cents(value, flag) {
  const c = parseDollarsToCents(value);
  if (c === null) throw new UsageError(`${flag} must be a dollar amount like 25 or 25.00 (got "${value}").`);
  return c;
}

function int(value, flag) {
  if (!/^\d+$/.test(value ?? '')) throw new UsageError(`${flag} must be a whole number (got "${value}").`);
  return Number(value);
}

function need(value, what) {
  if (value === undefined || value === '') throw new UsageError(`Missing ${what}. Run "npm run rogue -- help".`);
  return value;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${question} Type "yes" to continue: `);
  rl.close();
  return answer.trim().toLowerCase() === 'yes';
}

// --- HTTP ------------------------------------------------------------------

function apiBase(opts) {
  const fromEnv =
    process.env.ROGUE_CLI_API_URL ||
    `http://${process.env.API_HOST || '127.0.0.1'}:${process.env.API_PORT || 3000}`;
  return (opts['api-url'] || fromEnv).replace(/\/+$/, '');
}

/**
 * Send one API request the way Rogue App's server would. Retries once with a
 * refreshed token if the bot says the token is invalid.
 * @returns {Promise<{status: number, statusText: string, headers: Headers, text: string, json: any}>}
 */
async function send(opts, method, apiPath, { body, rawBody } = {}) {
  const url = apiBase(opts) + apiPath;
  const attempt = async (token) => {
    const headers = {};
    const key = opts['api-key'] ?? process.env.API_KEY;
    if (!opts['no-key']) {
      if (!key) throw new UsageError('No API key: set API_KEY in .env (or pass --api-key / --no-key).');
      headers['X-Api-Key'] = key;
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (rawBody !== undefined) payload = rawBody;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (payload !== undefined) headers['Content-Type'] = 'application/json';

    if (opts.verbose) {
      const shown = { ...headers };
      if (shown['X-Api-Key']) shown['X-Api-Key'] = '<api key>';
      if (shown.Authorization) shown.Authorization = 'Bearer <discord token>';
      console.error(`> ${method} ${url}\n> ${JSON.stringify(shown)}${payload ? `\n> ${payload}` : ''}`);
    }

    let res;
    try {
      res = await fetch(url, { method, headers, body: payload });
    } catch (err) {
      throw new UsageError(`Couldn't reach the API at ${apiBase(opts)} (${err.cause?.code ?? err.message}). Is the bot running with API_ENABLED=true?`);
    }
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON (e.g. CSV) */
    }
    return { status: res.status, statusText: res.statusText, headers: res.headers, text, json };
  };

  if (opts['no-token']) return attempt(null);
  const result = await attempt(await auth.accessToken(process.env, opts.profile));
  if (result.status === 401 && result.json?.error?.code === 'token_invalid') {
    if (opts.verbose) console.error('> token rejected; refreshing and retrying once');
    const refreshed = await auth.refresh(process.env, opts.profile).catch(() => null);
    if (refreshed) return attempt(refreshed.accessToken);
  }
  return result;
}

/** Print a response: status line on stderr, body on stdout. */
function show(res) {
  const ok = res.status < 400;
  console.error(`${ok ? '✔' : '✘'} HTTP ${res.status} ${res.statusText}`);
  if (res.json !== null) console.log(JSON.stringify(res.json, null, 2));
  else if (res.text) console.log(res.text);
  if (!ok) process.exitCode = 1;
}

// --- commands --------------------------------------------------------------

function guildPath(opts) {
  const guild = opts.guild || process.env.ROGUE_CLI_GUILD_ID || process.env.GUILD_ID;
  if (!guild) throw new UsageError('No server ID: pass --guild, or set ROGUE_CLI_GUILD_ID (or GUILD_ID) in .env.');
  return `/v1/guilds/${encodeURIComponent(guild)}`;
}

const userPath = (opts, user) => `${guildPath(opts)}/users/${encodeURIComponent(user ?? 'me')}`;

const COMMANDS = {
  async login(opts) {
    const record = await auth.login(process.env, opts.profile, { browser: !opts['no-browser'] });
    console.log(`\n✔ Profile "${opts.profile}" signed in as ${record.username} (${record.userId}).`);
  },

  async logout(opts) {
    const removed = await auth.logout(process.env, opts.profile);
    console.log(removed ? `✔ Signed out profile "${opts.profile}".` : `Profile "${opts.profile}" wasn't signed in.`);
  },

  async profiles() {
    const all = Object.entries(auth.listProfiles());
    if (all.length === 0) return console.log('No saved profiles. Run: npm run rogue -- login');
    for (const [name, p] of all) {
      const expires = new Date(p.expiresAt).toLocaleString();
      console.log(`${name.padEnd(12)} ${p.username} (${p.userId})  token expires ${expires}`);
    }
  },

  async whoami(opts) {
    const user = await auth.fetchDiscordUser(await auth.accessToken(process.env, opts.profile));
    console.log(`Profile "${opts.profile}" is ${user.global_name ?? user.username} (@${user.username}, ${user.id}).`);
  },

  health: (opts) => send(opts, 'GET', '/v1/health').then(show),

  guilds: (opts) => send(opts, 'GET', '/v1/guilds').then(show),

  list: (opts) => {
    const query = opts.status ? `?status=${encodeURIComponent(opts.status)}` : '';
    return send(opts, 'GET', `${guildPath(opts)}/auctions${query}`).then(show);
  },

  info: (opts, [id]) => {
    const query = opts['bids-limit'] ? `?bidsLimit=${encodeURIComponent(opts['bids-limit'])}` : '';
    return send(opts, 'GET', `${guildPath(opts)}/auctions/${need(id, 'auction ID')}${query}`).then(show);
  },

  create: (opts) => {
    const body = {
      itemName: need(opts.item, '--item'),
      startingBidCents: cents(need(opts['starting-bid'], '--starting-bid'), '--starting-bid'),
      duration: need(opts.duration, '--duration'),
    };
    if (opts.description !== undefined) body.description = opts.description;
    if (opts.increment !== undefined) body.incrementCents = cents(opts.increment, '--increment');
    if (opts.quantity !== undefined) body.quantity = int(opts.quantity, '--quantity');
    if (opts.group) body.groupMode = true;
    if (opts.winners !== undefined) body.winners = int(opts.winners, '--winners');
    if (opts['warn-before'] !== undefined) body.warnBefore = opts['warn-before'];
    return send(opts, 'POST', `${guildPath(opts)}/auctions`, { body }).then(show);
  },

  end: (opts, [id]) => send(opts, 'POST', `${guildPath(opts)}/auctions/${need(id, 'auction ID')}/end`).then(show),

  cancel: (opts, [id]) => send(opts, 'POST', `${guildPath(opts)}/auctions/${need(id, 'auction ID')}/cancel`).then(show),

  async delete(opts, [id]) {
    need(id, 'auction ID');
    if (!opts.yes && !(await confirm(`Permanently delete auction #${id} and its bids?`))) {
      return console.log('Cancelled — nothing was deleted.');
    }
    show(await send(opts, 'DELETE', `${guildPath(opts)}/auctions/${id}`));
  },

  async cleanup(opts) {
    if (!opts.yes && !(await confirm('Permanently delete every ended/cancelled auction in this server?'))) {
      return console.log('Cancelled — nothing was deleted.');
    }
    show(await send(opts, 'POST', `${guildPath(opts)}/cleanup`));
  },

  removebid: (opts, [id, bidId]) =>
    send(opts, 'DELETE', `${guildPath(opts)}/auctions/${need(id, 'auction ID')}/bids/${need(bidId, 'bid ID')}`).then(show),

  editbid: (opts, [id, bidId, dollars]) => {
    const body = { amountCents: cents(need(dollars, 'new amount'), 'amount') };
    return send(opts, 'PATCH', `${guildPath(opts)}/auctions/${need(id, 'auction ID')}/bids/${need(bidId, 'bid ID')}`, {
      body,
    }).then(show);
  },

  async export(opts) {
    const query = opts.auction ? `?auctionId=${encodeURIComponent(opts.auction)}` : '';
    const res = await send(opts, 'GET', `${guildPath(opts)}/export.csv${query}`);
    if (res.status >= 400) return show(res);
    if (opts.out === '-') return process.stdout.write(res.text);
    const suggested = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'export.csv';
    const file = path.resolve(opts.out ?? suggested);
    fs.writeFileSync(file, res.text);
    console.error(`✔ HTTP ${res.status}: saved ${file}`);
  },

  bids: (opts, [user]) => send(opts, 'GET', `${userPath(opts, user)}/bids`).then(show),

  active: (opts, [user]) => send(opts, 'GET', `${userPath(opts, user)}/active`).then(show),

  wins: (opts, [user]) => send(opts, 'GET', `${userPath(opts, user)}/wins`).then(show),

  raw: (opts, [method, apiPath, json]) => {
    const p = need(apiPath, 'path (e.g. /v1/health)');
    return send(opts, need(method, 'HTTP method').toUpperCase(), p.startsWith('/') ? p : `/${p}`, {
      rawBody: json,
    }).then(show);
  },

  help: () => console.log(HELP),
};

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new UsageError(`${err.message}\nRun "npm run rogue -- help".`);
  }
  const { values: opts, positionals } = parsed;
  const [name, ...args] = positionals;
  if (opts.help || !name) return COMMANDS.help();
  const command = COMMANDS[name];
  if (!command) throw new UsageError(`Unknown command "${name}". Run "npm run rogue -- help".`);
  await command(opts, args);
}

main().catch((err) => {
  console.error(`✘ ${err.message}`);
  process.exitCode = 1;
});
