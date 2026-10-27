// The Activity page: Discord sign-in, the room connection, the synced player and the
// comment overlay. The server decides what plays and where; this page follows it.

import { Danmaku } from './danmaku.js?v=2';

const $ = (id) => document.getElementById(id);
const video = $('video');
const stage = $('stage');
const dm = new Danmaku($('danmaku'), $('chat'));

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`spw.${k}`);
      return v === null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`spw.${k}`, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

/* ---------- messages on screen ---------- */

let toastTimer = 0;
function toast(text, ms = 4000) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

function center(text, clickable = false) {
  const c = $('center');
  c.hidden = !text;
  c.classList.toggle('click', clickable);
  $('center-text').textContent = text || '';
}

/** The useful part of a long error (yt-dlp likes to append links and causes). */
function shortError(e) {
  return String(e || '')
    .replace(/\s*\(caused by[\s\S]*$/, '')
    .replace(/;?\s*please report this issue[\s\S]*$/i, '')
    .replace(/\s*See https?:\S+[\s\S]*$/, '')
    .slice(0, 160);
}

/* ---------- sign-in ---------- */

async function signIn() {
  const cfg = await (await fetch('/api/config')).json();
  const params = new URLSearchParams(location.search);
  // local testing outside Discord: ?dev=<DEV_TOKEN>&room=<name>
  if (params.get('dev')) {
    return { token: params.get('dev'), instanceId: params.get('room') || 'dev', guildId: null };
  }
  if (!params.get('frame_id')) throw new Error('請在 Discord 語音頻道的「活動」裡開啟 CinemaRoom。');
  const { DiscordSDK } = await import('./vendor/discord-sdk.js?v=1');
  const sdk = new DiscordSDK(cfg.clientId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: cfg.clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'guilds'],
  });
  const r = await fetch('/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(`登入失敗：${data.error || r.status}`);
  await sdk.commands.authenticate({ access_token: data.access_token });
  return { token: data.access_token, instanceId: sdk.instanceId, guildId: sdk.guildId };
}

/* ---------- clock: the server's time, as seen from here ---------- */

let offset = 0; // server time - local time (ms)
let bestRtt = Infinity;
const serverNow = () => Date.now() + offset;

function onTime(msg) {
  const now = Date.now();
  const rtt = now - msg.c;
  // keep the measurement with the shortest round trip (the most accurate one), but let
  // it age so a changed network is picked up
  bestRtt = Math.min(bestRtt * 1.05, 5000);
  if (rtt <= bestRtt) {
    bestRtt = rtt;
    offset = msg.s - (msg.c + rtt / 2);
  }
}

/* ---------- connection ---------- */

let ws = null;
let auth = null;
let state = null;
let retry = 0;

function sendCmd(msg) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 0;
    ws.send(JSON.stringify({ type: 'hello', ...auth }));
    for (let i = 0; i < 3; i++) setTimeout(() => sendCmd({ type: 'time', c: Date.now() }), i * 300);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'state') onState(msg);
    else if (msg.type === 'time') onTime(msg);
    else if (msg.type === 'comments') {
      if (msg.key === currentKey) {
        dm.setList(msg.list);
        toast(`載入 ${msg.list.length} 則彈幕`, 2500);
      } else pendingComments.set(msg.key, msg.list);
    } else if (msg.type === 'live') {
      if (msg.key === currentKey) dm.push(msg.items);
    } else if (msg.type === 'preview') {
      showPreview(msg);
    } else if (msg.type === 'notice') {
      if (msg.text) toast(msg.text);
    } else if (msg.type === 'error') toast(msg.text);
  };
  ws.onclose = () => {
    const wait = Math.min(15000, 1000 * 2 ** retry++);
    center('連線中斷，重新連線中…');
    setTimeout(connect, wait);
  };
}

setInterval(() => sendCmd({ type: 'time', c: Date.now() }), 15000);

/* ---------- state from the server ---------- */

let currentKey = null;
let currentMedia = null;
let hls = null;
const pendingComments = new Map();

const SITE = { bilibili: 'B站', niconico: 'ニコニコ', youtube: 'YouTube' };

function fmt(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function onState(s) {
  state = s;
  state.recv = serverNow();
  const cur = s.queue[s.index] || null;
  $('title').textContent = cur ? cur.title : 'CinemaRoom';
  $('viewers').textContent = s.viewers.length ? `👥 ${s.viewers.join('、')}` : '';
  renderQueue(s);

  if ((cur?.key || null) !== currentKey) {
    currentKey = cur?.key || null;
    dm.setList(pendingComments.get(currentKey) || []);
    pendingComments.delete(currentKey);
    $('chat').replaceChildren();
    $('chat').hidden = !(cur?.live && cur.site === 'youtube');
    $('btn-chatmode').hidden = !(cur?.live && cur.site === 'youtube');
  }
  const media = cur?.status === 'ready' ? cur.media : null;
  if (media !== currentMedia) {
    currentMedia = media;
    load(media, cur);
  }
  const last = s.queue[s.queue.length - 1];
  if (!cur && last?.status === 'error') center(`無法播放：${shortError(last.error)}`);
  else if (!cur) center(s.queue.length ? '清單播完了' : '按右上角 ☰ 加入影片或直播的網址');
  else if (cur.status === 'error') center(`無法播放：${shortError(cur.error)}`);
  else if (cur.status === 'resolving') center('讀取中…');
  else if (cur.status !== 'ready') center(cur.live ? '準備直播中…' : '準備影片中…（第一次播放要等幾秒）');
  else if (!needClick) center('');
  $('btn-play').textContent = s.playing ? '⏸' : '▶';
  $('seek').disabled = !cur || cur.live || !cur.duration;
  sync();
}

function renderQueue(s) {
  const ol = $('items');
  ol.replaceChildren(
    ...s.queue.map((it, i) => {
      const li = document.createElement('li');
      if (i === s.index) li.className = 'cur';
      const th = document.createElement('div');
      th.className = 'th';
      if (it.thumb) th.style.backgroundImage = `url("${it.thumb}")`;
      const mid = document.createElement('div');
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = it.title;
      const st = document.createElement('div');
      st.className = 's';
      const badge = document.createElement('span');
      badge.className = it.live ? 'badge live' : 'badge';
      badge.textContent = it.live ? 'LIVE' : SITE[it.site] || it.site || '…';
      st.append(badge);
      if (it.status === 'error') {
        const e = document.createElement('span');
        e.className = 'err';
        e.textContent = shortError(it.error) || '錯誤';
        st.append(e);
      } else {
        st.append(document.createTextNode(`${it.duration ? fmt(it.duration) + ' · ' : ''}${it.by || ''}`));
      }
      mid.append(t, st);
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '✕';
      x.title = '移除';
      x.onclick = (e) => {
        e.stopPropagation();
        sendCmd({ type: 'remove', key: it.key });
      };
      li.append(th, mid, x);
      li.onclick = () => i !== s.index && sendCmd({ type: 'jump', key: it.key });
      return li;
    }),
  );
}

/* ---------- player ---------- */

let needClick = false;

function load(src, item) {
  hls?.destroy();
  hls = null;
  video.removeAttribute('src');
  video.load();
  if (!src) return;
  const live = Boolean(item?.live);
  if (window.Hls?.isSupported()) {
    hls = new window.Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      maxBufferLength: live ? 12 : 30,
      backBufferLength: 30,
      // a video still being prepared: its playlist grows, keep asking for it
      manifestLoadingMaxRetry: 6,
      levelLoadingMaxRetry: 6,
    });
    hls.on(window.Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === window.Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls?.startLoad(), 1500);
      else if (d.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else toast(`播放錯誤：${d.details}`);
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else {
    video.src = src; // Safari / iOS play HLS themselves
  }
}

function target() {
  if (!state) return 0;
  let p = state.pos;
  if (state.playing && state.ready) p += (serverNow() - state.now) / 1000;
  const cur = state.queue[state.index];
  return cur?.duration ? Math.min(p, cur.duration) : p;
}

async function tryPlay() {
  try {
    await video.play();
    if (needClick) {
      needClick = false;
      center('');
    }
  } catch (e) {
    if (e.name === 'NotAllowedError') {
      needClick = true;
      center('點一下開始播放', true);
    }
  }
}

function sync() {
  const cur = state?.queue[state.index];
  if (!cur || !currentMedia || video.readyState < 1) return;
  if (state.playing && video.paused) {
    // a live stream resumes at the live edge, not where it was paused
    if (cur.live && hls?.liveSyncPosition) video.currentTime = hls.liveSyncPosition;
    tryPlay();
  } else if (!state.playing && !video.paused) video.pause();
  if (cur.live) {
    video.playbackRate = 1;
    return;
  }
  const want = target();
  const drift = video.currentTime - want;
  if (Math.abs(drift) > 1.5 || (!state.playing && Math.abs(drift) > 0.3)) {
    video.currentTime = want;
    video.playbackRate = 1;
  } else if (state.playing && Math.abs(drift) > 0.25) {
    // small differences: catch up gently instead of jumping
    video.playbackRate = drift > 0 ? 0.95 : 1.05;
  } else video.playbackRate = 1;
}

setInterval(sync, 1000);
video.addEventListener('loadedmetadata', sync);

function frame() {
  const cur = state?.queue[state.index];
  dm.setPaused(video.paused || video.readyState < 3);
  if (cur && !cur.live) dm.update(video.currentTime);
  if (!seeking) {
    if (cur && !cur.live && cur.duration) {
      const t = currentMedia ? video.currentTime : target();
      $('seek').value = String(Math.round((t / cur.duration) * 1000));
      $('time').textContent = `${fmt(t)} / ${fmt(cur.duration)}`;
      $('time').classList.remove('live');
    } else if (cur?.live) {
      $('time').textContent = '● LIVE';
      $('time').classList.add('live');
      $('seek').value = '1000';
    } else {
      $('time').textContent = '0:00 / 0:00';
      $('time').classList.remove('live');
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- controls ---------- */

let seeking = false;
$('seek').addEventListener('input', () => {
  seeking = true;
  const cur = state?.queue[state.index];
  if (cur?.duration) $('time').textContent = `${fmt((Number($('seek').value) / 1000) * cur.duration)} / ${fmt(cur.duration)}`;
});
$('seek').addEventListener('change', () => {
  seeking = false;
  const cur = state?.queue[state.index];
  if (cur?.duration) sendCmd({ type: 'seek', t: (Number($('seek').value) / 1000) * cur.duration });
});
$('btn-play').onclick = () => sendCmd({ type: state?.playing ? 'pause' : 'play' });
$('btn-next').onclick = () => sendCmd({ type: 'next' });
$('btn-prev').onclick = () => sendCmd({ type: 'prev' });
$('btn-queue').onclick = () => {
  $('queue').hidden = !$('queue').hidden;
  if (!$('queue').hidden) $('add-url').focus();
};
$('btn-close').onclick = () => {
  $('queue').hidden = true;
};
// clicking the video closes the list
$('danmaku').parentElement.addEventListener('pointerdown', (e) => {
  if (!$('queue').hidden && !$('queue').contains(e.target) && e.target !== $('btn-queue')) $('queue').hidden = true;
});
$('add').onsubmit = (e) => {
  e.preventDefault();
  const url = $('add-url').value.trim();
  if (!url) return;
  sendCmd({ type: 'add', url });
  $('add-url').value = '';
  $('preview').hidden = true;
  previewUrl = '';
};

// a pasted link shows its cover and title before it is added
let previewUrl = '';
let previewTimer = 0;
$('add-url').addEventListener('input', () => {
  clearTimeout(previewTimer);
  const url = $('add-url').value.trim();
  if (!/^https?:\/\/\S+\.\S+/.test(url)) {
    $('preview').hidden = true;
    previewUrl = '';
    return;
  }
  previewTimer = setTimeout(() => {
    if (url === previewUrl) return;
    previewUrl = url;
    $('preview').hidden = false;
    $('pv-th').style.backgroundImage = '';
    $('pv-title').textContent = '讀取中…';
    $('pv-meta').textContent = '';
    $('pv-meta').className = 's';
    sendCmd({ type: 'preview', url });
  }, 500);
});

function showPreview(msg) {
  if (msg.url !== previewUrl) return; // the box has changed since
  $('preview').hidden = false;
  if (msg.error) {
    $('pv-title').textContent = '讀不到這個網址';
    $('pv-meta').textContent = shortError(msg.error);
    $('pv-meta').className = 's err';
    return;
  }
  const i = msg.info;
  $('pv-th').style.backgroundImage = i.thumb ? `url("${i.thumb}")` : '';
  $('pv-title').textContent = i.title;
  const site = SITE[i.site] || i.site || '';
  $('pv-meta').textContent = [i.live ? '🔴 直播中' : site, i.live ? site : i.duration ? fmt(i.duration) : '', i.uploader]
    .filter(Boolean)
    .join(' · ');
  $('pv-meta').className = 's';
}
$('center').onclick = () => needClick && tryPlay();

const dmOn = store.get('dm', true);
dm.setEnabled(dmOn);
$('btn-dm').classList.toggle('on', dmOn);
$('btn-dm').onclick = () => {
  const on = !dm.enabled;
  dm.setEnabled(on);
  $('btn-dm').classList.toggle('on', on);
  store.set('dm', on);
};
dm.chatMode = store.get('chatMode', 'panel');
const chatLabel = () => ($('btn-chatmode').textContent = dm.chatMode === 'panel' ? '側邊' : '彈幕');
chatLabel();
// comment look: size, opacity, how much of the screen they may cover (per viewer)
const dmStyle = { scale: store.get('dmScale', 1), opacity: store.get('dmOpacity', 0.9), area: store.get('dmArea', 0.75) };
function applyDmStyle() {
  dm.setStyle(dmStyle);
  $('dm-size').value = String(Math.round(dmStyle.scale * 100));
  $('dm-size-v').textContent = `${Math.round(dmStyle.scale * 100)}%`;
  $('dm-opacity').value = String(Math.round(dmStyle.opacity * 100));
  $('dm-opacity-v').textContent = `${Math.round(dmStyle.opacity * 100)}%`;
  for (const b of $('dm-area').children) b.classList.toggle('on', Number(b.dataset.v) === dmStyle.area);
}
applyDmStyle();
$('btn-dmset').onclick = () => ($('dmset').hidden = !$('dmset').hidden);
$('dm-size').oninput = () => {
  dmStyle.scale = Number($('dm-size').value) / 100;
  store.set('dmScale', dmStyle.scale);
  applyDmStyle();
};
$('dm-opacity').oninput = () => {
  dmStyle.opacity = Number($('dm-opacity').value) / 100;
  store.set('dmOpacity', dmStyle.opacity);
  applyDmStyle();
};
for (const b of $('dm-area').children) {
  b.onclick = () => {
    dmStyle.area = Number(b.dataset.v);
    store.set('dmArea', dmStyle.area);
    applyDmStyle();
  };
}
$('danmaku').parentElement.addEventListener('pointerdown', (e) => {
  if (!$('dmset').hidden && !$('dmset').contains(e.target) && e.target !== $('btn-dmset')) $('dmset').hidden = true;
});

$('btn-chatmode').onclick = () => {
  dm.chatMode = dm.chatMode === 'panel' ? 'scroll' : 'panel';
  $('chat').replaceChildren();
  store.set('chatMode', dm.chatMode);
  chatLabel();
};

video.volume = store.get('volume', 80) / 100;
$('volume').value = String(Math.round(video.volume * 100));
$('volume').oninput = () => {
  video.volume = Number($('volume').value) / 100;
  video.muted = false;
  store.set('volume', Number($('volume').value));
};

// controls fade out while watching
let idleTimer = 0;
function wake() {
  stage.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if ($('queue').hidden && document.activeElement?.tagName !== 'INPUT') stage.classList.add('idle');
  }, 3000);
}
for (const ev of ['mousemove', 'pointerdown', 'keydown']) stage.addEventListener(ev, wake);
wake();

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === ' ') {
    e.preventDefault();
    $('btn-play').click();
  }
});

/* ---------- start ---------- */

center('登入 Discord 中…');
signIn()
  .then((a) => {
    auth = a;
    center('連線中…');
    connect();
  })
  .catch((e) => center(e.message || String(e)));
