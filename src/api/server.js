'use strict';

/**
 * The HTTP API, served from the bot process with node:http. Every route lives
 * under /v1 and is a thin adapter over the services layer, which does the
 * moderator / privacy checks. See README "HTTP API" for the full reference.
 */

const http = require('node:http');
const services = require('../services/auctions');
const users = require('../services/users');
const { parseDurationMs } = require('../util/time');
const { AuthError, authenticate, checkApiKey } = require('./auth');
const { auctionJson, bidJson, auctionWithStanding } = require('./serialize');

const { ServiceError } = services;
const MAX_BODY_BYTES = 64 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// HTTP status for each ServiceError code.
const SERVICE_STATUS = {
  invalid_input: 400,
  channel_unavailable: 400,
  not_moderator: 403,
  not_member: 403,
  forbidden: 403,
  guild_not_found: 404,
  auction_not_found: 404,
  bid_not_found: 404,
  not_active: 409,
};

/**
 * Read API settings from the environment. Returns null (API off) unless
 * API_ENABLED=true and the required settings are present.
 */
function loadApiConfig(env = process.env) {
  if (env.API_ENABLED !== 'true') return null;
  const missing = ['API_KEY', 'ROGUE_APP_CLIENT_ID'].filter((k) => !env[k]);
  if (missing.length > 0) {
    console.error(`HTTP API not started: missing ${missing.join(', ')}.`);
    return null;
  }
  if (env.API_KEY.length < 32) {
    console.error('HTTP API not started: API_KEY must be at least 32 characters.');
    return null;
  }
  return {
    host: env.API_HOST || '127.0.0.1',
    port: Number(env.API_PORT || 3000),
    apiKey: env.API_KEY,
    rogueClientId: env.ROGUE_APP_CLIENT_ID,
    auctionChannelId: env.AUCTION_CHANNEL_ID || null,
  };
}

// --- Request helpers -------------------------------------------------------

async function readJsonBody(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'unsupported_media_type', 'Send a JSON body with Content-Type: application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object.');
  }
  return body;
}

function rejectUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    throw new HttpError(400, 'unknown_field', `Unknown field(s): ${unknown.join(', ')}. Allowed: ${allowed.join(', ')}.`);
  }
}

/** A positive integer path or query value, or a 400/404 HttpError. */
function toId(value, what, status = 404) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(status, `${what}_not_found`, `Invalid ${what} ID: ${value}.`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new HttpError(status, `${what}_not_found`, `Invalid ${what} ID: ${value}.`);
  return n;
}

/** JSON null and absent both mean "use the default" for optional fields. */
const optional = (v) => (v === null ? undefined : v);

// --- Routes ----------------------------------------------------------------

/** @type {{method: string, re: RegExp, names: string[], auth: 'key'|'user', body: boolean, handler: Function}[]} */
const routes = [];

function route(method, template, handler, { auth = 'user', body = false } = {}) {
  const names = [];
  const pattern = template.replace(/:(\w+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  routes.push({ method, re: new RegExp(`^${pattern}$`), names, auth, body, handler });
}

const CREATE_FIELDS = [
  'itemName',
  'description',
  'startingBidCents',
  'duration',
  'incrementCents',
  'quantity',
  'groupMode',
  'winners',
  'warnBefore',
];

route('GET', '/v1/health', async ({ client }) => ({ json: { ok: true, discordReady: client.isReady() } }), {
  auth: 'key',
});

route('GET', '/v1/guilds', async ({ client, actorId }) => {
  const guilds = await users.listGuildsForUser(client, actorId);
  return { json: { guilds: guilds.map(({ guild, isModerator }) => ({ id: guild.id, name: guild.name, isModerator })) } };
});

route(
  'POST',
  '/v1/guilds/:guildId/auctions',
  async ({ ctx, body, config }) => {
    rejectUnknownFields(body, CREATE_FIELDS);
    if (!config.auctionChannelId) {
      throw new HttpError(503, 'channel_not_configured', 'AUCTION_CHANNEL_ID is not set on the bot.');
    }
    const result = await services.createAuction(ctx, {
      channelId: config.auctionChannelId,
      itemName: body.itemName,
      description: body.description ?? null,
      startingBidCents: body.startingBidCents ?? null,
      durationMs: typeof body.duration === 'string' ? parseDurationMs(body.duration) : null,
      incrementCents: optional(body.incrementCents),
      quantity: optional(body.quantity),
      groupMode: optional(body.groupMode),
      winners: body.winners ?? null,
      warnBeforeMs:
        optional(body.warnBefore) === undefined
          ? undefined
          : typeof body.warnBefore === 'string'
            ? parseDurationMs(body.warnBefore)
            : null,
    });
    return {
      status: 201,
      json: {
        auctions: result.auctions.map((a) => auctionWithStanding(a)),
        endTime: result.endTime,
        warnTime: result.warnTime,
        listingPinned: result.allPinned,
      },
    };
  },
  { body: true },
);

route('GET', '/v1/guilds/:guildId/auctions', async ({ ctx, query }) => {
  const rows = await services.listAuctions(ctx, query.get('status') ?? 'active');
  return { json: { auctions: rows.map(({ auction, highBid }) => auctionWithStanding(auction, highBid)) } };
});

route('GET', '/v1/guilds/:guildId/auctions/:auctionId', async ({ ctx, params, query }) => {
  const limitParam = query.get('bidsLimit');
  const recentLimit = limitParam === null ? 25 : Number(limitParam);
  if (!Number.isInteger(recentLimit) || recentLimit < 1 || recentLimit > 500) {
    throw new HttpError(400, 'invalid_input', 'bidsLimit must be a whole number from 1 to 500.');
  }
  const info = await services.getAuctionInfo(ctx, toId(params.auctionId, 'auction'), { recentLimit });
  return { json: { auction: auctionWithStanding(info.auction), recentBids: info.recentBids.map(bidJson) } };
});

route('POST', '/v1/guilds/:guildId/auctions/:auctionId/end', async ({ ctx, params }) => {
  const auction = await services.endAuction(ctx, toId(params.auctionId, 'auction'));
  return { json: { auction: auctionWithStanding(auction) } };
});

route('POST', '/v1/guilds/:guildId/auctions/:auctionId/cancel', async ({ ctx, params }) => {
  const auction = await services.cancelAuction(ctx, toId(params.auctionId, 'auction'));
  return { json: { auction: auctionWithStanding(auction) } };
});

route('DELETE', '/v1/guilds/:guildId/auctions/:auctionId', async ({ ctx, params }) => {
  const { auction, bidCount } = await services.deleteAuction(ctx, toId(params.auctionId, 'auction'));
  return { json: { deleted: auctionJson(auction), bidCount } };
});

route('POST', '/v1/guilds/:guildId/cleanup', async ({ ctx }) => {
  const removed = await services.cleanupFinished(ctx);
  return { json: { deleted: removed.map(auctionJson) } };
});

route('DELETE', '/v1/guilds/:guildId/auctions/:auctionId/bids/:bidId', async ({ ctx, params }) => {
  const result = await services.removeBid(ctx, toId(params.auctionId, 'auction'), toId(params.bidId, 'bid'));
  return {
    json: {
      removed: bidJson(result.bid),
      restored: result.restored ? bidJson(result.restored) : null,
      auction: auctionWithStanding(result.auction),
    },
  };
});

route(
  'PATCH',
  '/v1/guilds/:guildId/auctions/:auctionId/bids/:bidId',
  async ({ ctx, params, body }) => {
    rejectUnknownFields(body, ['amountCents']);
    const result = await services.editBid(
      ctx,
      toId(params.auctionId, 'auction'),
      toId(params.bidId, 'bid'),
      body.amountCents ?? null,
    );
    return {
      json: {
        bid: bidJson(result.bid),
        oldAmountCents: result.oldAmountCents,
        auction: auctionWithStanding(result.auction),
      },
    };
  },
  { body: true },
);

route('GET', '/v1/guilds/:guildId/export.csv', async ({ ctx, query }) => {
  const raw = query.get('auctionId');
  const auctionId = raw === null ? null : toId(raw, 'auction');
  const { csv, fileName } = await services.exportBidsCsv(ctx, auctionId);
  return { csv, fileName };
});

/** `me` in a user route means the signed-in user. */
const targetUser = (params, actorId) => (params.userId === 'me' ? actorId : params.userId);

route('GET', '/v1/guilds/:guildId/users/:userId/bids', async ({ ctx, params, actorId }) => {
  const rows = await users.getUserBids(ctx, targetUser(params, actorId));
  return {
    json: {
      bids: rows.map((b) => ({ ...bidJson(b), itemName: b.item_name, auctionStatus: b.auction_status })),
    },
  };
});

route('GET', '/v1/guilds/:guildId/users/:userId/active', async ({ ctx, params, actorId }) => {
  const entries = await users.getUserActiveAuctions(ctx, targetUser(params, actorId));
  return {
    json: {
      auctions: entries.map(({ auction, ...standing }) => ({ auction: auctionJson(auction), ...standing })),
    },
  };
});

route('GET', '/v1/guilds/:guildId/users/:userId/wins', async ({ ctx, params, actorId }) => {
  const rows = await users.getUserWins(ctx, targetUser(params, actorId));
  return { json: { wins: rows.map((a) => ({ auction: auctionJson(a), amountCents: a.won_cents })) } };
});

// --- Dispatch --------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, err) {
  if (err instanceof AuthError || err instanceof HttpError) {
    return sendJson(res, err.status, { error: { code: err.code, message: err.message } });
  }
  if (err instanceof ServiceError) {
    return sendJson(res, SERVICE_STATUS[err.code] ?? 400, { error: { code: err.code, message: err.message } });
  }
  console.error('HTTP API error:', err);
  return sendJson(res, 500, { error: { code: 'internal_error', message: 'Something went wrong.' } });
}

async function handle(req, res, client, config) {
  const url = new URL(req.url, 'http://localhost');
  const matches = routes
    .map((r) => ({ r, m: r.re.exec(url.pathname) }))
    .filter(({ m }) => m);
  if (matches.length === 0) throw new HttpError(404, 'not_found', `No route for ${url.pathname}.`);

  const match = matches.find(({ r }) => r.method === req.method);
  if (!match) {
    res.setHeader('Allow', matches.map(({ r }) => r.method).join(', '));
    throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed on ${url.pathname}.`);
  }
  const { r, m } = match;
  const params = Object.fromEntries(r.names.map((name, i) => [name, decodeURIComponent(m[i + 1])]));

  let actorId = null;
  if (r.auth === 'key') {
    checkApiKey(req, config.apiKey);
  } else {
    actorId = await authenticate(req, config);
  }

  let guildId = null;
  if (params.guildId !== undefined) {
    if (!/^\d+$/.test(params.guildId)) throw new HttpError(404, 'guild_not_found', `Invalid guild ID: ${params.guildId}.`);
    guildId = params.guildId;
  }

  const body = r.body ? await readJsonBody(req) : null;
  const ctx = { client, guildId, actorId };
  const result = await r.handler({ client, config, ctx, params, query: url.searchParams, body, actorId });

  if (result.csv !== undefined) {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.fileName}"`,
      'Cache-Control': 'no-store',
    });
    res.end(result.csv);
    return;
  }
  sendJson(res, result.status ?? 200, result.json);
}

/**
 * Start the API server.
 * @param {import('discord.js').Client} client
 * @param {ReturnType<typeof loadApiConfig>} config
 * @returns {Promise<http.Server>} resolves once listening
 */
function startApi(client, config) {
  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      // Path only: query strings and headers (tokens) are never logged.
      const path = (req.url ?? '').split('?')[0];
      console.log(`API ${req.method} ${path} ${res.statusCode} ${Date.now() - started}ms`);
    });
    handle(req, res, client, config).catch((err) => {
      if (res.headersSent) {
        console.error('HTTP API error after response started:', err);
        res.destroy();
        return;
      }
      sendError(res, err);
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      const { address, port } = server.address();
      console.log(`HTTP API listening on http://${address}:${port}/v1`);
      resolve(server);
    });
  });
}

module.exports = { loadApiConfig, startApi };
