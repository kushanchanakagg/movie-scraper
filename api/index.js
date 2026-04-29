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

    const DmClass = globalThis.Dm || globalThis.DmClass;
    if (!DmClass) throw new Error('Dm not found');

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

// ── GET STREAM ────────────────────────────────────────────
async function getStream(id, season, episode) {
  await bootWasm();

  const token = globalThis.getAdv(String(id));
  if (!token) throw new Error('Token failed');

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

  const data = await res.json();
  return data?.stream?.playlist;
}

// ── FETCH UPSTREAM ────────────────────────────────────────
function fetchUpstream(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject('Too many redirects');

    const client = url.startsWith('https') ? https : http;

    const req = client.get(url, {
      headers: {
        Referer: REFERER,
        Origin: ORIGIN,
        'User-Agent': UA
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

// ── SMART REWRITE ─────────────────────────────────────────
function rewriteM3u8(body, url) {
  const realUrl = new URL(url).searchParams.get('url') || url;

  return body.split('\n').map(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;

    const abs = new URL(t, realUrl).href;

    return '/api?url=' + encodeURIComponent(abs);
  }).join('\n');
}

// ── HANDLER ───────────────────────────────────────────────
module.exports = async function handler(req, res) {

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  const { searchParams } = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(searchParams);

  // ── STREAM ENTRY ───────────────────────────────────────
  if (q.id) {
    try {
      const streamUrl = await getStream(q.id, q.s, q.e);

      // ✅ IMPORTANT: return PROXY URL, NOT redirect
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        url: '/api?url=' + encodeURIComponent(streamUrl)
      }));

    } catch (e) {
      res.statusCode = 500;
      return res.end(e.message);
    }
  }

  // ── PROXY MODE ─────────────────────────────────────────
  if (q.url) {
    const url = decodeURIComponent(q.url);

    try {
      const upstream = await fetchUpstream(url);

      const ct = upstream.headers['content-type'] || '';
      const isM3u8 = ct.includes('mpegurl') || url.includes('.m3u8');

      if (isM3u8) {
        const chunks = [];
        for await (const c of upstream) chunks.push(c);

        const body = Buffer.concat(chunks).toString('utf8');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');

        return res.end(rewriteM3u8(body, url));
      }

      res.setHeader('Content-Type', ct);
      return upstream.pipe(res);

    } catch (e) {
      res.statusCode = 502;
      return res.end(e.message);
    }
  }

  res.statusCode = 400;
  res.end('Invalid request');
};
