// bilibili comments (彈幕):
//  - videos: the XML at comment.bilibili.com/<cid>.xml (yt-dlp tells us its address)
//  - live rooms: the danmaku WebSocket (live.bilibili.com's own protocol)

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import zlib from 'node:zlib';
import { cookieHeader, cookiesFor } from '../cookies.js';
import { UA, getJson, getText } from '../net.js';
import { MAX_VOD, clean, hexColor, xmlUnescape } from './common.js';

const MODES = { 1: 'scroll', 2: 'scroll', 3: 'scroll', 4: 'bottom', 5: 'top', 6: 'scroll' };

/** Comments in a bilibili danmaku XML (advanced / code comments are left out). */
export function parseXml(xml) {
  const out = [];
  const re = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let m;
  while ((m = re.exec(xml)) && out.length < MAX_VOD) {
    const p = m[1].split(',');
    const mode = MODES[p[1]];
    if (!mode) continue;
    const size = Number(p[2]);
    out.push({
      t: Number(p[0]) || 0,
      text: clean(xmlUnescape(m[2])),
      mode,
      color: hexColor(p[3]),
      size: size >= 30 ? 'big' : size && size < 22 ? 'small' : 'normal',
    });
  }
  return out.filter((c) => c.text).sort((a, b) => a.t - b.t);
}

export async function fetchVod(url, cookieFile) {
  const jar = cookiesFor(cookieFile, 'bilibili.com');
  const xml = await getText(url, {
    headers: { Referer: 'https://www.bilibili.com/', Cookie: cookieHeader(jar) },
  });
  return parseXml(xml);
}

/* ---------------- live ---------------- */

// WBI request signing (bilibili's web API): the key is mixed from two image names.
const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

export function wbiSign(params, imgKey, subKey, now = Date.now()) {
  const raw = imgKey + subKey;
  const mixin = MIXIN.map((i) => raw[i]).join('').slice(0, 32);
  const all = { ...params, wts: Math.floor(now / 1000) };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  const w_rid = createHash('md5').update(query + mixin).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

const OP = { HEARTBEAT: 2, HEARTBEAT_REPLY: 3, MESSAGE: 5, AUTH: 7, AUTH_REPLY: 8 };

export function packet(op, body) {
  const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const head = Buffer.alloc(16);
  head.writeUInt32BE(16 + data.length, 0);
  head.writeUInt16BE(16, 4);
  head.writeUInt16BE(1, 6);
  head.writeUInt32BE(op, 8);
  head.writeUInt32BE(1, 12);
  return Buffer.concat([head, data]);
}

/** Splits a WebSocket frame into { op, body } packets, unpacking compressed ones. */
export function unpack(buf) {
  const out = [];
  let pos = 0;
  while (pos + 16 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const headLen = buf.readUInt16BE(pos + 4);
    const ver = buf.readUInt16BE(pos + 6);
    const op = buf.readUInt32BE(pos + 8);
    if (len < 16 || pos + len > buf.length) break;
    const body = buf.subarray(pos + headLen, pos + len);
    if (op === OP.MESSAGE && ver === 2) out.push(...unpack(zlib.inflateSync(body)));
    else if (op === OP.MESSAGE && ver === 3) out.push(...unpack(zlib.brotliDecompressSync(body)));
    else out.push({ op, body });
    pos += len;
  }
  return out;
}

/** A live comment from one message (null for messages that aren't comments). */
export function toComment(msg) {
  const cmd = String(msg?.cmd || '');
  if (cmd.startsWith('DANMU_MSG')) {
    const info = msg.info || [];
    const text = clean(info[1]);
    if (!text) return null;
    return {
      text,
      mode: info[0]?.[1] === 4 ? 'bottom' : info[0]?.[1] === 5 ? 'top' : 'scroll',
      color: hexColor(info[0]?.[3] ?? 0xffffff),
      size: 'normal',
      user: clean(info[2]?.[1], 40),
    };
  }
  if (cmd === 'SUPER_CHAT_MESSAGE') {
    const d = msg.data || {};
    const text = clean(d.message);
    if (!text) return null;
    return {
      text,
      mode: 'top',
      color: d.background_bottom_color || '#ffd54f',
      size: 'big',
      user: clean(d.user_info?.uname, 40),
      paid: d.price ? `¥${d.price}` : true,
    };
  }
  return null;
}

/** Room number from a live.bilibili.com link. */
export function roomFromUrl(url) {
  const m = /live\.bilibili\.com\/(?:h5\/|blanc\/)?(\d+)/.exec(url);
  return m ? Number(m[1]) : null;
}

/**
 * Live comments of one room. Emits 'comment' ({ text, … }) and 'status' (text);
 * reconnects by itself until stop().
 */
export class BiliLive extends EventEmitter {
  constructor(room, cookieFile) {
    super();
    this.room = room;
    this.cookieFile = cookieFile;
    this.stopped = false;
    this.ws = null;
    this.timer = null;
    this.retry = 0;
  }

  start() {
    this.connect().catch((e) => this.fail(e));
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.ws?.close();
  }

  fail(e) {
    if (this.stopped) return;
    this.emit('status', `bilibili 彈幕連線失敗：${e.message}`);
    clearInterval(this.timer);
    const wait = Math.min(60, 3 * 2 ** this.retry++);
    setTimeout(() => this.connect().catch((err) => this.fail(err)), wait * 1000);
  }

  async connect() {
    if (this.stopped) return;
    const jar = cookiesFor(this.cookieFile, 'bilibili.com');
    const headers = {
      Referer: `https://live.bilibili.com/${this.room}`,
      Origin: 'https://live.bilibili.com',
      Cookie: cookieHeader(jar),
    };
    const init = await getJson(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${this.room}`, { headers });
    const roomId = init?.data?.room_id || this.room;
    const nav = await getJson('https://api.bilibili.com/x/web-interface/nav', { headers });
    const key = (u) => String(u || '').split('/').pop().split('.')[0];
    const imgKey = key(nav?.data?.wbi_img?.img_url);
    const subKey = key(nav?.data?.wbi_img?.sub_url);
    const q = wbiSign({ id: roomId, type: 0, web_location: '444.8' }, imgKey, subKey);
    const info = await getJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${q}`, { headers });
    if (info?.code !== 0) throw new Error(info?.message || `getDanmuInfo ${info?.code}`);
    const host = info.data.host_list?.[0] || { host: 'broadcastlv.chat.bilibili.com', wss_port: 443 };
    // Node's own WebSocket (takes extra headers, follows the system proxy settings)
    const ws = new WebSocket(`wss://${host.host}:${host.wss_port || 443}/sub`, {
      headers: { 'User-Agent': UA, Origin: 'https://live.bilibili.com', Cookie: headers.Cookie },
    });
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(
        packet(OP.AUTH, {
          uid: Number(jar.DedeUserID) || 0,
          roomid: roomId,
          protover: 3,
          buvid: jar.buvid3 || '',
          platform: 'web',
          type: 2,
          key: info.data.token,
        }),
      );
      this.timer = setInterval(() => ws.readyState === 1 && ws.send(packet(OP.HEARTBEAT, '')), 30_000);
    });
    ws.addEventListener('message', (ev) => {
      let packets;
      try {
        packets = unpack(Buffer.from(ev.data));
      } catch {
        return;
      }
      for (const p of packets) {
        if (p.op === OP.AUTH_REPLY) {
          this.retry = 0;
          this.emit('status', jar.SESSDATA ? 'bilibili 彈幕已連線' : 'bilibili 彈幕已連線（沒有登入 cookie，名稱可能被隱藏）');
        } else if (p.op === OP.MESSAGE) {
          try {
            const c = toComment(JSON.parse(p.body.toString('utf8')));
            if (c) this.emit('comment', c);
          } catch {
            /* not JSON */
          }
        }
      }
    });
    ws.addEventListener('close', () => {
      clearInterval(this.timer);
      if (!this.stopped && this.ws === ws) this.fail(new Error('連線中斷'));
    });
  }
}
