// CinemaRoom: a Discord Activity for watching bilibili / niconico videos and
// live streams (and YouTube live streams) together in a voice channel, with the comments.
//
// One HTTP server does everything (it sits behind Discord's proxy, so it is one origin):
//   /                 the Activity page (public/)
//   /api/config       the client ID for the Discord SDK
//   /api/token        swaps the SDK's one-time code for an access token
//   /ws               the room: commands in, state / comments out
//   /media/<job>/…    HLS playlists and segments
//   /thumb/<room>/<item>  cover pictures (fetched here: the Activity can't load other sites)

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { checkConfig, config } from './config.js';
import { allowed, exchangeCode, whoIs } from './discord.js';
import { clearCache, mediaFile } from './media.js';
import { request } from './net.js';
import { findRoom, room, roomCount } from './rooms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const missing = checkConfig();
if (missing.length) {
  console.error(`.env 缺少：${missing.join('、')}（見 .env.example）`);
  process.exit(1);
}
clearCache();

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
};

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 16 * 1024) {
  return new Promise((ok, fail) => {
    let size = 0;
    const parts = [];
    req.on('data', (d) => {
      size += d.length;
      if (size > limit) {
        fail(new Error('too large'));
        req.destroy();
      } else parts.push(d);
    });
    req.on('end', () => ok(Buffer.concat(parts).toString('utf8')));
    req.on('error', fail);
  });
}

function serveFile(res, file, cache) {
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': statSync(file).size, 'Cache-Control': cache });
  createReadStream(file).pipe(res);
}

const thumbs = new Map(); // url -> { type, body, at }

async function serveThumb(res, roomId, key) {
  const url = findRoom(roomId)?.thumb(key);
  if (!url) return sendJson(res, 404, { error: 'not found' });
  let hit = thumbs.get(url);
  if (!hit || (!hit.body && Date.now() - hit.at > 10 * 60_000)) {
    hit = { type: '', body: null, at: Date.now() };
    try {
      const r = await request(url, { headers: { Referer: new URL(url).origin + '/' } });
      if (r.status < 400 && /^image\//.test(r.headers['content-type'] || '')) hit = { type: r.headers['content-type'], body: r.body, at: Date.now() };
    } catch {
      /* remembered as missing for a while */
    }
    thumbs.set(url, hit);
    if (thumbs.size > 200) thumbs.delete(thumbs.keys().next().value);
  }
  if (!hit.body) return sendJson(res, 404, { error: 'thumb' });
  res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': 'public, max-age=86400' });
  res.end(hit.body);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = decodeURIComponent(u.pathname).replace(/^\/\.proxy(?=\/)/, '');
  try {
    if (p === '/api/config') return sendJson(res, 200, { clientId: config.clientId, version: VERSION });
    if (p === '/api/token' && req.method === 'POST') {
      const { code } = JSON.parse((await readBody(req)) || '{}');
      if (!code) return sendJson(res, 400, { error: 'code' });
      return sendJson(res, 200, { access_token: await exchangeCode(String(code)) });
    }
    if (p === '/healthz') return sendJson(res, 200, { ok: true, rooms: roomCount() });
    let m = /^\/media\/([0-9a-f]{24})\/([\w.-]+)$/.exec(p);
    if (m) {
      const f = mediaFile(m[1], m[2]);
      if (!f) return sendJson(res, 404, { error: 'not found' });
      // playlists change while a video is being prepared / a stream runs; segments never do
      return serveFile(res, f.file, m[2].endsWith('.m3u8') ? 'no-cache' : 'public, max-age=86400, immutable');
    }
    m = /^\/thumb\/([^/]+)\/([0-9a-f]+)$/.exec(p);
    if (m) return await serveThumb(res, m[1], m[2]);
    // the Activity page
    const rel = p === '/' ? 'index.html' : p.slice(1);
    const file = path.join(PUBLIC, rel);
    if (file.startsWith(PUBLIC + path.sep) && existsSync(file) && statSync(file).isFile()) {
      // Discord caches hard: the page itself is never cached, the files it loads carry ?v=
      return serveFile(res, file, rel === 'index.html' ? 'no-cache' : 'public, max-age=300');
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`${req.method} ${p}:`, e.message);
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.destroy();
  }
});

/* ---------- the room connection ---------- */

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/\.proxy(?=\/)/, '');
  if (p !== '/ws') return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  let joined = null; // { room, user }
  let alive = true;
  ws.on('pong', () => {
    alive = true;
  });
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);
  const say = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (msg.type === 'time') return say({ type: 'time', c: msg.c, s: Date.now() });
    try {
      if (msg.type === 'hello') {
        if (joined) return;
        const who = await whoIs(String(msg.token || ''));
        const instance = String(msg.instanceId || '').slice(0, 100);
        if (!instance) throw new Error('缺少 Activity instance');
        if (!allowed(who, msg.guildId)) throw new Error('這個伺服器不能使用');
        joined = { room: room(instance, { guildId: msg.guildId }), user: who.user };
        joined.room.join(ws, who.user);
        return say({ type: 'welcome', user: who.user });
      }
      if (!joined) throw new Error('還沒登入');
      joined.room.command(joined.user, msg);
    } catch (e) {
      say({ type: 'error', text: e.message });
    }
  });
  ws.on('close', () => {
    clearInterval(ping);
    joined?.room.leave(ws);
  });
  ws.on('error', () => {});
});

server.listen(config.port, config.host, () => {
  console.log(`CinemaRoom ${VERSION}：http://${config.host}:${config.port}`);
});
