'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const REFERER = 'https://vidlink.pro/';
const ORIGIN  = 'https://vidlink.pro';
const UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

// ── WASM BOOT ─────────────────────────────────────────────
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

    // FIX: safe Dm access
    const DmClass = globalThis.Dm || globalThis.DmClass;
    if (!DmClass) throw new Error('Dm is not defined in script.js');

    const go = new DmClass();

    const wasmBuf = fs.readFileSync(path.join(__dirname, 'fu.wasm'));
    const { instance } = await WebAssembly.instantiate(wasmBuf, go.importObject);

    go.run(instance);

    await new Promise(r => setTimeout(r, 500));

    if (typeof globalThis.getAdv !== 'function') {
      throw new Error('getAdv not found');
    }
  })();

  return bootPromise;
}

// ── STREAM TOKEN ──────────────────────────────────────────
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

  console.log('🎬 Playlist:', playlist);
  return playlist;
}

// ── UPSTREAM FETCH ────────────────────────────────────────
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
        const next = new URL(res.headers.location, url).href;
        return resolve(fetchUpstream(next, redirects + 1));
      }
      resolve(res);
    });

    req.on('error', reject);
  });
}

// ── M3U8 REWRITE (SAFE) ───────────────────────────────────
function rewriteM3u8(body, url) {
  const realUrl = new URL(url).searchParams.get('url') || url;
  const isMaster = body.includes('#EXT-X-STREAM-INF');

  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;

    const abs = new URL(t, realUrl).href;

    // keep structure safe
    return '/api?url=' + encodeURIComponent(abs);
  }).join('\n');
}

// ── MAIN HANDLER ──────────────────────────────────────────
module.exports = async function handler(req, res) {

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    return res.end();
  }

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // ── PROXY MODE ─────────────────────────────────────────
  if (q.url) {
    const url = decodeURIComponent(q.url);

    try {
      const upstream = await fetchUpstream(url);

      const ct = (upstream.headers['content-type'] || '').toLowerCase();
      const isM3u8 =
        ct.includes('mpegurl') ||
        /\.m3u8/i.test(url.split('?')[0]);

      // ── M3U8 HANDLING ────────────────────────────────
      if (isM3u8) {
        const chunks = [];
        for await (const c of upstream) chunks.push(c);

        const body = Buffer.concat(chunks).toString('utf8');

        console.log('📄 Playlist type:', body.includes('#EXT-X-STREAM-INF') ? 'MASTER' : 'MEDIA');

        // ❌ FORCE DOWNLOAD MODE (your request)
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', 'attachment; filename="playlist.m3u8"');
        res.setHeader('Cache-Control', 'no-store');

        return res.end(body);
      }

      // ── TS / MEDIA FILES ─────────────────────────────
      res.setHeader('Content-Type', ct || 'application/octet-stream');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Accept-Ranges', 'bytes');

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

  // ── STREAM FETCH ────────────────────────────────────────
  if (!q.id) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Missing id' }));
  }

  try {
    const streamUrl = await getStream(q.id, q.s, q.e);

    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ url: streamUrl }));

  } catch (err) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: err.message }));
  }
};
