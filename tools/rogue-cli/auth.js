'use strict';

/**
 * Discord "Sign in with Discord" (OAuth2 authorization-code flow) for the
 * Rogue App stand-in, plus a small token store with one entry per profile.
 *
 * Tokens are saved in .rogue-cli/tokens.json (git-ignored; ROGUE_CLI_HOME moves it). They are real
 * Discord credentials for the signed-in account; don't share that file.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DISCORD_API = 'https://discord.com/api/v10';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const SCOPES = ['identify', 'guilds'];
const LOGIN_TIMEOUT_MS = 3 * 60 * 1000;
// Refresh a little before the token actually expires.
const REFRESH_MARGIN_MS = 60 * 1000;

// ROGUE_CLI_HOME relocates the store (the CLI's own tests use a temp dir).
const STORE_DIR = process.env.ROGUE_CLI_HOME
  ? path.resolve(process.env.ROGUE_CLI_HOME)
  : path.join(__dirname, '..', '..', '.rogue-cli');
const STORE_FILE = path.join(STORE_DIR, 'tokens.json');

// --- token store -----------------------------------------------------------

function readStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeStore(store) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function getProfile(name) {
  return readStore()[name] ?? null;
}

function saveProfile(name, data) {
  const store = readStore();
  store[name] = data;
  writeStore(store);
}

function deleteProfile(name) {
  const store = readStore();
  delete store[name];
  writeStore(store);
}

function listProfiles() {
  return readStore();
}

// --- OAuth2 ----------------------------------------------------------------

function oauthConfig(env) {
  const missing = ['ROGUE_APP_CLIENT_ID', 'ROGUE_APP_CLIENT_SECRET'].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing ${missing.join(', ')}. See "Testing the API with rogue-cli" in the README.`);
  }
  return {
    clientId: env.ROGUE_APP_CLIENT_ID,
    clientSecret: env.ROGUE_APP_CLIENT_SECRET,
    redirectUri: env.ROGUE_APP_REDIRECT_URI || 'http://localhost:53134/callback',
  };
}

/** POST to Discord's token endpoint with client credentials. */
async function tokenRequest(cfg, params) {
  const res = await fetch(`${DISCORD_API}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Discord token request failed (${res.status}): ${json.error_description ?? json.error ?? 'unknown error'}`);
  }
  return json;
}

/** The Discord account a token belongs to. */
async function fetchDiscordUser(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Couldn't read the Discord account (${res.status}).`);
  return res.json();
}

function tokenRecord(tokens, user) {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
    userId: user.id,
    username: user.global_name ?? user.username,
  };
}

function openBrowser(url) {
  // rundll32 / open / xdg-open take the URL as a plain argument, so the '&'s in
  // it never reach a shell.
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

/**
 * Run the browser sign-in and save the result under `profile`.
 * Starts a one-shot local server on the redirect URI to receive the code.
 */
async function login(env, profile, { browser = true } = {}) {
  const cfg = oauthConfig(env);
  const redirect = new URL(cfg.redirectUri);
  if (!['localhost', '127.0.0.1'].includes(redirect.hostname)) {
    throw new Error('ROGUE_APP_REDIRECT_URI must point at localhost so this CLI can receive the sign-in.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  const authorizeUrl =
    `${AUTHORIZE_URL}?` +
    new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      scope: SCOPES.join(' '),
      redirect_uri: cfg.redirectUri,
      state,
      prompt: 'consent',
    });

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, cfg.redirectUri);
      if (url.pathname !== redirect.pathname) {
        res.writeHead(404).end();
        return;
      }
      const finish = (status, message, result) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><meta charset="utf-8"><title>rogue-cli</title><p style="font:16px system-ui">${message}</p>`);
        clearTimeout(timer);
        server.close();
        result();
      };
      if (url.searchParams.get('state') !== state) {
        return finish(400, 'Sign-in failed: state mismatch. Run login again.', () => reject(new Error('OAuth state mismatch.')));
      }
      const error = url.searchParams.get('error');
      if (error) {
        return finish(400, `Sign-in cancelled (${error}). You can close this tab.`, () => reject(new Error(`Sign-in cancelled: ${error}`)));
      }
      finish(200, 'Signed in. You can close this tab and go back to the terminal.', () => resolve(url.searchParams.get('code')));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the Discord sign-in (3 minutes).'));
    }, LOGIN_TIMEOUT_MS);
    server.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Couldn't listen on ${cfg.redirectUri}: ${err.message}`));
    });
    server.listen(Number(redirect.port || 80), redirect.hostname, () => {
      console.log(`Sign in with the Discord account for profile "${profile}":\n\n  ${authorizeUrl}\n`);
      if (browser) openBrowser(authorizeUrl);
      console.log('Waiting for the sign-in to finish…');
    });
  });

  const tokens = await tokenRequest(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: cfg.redirectUri,
  });
  const user = await fetchDiscordUser(tokens.access_token);
  const record = tokenRecord(tokens, user);
  saveProfile(profile, record);
  return record;
}

/** Exchange the profile's refresh token for a new access token. */
async function refresh(env, profile) {
  const current = getProfile(profile);
  if (!current?.refreshToken) throw new Error(`Profile "${profile}" has no refresh token. Run login again.`);
  const tokens = await tokenRequest(oauthConfig(env), {
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
  });
  const record = tokenRecord(tokens, { id: current.userId, username: current.username });
  saveProfile(profile, record);
  return record;
}

/** The profile's access token, refreshed first if it's about to expire. */
async function accessToken(env, profile) {
  const current = getProfile(profile);
  if (!current) throw new Error(`Not signed in as profile "${profile}". Run: npm run rogue -- login --profile ${profile}`);
  if (current.expiresAt - REFRESH_MARGIN_MS > Date.now()) return current.accessToken;
  return (await refresh(env, profile)).accessToken;
}

/** Revoke the profile's token with Discord (best-effort) and forget it. */
async function logout(env, profile) {
  const current = getProfile(profile);
  if (!current) return false;
  try {
    const cfg = oauthConfig(env);
    await fetch(`${DISCORD_API}/oauth2/token/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
      },
      body: new URLSearchParams({ token: current.accessToken, token_type_hint: 'access_token' }),
    });
  } catch {
    /* forget it locally regardless */
  }
  deleteProfile(profile);
  return true;
}

module.exports = { login, refresh, accessToken, logout, getProfile, listProfiles, fetchDiscordUser };
