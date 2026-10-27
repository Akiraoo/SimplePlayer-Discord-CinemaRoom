// Turning a link into something every viewer's player can read:
//   resolve()  yt-dlp -J: title, length, live or not, where the comments are
//   Job        yt-dlp writes the video to stdout → ffmpeg cuts it into HLS (fMP4 segments,
//              no re-encoding) in the cache folder; the browsers read the playlist
// Small segments instead of one big file: seeking is just reading another segment, which
// goes through Discord's proxy (and any CDN) much better than Range requests.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { config } from './config.js';

/** Arguments every yt-dlp call gets. */
export function baseArgs() {
  const a = ['--no-warnings', '--no-progress', '--no-playlist', '--js-runtimes', `node:${process.execPath}`];
  if (config.cookies) a.push('--cookies', config.cookies);
  return [...a, ...config.ytdlpArgs];
}

export function errorLine(stderr) {
  const lines = String(stderr).split(/\r?\n/).filter((l) => l.trim());
  const e = lines.filter((l) => /^ERROR:/.test(l)).pop() || lines.filter((l) => !/^\[download\]/.test(l)).pop() || '';
  return e
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
    .slice(0, 300);
}

function run(args, timeoutMs = 90_000) {
  return new Promise((ok, fail) => {
    const p = spawn(config.ytdlp, [...baseArgs(), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => {
      err = (err + d).slice(-6000);
    });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(timer);
      fail(e.code === 'ENOENT' ? new Error('找不到 yt-dlp（.env 的 YTDLP）') : e);
    });
    p.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return ok(Buffer.concat(out).toString('utf8'));
      fail(new Error(signal ? 'yt-dlp 逾時' : errorLine(err) || `yt-dlp 結束代碼 ${code}`));
    });
  });
}

export function formatSelector(live) {
  const h = config.maxHeight;
  // H.264 + AAC first: every browser (and Discord's) can play it without re-encoding
  // (sites name it avc1 / avc / h264; "<=?" also accepts formats whose height is unknown)
  const avc = "[vcodec~='^(avc|h264)']";
  const parts = [
    `bv*${avc}[height<=?${h}]+ba[acodec~='^(mp4a|aac)']`,
    `bv*${avc}[height<=?${h}]+ba`,
    `b${avc}[height<=?${h}]`,
    `bv*[height<=?${h}]+ba`,
    `b[height<=?${h}]`,
    'b',
  ];
  // live streams: one stream with both, when there is one
  return live ? `b${avc}[height<=?${h}]/${parts.join('/')}` : parts.join('/');
}

/** Which site a link is (by yt-dlp's extractor name). */
export function siteOf(info) {
  const ex = String(info.extractor_key || info.extractor || '').toLowerCase();
  if (ex.startsWith('bilibili') || ex === 'bililive' || ex.startsWith('bili')) return 'bilibili';
  if (ex.startsWith('niconico') || ex.startsWith('nico')) return 'niconico';
  if (ex.startsWith('youtube')) return 'youtube';
  return ex || 'other';
}

/* What yt-dlp found for a link, kept a few minutes: the preview, adding it to the list and
   starting the download then need only one look-up (the download reuses it with
   --load-info-json instead of asking the site again, so playback starts sooner). */
const infos = new Map(); // url -> { at, raw, summary }
const pending = new Map(); // url -> Promise
const INFO_FRESH = 4 * 60_000;

function remember(urls, raw, summary) {
  const entry = { at: Date.now(), raw, summary };
  for (const u of urls) infos.set(u, entry);
  for (const [u, e] of infos) if (Date.now() - e.at > INFO_FRESH) infos.delete(u);
}

/** yt-dlp's full info for a link, if it was looked up recently enough to still be valid. */
export function freshInfo(url, maxAge = INFO_FRESH) {
  const e = infos.get(url);
  return e && Date.now() - e.at < maxAge ? e.raw : null;
}

/* cover pictures go through this server (the Activity can't load other sites) */
const thumbs = new Map(); // id -> url
export function thumbPath(url) {
  if (!url) return null;
  const id = createHash('sha1').update(url).digest('hex').slice(0, 20);
  thumbs.set(id, url);
  if (thumbs.size > 1000) thumbs.delete(thumbs.keys().next().value);
  return `/thumb/${id}`;
}
export function thumbUrl(id) {
  return thumbs.get(id) || null;
}

/** Title, length and where the comments are, from a link. */
export function resolve(url) {
  const hit = infos.get(url);
  if (hit && Date.now() - hit.at < INFO_FRESH) return Promise.resolve({ ...hit.summary });
  if (!pending.has(url)) {
    const p = lookUp(url).finally(() => pending.delete(url));
    pending.set(url, p);
  }
  return pending.get(url).then((s) => ({ ...s }));
}

async function lookUp(url) {
  const out = await run(['-J', '--write-subs', '--sub-langs', 'danmaku,comments', '-f', formatSelector(false), '--', url]);
  const info = JSON.parse(out);
  if (info._type === 'playlist') {
    const first = (info.entries || []).find(Boolean);
    if (!first) throw new Error('這個連結裡沒有影片');
    if (first.url && first.url !== url) return resolve(first.webpage_url || first.url);
  }
  const live = info.is_live === true || info.live_status === 'is_live';
  if (info.live_status === 'is_upcoming') throw new Error('直播還沒開始');
  const site = siteOf(info);
  const page = info.webpage_url || url;
  const subs = info.subtitles || {};
  let comments = null;
  if (!live && subs.danmaku?.[0]?.url) comments = { type: 'bili-xml', url: subs.danmaku[0].url };
  else if (!live && subs.comments?.[0]?.data) comments = { type: 'nico', data: subs.comments[0].data };
  let liveComments = null;
  if (live && site === 'bilibili') liveComments = { type: 'bili', url: page };
  else if (live && site === 'niconico') liveComments = { type: 'nico', url: page };
  else if (live && site === 'youtube') liveComments = { type: 'youtube', url: page };
  const thumb = [info.thumbnail, ...(info.thumbnails || []).map((t) => t.url).reverse()].find((t) => /^https:\/\//.test(t || ''));
  const summary = {
    url: page,
    title: String(info.title || info.fulltitle || page).slice(0, 200),
    uploader: String(info.uploader || info.channel || '').slice(0, 80),
    duration: live ? 0 : Number(info.duration) || 0,
    live,
    site,
    thumb: thumb || null,
    comments,
    liveComments,
  };
  remember([url, page], out, summary);
  return summary;
}

/* ---------------- HLS jobs ---------------- */

const jobs = new Map(); // id -> Job
const byUrl = new Map(); // url -> Job (recorded videos only: shared between rooms)

function cacheRoot() {
  const dir = path.resolve(config.cacheDir);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Leftovers from the last run: the cache doesn't survive a restart. */
export function clearCache() {
  const root = cacheRoot();
  // only our own folders (job IDs, chat-…), in case CACHE_DIR points somewhere shared
  for (const f of readdirSync(root)) {
    if (/^[0-9a-f]{24}$|^chat-/.test(f)) rmSync(path.join(root, f), { recursive: true, force: true });
  }
}

function dirSize(dir) {
  let total = 0;
  try {
    for (const f of readdirSync(dir)) total += statSync(path.join(dir, f)).size;
  } catch {
    /* gone */
  }
  return total;
}

export class Job {
  constructor(url, live) {
    this.id = randomBytes(12).toString('hex');
    this.url = url;
    this.live = live;
    this.dir = path.join(cacheRoot(), this.id);
    this.state = 'starting'; // starting → ready → done | error
    this.error = '';
    this.refs = 0;
    this.lastUsed = Date.now();
    this.listeners = new Set();
    this.procs = [];
    this.timer = null;
  }

  get playlist() {
    return `/media/${this.id}/index.m3u8`;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  set(state, error = '') {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    for (const fn of this.listeners) fn(this);
  }

  start() {
    mkdirSync(this.dir, { recursive: true });
    // reuse the look-up from a moment ago (live stream addresses go stale faster)
    const raw = freshInfo(this.url, this.live ? 60_000 : INFO_FRESH);
    let source = ['--', this.url];
    if (raw) {
      const file = path.join(this.dir, 'info.json');
      writeFileSync(file, raw);
      source = ['--load-info-json', file];
    }
    const yt = spawn(config.ytdlp, [...baseArgs(), '-f', formatSelector(this.live), '-o', '-', ...source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const hls = this.live
      ? ['-hls_time', '2', '-hls_list_size', '10', '-hls_flags', 'delete_segments+independent_segments']
      : ['-hls_time', '2', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments'];
    const ff = spawn(
      config.ffmpeg,
      [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-probesize', '10M', '-analyzeduration', '10M',
        '-i', 'pipe:0',
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-f', 'hls',
        ...hls,
        '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', 'init.mp4',
        '-hls_segment_filename', path.join(this.dir, 's%05d.m4s'),
        path.join(this.dir, 'index.m3u8'),
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    );
    this.procs = [yt, ff];
    yt.stdout.pipe(ff.stdin);
    ff.stdin.on('error', () => {});
    let ytErr = '';
    let ffErr = '';
    yt.stderr.on('data', (d) => {
      ytErr = (ytErr + d).slice(-6000);
    });
    ff.stderr.on('data', (d) => {
      ffErr = (ffErr + d).slice(-3000);
    });
    yt.on('error', (e) => this.set('error', e.code === 'ENOENT' ? '找不到 yt-dlp' : e.message));
    ff.on('error', (e) => this.set('error', e.code === 'ENOENT' ? '找不到 ffmpeg' : e.message));
    ff.on('close', (code) => {
      clearInterval(this.timer);
      if (this.state === 'error' || this.stopped) return;
      if (code === 0 && this.segments() > 0) {
        this.set('done');
      } else {
        const why = (/ERROR:/.test(ytErr) && errorLine(ytErr)) || ffErr.trim().split(/\r?\n/).pop() || `ffmpeg 結束代碼 ${code}`;
        console.error(`[job ${this.id}] ${this.url}\n${ytErr.slice(-1500)}\n${ffErr}`);
        this.set(this.live && this.state === 'ready' ? 'done' : 'error', why);
      }
    });
    // ready once a few segments exist (a live stream needs a little more to start smoothly)
    const need = this.live ? 3 : 2;
    this.timer = setInterval(() => {
      if (this.state === 'starting' && this.segments() >= need) this.set('ready');
    }, 400);
    return this;
  }

  segments() {
    try {
      const text = readFileSync(path.join(this.dir, 'index.m3u8'), 'utf8');
      return (text.match(/#EXTINF/g) || []).length;
    } catch {
      return 0;
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    for (const p of this.procs) p.kill('SIGKILL');
  }

  remove() {
    this.stop();
    jobs.delete(this.id);
    if (byUrl.get(this.url) === this) byUrl.delete(this.url);
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The job for a link: a recorded video already in the cache is reused. */
export function acquire(url, live) {
  let job = live ? null : byUrl.get(url);
  if (!job || job.state === 'error') {
    job?.remove();
    job = new Job(url, live);
    jobs.set(job.id, job);
    if (!live) byUrl.set(url, job);
    trim();
    job.start();
  }
  job.refs++;
  job.lastUsed = Date.now();
  return job;
}

export function release(job) {
  if (!job) return;
  job.refs = Math.max(0, job.refs - 1);
  job.lastUsed = Date.now();
}

export function getJob(id) {
  return jobs.get(id);
}

/** Drops unused cache: live streams right away, videos after 2 h or when over the size limit. */
export function trim() {
  const now = Date.now();
  const unused = [...jobs.values()].filter((j) => j.refs === 0);
  for (const j of unused) {
    if ((j.live && now - j.lastUsed > 30_000) || now - j.lastUsed > 2 * 3600_000) j.remove();
  }
  let total = [...jobs.values()].reduce((n, j) => n + dirSize(j.dir), 0);
  for (const j of [...jobs.values()].filter((x) => x.refs === 0).sort((a, b) => a.lastUsed - b.lastUsed)) {
    if (total <= config.cacheMaxBytes) break;
    total -= dirSize(j.dir);
    j.remove();
  }
}

setInterval(trim, 15_000).unref();

export function mediaFile(jobId, name) {
  const job = jobs.get(jobId);
  // only the playlist and its segments (info.json may hold cookies)
  if (!job || !/^[\w-]+\.(m3u8|m4s|mp4)$/.test(name)) return null;
  const file = path.join(job.dir, name);
  if (!existsSync(file)) return null;
  job.lastUsed = Date.now();
  return { job, file };
}
