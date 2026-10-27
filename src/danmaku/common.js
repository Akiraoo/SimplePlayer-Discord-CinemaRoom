// The comment format sent to the browser, shared by every site:
//   { t?, text, mode, color, size, user? }
//   t     seconds into the video (recorded comments only; live ones show right away)
//   mode  'scroll' | 'top' | 'bottom'
//   color '#rrggbb'
//   size  'small' | 'normal' | 'big'
// plus `kind: 'chat'` for live chat lines (YouTube) and `paid` for super chats.

export const MAX_VOD = 30000;

export function hexColor(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '#ffffff';
  return `#${(v & 0xffffff).toString(16).padStart(6, '0')}`;
}

export function clean(text, max = 200) {
  return String(text ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function xmlUnescape(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}
