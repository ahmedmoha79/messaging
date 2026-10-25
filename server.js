'use strict';

/**
 * WAZAMBI messaging server.
 *
 * Zero runtime dependencies: only Node built-ins. The browser talks to
 * Supabase directly (protected by row-level security), so this server's job
 * is to deliver the app as fast as possible and keep secrets off the client:
 *
 *   - serves /public with compression, ETags and long-lived caching
 *   - serves vendored browser libraries (supabase-js, Leaflet) from node_modules
 *   - publishes runtime config (Supabase URL/key, WebRTC ICE servers) at /config.js
 *   - proxies weather lookups so the OpenWeather key never reaches the browser
 *   - sets strict security headers (CSP, frame, referrer, permissions)
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

loadDotEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_VERSION = process.env.RENDER_GIT_COMMIT
  ? process.env.RENDER_GIT_COMMIT.slice(0, 8)
  : String(Date.now());

// The anon key is designed to be public (RLS protects the data), so a default
// keeps existing deployments working. Override both in Render's environment.
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://twsqvdxhsfvdibhpfvqr.supabase.co').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR3c3F2ZHhoc2Z2ZGliaHBmdnFyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDAxNDA2MzUsImV4cCI6MjA1NTcxNjYzNX0.EVjqobvn9fAd4djsBfg1zOlA2CVSeYukmsc_DMhT1b4';
const OPENWEATHER_API_KEY = process.env.OPENWEATHER_API_KEY || '';

// ---------------------------------------------------------------------------
// WebRTC ICE servers. STUN alone connects most calls; a TURN relay is needed
// when both people are behind strict NATs (some mobile networks, offices).
// ---------------------------------------------------------------------------
function iceServers() {
  const servers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ];
  const turnUrls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (turnUrls.length) {
    servers.push({
      urls: turnUrls,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  return servers;
}

// ---------------------------------------------------------------------------
// Vendored browser libraries, resolved from node_modules once at startup.
// If a package is missing we fall back to its CDN copy so the app still loads.
// ---------------------------------------------------------------------------
const VENDOR = {
  '/vendor/supabase.js': {
    file: resolvePackageFile('@supabase/supabase-js', 'dist/umd/supabase.js'),
    cdn: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js'
  }
};
const LEAFLET_DIST = resolvePackageFile('leaflet', 'dist');

function resolvePackageFile(pkg, rel) {
  try {
    const pkgJson = require.resolve(`${pkg}/package.json`, { paths: [__dirname] });
    const full = path.join(path.dirname(pkgJson), rel);
    return fs.existsSync(full) ? full : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Static file serving with an in-memory cache of compressed bodies.
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};
const COMPRESSIBLE = /^(text\/|application\/(json|manifest\+json|javascript)|image\/svg\+xml)/;
const fileCache = new Map(); // absPath -> { mtimeMs, size, etag, type, raw, br, gz }

async function loadFile(absPath) {
  const stat = await fsp.stat(absPath);
  if (!stat.isFile()) return null;
  const cached = fileCache.get(absPath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

  const raw = await fsp.readFile(absPath);
  const type = MIME[path.extname(absPath).toLowerCase()] || 'application/octet-stream';
  const entry = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    type,
    raw,
    etag: '"' + crypto.createHash('sha1').update(raw).digest('base64url').slice(0, 20) + '"',
    br: null,
    gz: null
  };
  if (COMPRESSIBLE.test(type) && raw.length > 1024) {
    entry.br = zlib.brotliCompressSync(raw, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length }
    });
    entry.gz = zlib.gzipSync(raw, { level: 9 });
  }
  fileCache.set(absPath, entry);
  return entry;
}

function cacheControlFor(absPath, urlPath) {
  const ext = path.extname(absPath).toLowerCase();
  if (urlPath === '/sw.js') return 'no-cache';
  if (ext === '.html' || ext === '.webmanifest' || urlPath === '/manifest.json') return 'no-cache';
  if (urlPath.startsWith('/vendor/')) return 'public, max-age=2592000, immutable';
  // Versioned app assets (?v=...) can be cached hard; unversioned ones revalidate.
  return 'public, max-age=3600, must-revalidate';
}

async function sendFile(req, res, absPath, urlPath, extraHeaders = {}) {
  let entry;
  try {
    entry = await loadFile(absPath);
  } catch {
    entry = null;
  }
  if (!entry) return false;

  const headers = {
    'Content-Type': entry.type,
    'Cache-Control': cacheControlFor(absPath, urlPath),
    ETag: entry.etag,
    Vary: 'Accept-Encoding',
    ...extraHeaders
  };
  if (/\?v=/.test(req.url) && !urlPath.endsWith('.html')) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  }

  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  const accept = String(req.headers['accept-encoding'] || '');
  let body = entry.raw;
  if (entry.br && /\bbr\b/.test(accept)) {
    body = entry.br;
    headers['Content-Encoding'] = 'br';
  } else if (entry.gz && /\bgzip\b/.test(accept)) {
    body = entry.gz;
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  if (decoded.includes('\0')) return null;
  const full = path.normalize(path.join(root, decoded));
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  // Never serve dotfiles (.env, .git, ...)
  if (full.split(path.sep).some(part => part.startsWith('.') && part.length > 1)) return null;
  return full;
}

// ---------------------------------------------------------------------------
// Security headers
// ---------------------------------------------------------------------------
const supabaseOrigin = new URL(SUPABASE_URL).origin;
const supabaseSocket = supabaseOrigin.replace(/^http/, 'ws');
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: https: ${supabaseOrigin}`,
  `media-src 'self' blob: data: ${supabaseOrigin}`,
  "font-src 'self' data:",
  `connect-src 'self' ${supabaseOrigin} ${supabaseSocket}`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  `form-action 'self' ${supabaseOrigin}`,
  "object-src 'none'"
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), display-capture=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function sendJson(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    ...headers
  });
  res.end(body);
}

function redirect(res, location, status = 301) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'public, max-age=3600' });
  res.end();
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

// Fixed-window rate limiter, per key.
const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    buckets.set(key, { start: now, count: 1 });
    return false;
  }
  b.count += 1;
  return b.count > limit;
}
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, b] of buckets) if (b.start < cutoff) buckets.delete(k);
}, 60 * 1000).unref();

// Verify a Supabase access token by asking Supabase who it belongs to.
// Results are cached briefly so the weather widget doesn't add auth latency.
const tokenCache = new Map();
async function verifyUser(req) {
  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return null;
  const hit = tokenCache.get(token);
  if (hit && hit.expires > Date.now()) return hit.user;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return null;
    const user = await r.json();
    tokenCache.set(token, { user, expires: Date.now() + 5 * 60 * 1000 });
    if (tokenCache.size > 5000) tokenCache.delete(tokenCache.keys().next().value);
    return user;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// API: weather (cached ~10 min per ~1km cell)
// ---------------------------------------------------------------------------
const weatherCache = new Map();
async function handleWeather(req, res, url) {
  if (!OPENWEATHER_API_KEY) return sendJson(res, 503, { error: 'Weather is not configured' });
  if (rateLimited('weather:' + clientIp(req), 30, 60 * 1000)) return sendJson(res, 429, { error: 'Too many requests' });
  const user = await verifyUser(req);
  if (!user) return sendJson(res, 401, { error: 'Sign in required' });

  const lat = Number(url.searchParams.get('lat'));
  const lon = Number(url.searchParams.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return sendJson(res, 400, { error: 'lat and lon are required' });
  }
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = weatherCache.get(key);
  if (hit && hit.expires > Date.now()) return sendJson(res, 200, hit.data);

  try {
    const api = new URL('https://api.openweathermap.org/data/2.5/weather');
    api.search = new URLSearchParams({ lat: String(lat), lon: String(lon), units: 'metric', appid: OPENWEATHER_API_KEY });
    const r = await fetch(api, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return sendJson(res, 502, { error: 'Weather service unavailable' });
    const w = await r.json();
    const data = {
      place: w.name || '',
      temp: Math.round(w.main?.temp),
      feels_like: Math.round(w.main?.feels_like),
      humidity: w.main?.humidity,
      wind: w.wind?.speed,
      description: w.weather?.[0]?.description || '',
      icon: w.weather?.[0]?.icon || ''
    };
    weatherCache.set(key, { data, expires: Date.now() + 10 * 60 * 1000 });
    if (weatherCache.size > 2000) weatherCache.delete(weatherCache.keys().next().value);
    return sendJson(res, 200, data);
  } catch {
    return sendJson(res, 502, { error: 'Weather service unavailable' });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const LEGACY_REDIRECTS = {
  '/login.html': '/',
  '/signup.html': '/?mode=signup',
  '/message.html': '/app',
  '/accounts.html': '/app#/settings',
  '/secure.html': '/app#/settings',
  '/manifest.json': '/manifest.webmanifest',
  '/index.html': '/'
};

async function handle(req, res) {
  securityHeaders(res);
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
  }

  if (p === '/health') {
    return sendJson(res, 200, { status: 'ok', version: APP_VERSION, uptime: Math.round(process.uptime()) });
  }

  if (p === '/config.js') {
    const config = {
      supabaseUrl: SUPABASE_URL,
      supabaseAnonKey: SUPABASE_ANON_KEY,
      iceServers: iceServers(),
      weather: !!OPENWEATHER_API_KEY,
      version: APP_VERSION
    };
    const body = `window.APP_CONFIG = Object.freeze(${JSON.stringify(config)});\n`;
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  if (p === '/api/weather') return handleWeather(req, res, url);
  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'Not found' });

  if (LEGACY_REDIRECTS[p]) return redirect(res, LEGACY_REDIRECTS[p] + (url.search && !LEGACY_REDIRECTS[p].includes('?') ? url.search : ''));

  if (VENDOR[p]) {
    const v = VENDOR[p];
    if (v.file && (await sendFile(req, res, v.file, p))) return;
    return redirect(res, v.cdn, 302);
  }
  if (p.startsWith('/vendor/leaflet/')) {
    if (LEAFLET_DIST) {
      const full = safeJoin(LEAFLET_DIST, p.slice('/vendor/leaflet'.length));
      if (full && (await sendFile(req, res, full, p))) return;
    } else {
      return redirect(res, 'https://unpkg.com/leaflet@1.9.4/dist' + p.slice('/vendor/leaflet'.length), 302);
    }
    return sendJson(res, 404, { error: 'Not found' });
  }

  // Service worker, stamped with the deploy version so each deploy refreshes caches.
  if (p === '/sw.js') {
    const file = path.join(PUBLIC_DIR, 'sw.js');
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return sendJson(res, 404, { error: 'Not found' });
    }
    const body = text.replace(/__APP_VERSION__/g, APP_VERSION);
    res.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Service-Worker-Allowed': '/'
    });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }

  // Pretty routes for the two pages
  if (p === '/') return sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'), '/index.html');
  if (p === '/app' || p === '/app/') return sendFile(req, res, path.join(PUBLIC_DIR, 'app.html'), '/app.html');
  // Public delivery tracking (no account): /t/<token>
  if (/^\/t\/[0-9a-f]{24,64}\/?$/i.test(p)) {
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex');
    return sendFile(req, res, path.join(PUBLIC_DIR, 'track.html'), '/track.html');
  }
  if (p === '/proof' || p === '/proof/') return sendFile(req, res, path.join(PUBLIC_DIR, 'proof.html'), '/proof.html');
  // Company invite links: /join/<CODE> → the app, which joins after sign-in
  const join = p.match(/^\/join\/([A-Za-z0-9]{4,16})\/?$/);
  if (join) return redirect(res, `/app#/join/${join[1].toUpperCase()}`, 302);

  const full = safeJoin(PUBLIC_DIR, p);
  if (full && (await sendFile(req, res, full, p))) return;

  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end('<!doctype html><meta charset="utf-8"><title>Not found</title><p style="font-family:system-ui;padding:2rem">Page not found. <a href="/">Go home</a></p>');
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  handle(req, res).catch(err => {
    console.error('Request failed:', req.method, req.url, err);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
    else res.end();
  }).finally(() => {
    if (!IS_PROD) console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
  });
});
server.keepAliveTimeout = 65 * 1000;
server.headersTimeout = 66 * 1000;

server.listen(PORT, () => {
  console.log(`Messaging server listening on :${PORT} (version ${APP_VERSION})`);
  if (!VENDOR['/vendor/supabase.js'].file) console.warn('supabase-js not installed locally; serving it from the CDN');
  if (!LEAFLET_DIST) console.warn('leaflet not installed locally; serving it from the CDN');
  if (!OPENWEATHER_API_KEY) console.warn('OPENWEATHER_API_KEY not set; the weather widget is disabled');
});

// Render's free plan sleeps after 15 minutes without traffic. A light self-ping
// keeps the first message fast. Only runs where Render tells us our own URL.
if (process.env.RENDER_EXTERNAL_URL && process.env.KEEP_ALIVE !== 'false') {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/health`, { signal: AbortSignal.timeout(10000) }).catch(() => {});
  }, 14 * 60 * 1000).unref();
}

function shutdown(signal) {
  console.log(`${signal} received, closing server`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Minimal .env loader so local development works without extra packages.
function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
}
