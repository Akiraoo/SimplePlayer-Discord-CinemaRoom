// Small HTTP helpers. Bodies are decoded by hand (gzip / deflate / raw deflate / brotli)
// because some sites send raw deflate marked as "deflate", which fetch() can't read.

import https from 'node:https';
import http from 'node:http';
import zlib from 'node:zlib';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function decodeBody(buf, encoding) {
  const enc = String(encoding || '').toLowerCase();
  try {
    if (enc === 'gzip') return zlib.gunzipSync(buf);
    if (enc === 'br') return zlib.brotliDecompressSync(buf);
    if (enc === 'deflate') {
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    }
  } catch {
    /* fall through: maybe it wasn't compressed after all */
  }
  return buf;
}

/** GET (or POST with `body`); resolves { status, headers, body: Buffer }. */
export function request(url, { headers = {}, body, method, timeout = 15000 } = {}) {
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(
      u,
      {
        method: method || (body ? 'POST' : 'GET'),
        headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br', ...headers },
        timeout,
      },
      (res) => {
        const parts = [];
        res.on('data', (d) => parts.push(d));
        res.on('end', () =>
          ok({
            status: res.statusCode,
            headers: res.headers,
            body: decodeBody(Buffer.concat(parts), res.headers['content-encoding']),
          }),
        );
        res.on('error', fail);
      },
    );
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', fail);
    if (body) req.write(body);
    req.end();
  });
}

export async function getJson(url, opts) {
  const r = await request(url, opts);
  if (r.status >= 400) throw new Error(`HTTP ${r.status} (${new URL(url).host})`);
  return JSON.parse(r.body.toString('utf8'));
}

export async function getText(url, opts) {
  const r = await request(url, opts);
  if (r.status >= 400) throw new Error(`HTTP ${r.status} (${new URL(url).host})`);
  return r.body.toString('utf8');
}

/**
 * Streams a response: calls onData(chunk) as bytes arrive. Resolves when the response
 * ends; `signal` aborts it.
 */
export function stream(url, { headers = {}, signal, onData, timeout = 60000 } = {}) {
  return new Promise((ok, fail) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.get(u, { headers: { 'User-Agent': UA, ...headers }, timeout, signal }, (res) => {
      if (res.statusCode >= 400) {
        res.resume();
        fail(new Error(`HTTP ${res.statusCode} (${u.host})`));
        return;
      }
      res.on('data', (d) => onData(d));
      res.on('end', ok);
      res.on('error', fail);
    });
    req.on('timeout', () => req.destroy(new Error('stream timed out')));
    req.on('error', fail);
  });
}
