// Discord sign-in for the Activity: the browser gets a one-time code from the Discord
// client (sdk.commands.authorize), we swap it for an access token here (that needs the
// client secret, so it can't happen in the browser), and later check who a token belongs to.

import { config } from './config.js';

const API = 'https://discord.com/api/v10';

export async function exchangeCode(code) {
  const r = await fetch(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.access_token) throw new Error(data.error_description || data.error || `HTTP ${r.status}`);
  return data.access_token;
}

const cache = new Map(); // token -> { user, guilds, at }

/** { id, name } of a token's user (+ guild IDs when a server allow-list is set). */
export async function whoIs(token) {
  // local testing without Discord (DEV_TOKEN in .env; never set it on a public server)
  if (config.devToken && token === config.devToken) return { user: { id: 'dev', name: 'dev' }, guilds: null };
  const hit = cache.get(token);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
  const headers = { Authorization: `Bearer ${token}` };
  const r = await fetch(`${API}/users/@me`, { headers });
  if (!r.ok) throw new Error('Discord 登入已失效');
  const u = await r.json();
  let guilds = null;
  if (config.allowedGuilds.length) {
    const g = await fetch(`${API}/users/@me/guilds`, { headers });
    guilds = g.ok ? (await g.json()).map((x) => x.id) : [];
  }
  const entry = { user: { id: u.id, name: u.global_name || u.username }, guilds, at: Date.now() };
  cache.set(token, entry);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return entry;
}

/** May this user use the Activity in this server? */
export function allowed(entry, guildId) {
  if (!config.allowedGuilds.length) return true;
  return Boolean(guildId && config.allowedGuilds.includes(guildId) && entry.guilds?.includes(guildId));
}
