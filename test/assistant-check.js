/* Functional test for the Trails page (needs `npm i jsdom` somewhere on NODE_PATH).
   Loads the REAL trails.html + js/*.js in jsdom with:
     - mocked trail/weather/places/POI/loop APIs (window.fetch)
     - a mocked Puter.js (window.puter) that scripts Grok tool-calling replies
     - Google Maps blocked → must fall back to the bundled Leaflet map
     - mocked geolocation to drive the hike tracker
   Run:  NODE_PATH=/path/to/node_modules node test/assistant-check.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, ResourceLoader, VirtualConsole } = require('jsdom');

const root = path.join(__dirname, '..');
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond || extra === undefined ? '' : '  → ' + extra));
  if (!cond) failures++;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 4000)) { try { if (fn()) return true; } catch (e) { } await sleep(25); }
  return false;
}

/* ---------- local files only; everything external fails ---------- */
class LocalLoader extends ResourceLoader {
  fetch(url, options) {
    if (url.startsWith('http://127.0.0.1:8765/')) {
      const rel = decodeURIComponent(url.slice('http://127.0.0.1:8765/'.length).split('?')[0]);
      const file = path.join(root, rel);
      if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file));
    }
    loadedExternal.push(url);
    return Promise.reject(new Error('blocked in test: ' + url));
  }
}
const loadedExternal = [];

/* polyline6 encoder for the fake loop */
function encode6(points) {
  let out = '', pl = 0, pn = 0;
  function enc(v) { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); }
  points.forEach(([lat, lng]) => { const a = Math.round(lat * 1e6), b = Math.round(lng * 1e6); out += enc(a - pl) + enc(b - pn); pl = a; pn = b; });
  return out;
}
const LOOP = [[46.02, 7.749], [46.025, 7.755], [46.03, 7.749], [46.02, 7.749]];

const fetchLog = [];
function fakeFetch(url, opts) {
  fetchLog.push(String(url));
  const json = (obj, status) => Promise.resolve({ ok: (status || 200) < 400, status: status || 200, json: () => Promise.resolve(obj) });
  url = String(url);
  if (url.includes('/trails/v1/bbox')) {
    return json({ type: 'FeatureCollection', features: [
      { properties: { osm_relation_id: 111, route_type: 'hiking', name: 'Lake Loop Trail', network: 'lwn', distance_m: 4200 }, geometry: { type: 'Point', coordinates: [7.75, 46.02] } },
      { properties: { osm_relation_id: 222, route_type: 'hiking', name: 'Ridge Traverse', network: 'rwn', distance_m: 15800 }, geometry: { type: 'Point', coordinates: [7.76, 46.03] } },
      { properties: { osm_relation_id: 333, route_type: 'hiking', name: 'Forest Walk', network: 'lwn', distance_m: 2500 }, geometry: { type: 'Point', coordinates: [7.74, 46.01] } }
    ] });
  }
  if (url.includes('overpass') || url.includes('interpreter')) return json({ elements: [] });
  if (url.includes('places.googleapis.com')) return json({ places: [] });
  if (url.includes('/api/weather/forecast')) {
    return json({ provider: { attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)' }, points: [{ days: [
      { date: '2026-10-12', weather_code: 2, temp_max_c: 18, temp_min_c: 7, precip_mm: 0, precip_probability_max_pct: 5 },
      { date: '2026-10-13', weather_code: 61, temp_max_c: 14, temp_min_c: 6, precip_mm: 6, precip_probability_max_pct: 80 },
      { date: '2026-10-14', weather_code: 0, temp_max_c: 20, temp_min_c: 8, precip_mm: 0, precip_probability_max_pct: 0 }
    ] }] });
  }
  if (url.includes('/trails/v1/relation/')) return json({ properties: { ascent_m: 320, descent_m: 318, from: 'Village', to: 'Lake' }, geometry: null });
  if (url.includes('/v1/roundtrips')) {
    const body = JSON.parse(opts.body);
    lastLoopBody = body;
    return json({ schema: 'roundtrips/1', status: 'complete', loops: [{ rank: 1, status: 'complete', distance_m: 5100, target_m: 5000, target_error_pct: 2, repeated_share: 0.04, ascent_m: 140, time: { moving_s: 4380 }, shape: encode6(LOOP), score: { marked: 0.8 } }] });
  }
  if (url.includes('/pois/v1/bbox')) {
    return json({ features: [
      { kind: 'parking', name: 'Trailhead Lot', lat: 46.021, lon: 7.751 },
      { kind: 'water', name: 'Fountain', lat: 46.0205, lon: 7.7495 }
    ] });
  }
  if (url.includes('/search/v1/reverse')) return json({ features: [{ name: 'Testville', region: 'TS' }] });
  if (url.includes('/search/v1/forward')) return json({ features: [{ center: [-97.74, 30.27], name: 'Austin', region: 'Texas' }] });
  return json({ error: 'unexpected ' + url }, 404);
}
let lastLoopBody = null;

/* ---------- scripted Puter mock ---------- */
const chatCalls = [];
let script = [];         /* queue of fn(messages, opts) → response | throws */
const puterMock = {
  auth: {
    signedIn: false, signInCalls: [], failNext: null,
    isSignedIn() { return this.signedIn; },
    signIn(opts) {
      this.signInCalls.push(opts);
      if (this.failNext) { const e = this.failNext; this.failNext = null; return Promise.reject(e); }
      this.signedIn = true; return Promise.resolve({ success: true });
    },
    signOut() { this.signedIn = false; }
  },
  ai: {
    chat(messages, opts) {
      chatCalls.push({ messages: JSON.parse(JSON.stringify(messages)), opts: JSON.parse(JSON.stringify(opts)) });
      const step = script.shift();
      if (!step) return Promise.reject(new Error('no scripted reply'));
      try { return Promise.resolve(step(messages, opts)); } catch (e) { return Promise.reject(e); }
    }
  }
};

/* ---------- geolocation mock ---------- */
const geo = { watchers: {}, nextId: 1 };
const geolocation = {
  getCurrentPosition(ok) { setTimeout(() => ok({ coords: { latitude: 46.02, longitude: 7.749, accuracy: 8 }, timestamp: Date.now() }), 5); },
  watchPosition(ok, err) { const id = geo.nextId++; geo.watchers[id] = ok; return id; },
  clearWatch(id) { delete geo.watchers[id]; }
};
function emitFix(lat, lng, acc, t, speed) {
  Object.values(geo.watchers).forEach(fn => fn({ coords: { latitude: lat, longitude: lng, accuracy: acc, speed: speed == null ? null : speed }, timestamp: t }));
}

(async function main() {
  const html = fs.readFileSync(path.join(root, 'trails.html'), 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => { if (!/blocked in test|Could not load script|Could not load link/.test(String(e && e.message))) errors.push(String(e && (e.stack || e.message))); });
  vc.on('error', () => { });
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/trails.html',
    runScripts: 'dangerously',
    resources: new LocalLoader(),
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(win) {
      win.fetch = fakeFetch;
      win.puter = puterMock;
      Object.defineProperty(win.navigator, 'geolocation', { value: geolocation, configurable: true });
      win.Element.prototype.scrollIntoView = function () { };
      /* jsdom has no SVG geometry; Leaflet only needs createSVGRect to exist to pick its SVG renderer */
      if (win.SVGSVGElement && !win.SVGSVGElement.prototype.createSVGRect) win.SVGSVGElement.prototype.createSVGRect = function () { return {}; };
      if (win.SVGElement && !win.SVGElement.prototype.getBBox) win.SVGElement.prototype.getBBox = function () { return { x: 0, y: 0, width: 0, height: 0 }; };
      Object.defineProperty(win.HTMLElement.prototype, 'clientWidth', { get() { return 360; }, configurable: true });
      Object.defineProperty(win.HTMLElement.prototype, 'clientHeight', { get() { return 300; }, configurable: true });
    }
  });
  const win = dom.window, doc = win.document;
  const $ = s => doc.querySelector(s);

  /* ---- page boot ---- */
  check('trail list rendered from TrailSplits data', await waitFor(() => doc.querySelectorAll('.trail-card').length === 3, 5000), doc.querySelectorAll('.trail-card').length);
  check('status line mentions TrailSplits', /TrailSplits/.test($('#statusLine').textContent), $('#statusLine').textContent);
  check('weather strip rendered', doc.querySelectorAll('.weather-day').length === 3);

  /* ---- Google blocked → Leaflet fallback (never the OSM iframe) ---- */
  check('no OSM iframe on the page', !$('#osmMap'));
  check('Leaflet backup map shown when Google can’t load', await waitFor(() => $('#leafletMap').style.display === 'block' && win.L, 5000), $('#leafletMap').style.display);
  check('caption explains Google failure', /Google Maps couldn’t load/.test($('#mapCaption').innerHTML), $('#mapCaption').innerHTML);
  check('Leaflet trail pins drawn', await waitFor(() => doc.querySelectorAll('#leafletMap .lf-pin').length === 3, 3000), doc.querySelectorAll('#leafletMap .lf-pin').length);

  /* ---- assistant: open, greeting, Puter sign-in + tool calling ---- */
  $('#assistantFab').click();
  check('assistant opens with a Grok greeting', /Grok/.test($('#assistantLog').textContent));
  check('greeting explains the free Puter sign-in', /Puter sign-in/.test($('#assistantLog').textContent));
  check('status shows Grok 4.1 Fast via Puter', /Grok 4\.1 Fast by xAI · via Puter/.test($('#assistantStatus').textContent), $('#assistantStatus').textContent);

  script = [
    (messages, opts) => ({ message: { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search_trails', arguments: JSON.stringify({ sort: 'shortest', limit: 2 }) } },
      { id: 'c2', type: 'function', function: { name: 'get_weather', arguments: '{}' } }
    ] } }),
    (messages) => ({ message: { role: 'assistant', content: '**Forest Walk** (1.6 mi) is the easiest.\n- Dry on Monday\n- Rain Tuesday' } })
  ];
  $('#assistantText').value = 'Which trail is easiest and will it rain?';
  $('#assistantForm').dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  check('typed question goes to Grok and the answer is rendered', await waitFor(() => /easiest/.test($('#assistantLog').lastElementChild.textContent) && !$('.msg--typing'), 4000), $('#assistantLog').lastElementChild.innerHTML);
  check('sign-in used attempt_temp_user_creation', puterMock.auth.signInCalls.length === 1 && puterMock.auth.signInCalls[0].attempt_temp_user_creation === true, JSON.stringify(puterMock.auth.signInCalls));
  const c0 = chatCalls[0], c1 = chatCalls[1];
  check('first call: system prompt + user question', c0 && c0.messages[0].role === 'system' && c0.messages[c0.messages.length - 1].content === 'Which trail is easiest and will it rain?');
  check('first call: default model grok-4-1-fast-non-reasoning, normalize, tools', c0 && c0.opts.model === 'x-ai/grok-4-1-fast-non-reasoning' && c0.opts.normalize === true && Array.isArray(c0.opts.tools) && c0.opts.tools.length >= 8, c0 && JSON.stringify(c0.opts).slice(0, 160));
  check('system prompt lists loaded trails + forecast', c0 && /Lake Loop Trail/.test(c0.messages[0].content) && /Forecast here/.test(c0.messages[0].content));
  const toolMsgs = c1 ? c1.messages.filter(m => m.role === 'tool') : [];
  check('second call carries the assistant tool_calls + 2 tool results', c1 && c1.messages.some(m => m.role === 'assistant' && m.tool_calls && m.tool_calls.length === 2) && toolMsgs.length === 2);
  const searchRes = toolMsgs[0] ? JSON.parse(toolMsgs[0].content) : {};
  check('search_trails result: shortest first (Forest Walk)', searchRes.trails && searchRes.trails[0].name === 'Forest Walk' && searchRes.trails[0].length.mi === 1.6, toolMsgs[0] && toolMsgs[0].content.slice(0, 200));
  const wxRes = toolMsgs[1] ? JSON.parse(toolMsgs[1].content) : {};
  check('get_weather result has °F + rain chance', wxRes.days && wxRes.days[1].rain_chance_pct === 80 && wxRes.days[0].high_f === 64, toolMsgs[1] && toolMsgs[1].content.slice(0, 200));
  check('markdown rendered (bold + list)', /<b>Forest Walk<\/b>/.test($('#assistantLog').lastElementChild.innerHTML) && /<li>/.test($('#assistantLog').lastElementChild.innerHTML));

  /* ---- loop planning (TrailSplits roundtrips) + drawn on the map ---- */
  script = [
    () => ({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'l1', type: 'function', function: { name: 'plan_loop_route', arguments: JSON.stringify({ distance_km: 5, start: 'my_location' }) } }] } }),
    (messages) => ({ message: { role: 'assistant', content: 'Here is a **5.1 km loop** — it is on the map in purple.' } })
  ];
  const before = chatCalls.length;
  $('#assistantText').value = 'Plan a 5 km loop near me';
  $('#assistantForm').dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  check('loop answer rendered', await waitFor(() => /5\.1 km loop/.test($('#assistantLog').textContent) && !$('.msg--typing'), 4000));
  check('roundtrips called with GPS start + 5 km + hike', lastLoopBody && lastLoopBody.distance_km === 5 && lastLoopBody.profile === 'hike' && Math.abs(lastLoopBody.start[1] - 46.02) < 1e-6, JSON.stringify(lastLoopBody));
  const loopTool = chatCalls[before + 1] && chatCalls[before + 1].messages.filter(m => m.role === 'tool').pop();
  const loopRes = loopTool ? JSON.parse(loopTool.content) : {};
  check('loop tool result: drawn on map, 73 min, 140 m climb', loopRes.drawn_on_map === true && loopRes.loops[0].est_time_min === 73 && loopRes.loops[0].climb_m === 140, loopTool && loopTool.content);
  check('loop polyline on the Leaflet map', !!doc.querySelector('#leafletMap path.leaflet-interactive[stroke="#7c3aed"]'));
  check('history kept for follow-ups', chatCalls[before].messages.some(m => m.role === 'assistant' && /easiest/.test(m.content)));

  /* ---- model fallback ---- */
  script = [
    () => { throw { error: { message: 'model x-ai/grok-4-1-fast-non-reasoning not available' } }; },
    () => ({ message: { role: 'assistant', content: [{ type: 'text', text: 'Answer from the fallback model.' }] } })
  ];
  const b2 = chatCalls.length;
  $('#assistantText').value = 'What should I pack?';
  $('#assistantForm').dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  check('falls back to the next Grok model + array content handled', await waitFor(() => /fallback model/.test($('#assistantLog').textContent), 4000));
  check('fallback model is grok-4.7', chatCalls[b2 + 1] && chatCalls[b2 + 1].opts.model === 'x-ai/grok-4.7', chatCalls[b2 + 1] && chatCalls[b2 + 1].opts.model);

  /* ---- sign-in cancelled → local answer + sign-in button ---- */
  puterMock.auth.signedIn = false;
  puterMock.auth.failNext = { error: 'auth_window_closed', msg: 'closed' };
  script = [];
  await waitFor(() => !$('.msg--typing'), 1000);
  $('#assistantText').value = 'Is Lake Loop Trail good?';
  $('#assistantForm').dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  check('cancelled sign-in → explains + offers retry + local data', await waitFor(() => /Sign in &amp; ask again|Sign in & ask again/.test($('#assistantLog').lastElementChild.innerHTML), 4000) &&
    /Lake Loop Trail/.test($('#assistantLog').lastElementChild.textContent), $('#assistantLog').lastElementChild.innerHTML.slice(0, 300));

  /* ---- action tool: update_trail_list changes what is on screen ---- */
  puterMock.auth.signedIn = true;
  script = [
    () => ({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'u1', type: 'function', function: { name: 'update_trail_list', arguments: JSON.stringify({ max_km: 5 }) } }] } }),
    () => ({ message: { role: 'assistant', content: 'Showing the 2 trails under 5 km.' } })
  ];
  $('#assistantText').value = 'only show trails under 5 km';
  $('#assistantForm').dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
  check('update_trail_list filtered the visible list to 2', await waitFor(() => doc.querySelectorAll('.trail-card').length === 2, 4000), doc.querySelectorAll('.trail-card').length);

  /* ---- tracker: desk jitter adds nothing; walking counts; pause is real ---- */
  const closeBtn = $('#assistantClose'); closeBtn.click();
  $('#trackBtn').click();
  check('tracking panel visible + map docked under it', !$('#trackPanel').hidden && $('#trackPanel').nextElementSibling.classList.contains('map-panel'));
  let t = Date.now();
  const R = 111320;
  /* 90 s on a desk: ±15 m accuracy, positions wandering up to 22 m */
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) {
    const dx = (rnd() - .5) * 44, dy = (rnd() - .5) * 44;
    emitFix(46.02 + dy / R, 7.749 + dx / (R * Math.cos(46.02 * Math.PI / 180)), 15, t += 1000, rnd() < .5 ? 0 : null);
  }
  check('desk jitter (90 fixes, ±15 m) adds 0 distance', /^0\.00 mi$/.test($('#trackDist').textContent), $('#trackDist').textContent);
  /* also some awful fixes */
  emitFix(46.03, 7.76, 60, t += 1000);
  check('±60 m fix ignored', /^0\.00 mi$/.test($('#trackDist').textContent), $('#trackDist').textContent);
  /* walk north 1.4 m/s for 120 s with ±5 m accuracy */
  let lat = 46.02;
  for (let i = 0; i < 120; i++) { lat += 1.4 / R; emitFix(lat + (rnd() - .5) * 4 / R, 7.749, 5, t += 1000, 1.4); }
  const walked = parseFloat($('#trackDist').textContent);
  check('120 s walk at 1.4 m/s ≈ 0.10 mi (168 m) counted', walked >= 0.08 && walked <= 0.12, $('#trackDist').textContent);
  /* pause, walk 100 m, resume → unchanged */
  $('#trackPause').click();
  for (let i = 0; i < 70; i++) { lat += 1.4 / R; emitFix(lat, 7.749, 5, t += 1000, 1.4); }
  $('#trackPause').click();
  emitFix(lat, 7.749, 5, t += 1000, 0);
  check('walking while paused adds nothing', $('#trackDist').textContent === walked.toFixed(2) + ' mi', $('#trackDist').textContent + ' vs ' + walked.toFixed(2));
  /* GPS teleport rejected */
  emitFix(lat + 2000 / R, 7.749, 5, t += 1000);
  emitFix(lat + 2001 / R, 7.749, 5, t += 1000);
  check('2 km teleport rejected', $('#trackDist').textContent === walked.toFixed(2) + ' mi', $('#trackDist').textContent);
  check('live track polyline drawn on the map', !!doc.querySelector('#leafletMap path.leaflet-interactive[stroke="#16a34a"]'));
  $('#trackStop').click();
  const logs = JSON.parse(win.localStorage.getItem('calledit_tracks_v1') || '[]');
  check('finished hike saved', logs.length === 1 && logs[0].km > 0.12 && logs[0].km < 0.2, JSON.stringify(logs));
  check('map returned to its normal place', !$('#trackPanel').nextElementSibling.classList.contains('map-panel'));

  /* ---- scenario 2: US-style area — no signed relations, Google places fill the list; TrailSplits key → Bearer header ---- */
  const seenHeaders = [];
  const dom2 = new JSDOM(html, {
    url: 'http://127.0.0.1:8765/trails.html?lat=30.27&lon=-97.74',
    runScripts: 'dangerously', resources: new LocalLoader(), pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.localStorage.setItem('calledit_keys_v1', JSON.stringify({ trailsplitsApiKey: 'ts-test-key' }));
      w.fetch = (url, opts) => {
        url = String(url);
        if (url.includes('api.trailsplits.com')) seenHeaders.push((opts && opts.headers) || {});
        const json = obj => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(obj) });
        if (url.includes('/trails/v1/bbox')) return json({ type: 'FeatureCollection', features: [] });
        if (url.includes('interpreter')) return json({ elements: [] });
        if (url.includes('places.googleapis.com')) return json({ places: [
          { id: 'p1', displayName: { text: 'Barton Creek Greenbelt' }, location: { latitude: 30.26, longitude: -97.79 }, rating: 4.8, userRatingCount: 5200, googleMapsUri: 'https://maps.google.com/?cid=1' },
          { id: 'p2', displayName: { text: 'Lady Bird Lake Hike-and-Bike Trail' }, location: { latitude: 30.26, longitude: -97.75 }, rating: 4.7, userRatingCount: 9000 }
        ] });
        if (url.includes('/api/weather/forecast')) return Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve({}) });
        if (url.includes('allorigins')) return Promise.resolve({ ok: false, status: 502, json: () => Promise.resolve({}) });
        if (url.includes('api.open-meteo.com')) return json({ daily: { time: ['2026-10-12'], weather_code: [1], temperature_2m_max: [31], temperature_2m_min: [21], precipitation_sum: [0], precipitation_probability_max: [3], wind_speed_10m_max: [12], wind_gusts_10m_max: [30] } });
        return json({});
      };
      w.puter = puterMock;
      Object.defineProperty(w.navigator, 'geolocation', { value: geolocation, configurable: true });
      w.Element.prototype.scrollIntoView = function () { };
    }
  });
  const d2 = dom2.window.document;
  check('no signed routes → Google “hiking area” places listed as trails', await waitFor(() => d2.querySelectorAll('.trail-card').length === 2, 5000), d2.querySelectorAll('.trail-card').length);
  check('status credits Google Maps', /Google Maps/.test(d2.querySelector('#statusLine').textContent), d2.querySelector('#statusLine').textContent);
  check('TrailSplits forecast down → Open-Meteo fallback fills the weather strip', d2.querySelectorAll('.weather-day').length === 1);
  check('TrailSplits key sent as Authorization: Bearer (not ?key=)', seenHeaders.length > 0 && seenHeaders.every(h => h.Authorization === 'Bearer ts-test-key'), JSON.stringify(seenHeaders.slice(0, 2)));
  dom2.window.close();

  check('no uncaught script errors', errors.length === 0, errors.join('\n---\n').slice(0, 1500));
  check('external requests were only Google Maps / fonts / Puter (all blocked)', loadedExternal.every(u => /maps\.googleapis|fonts\.googleapis|js\.puter\.com/.test(u)), loadedExternal.join(', '));

  console.log(failures ? '\n' + failures + ' FAILURES' : '\nAll assistant/map/tracker checks passed.');
  win.close();
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
