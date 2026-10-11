/* Real-browser test harness for CalledIt (headless Chromium via puppeteer-core).
 *
 * Network is mocked so tests are deterministic and work offline:
 *   - TrailSplits (real Zermatt data in test/fixtures), weather, POIs, loops
 *   - Google Places search + photo media, Wikimedia Commons photos
 *   - map tiles (generated PNG), Puter.js (scripted Grok that makes tool calls)
 *   - Google Maps JS is blocked → exercises the Leaflet backup map
 *
 * Needs: cd test/browser && npm install   (see test/browser/README.md)
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ---------------- tiny PNG encoder (for fake map tiles) ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function makePng(w, h, pixel) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = y * (w * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/* a map-like tile: meadow colour, a "river", a "road" and grid */
export const TILE_PNG = makePng(256, 256, (x, y) => {
  if (Math.abs(y - (128 + 40 * Math.sin(x / 40))) < 5) return [140, 190, 230, 255];
  if (Math.abs(x - y * 0.6 - 30) < 2.5) return [250, 250, 250, 255];
  if (x % 64 === 0 || y % 64 === 0) return [214, 226, 206, 255];
  return [226, 236, 218, 255];
});

/* ---------------- fixtures ---------------- */
const ZERMATT = JSON.parse(fs.readFileSync(path.join(ROOT, 'test/fixtures/zermatt-trails.json'), 'utf8'));
const PHOTOS = ['assets/fallback-forest.jpg', 'assets/fallback-lake.jpg', 'assets/fallback-ridge.jpg', 'assets/hero-trails.jpg', 'assets/hiker.jpg', 'assets/biker.jpg']
  .map(p => fs.readFileSync(path.join(ROOT, p)));

function forecast(lat, lon) {
  const days = [];
  const base = new Date('2026-10-12T12:00:00Z');
  const codes = [2, 61, 0, 3, 80, 1, 2];
  for (let i = 0; i < 7; i++) {
    const d = new Date(base.getTime() + i * 864e5);
    days.push({ date: d.toISOString().slice(0, 10), weather_code: codes[i], temp_max_c: 14 + i, temp_min_c: 3 + i / 2, precip_mm: codes[i] > 50 ? 4.2 : 0, precip_probability_max_pct: codes[i] > 50 ? 75 : 5, wind_max_kmh: 18, gust_max_kmh: 35 });
  }
  return { schema: 'weather-forecast/1', provider: { attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)' }, points: [{ lat, lon, days }] };
}

const PLACES_ZERMATT = [
  ['ChIJmatterhorn_glacier', 'Matterhorn Glacier Trail', 45.9806, 7.7063, 4.9, 1834],
  ['ChIJfive_lakes', '5-Seenweg (5 Lakes Walk)', 46.0113, 7.7901, 4.8, 2911],
  ['ChIJhornli', 'Hörnli Hut Trail', 45.9899, 7.6879, 4.8, 640],
  ['ChIJedelweiss', 'Edelweissweg Zermatt', 46.0178, 7.7076, 4.7, 388],
  ['ChIJgornergrat', 'Gornergrat Panorama Trail', 45.9836, 7.7849, 4.9, 5120],
  ['ChIJschwarzsee', 'Schwarzsee Paradise', 45.9906, 7.7086, 4.7, 902],
  ['ChIJriffelsee', 'Riffelsee Lake', 45.9858, 7.7499, 4.9, 3410],
  ['ChIJzmutt', 'Zmutt Hamlet Walk', 46.0098, 7.7297, 4.6, 214]
];
function placesResponse(set) {
  return { places: set.map(([id, name, lat, lon, rating, count], i) => ({
    id, displayName: { text: name, languageCode: 'en' }, location: { latitude: lat, longitude: lon },
    rating, userRatingCount: count, formattedAddress: '3920 Zermatt, Switzerland',
    googleMapsUri: 'https://maps.google.com/?cid=' + (1000 + i),
    photos: [{ name: 'places/' + id + '/photos/PHOTO' + i, widthPx: 1600, heightPx: 1067 }]
  })) };
}

function commonsResponse(lat, lon) {
  /* realistic mix: good landscape photos + junk the app must filter out */
  const pages = {};
  const items = [
    ['File:Risk Legacy.jpg', 1936, 2592, 'image/jpeg'],
    ['File:Hand-Drawn Dungeon Map with Crosshatch Pattern.jpg', 1936, 2592, 'image/jpeg'],
    ['File:Zermatt - Hohlicht West - Swisstopo 349817.tif', 7000, 4639, 'image/tiff'],
    ['File:Matterhorn from the trail (' + lat.toFixed(3) + ').jpg', 5184, 3456, 'image/jpeg'],
    ['File:Zmutttal view ' + lon.toFixed(3) + '.jpg', 4000, 2667, 'image/jpeg'],
    ['File:Voting Machine (3003065716).jpg', 1024, 1280, 'image/jpeg'],
    ['File:Zermatt City Hall 2019.jpg', 4000, 3000, 'image/jpeg'],
    ['File:My dog at the lake.jpg', 3000, 2000, 'image/jpeg'],
    ['File:DSC 0042.JPG', 4000, 2667, 'image/jpeg']
  ];
  items.forEach(([title, w, h, mime], i) => {
    const id = Math.round(Math.abs(lat * 1000 + lon * 100)) * 10 + i;
    const slug = encodeURIComponent(title.replace(/^File:/, '').replace(/ /g, '_'));
    pages[id] = {
      pageid: id, ns: 6, title, index: i,
      imageinfo: [{
        width: w, height: h, mime,
        thumburl: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/' + slug + '/500px-' + slug + (mime === 'image/tiff' ? '.jpg' : ''),
        thumbwidth: 480, thumbheight: Math.round(480 * h / w),
        descriptionurl: 'https://commons.wikimedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_')),
        extmetadata: { Artist: { value: '<a href="https://www.flickr.com/people/x">Björn S…</a>' }, LicenseShortName: { value: 'CC BY-SA 2.0' } }
      }]
    };
  });
  return { batchcomplete: '', query: { pages } };
}

/* polyline6 encoder */
function encode6(points) {
  let out = '', pl = 0, pn = 0;
  const enc = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [lat, lng] of points) { const a = Math.round(lat * 1e6), b = Math.round(lng * 1e6); out += enc(a - pl) + enc(b - pn); pl = a; pn = b; }
  return out;
}

function relationFor(id) {
  const f = ZERMATT.features.find(x => String(x.properties.osm_relation_id) === String(id));
  const p = f ? f.properties : { name: 'Test route' };
  const [w, s, e, n] = f ? p.bbox : [7.74, 46.01, 7.76, 46.03];
  const coords = [];
  for (let i = 0; i <= 40; i++) coords.push([w + (e - w) * i / 40, s + (n - s) * (0.5 + 0.45 * Math.sin(i / 6)) ]);
  return { type: 'Feature', properties: p, geometry: { type: 'LineString', coordinates: coords } };
}

function elevationProfile() {
  const pts = [];
  for (let i = 0; i <= 60; i++) pts.push([i * 100, 1620 + 380 * Math.sin(i / 12) + 60 * Math.sin(i / 3)]);
  return { series: { columns: ['distance_m', 'elevation_m'], points: pts }, elevation: { source: 'terrain', ascent_m: 512, descent_m: 498 } };
}

/* ---------------- scripted Puter / Grok ---------------- */
export const PUTER_MOCK = `
(function () {
  var signed = false;
  function last(messages, role) { for (var i = messages.length - 1; i >= 0; i--) if (messages[i].role === role) return messages[i]; return null; }
  window.__puterCalls = [];
  window.puter = {
    auth: {
      isSignedIn: function () { return signed; },
      signIn: function (o) { window.__puterSignIn = o; signed = true; return Promise.resolve({ success: true }); },
      signOut: function () { signed = false; }
    },
    ai: {
      chat: function (messages, opts) {
        window.__puterCalls.push({ n: messages.length, model: opts && opts.model, tools: !!(opts && opts.tools) });
        return new Promise(function (resolve) {
          setTimeout(function () {
            var tool = last(messages, 'tool');
            var user = last(messages, 'user');
            var q = (user && user.content || '').toLowerCase();
            var lastIsTool = messages[messages.length - 1].role === 'tool';
            if (lastIsTool) {
              var data = {}; try { data = JSON.parse(tool.content); } catch (e) {}
              var t = data.trails && data.trails[0];
              if (data.loops) return resolve({ message: { role: 'assistant', content: 'I planned a **' + data.loops[0].length.mi + ' mi loop** (' + data.loops[0].length.km + ' km, ~' + data.loops[0].est_time_min + ' min, ' + data.loops[0].climb_m + ' m climb). It is drawn on the map in purple.' } });
              if (data.counts) { var pk = (data.nearest_each && data.nearest_each.parking) || data.nearest[0]; return resolve({ message: { role: 'assistant', content: 'Park at **' + pk.name + '** (' + pk.km_away + ' km). Water: ' + ((data.nearest_each.water || {}).name || 'none mapped') + '.' } }); }
              if (t) return resolve({ message: { role: 'assistant', content: 'The easiest nearby option is **' + t.name + '** — ' + (t.length ? t.length.mi + ' mi (' + t.length.km + ' km)' : 'length unlisted') + '.\\n- Mostly gentle\\n- Great views' } });
              return resolve({ message: { role: 'assistant', content: 'Done.' } });
            }
            if (/loop/.test(q)) return resolve({ message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'plan_loop_route', arguments: JSON.stringify({ distance_km: 5 }) } }] } });
            if (/park|water/.test(q)) return resolve({ message: { role: 'assistant', content: '', tool_calls: [{ id: 't2', type: 'function', function: { name: 'find_places_nearby', arguments: JSON.stringify({ kinds: ['parking', 'water'] }) } }] } });
            if (/easiest|easy/.test(q)) return resolve({ message: { role: 'assistant', content: '', tool_calls: [{ id: 't3', type: 'function', function: { name: 'search_trails', arguments: JSON.stringify({ sort: 'shortest', limit: 3 }) } }] } });
            resolve({ message: { role: 'assistant', content: 'Pack water, layers and sun cream — weather changes fast up there.' } });
          }, 120);
        });
      }
    }
  };
})();`;

/* ---------------- controllable GPS (tracking, location-off tests) ---------------- */
export const GEO_MOCK = `(function () {
  var watchers = {}, nid = 1, cfg = { mode: 'ok', lat: 30.2672, lon: -97.7431, acc: 12, code: 2 };
  function pos(lat, lon, acc, t, speed) {
    return { coords: { latitude: lat, longitude: lon, accuracy: acc, altitude: null, altitudeAccuracy: null, heading: null, speed: speed == null ? null : speed }, timestamp: t || Date.now() };
  }
  function err(code) { return { code: code, message: 'mock', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }; }
  var geo = {
    getCurrentPosition: function (ok, fail) {
      window.__geoCalls = (window.__geoCalls || 0) + 1;
      setTimeout(function () { if (cfg.mode === 'ok') ok(pos(cfg.lat, cfg.lon, cfg.acc)); else if (fail) fail(err(cfg.code)); }, 40);
    },
    watchPosition: function (ok, fail) {
      var id = nid++; watchers[id] = { ok: ok, fail: fail };
      setTimeout(function () { if (cfg.mode !== 'ok' && watchers[id] && fail) fail(err(cfg.code)); }, 40);
      return id;
    },
    clearWatch: function (id) { delete watchers[id]; }
  };
  Object.defineProperty(Navigator.prototype, 'geolocation', { get: function () { return geo; }, configurable: true });
  window.__geo = {
    set: function (o) { for (var k in o) cfg[k] = o[k]; },
    emit: function (lat, lon, acc, t, speed) { Object.keys(watchers).forEach(function (id) { watchers[id].ok(pos(lat, lon, acc, t, speed)); }); },
    watchers: function () { return Object.keys(watchers).length; }
  };
})();`;

/* ---------------- the APK's window.CalledItAndroid bridge ---------------- */
export const BRIDGE_MOCK = `(function () {
  window.__bridge = { prompts: 0, settings: 0, locationOn: false };
  window.CalledItAndroid = {
    promptEnableLocation: function () { window.__bridge.prompts++; return !window.__bridge.locationOn; },
    openLocationSettings: function () { window.__bridge.settings++; },
    isLocationOn: function () { return window.__bridge.locationOn; },
    appVersion: function () { return '1.2.1'; }
  };
})();`;

/* ---------------- request router ---------------- */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const json = (obj, status = 200) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(obj) });

export function makeRouter(opts = {}) {
  const log = { external: [], blocked: [], apiCalls: [] };
  const scenario = opts.scenario || 'zermatt';
  let photoN = 0;
  function route(req) {
    const url = req.url();
    const u = new URL(url);
    const host = u.hostname;
    if (u.protocol === 'data:' || u.protocol === 'blob:') return 'continue';
    if (req.method() === 'OPTIONS') return { status: 204, headers: CORS, body: '' };
    if (host === '127.0.0.1' || host === 'localhost') return 'continue';
    log.external.push(url);
    if (host === 'api.trailsplits.com') {
      log.apiCalls.push({ path: u.pathname, query: u.search, auth: req.headers()['authorization'] || null });
      if (u.pathname.startsWith('/trails/v1/bbox')) return json(scenario === 'austin' ? { type: 'FeatureCollection', features: [] } : ZERMATT);
      if (u.pathname.startsWith('/trails/v1/relation/')) return json(relationFor(u.pathname.split('/').pop()));
      if (u.pathname.startsWith('/v1/elevation-profile')) return json(elevationProfile());
      if (u.pathname.startsWith('/search/v1/forward')) {
        const q = (u.searchParams.get('q') || '').toLowerCase();
        if (/austin/.test(q)) return json({ features: [{ center: [-97.7431, 30.2672], name: 'Austin', region: 'Texas' }] });
        if (/zzzz/.test(q)) return json({ features: [] });
        return json({ features: [{ center: [7.7491, 46.0207], name: 'Zermatt', region: 'Valais' }] });
      }
      if (u.pathname.startsWith('/search/v1/reverse')) return json({ features: [{ name: 'Zermatt', region: 'Valais' }] });
      if (u.pathname.startsWith('/pois/v1/bbox')) {
        const kinds = (u.searchParams.get('kind') || '').split(',');
        return json({ features: [
          { kind: 'parking', name: 'Täsch Matterhorn Terminal', lat: 46.068, lon: 7.778 },
          { kind: 'drinking_water', name: 'Brunnen Bahnhofplatz', lat: 46.0236, lon: 7.7476 },
          { kind: 'toilets', name: null, lat: 46.0222, lon: 7.7481 }
        ].filter(f => !kinds[0] || kinds.includes(f.kind)) });
      }
      if (u.pathname.startsWith('/v1/roundtrips')) {
        const body = JSON.parse(req.postData() || '{}');
        const [lon, lat] = body.start || [7.7491, 46.0207];
        const pts = [[lat, lon], [lat + 0.006, lon + 0.008], [lat + 0.012, lon], [lat + 0.006, lon - 0.008], [lat, lon]];
        return json({ schema: 'roundtrips/1', status: 'complete', loops: [{ rank: 1, status: 'complete', distance_m: 5120, target_m: 5000, target_error_pct: 2.4, repeated_share: 0.03, ascent_m: 186, time: { moving_s: 4620 }, shape: encode6(pts), score: { marked: 0.82 } }] });
      }
      return json({ error: 'unmocked ' + u.pathname }, 404);
    }
    if (host === 'trailsplits.com' && u.pathname.startsWith('/api/weather/forecast')) {
      const p = (u.searchParams.get('p') || '46,7').split(',').map(Number);
      return json(forecast(p[0], p[1]));
    }
    if (host === 'api.open-meteo.com') return json({ daily: { time: ['2026-10-12'], weather_code: [1], temperature_2m_max: [15], temperature_2m_min: [4], precipitation_sum: [0], precipitation_probability_max: [5], wind_speed_10m_max: [10], wind_gusts_10m_max: [20] } });
    if (/overpass|interpreter/.test(url)) return json({ elements: [] });
    if (host === 'places.googleapis.com') {
      if (u.pathname.includes('places:search')) {
        if (scenario === 'austin') return json(placesResponse([
          ['ChIJbarton', 'Barton Creek Greenbelt', 30.2595, -97.7856, 4.8, 5210],
          ['ChIJladybird', 'Lady Bird Lake Hike-and-Bike Trail', 30.2638, -97.7495, 4.8, 9010],
          ['ChIJbonnell', 'Mount Bonnell', 30.3207, -97.7735, 4.7, 12400],
          ['ChIJwalnut', 'Walnut Creek Metropolitan Park', 30.3995, -97.6812, 4.7, 3200]
        ]));
        return json(placesResponse(PLACES_ZERMATT));
      }
      if (u.pathname.endsWith('/media')) {
        if (opts.googlePhotosFail) return { status: 403, contentType: 'text/plain', headers: CORS, body: 'denied' };
        return { status: 200, contentType: 'image/jpeg', headers: CORS, body: PHOTOS[(photoN++) % PHOTOS.length] };
      }
    }
    if (host === 'commons.wikimedia.org') {
      const coord = (u.searchParams.get('ggscoord') || '46|7').split('|').map(Number);
      if (opts.commonsEmpty) return json({ batchcomplete: '' });
      return json(commonsResponse(coord[0], coord[1]));
    }
    if (host === 'thumb.wikimedia.org' || host === 'upload.wikimedia.org') {
      return { status: 200, contentType: 'image/jpeg', headers: CORS, body: PHOTOS[(photoN++) % PHOTOS.length] };
    }
    if (/basemaps\.cartocdn\.com|tile\.opentopomap\.org|tile\.openstreetmap\.org/.test(host)) {
      return { status: 200, contentType: 'image/png', headers: CORS, body: TILE_PNG };
    }
    if (host === 'js.puter.com') return { status: 200, contentType: 'text/javascript', headers: CORS, body: PUTER_MOCK };
    log.blocked.push(url);
    return 'abort';
  }
  return { route, log };
}

/* ---------------- browser ---------------- */
export async function launch() {
  const puppeteer = (await import('puppeteer-core')).default;
  if (process.env.CHROME_PATH) {             /* any installed Chrome/Chromium, e.g. on CI runners */
    return puppeteer.launch({ executablePath: process.env.CHROME_PATH, headless: true, args: ['--no-sandbox', '--lang=en-US'] });
  }
  process.env.AWS_EXECUTION_ENV = process.env.AWS_EXECUTION_ENV || 'AWS_Lambda_nodejs22.x';
  const chromium = (await import('@sparticuz/chromium')).default;
  return puppeteer.launch({
    executablePath: await chromium.executablePath(),
    /* drop single-process (breaks separate contexts) and the web-security
       opt-outs, so CORS / same-origin behave like a real phone browser */
    args: chromium.args.filter(a => !/^--(single-process|disable-web-security|allow-running-insecure-content)$/.test(a))
      .concat(['--no-sandbox', '--lang=en-US']),
    headless: 'shell'
  });
}

export async function openPage(browser, url, opts = {}) {
  const context = await browser.createBrowserContext();
  const origin = new URL(url).origin;
  await context.overridePermissions(origin, ['geolocation']);
  const page = await context.newPage();
  const mobile = opts.mobile !== false;
  await page.setViewport(mobile ? { width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1366, height: 900 });
  if (opts.userAgent) await page.setUserAgent(opts.userAgent);
  else if (mobile) await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36');
  await page.setGeolocation({ latitude: opts.lat || 46.0207, longitude: opts.lon || 7.7491, accuracy: 12 });
  const router = makeRouter(opts);
  await page.setRequestInterception(true);
  page.on('request', req => {
    const r = router.route(req);
    if (r === 'continue') req.continue();
    else if (r === 'abort') req.abort('internetdisconnected');
    else req.respond(r);
  });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + (e && e.message)));
  page.on('console', m => { if (m.type() === 'error' && !/net::ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(m.text())) errors.push('console: ' + m.text()); });
  const failedLocal = [];
  page.on('requestfailed', r => { const u = r.url(); if (/^http:\/\/(127\.0\.0\.1|localhost)/.test(u)) failedLocal.push(u); });
  page.on('response', r => { const u = r.url(); if (/^http:\/\/(127\.0\.0\.1|localhost)/.test(u) && r.status() >= 400) failedLocal.push(r.status() + ' ' + u); });
  if (opts.fakeGeo) await page.evaluateOnNewDocument(GEO_MOCK);
  if (opts.bridge) await page.evaluateOnNewDocument(BRIDGE_MOCK);
  if (opts.beforeLoad) await opts.beforeLoad(page);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, context, router, errors, failedLocal };
}

export async function brokenImages(page) {
  return page.evaluate(() => Array.from(document.images)
    .filter(img => img.complete && img.getAttribute('src') && img.naturalWidth === 0 && img.offsetParent !== null)
    .map(img => img.getAttribute('src')));
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function waitFor(page, fn, timeout = 8000, ...args) {
  try { await page.waitForFunction(fn, { timeout, polling: 100 }, ...args); return true; } catch (e) { return false; }
}

/* ---------------- static server (self-contained runs) ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
export function serveStatic(root = ROOT, port = 0) {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(root, path.normalize(p));
      if (!f.startsWith(root)) { res.writeHead(403); res.end(); return; }
      fs.readFile(f, (err, buf) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve({ origin: 'http://127.0.0.1:' + srv.address().port, close: () => new Promise(r => srv.close(r)) }));
  });
}

/* ---------------- tiny test runner ---------------- */
export function makeRunner() {
  const r = { pass: 0, fail: 0, failures: [] };
  r.check = (name, ok, detail) => {
    if (ok) { r.pass++; console.log('  \u2713 ' + name); }
    else { r.fail++; r.failures.push(name + (detail ? ' — ' + detail : '')); console.log('  \u2717 ' + name + (detail ? '  -> ' + detail : '')); }
    return !!ok;
  };
  r.section = async (name, fn) => {
    if (process.env.ONLY && !new RegExp(process.env.ONLY, 'i').test(name)) return;
    console.log('\n' + name);
    try { await fn(); } catch (e) { r.fail++; r.failures.push(name + ' threw: ' + (e && e.message)); console.log('  \u2717 threw: ' + (e && e.stack)); }
  };
  return r;
}
