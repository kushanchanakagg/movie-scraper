'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// ── WASM singleton ────────────────────────────────────────────────────────────
let bootPromise = null;

function bootWasm() {
  if (bootPromise) return bootPromise;

  bootPromise = (async () => {
    globalThis.window = globalThis;
    globalThis.self = globalThis;
    globalThis.document = { createElement: () => ({}), body: { appendChild: () => {} } };

    const sodium = require('libsodium-wrappers');
    await sodium.ready;
    globalThis.sodium = sodium;

    eval(fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8'));

    const go = new Dm();
    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);
    go.run(instance);

    await new Promise(r => setTimeout(r, 500));
    if (typeof globalThis.getAdv !== 'function') throw new Error('getAdv not found');
  })();

  return bootPromise;
}

// ── Get stream URL ────────────────────────────────────────────────────────────
async function getStream(id, season, episode) {
  await bootWasm();

  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('Token generation failed');

  const apiUrl = season
    ? `https://vidlink.pro/api/b/tv/${token}/${season}/${episode || 1}?multiLang=1`
    : `https://vidlink.pro/api/b/movie/${token}?multiLang=1`;

  const res = await fetch(apiUrl, {
    headers: {
      Referer: REFERER,
      Origin: ORIGIN,
      'User-Agent': UA
    }
  });

  if (!res.ok) throw new Error(`API error: ${res.status}`);

  const data = await res.json();
  const playlist = data?.stream?.playlist;

  if (!playlist) throw new Error('No playlist found');

  console.log('🎬 Playlist URL:', playlist);

  return playlist;
}

// ── Fetch upstream ────────────────────────────────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));

    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, {
      headers: {
        Referer: REFERER,
        Origin: ORIGIN,
        'User-Agent': UA,
        Accept: '*/*'
      }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
        return resolve(fetchUpstream(next, redirects + 1));
      }
      resolve(res);
    });

    req.on('error', reject);
  });
}

// ── Rewrite playlist (SAFE) ───────────────────────────────────────────────────
function rewriteM3u8(body, url) {
  const base = url.split('?')[0];
  const baseDir = base.substring(0, base.lastIndexOf('/') + 1);
  const origin = new URL(url).origin;

  return body.split('\n').map(line => {
    const t = line.trim();

    if (!t || t.startsWith('#')) return line;

    const abs = t.startsWith('http')
      ? t
      : t.startsWith('/')
      ? origin + t
      : baseDir + t;

    return '/api?url=' + encodeURIComponent(abs);
  }).join('\n');
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {

  // ✅ CORS FIX
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // ── PROXY MODE ──────────────────────────────────────────────────────────────
  if (q.url) {
    const url = decodeURIComponent(q.url);

    try {
      const upstream = await fetchUpstream(url);

      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 =
        ct.includes('mpegurl') ||
        ct.includes('m3u8') ||
        /\.m3u8?(\?|$)/i.test(url.split('?')[0]);

      if (isM3u8) {
        const chunks = [];
        for await (const chunk of upstream) chunks.push(chunk);

        const body = Buffer.concat(chunks).toString('utf8');

        console.log('📄 Playlist Preview:\n', body.substring(0, 300));
        console.log('🎯 Is Master:', body.includes('#EXT-X-STREAM-INF'));

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');

        return res.end(rewriteM3u8(body, url));
      }

      // Non-m3u8 (TS segments)
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      if (upstream.headers['content-length']) {
        res.setHeader('Content-Length', upstream.headers['content-length']);
      }

      res.statusCode = upstream.statusCode;
      return upstream.pipe(res);

    } catch (err) {
      res.statusCode = 502;
      return res.end(err.message);
    }
  }

  // ── STREAM FETCH ────────────────────────────────────────────────────────────
  if (!q.id) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Missing id' }));
  }

  try {
    const streamUrl = await getStream(q.id, q.s, q.e);

    if (q.proxy === 'true') {
      const upstream = await fetchUpstream(streamUrl);

      const chunks = [];
      for await (const chunk of upstream) chunks.push(chunk);

      const body = Buffer.concat(chunks).toString('utf8');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      return res.end(rewriteM3u8(body, streamUrl));
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: streamUrl }));

  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
};
