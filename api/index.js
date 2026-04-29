'use strict';

const fs = require('fs');
const path = require('path');

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
    if (!DmClass) throw new Error('Dm is not defined');

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

// ── GET STREAM URL ────────────────────────────────────────
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

  console.log('🎬 Stream URL:', playlist);

  return playlist;
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

  // ── STREAM MODE ─────────────────────────────────────────
  if (!q.id) {
    res.statusCode = 400;
    return res.end('Missing id');
  }

  try {
    const streamUrl = await getStream(q.id, q.s, q.e);

    // 🔥 IMPORTANT: REDIRECT TO ACTUAL STREAM
    res.writeHead(302, {
      Location: streamUrl,
      'Cache-Control': 'no-store'
    });

    return res.end();

  } catch (err) {
    res.statusCode = 500;
    return res.end(err.message);
  }
};
