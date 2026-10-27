// One room per Activity instance (= one voice channel watching together): the queue,
// what is playing and where, and the comments. The server's clock is the reference;
// every browser follows it.

import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { config } from './config.js';
import { BiliLive, fetchVod as biliVod, roomFromUrl } from './danmaku/bilibili.js';
import { NicoLive, parseVod as nicoVod } from './danmaku/niconico.js';
import { YouTubeChat } from './danmaku/youtube.js';
import { acquire, baseArgs, release, resolve, thumbPath } from './media.js';

const rooms = new Map();

const newKey = () => randomBytes(6).toString('hex');

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
const PUBLIC = ['key', 'url', 'title', 'uploader', 'duration', 'live', 'site', 'by', 'status', 'error', 'media', 'group'];

class Room {
  constructor(id, meta) {
    this.id = id;
    this.guildId = meta.guildId || null;
    this.clients = new Map(); // ws -> user
    this.queue = [];
    this.groups = new Map(); // playlist key -> { title, thumb, url, site, by }
    this.index = -1;
    this.seekGen = 0; // bumped on every jump in position: the players snap to it
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
        if (it.thumb) o.thumb = thumbPath(it.thumb);
        return o;
      }),
      groups: Object.fromEntries(
        [...this.groups].map(([k, g]) => [k, { title: g.title, url: g.url, site: g.site, by: g.by, thumb: thumbPath(g.thumb) }]),
      ),
      index: this.index,
      playing: this.playing,
      ready: this.ready,
      seek: this.seekGen,
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
      case 'remove-group':
        return this.removeGroup(msg.group);
      case 'move':
        return this.move(msg.key, Number(msg.dir));
      case 'jump': {
        const i = this.queue.findIndex((it) => it.key === msg.key);
        return i >= 0 && this.jump(i);
      }
      case 'next':
        return this.jump(this.index + 1);
      case 'prev':
        // played videos are gone from the list: "back" starts this one over
        if (!this.current || this.current.live) return;
        this.pos = 0;
        this.ref = Date.now();
        this.seekGen++;
        return this.broadcast();
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
        this.seekGen++;
        this.ended = false;
        return this.broadcast();
      }
      default:
    }
  }

  /** Videos and playlists at the top of the list (a playlist counts once). */
  units() {
    return new Set(this.queue.map((it) => it.group || it.key)).size;
  }

  add(user, url) {
    if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('請貼上影片、直播或播放清單的網址');
    if (this.units() >= config.maxQueue) throw new Error(`清單最多 ${config.maxQueue} 項`);
    if (this.queue.length >= 1000) throw new Error('清單裡的影片太多了');
    const item = {
      key: newKey(),
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
        if (info.playlist) return this.expand(item, info, user);
        Object.assign(item, info, { status: 'queued', resolved: true });
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

  /** A playlist link: its videos take the placeholder's place, grouped under one entry. */
  expand(item, info, user) {
    const group = `g${newKey()}`;
    this.groups.set(group, { title: info.title, thumb: info.thumb, url: info.url, site: info.site, by: user.name });
    const room = 1000 - this.queue.length + 1;
    const make = (e) => ({
      key: newKey(),
      url: e.url,
      title: e.title,
      duration: e.duration,
      thumb: e.thumb,
      site: info.site,
      by: user.name,
      status: 'queued',
      live: false,
      group,
    });
    const rest = info.entries.slice(1, room).map(make);
    Object.assign(item, make(info.entries[0]), { key: item.key });
    const at = this.queue.indexOf(item);
    this.queue.splice(at + 1, 0, ...rest);
    if (at < this.index) this.index += rest.length;
    if (this.current === item) this.load();
    else this.broadcast();
  }

  remove(key) {
    const i = this.queue.findIndex((it) => it.key === key);
    if (i < 0) return;
    const wasCurrent = i === this.index;
    const group = this.queue[i].group;
    this.queue.splice(i, 1);
    this.vod.delete(key);
    if (group && !this.queue.some((it) => it.group === group)) this.groups.delete(group);
    if (i < this.index) this.index--;
    if (wasCurrent) {
      if (this.index >= this.queue.length) this.index = this.queue.length - 1;
      this.load();
    } else this.broadcast();
  }

  /** Removes a whole playlist. */
  removeGroup(group) {
    if (!this.groups.has(group)) return;
    const cur = this.current;
    const removedCurrent = cur?.group === group;
    let before = 0;
    for (let i = 0; i < this.index && i < this.queue.length; i++) if (this.queue[i].group === group) before++;
    for (const it of this.queue) if (it.group === group) this.vod.delete(it.key);
    this.queue = this.queue.filter((it) => it.group !== group);
    this.groups.delete(group);
    this.index -= before;
    if (removedCurrent) {
      if (this.index >= this.queue.length) this.index = this.queue.length - 1;
      this.load();
    } else this.broadcast();
  }

  /** Moves a video up / down inside its playlist (or among the single videos). */
  move(key, dir) {
    const i = this.queue.findIndex((it) => it.key === key);
    const j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= this.queue.length) return;
    if ((this.queue[i].group || null) !== (this.queue[j].group || null)) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    if (this.index === i) this.index = j;
    else if (this.index === j) this.index = i;
    this.broadcast();
  }

  /** Looks up the next video ahead of time, so it starts quickly. */
  prefetch() {
    const n = this.queue[this.index + 1];
    if (!n || n.resolved || n.status !== 'queued') return;
    resolve(n.url)
      .then((info) => {
        if (info.playlist || n.resolved || n.status !== 'queued') return;
        Object.assign(n, info, { status: 'queued', resolved: true, key: n.key, group: n.group, by: n.by });
        this.broadcast();
      })
      .catch(() => {});
  }

  /**
   * Plays item `i`. The item that was playing is taken off the list (played or skipped
   * videos don't stay). Past the end: back to anything still left at the top, or idle.
   */
  jump(i) {
    const old = this.index;
    if (this.current && i !== old) {
      this.drop(old);
      if (i > old) i--;
    }
    if (i >= this.queue.length) i = 0;
    if (i < 0 || !this.queue.length) {
      this.unload();
      this.index = -1;
      this.playing = false;
      this.ended = false;
      return this.broadcast();
    }
    this.index = i;
    this.ended = false;
    this.load();
  }

  /** Takes item `i` off the list (without changing what plays). */
  drop(i) {
    const it = this.queue[i];
    if (!it) return;
    this.queue.splice(i, 1);
    this.vod.delete(it.key);
    if (it.group && !this.queue.some((x) => x.group === it.group)) this.groups.delete(it.group);
    if (i < this.index) this.index--;
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
    if (!item.resolved && item.status !== 'error') {
      // a video from a playlist: look it up now
      item.status = 'resolving';
      this.broadcast();
      resolve(item.url)
        .then((info) => {
          if (info.playlist) throw new Error('這是播放清單，不是單一影片');
          Object.assign(item, info, { status: 'queued', resolved: true, key: item.key, group: item.group, by: item.by });
          if (this.current === item) this.load();
          else this.broadcast();
        })
        .catch((e) => {
          item.status = 'error';
          item.error = e.message;
          this.broadcast();
          if (this.current === item) this.skipSoon();
        });
      return;
    }
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
          this.prefetch();
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
      this.jump(this.index + 1);
    }
  }

}

export function findRoom(id) {
  return rooms.get(id) || null;
}
