// YouTube live chat. yt-dlp's live chat downloader keeps appending to
// "<name>.live_chat.json.part" while the stream runs; we follow that file.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, openSync, readSync, closeSync, statSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { clean } from './common.js';

function runsText(message) {
  if (message?.simpleText) return message.simpleText;
  return (message?.runs || [])
    .map((r) => r.text ?? (r.emoji ? r.emoji.shortcuts?.[0] || r.emoji.emojiId || '' : ''))
    .join('');
}

/** Chat lines in one line of the live chat file. */
export function parseLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  const out = [];
  for (const a of obj?.replayChatItemAction?.actions || []) {
    const item = a?.addChatItemAction?.item;
    if (!item) continue;
    const text = item.liveChatTextMessageRenderer;
    const paid = item.liveChatPaidMessageRenderer;
    const r = text || paid;
    if (!r) continue;
    const body = clean(runsText(r.message));
    if (!body && !paid) continue;
    out.push({
      kind: 'chat',
      text: body,
      user: clean(r.authorName?.simpleText || '', 40),
      mode: 'scroll',
      color: paid ? '#ffd54f' : '#ffffff',
      size: 'normal',
      ...(paid ? { paid: clean(paid.purchaseAmountText?.simpleText || '', 20) || true } : {}),
    });
  }
  return out;
}

/** Follows the chat of one live stream until stop(). Emits 'comment' and 'status'. */
export class YouTubeChat extends EventEmitter {
  constructor(url, { ytdlp, base, dir }) {
    super();
    this.url = url;
    this.ytdlp = ytdlp; // command, e.g. "yt-dlp"
    this.base = base; // the arguments every yt-dlp call gets
    this.dir = dir;
    this.proc = null;
    this.timer = null;
    this.offset = 0;
    this.rest = '';
    this.stopped = false;
  }

  start() {
    mkdirSync(this.dir, { recursive: true });
    this.spawn();
    this.timer = setInterval(() => this.poll(), 1000);
    return this;
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.proc?.kill('SIGKILL');
    rmSync(this.dir, { recursive: true, force: true });
  }

  spawn() {
    if (this.stopped) return;
    const args = [...this.base, '--skip-download', '--write-subs', '--sub-langs', 'live_chat', '-o', path.join(this.dir, 'chat.%(ext)s'), '--', this.url];
    const p = spawn(this.ytdlp, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    this.proc = p;
    let err = '';
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-2000);
    });
    p.on('error', (e) => this.emit('status', `YouTube 聊天室：${e.message}`));
    p.on('close', () => {
      if (this.stopped) return;
      const line = err.split(/\r?\n/).filter((l) => /ERROR:/.test(l)).pop();
      this.emit('status', `YouTube 聊天室中斷${line ? `：${line.replace(/^ERROR:\s*/, '').slice(0, 160)}` : ''}，10 秒後重連`);
      setTimeout(() => {
        this.offset = 0;
        this.rest = '';
        this.seen = false;
        rmSync(this.dir, { recursive: true, force: true });
        mkdirSync(this.dir, { recursive: true });
        this.spawn();
      }, 10_000);
    });
    this.emit('status', 'YouTube 聊天室連線中…');
  }

  poll() {
    let file;
    try {
      file = readdirSync(this.dir).find((f) => /\.live_chat\.json(\.part)?$/.test(f));
    } catch {
      return;
    }
    if (!file) return;
    const full = path.join(this.dir, file);
    let size;
    try {
      size = statSync(full).size;
    } catch {
      return;
    }
    if (size <= this.offset) return;
    const fd = openSync(full, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size - this.offset, 4 * 1024 * 1024));
      const n = readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += n;
      const text = this.rest + buf.subarray(0, n).toString('utf8');
      const lines = text.split('\n');
      this.rest = lines.pop();
      // the first read may hold a backlog of older messages: show only the newest few
      const from = this.seen ? 0 : Math.max(0, lines.length - 30);
      this.seen = true;
      for (let i = from; i < lines.length; i++) {
        for (const c of parseLine(lines[i])) this.emit('comment', c);
      }
    } finally {
      closeSync(fd);
    }
  }
}
