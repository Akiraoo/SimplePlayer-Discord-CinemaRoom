// One room per Activity instance (= one voice channel watching together): the queue,
// what is playing and where, and the comments. The server's clock is the reference;
// every browser follows it.

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { config } from './config.js';
import { BiliLive, fetchVod as biliVod, roomFromUrl } from './danmaku/bilibili.js';
import { NicoLive, parseVod as nicoVod } from './danmaku/niconico.js';
import { YouTubeChat } from './danmaku/youtube.js';
import { acquire, baseArgs, release, resolve } from './media.js';

const rooms = new Map();

export function room(id, meta = {}) {
  let r = rooms.get(id);
  if (!r) {
    r = new Room(id, meta);
    rooms.set(id, r);
  }
  return r;
}

export function roomCount() {
  return rooms.size;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// sent to the browsers (restarts, comments' addresses etc. stay here)
const PUBLIC = ['key', 'url', 'title', 'uploader', 'duration', 'live', 'site', 'by', 'status', 'error', 'media'];

class Room {
  constructor(id, meta) {
    this.id = id;
    this.guildId = meta.guildId || null;
    this.clients = new Map(); // ws -> user
    this.queue = [];
    this.index = -1;
    this.playing = false;
    this.pos = 0;
    this.ref = Date.now();
    this.ready = false;
    this.job = null;
    this.unsubJob = null;
    this.source = null; // live comments
    this.vod = new Map(); // item key -> comments
    this.liveBuf = [];
    this.flushTimer = null;
    this.idleTimer = null;
    this.advanceTimer = null;
    this.tick = setInterval(() => this.onTick(), 1000);
  }

  get current() {
    return this.queue[this.index] || null;
  }

  /* ---------- people ---------- */

  join(ws, user) {
    clearTimeout(this.idleTimer);
    this.clients.set(ws, user);
    this.broadcast();
    const cur = this.current;
    if (cur && this.vod.has(cur.key)) send(ws, { type: 'comments', key: cur.key, list: this.vod.get(cur.key) });
    if (this.notice) send(ws, { type: 'notice', text: this.notice });
  }

  leave(ws) {
    this.clients.delete(ws);
    if (this.clients.size) {
      this.broadcast();
      return;
    }
    // everyone left: keep the room a minute (someone may just be reloading), then drop it
    this.idleTimer = setTimeout(() => this.destroy(), 60_000);
  }

  destroy() {
    clearInterval(this.tick);
    clearTimeout(this.advanceTimer);
    this.unload();
    rooms.delete(this.id);
  }

  /* ---------- state ---------- */

  position() {
    const cur = this.current;
    if (!cur || cur.live) return 0;
    let p = this.pos;
    if (this.playing && this.ready) p += (Date.now() - this.ref) / 1000;
    return cur.duration ? Math.min(p, cur.duration) : p;
  }

  snapshot() {
    return {
      type: 'state',
      queue: this.queue.map((it) => {
        const o = {};
        for (const k of PUBLIC) if (it[k] !== undefined) o[k] = it[k];
        if (it.thumb) o.thumb = `/thumb/${this.id}/${it.key}`;
        return o;
      }),
      index: this.index,
      playing: this.playing,
      ready: this.ready,
      pos: this.position(),
      now: Date.now(),
      viewers: [...new Set([...this.clients.values()].map((u) => u.name))],
    };
  }

  broadcast() {
    const msg = this.snapshot();
    for (const ws of this.clients.keys()) send(ws, msg);
  }

  notify(text) {
    this.notice = text;
    for (const ws of this.clients.keys()) send(ws, { type: 'notice', text });
  }

  /* ---------- commands ---------- */

  command(user, msg) {
    switch (msg.type) {
      case 'add':
        return this.add(user, String(msg.url || '').trim());
      case 'remove':
        return this.remove(msg.key);
      case 'jump':
        return this.jump(this.queue.findIndex((it) => it.key === msg.key));
      case 'next':
        return this.jump(this.index + 1);
      case 'prev':
        return this.jump(Math.max(0, this.index - 1));
      case 'play':
        if (this.ended && this.current) {
          // played to the end: start it over
          this.ended = false;
          this.pos = 0;
        }
        if (!this.playing) {
          this.pos = this.position();
          this.ref = Date.now();
          this.playing = true;
        }
        return this.broadcast();
      case 'pause':
        if (this.playing) {
          this.pos = this.position();
          this.playing = false;
        }
        return this.broadcast();
      case 'seek': {
        const cur = this.current;
        if (!cur || cur.live) return;
        const t = Number(msg.t);
        if (!Number.isFinite(t)) return;
        this.pos = Math.max(0, cur.duration ? Math.min(t, cur.duration) : t);
        this.ref = Date.now();
        this.ended = false;
        return this.broadcast();
      }
      default:
    }
  }

  add(user, url) {
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('請貼上影片或直播的網址');
    if (this.queue.length >= config.maxQueue) throw new Error(`清單最多 ${config.maxQueue} 個`);
    const item = {
      key: randomBytes(6).toString('hex'),
      url,
      title: url,
      by: user.name,
      status: 'resolving',
      duration: 0,
      live: false,
    };
    // nothing playing (empty, or the list played to the end): start the new one
    const startNow = !this.current || this.ended;
    this.queue.push(item);
    if (startNow) {
      this.ended = false;
      this.index = this.queue.length - 1;
    }
    this.broadcast();
    resolve(url)
      .then((info) => {
        Object.assign(item, info, { status: 'queued' });
        // the resolved page address is the one to download (short links, redirects)
        if (this.current === item) this.load();
        else this.broadcast();
      })
      .catch((e) => {
        item.status = 'error';
        item.error = e.message;
        this.broadcast();
        if (this.current === item) this.skipSoon();
      });
    if (startNow) this.load();
  }

  remove(key) {
    const i = this.queue.findIndex((it) => it.key === key);
    if (i < 0) return;
    const wasCurrent = i === this.index;
    this.queue.splice(i, 1);
    this.vod.delete(key);
    if (i < this.index) this.index--;
    if (wasCurrent) {
      if (this.index >= this.queue.length) this.index = this.queue.length - 1;
      this.load();
    } else this.broadcast();
  }

  jump(i) {
    if (i < 0 || i >= this.queue.length) {
      if (i >= this.queue.length && this.queue.length) {
        // past the end: stop after the last one
        this.unload();
        this.ended = true;
        this.index = this.queue.length;
        this.playing = false;
        this.broadcast();
      }
      return;
    }
    this.index = i;
    this.ended = false;
    this.load();
  }

  skipSoon() {
    clearTimeout(this.advanceTimer);
    this.advanceTimer = setTimeout(() => {
      if (this.current?.status === 'error') this.jump(this.index + 1);
    }, 4000);
  }

  /* ---------- the current item ---------- */

  unload() {
    this.unsubJob?.();
    this.unsubJob = null;
    release(this.job);
    this.job = null;
    this.source?.stop();
    this.source = null;
    this.notice = '';
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.liveBuf = [];
    for (const it of this.queue) delete it.media;
  }

  load() {
    clearTimeout(this.advanceTimer);
    this.unload();
    this.ready = false;
    this.pos = 0;
    this.ref = Date.now();
    this.playing = true;
    const item = this.current;
    if (!item) {
      this.playing = false;
      return this.broadcast();
    }
    if (item.status === 'resolving') return this.broadcast(); // load() runs again when it is known
    if (item.status === 'error') {
      this.broadcast();
      return this.skipSoon();
    }
    item.status = 'preparing';
    item.error = undefined;
    const job = acquire(item.url, item.live);
    this.job = job;
    const onJob = (j) => {
      if (this.job !== j) return;
      if (j.state === 'ready' || (j.state === 'done' && !item.live)) {
        item.status = 'ready';
        item.media = j.playlist;
        if (!this.ready) {
          this.ready = true;
          this.ref = Date.now();
        }
      } else if (j.state === 'done' && item.live) {
        // the stream stopped: a dropped connection is retried a few times, then it counts as over
        const now = Date.now();
        item.restarts = (item.restarts || []).filter((t) => now - t < 5 * 60_000);
        if (item.restarts.length < 3) {
          item.restarts.push(now);
          this.notify('直播中斷，重新連線中…');
          return this.load();
        }
        this.notify('直播結束了');
        return this.jump(this.index + 1);
      } else if (j.state === 'error') {
        item.status = 'error';
        item.error = j.error;
        this.skipSoon();
      }
      this.broadcast();
    };
    this.unsubJob = job.onChange(onJob);
    if (job.state !== 'starting') onJob(job);
    this.loadComments(item);
    this.broadcast();
  }

  loadComments(item) {
    if (!item.live && item.comments && !this.vod.has(item.key)) {
      const c = item.comments;
      const p = c.type === 'bili-xml' ? biliVod(c.url, config.cookies) : Promise.resolve(nicoVod(c.data));
      p.then((list) => {
        this.vod.set(item.key, list);
        if (this.current !== item) return;
        for (const ws of this.clients.keys()) send(ws, { type: 'comments', key: item.key, list });
      }).catch((e) => this.notify(`彈幕讀取失敗：${e.message}`));
    } else if (!item.live && this.vod.has(item.key)) {
      const list = this.vod.get(item.key);
      for (const ws of this.clients.keys()) send(ws, { type: 'comments', key: item.key, list });
    }
    const lc = item.live && item.liveComments;
    if (!lc) return;
    let src = null;
    if (lc.type === 'bili') {
      const r = roomFromUrl(lc.url);
      if (r) src = new BiliLive(r, config.cookies);
    } else if (lc.type === 'nico') {
      src = new NicoLive(lc.url);
    } else if (lc.type === 'youtube') {
      src = new YouTubeChat(lc.url, {
        ytdlp: config.ytdlp,
        base: baseArgs(),
        dir: path.join(path.resolve(config.cacheDir), `chat-${this.id.slice(0, 16)}-${item.key}`),
      });
    }
    if (!src) return;
    this.source = src;
    src.on('status', (t) => this.notify(t));
    src.on('comment', (c) => {
      if (this.source !== src) return;
      this.liveBuf.push(c);
      if (this.liveBuf.length > 300) this.liveBuf.splice(0, this.liveBuf.length - 300);
      this.flushTimer ||= setTimeout(() => {
        this.flushTimer = null;
        const items = this.liveBuf.splice(0);
        for (const ws of this.clients.keys()) send(ws, { type: 'live', key: item.key, items });
      }, 250);
    });
    src.start();
  }

  onTick() {
    const cur = this.current;
    if (!cur || cur.live || !this.playing || !this.ready || !cur.duration) return;
    if (this.position() >= cur.duration - 0.05 && Date.now() - this.ref > 1500) {
      if (this.index + 1 < this.queue.length) this.jump(this.index + 1);
      else {
        this.pos = cur.duration;
        this.playing = false;
        this.ended = true;
        this.broadcast();
      }
    }
  }

  thumb(key) {
    return this.queue.find((it) => it.key === key)?.thumb || null;
  }
}

export function findRoom(id) {
  return rooms.get(id) || null;
}
