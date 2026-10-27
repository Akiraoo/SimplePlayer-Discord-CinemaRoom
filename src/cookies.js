// Reads a cookies.txt (Netscape format, the one yt-dlp uses) for the live comment
// connections, which talk to bilibili / niconico directly instead of through yt-dlp.

import { readFileSync } from 'node:fs';

/** All cookies whose domain ends with `domain`, as { name: value }. */
export function cookiesFor(file, domain) {
  const out = {};
  if (!file) return out;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (let line of text.split(/\r?\n/)) {
    if (line.startsWith('#HttpOnly_')) line = line.slice('#HttpOnly_'.length);
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const host = f[0].replace(/^\./, '');
    if (host === domain || host.endsWith(`.${domain}`)) out[f[5]] = f[6];
  }
  return out;
}

/** { a: 1, b: 2 } → "a=1; b=2" */
export function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}
