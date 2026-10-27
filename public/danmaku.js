// Comment overlay: scrolling / top / bottom comments in lanes, and a chat panel for
// YouTube live chat. Recorded comments are shown when the video reaches their time;
// live ones as they arrive.

const SCROLL_SECONDS = 7; // time a comment takes to cross the screen (at the screen's width)
const FIXED_SECONDS = 4;
const MAX_ON_SCREEN = 180;

export class Danmaku {
  constructor(layer, chatPanel) {
    this.layer = layer;
    this.chat = chatPanel;
    this.list = []; // recorded comments, sorted by t
    this.next = 0; // index of the next one to show
    this.lastT = 0;
    this.lanes = { scroll: [], top: [], bottom: [] };
    this.live = new Set(); // Animation objects on screen
    this.enabled = true;
    this.paused = false;
    this.chatMode = 'panel'; // YouTube chat: 'panel' | 'scroll'
  }

  size() {
    const h = this.layer.clientHeight || 360;
    const font = Math.max(16, Math.min(40, h / 16));
    return { w: this.layer.clientWidth || 640, h, font, lane: font * 1.25 };
  }

  setList(list) {
    this.list = list || [];
    this.clear();
    this.next = 0;
    this.lastT = 0;
  }

  clear() {
    for (const a of this.live) a.cancel();
    this.live.clear();
    this.layer.replaceChildren();
    this.lanes = { scroll: [], top: [], bottom: [] };
  }

  setEnabled(on) {
    this.enabled = on;
    this.layer.classList.toggle('off', !on);
    this.chat.style.display = on ? '' : 'none';
    if (!on) this.clear();
  }

  setPaused(p) {
    if (p === this.paused) return;
    this.paused = p;
    for (const a of this.live) p ? a.pause() : a.play();
  }

  /** Called often with the video's time: shows the recorded comments that are due. */
  update(t) {
    if (!this.list.length) return;
    if (t < this.lastT - 0.5 || t > this.lastT + 3) {
      // a seek: jump to the comments around the new position, no burst of old ones
      this.clear();
      this.next = this.find(t - 0.2);
    }
    this.lastT = t;
    if (this.paused || !this.enabled) return;
    let shown = 0;
    while (this.next < this.list.length && this.list[this.next].t <= t) {
      const c = this.list[this.next++];
      if (t - c.t < 1 && shown++ < 40) this.show(c);
    }
  }

  find(t) {
    let lo = 0;
    let hi = this.list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.list[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Live comments (shown right away). */
  push(items) {
    if (!this.enabled || this.paused) return;
    for (const c of items) {
      if (c.kind === 'chat' && this.chatMode === 'panel') this.chatLine(c);
      else this.show(c);
    }
  }

  chatLine(c) {
    const el = document.createElement('div');
    el.className = c.paid ? 'm paid' : 'm';
    if (c.user) {
      const u = document.createElement('span');
      u.className = 'u';
      u.textContent = c.user;
      el.append(u);
    }
    el.append(document.createTextNode((c.paid && c.paid !== true ? `${c.paid} ` : '') + c.text));
    this.chat.append(el);
    while (this.chat.childElementCount > 14) this.chat.firstElementChild.remove();
  }

  show(c) {
    if (this.live.size >= MAX_ON_SCREEN) return;
    const { w, h, font, lane } = this.size();
    const el = document.createElement('div');
    el.className = c.paid ? 'c paid' : 'c';
    const px = font * (c.size === 'big' ? 1.35 : c.size === 'small' ? 0.75 : 1);
    el.style.fontSize = `calc(${px}px * var(--dm-scale))`;
    el.style.color = c.color || '#fff';
    if (c.kind === 'chat' && c.user) {
      const u = document.createElement('span');
      u.className = 'u';
      u.textContent = c.user;
      el.append(u);
    }
    el.append(document.createTextNode(c.text));
    this.layer.append(el);
    const width = el.offsetWidth;
    const now = performance.now();
    const mode = c.mode === 'top' || c.mode === 'bottom' ? c.mode : 'scroll';
    const count = Math.max(1, Math.floor((mode === 'scroll' ? h * 0.85 : h * 0.5) / lane));
    let a;
    if (mode === 'scroll') {
      const speed = (w + 120) / SCROLL_SECONDS; // px per second, the same for every comment
      const duration = (w + width) / speed;
      // a lane is free once the previous comment has fully come onto the screen
      let row = -1;
      for (let i = 0; i < count; i++) {
        if (!this.lanes.scroll[i] || this.lanes.scroll[i] <= now) {
          row = i;
          break;
        }
      }
      if (row < 0) {
        el.remove();
        return; // too crowded: skip rather than pile up
      }
      this.lanes.scroll[row] = now + ((width + 24) / speed) * 1000;
      el.style.top = `${row * lane + 4}px`;
      a = el.animate([{ transform: `translateX(${w}px)` }, { transform: `translateX(${-width}px)` }], {
        duration: duration * 1000,
        easing: 'linear',
      });
    } else {
      const lanes = this.lanes[mode];
      let row = lanes.findIndex((until, i) => i < count && (!until || until <= now));
      if (row < 0) row = lanes.length < count ? lanes.length : -1;
      if (row < 0) {
        el.remove();
        return;
      }
      lanes[row] = now + FIXED_SECONDS * 1000;
      el.style.left = `${Math.max(0, (w - width) / 2)}px`;
      el.style[mode === 'top' ? 'top' : 'bottom'] = `${row * lane + 4 + (mode === 'bottom' ? 70 : 0)}px`;
      a = el.animate([{ transform: 'none' }, { transform: 'none' }], { duration: FIXED_SECONDS * 1000 });
    }
    this.live.add(a);
    if (this.paused) a.pause();
    a.onfinish = a.oncancel = () => {
      this.live.delete(a);
      el.remove();
    };
  }
}
