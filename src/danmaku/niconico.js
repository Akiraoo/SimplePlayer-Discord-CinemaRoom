// niconico comments:
//  - videos: yt-dlp hands over the comment list (with --write-subs) as JSON
//  - live programs: the watch WebSocket gives a "view" address; comments then come as
//    protobuf streams (niconico's "NDGR" message server)

import { EventEmitter } from 'node:events';
import { UA, getText, stream } from '../net.js';
import { MAX_VOD, clean, xmlUnescape } from './common.js';
import { LengthDelimited, decode, first, str, sub } from './proto.js';

// commands / modifier colours (the premium "2" colours have names of their own)
const COLORS = {
  white: '#ffffff',
  red: '#ff0000',
  pink: '#ff8080',
  orange: '#ffc000',
  yellow: '#ffff00',
  green: '#00ff00',
  cyan: '#00ffff',
  blue: '#0000ff',
  purple: '#c000ff',
  black: '#000000',
  white2: '#cccc99',
  niconicowhite: '#cccc99',
  red2: '#cc0033',
  truered: '#cc0033',
  pink2: '#ff33cc',
  orange2: '#ff6600',
  passionorange: '#ff6600',
  yellow2: '#999900',
  madyellow: '#999900',
  green2: '#00cc66',
  elementalgreen: '#00cc66',
  cyan2: '#00cccc',
  marineblue: '#00cccc',
  blue2: '#3399ff',
  purple2: '#6633cc',
  nobleviolet: '#6633cc',
  black2: '#666666',
};
const NAMED = [
  'white', 'red', 'pink', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'black',
  'white2', 'red2', 'pink2', 'orange2', 'yellow2', 'green2', 'cyan2', 'blue2', 'purple2', 'black2',
];

/** mode / colour / size from a comment's command list ("ue red big" …). */
export function fromCommands(commands = []) {
  let mode = 'scroll';
  let color = '#ffffff';
  let size = 'normal';
  for (const raw of commands) {
    const c = String(raw).toLowerCase();
    if (c === 'ue') mode = 'top';
    else if (c === 'shita') mode = 'bottom';
    else if (c === 'big') size = 'big';
    else if (c === 'small') size = 'small';
    else if (COLORS[c]) color = COLORS[c];
    else if (/^#[0-9a-f]{6}$/.test(c)) color = c;
  }
  return { mode, color, size };
}

/** Video comments from yt-dlp's JSON (comments the community voted down are skipped). */
export function parseVod(json) {
  let list;
  try {
    list = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (out.length >= MAX_VOD) break;
    if (typeof c?.score === 'number' && c.score <= -4800) continue; // niconico's own NG level
    const text = clean(c?.body);
    if (!text) continue;
    out.push({ t: (Number(c.vposMs) || 0) / 1000, text, ...fromCommands(c.commands) });
  }
  return out.sort((a, b) => a.t - b.t);
}

/* ---------------- live ---------------- */

/** One live chat from a decoded ChunkedMessage (null if it isn't a chat). */
export function chatFromMessage(fields) {
  const msg = sub(fields, 2); // NicoliveMessage
  if (!msg) return null;
  const chat = sub(msg, 1) || sub(msg, 20); // chat / overflowed_chat
  if (!chat) return null;
  const text = clean(str(first(chat, 1)));
  if (!text) return null;
  const mod = sub(chat, 7) || {};
  const pos = first(mod, 1) || 0;
  const size = first(mod, 2) || 0;
  let color = '#ffffff';
  if (mod[3] !== undefined) color = COLORS[NAMED[first(mod, 3)]] || color;
  const full = sub(mod, 4);
  if (full) {
    const hex = (n) => Math.max(0, Math.min(255, Number(first(full, n)) || 0)).toString(16).padStart(2, '0');
    color = `#${hex(1)}${hex(2)}${hex(3)}`;
  }
  return {
    text,
    mode: pos === 2 ? 'top' : pos === 1 ? 'bottom' : 'scroll',
    color,
    size: size === 2 ? 'big' : size === 1 ? 'small' : 'normal',
    user: clean(str(first(chat, 2)) || '', 40) || undefined,
  };
}

/** The program's settings embedded in its watch page. */
export function embeddedData(html) {
  const m = /<script[^>]*id="embedded-data"[^>]*data-props="([^"]*)"/.exec(html);
  if (!m) throw new Error('找不到節目資料（節目不存在或需要登入）');
  return JSON.parse(xmlUnescape(m[1]));
}

/**
 * Live comments of one program (lv…). Emits 'comment' and 'status'. Connects without
 * the account's cookie on purpose: one account can only watch a program once at a time,
 * and the video itself (through yt-dlp) already uses that seat.
 */
export class NicoLive extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.stopped = false;
    this.ws = null;
    this.abort = new AbortController();
    this.segments = new Set();
    this.retry = 0;
    this.keep = null;
  }

  start() {
    this.connect().catch((e) => this.fail(e));
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.keep);
    this.abort.abort();
    this.ws?.close();
  }

  fail(e) {
    if (this.stopped) return;
    this.emit('status', `niconico 留言連線失敗：${e.message}`);
    clearInterval(this.keep);
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.abort.abort();
    this.abort = new AbortController();
    const wait = Math.min(60, 3 * 2 ** this.retry++);
    setTimeout(() => this.connect().catch((err) => this.fail(err)), wait * 1000);
  }

  async connect() {
    if (this.stopped) return;
    const html = await getText(this.url, { headers: { 'Accept-Language': 'ja' } });
    const data = embeddedData(html);
    const wsUrl = data?.site?.relive?.webSocketUrl;
    if (!wsUrl) throw new Error('節目沒有提供留言伺服器（可能還沒開始或已經結束）');
    const u = new URL(wsUrl);
    u.searchParams.set('frontend_id', String(data?.site?.frontendId ?? 9));
    // Node's own WebSocket (it takes extra headers, and follows the system proxy settings)
    const ws = new WebSocket(u, { headers: { 'User-Agent': UA, Origin: 'https://live.nicovideo.jp' } });
    this.ws = ws;
    let gotServer = false;
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'startWatching',
          data: {
            reconnect: false,
            room: { protocol: 'webSocket', commentable: true },
            stream: { quality: 'abr', protocol: 'hls', latency: 'high', chasePlay: false },
          },
        }),
      );
    });
    ws.addEventListener('message', (ev) => {
      let m;
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === 'ping') {
        ws.send('{"type":"pong"}');
        ws.send('{"type":"keepSeat"}');
      } else if (m.type === 'seat') {
        clearInterval(this.keep);
        const every = Math.max(10, Number(m.data?.keepIntervalSec) || 30) * 1000;
        this.keep = setInterval(() => ws.readyState === 1 && ws.send('{"type":"keepSeat"}'), every);
      } else if (m.type === 'messageServer' && m.data?.viewUri) {
        if (gotServer) return;
        gotServer = true;
        this.retry = 0;
        this.emit('status', 'niconico 留言已連線');
        this.view(m.data.viewUri).catch((e) => this.fail(e));
      } else if (m.type === 'disconnect') {
        this.fail(new Error(`伺服器斷線（${m.data?.reason || '?'}）`));
      } else if (m.type === 'error') {
        this.fail(new Error(m.data?.code || 'error'));
      }
    });
    ws.addEventListener('close', () => {
      clearInterval(this.keep);
      // closed before the comments started: try again (after that the view stream carries on)
      if (!gotServer && this.ws === ws) this.fail(new Error('連線中斷'));
    });
  }

  /** Follows the view stream: each entry names a segment of comments, or when to ask next. */
  async view(viewUri) {
    let at = 'now';
    while (!this.stopped) {
      let next = null;
      const split = new LengthDelimited();
      await stream(`${viewUri}${viewUri.includes('?') ? '&' : '?'}at=${at}`, {
        signal: this.abort.signal,
        onData: (chunk) => {
          for (const m of split.push(chunk)) {
            const entry = decode(m);
            const seg = sub(entry, 1); // segment
            if (seg) this.segment(str(first(seg, 3)));
            const nx = sub(entry, 4); // next
            if (nx) next = first(nx, 1);
          }
        },
      });
      if (!next) throw new Error('留言串流結束');
      at = next;
    }
  }

  segment(uri) {
    if (!uri || this.segments.has(uri) || this.stopped) return;
    this.segments.add(uri);
    if (this.segments.size > 200) this.segments.delete(this.segments.values().next().value);
    const split = new LengthDelimited();
    stream(uri, {
      signal: this.abort.signal,
      onData: (chunk) => {
        for (const m of split.push(chunk)) {
          try {
            const c = chatFromMessage(decode(m));
            if (c) this.emit('comment', c);
          } catch {
            /* a message we don't understand */
          }
        }
      },
    }).catch(() => {});
  }
}
