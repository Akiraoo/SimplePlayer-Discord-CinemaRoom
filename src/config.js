// Settings from .env (see .env.example).

const env = process.env;

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && v !== '' && v !== undefined ? n : fallback;
}

export const config = {
  clientId: env.DISCORD_CLIENT_ID || '',
  clientSecret: env.DISCORD_CLIENT_SECRET || '',
  host: env.HOST || '127.0.0.1',
  port: num(env.PORT, 3090),
  ytdlp: env.YTDLP || 'yt-dlp',
  ffmpeg: env.FFMPEG || 'ffmpeg',
  cookies: env.YTDLP_COOKIES || '',
  ytdlpArgs: String(env.YTDLP_ARGS || '').split(/\s+/).filter(Boolean),
  cacheDir: env.CACHE_DIR || './cache',
  cacheMaxBytes: num(env.CACHE_MAX_GB, 5) * 1024 ** 3,
  maxHeight: num(env.MAX_HEIGHT, 1080),
  // empty = any server; otherwise only these guild (server) IDs may use it
  allowedGuilds: String(env.ALLOWED_GUILDS || '').split(/[\s,]+/).filter(Boolean),
  maxQueue: num(env.MAX_QUEUE, 50),
  // most videos taken from one playlist link
  maxPlaylist: num(env.MAX_PLAYLIST, 200),
  devToken: env.DEV_TOKEN || '',
};

export function checkConfig() {
  const missing = [];
  if (!config.clientId) missing.push('DISCORD_CLIENT_ID');
  if (!config.clientSecret) missing.push('DISCORD_CLIENT_SECRET');
  return missing;
}
