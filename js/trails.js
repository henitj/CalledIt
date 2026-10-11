/* ============================================================
   Trails page
   Data providers (in order of preference, all automatic):
     1. TrailSplits API  — trails/bbox, search, weather, elevation
     2. OpenStreetMap    — Overpass + Nominatim fallback
     3. Google Maps      — Places photos + ratings, interactive map
   ============================================================ */
(function () {
  'use strict';

  var C = window.CalledIt;
  var cfg = window.CALLEDIT_CONFIG;
  var qs = C.qs, qsa = C.qsa, esc = C.escapeHtml;

  /* ---------------- state ---------------- */
  var state = {
    mode: 'hike',                       // 'hike' | 'bike'
    location: { lat: cfg.defaultLocation.lat, lon: cfg.defaultLocation.lon, label: cfg.defaultLocation.label, guessed: true },
    trails: [],                         // normalized trail records
    googlePlaces: [],                   // google places results near location
    weather: null,                      // trailsplits weather response
    dataSource: '…',
    googleOk: false,
    mapLib: null,                       // 'google' | 'osm' | null
    map: null, markers: [],
    filter: { maxKm: null, sort: 'near', easyOnly: false, minRating: null },
    loading: false
  };

  var els = {
    searchInput: qs('#searchInput'), searchBtn: qs('#searchBtn'), locateBtn: qs('#locateBtn'),
    modeHike: qs('#modeHike'), modeBike: qs('#modeBike'),
    statusLine: qs('#statusLine'), errorBox: qs('#errorBox'),
    weatherStrip: qs('#weatherStrip'), weatherNote: qs('#weatherNote'),
    highlights: qs('#highlights'), highlightsRow: qs('#highlightsRow'),
    trailList: qs('#trailList'),
    googleMap: qs('#googleMap'), osmMap: qs('#osmMap'), mapCaption: qs('#mapCaption'),
    backdrop: qs('#modalBackdrop'), modalBody: qs('#modalBody'), modalClose: qs('#modalClose')
  };

  /* ---------------- fetch helper w/ timeout ---------------- */
  function fetchJSON(url, opts, timeoutMs) {
    opts = opts || {};
    var controller = new AbortController();
    var t = setTimeout(function () { controller.abort(); }, timeoutMs || 12000);
    opts.signal = controller.signal;
    return fetch(url, opts).then(function (res) {
      clearTimeout(t);
      if (!res.ok) {
        var err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }).catch(function (e) {
      clearTimeout(t);
      throw e;
    });
  }

  /* GET that survives CORS-blocked endpoints: try direct first, then a
     public CORS proxy (api.allorigins.win). Keeps TrailSplits/weather working
     even where the provider hasn't enabled cross-origin browser calls. */
  function withTrailKey(url) {
    if (cfg.trailsplitsApiKey && url.indexOf(cfg.trailsplitsApi) === 0) {
      url += (url.indexOf('?') === -1 ? '?' : '&') + 'key=' + encodeURIComponent(cfg.trailsplitsApiKey);
    }
    return url;
  }
  function getJSONsmart(url, timeoutMs) {
    url = withTrailKey(url);
    return fetchJSON(url, null, timeoutMs).catch(function () {
      var proxied = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
      return fetchJSON(proxied, null, (timeoutMs || 12000) + 8000);
    });
  }

  function hasGoogleKey() {
    return !!cfg.googleMapsApiKey && cfg.googleMapsApiKey.indexOf('AIza') === 0;
  }

  /* ============================================================
     PROVIDER 1 — TrailSplits
     ============================================================ */
  var ts = {
    trailsBBox: function (lat, lon, mode) {
      var dLat = 0.14;
      var dLon = Math.min(0.6, 0.14 / Math.max(0.2, Math.cos(lat * Math.PI / 180)));
      var url = cfg.trailsplitsApi + '/trails/v1/bbox' +
        '?min_lat=' + (lat - dLat).toFixed(5) + '&min_lng=' + (lon - dLon).toFixed(5) +
        '&max_lat=' + (lat + dLat).toFixed(5) + '&max_lng=' + (lon + dLon).toFixed(5) +
        '&type=' + (mode === 'bike' ? 'bicycle' : 'hiking') + '&limit=80';
      return getJSONsmart(url, 12000).then(function (json) {
        if (!json || !Array.isArray(json.features)) throw new Error('bad trails payload');
        return json.features.map(function (f) {
          var p = f.properties || {};
          var c = (f.geometry && f.geometry.coordinates) || [];
          return {
            id: 'ts-' + p.osm_relation_id,
            osmId: p.osm_relation_id,
            name: String(p.name || 'Unnamed trail'),
            ref: p.ref || null,
            network: p.network || null,
            routeType: p.route_type || (mode === 'bike' ? 'bicycle' : 'hiking'),
            distanceM: typeof p.distance_m === 'number' ? p.distance_m : null,
            lon: typeof c[0] === 'number' ? c[0] : null,
            lat: typeof c[1] === 'number' ? c[1] : null,
            source: 'TrailSplits'
          };
        }).filter(function (t) { return t.lat != null; });
      });
    },

    relation: function (osmId) {
      return getJSONsmart(cfg.trailsplitsApi + '/trails/v1/relation/' + encodeURIComponent(osmId));
    },

    elevationProfile: function (geometry) {
      return fetchJSON(cfg.trailsplitsApi + '/v1/elevation-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry: geometry, points: 400 })
      });
    },

    /* fallback elevation: sampled terrain heights via GET elevation sampler */
    elevationSample: function (geometry) {
      var pts = sampleGeometryPoints(geometry, 100);
      if (pts.length < 2) return Promise.reject(new Error('no points'));
      var q = pts.map(function (p) { return p[0].toFixed(5) + ',' + p[1].toFixed(5); }).join('|');
      return getJSONsmart(cfg.trailsplitsApi + '/tiles/v1/elevation/current/sample?z=12&points=' + encodeURIComponent(q))
        .then(function (json) {
          if (!json || !Array.isArray(json.points)) throw new Error('bad elevation payload');
          /* build a synthetic elevation-profile-shaped response */
          var dist = 0, series = [], prev = null;
          var values = [];
          for (var i = 0; i < json.points.length; i++) {
            if (prev) dist += C.haversineM(prev[0], prev[1], json.points[i].lat, json.points[i].lon);
            prev = [json.points[i].lat, json.points[i].lon];
            if (json.points[i].elevation_m != null) {
              series.push([dist, json.points[i].elevation_m]);
              values.push(json.points[i].elevation_m);
            }
          }
          if (series.length < 2) throw new Error('no heights');
          var asc = 0, desc = 0;
          for (var j = 1; j < series.length; j++) {
            var d = series[j][1] - series[j - 1][1];
            if (d > 0) asc += d; else desc -= d;
          }
          return {
            series: { columns: ['distance_m', 'elevation_m'], points: series },
            elevation: {
              source: 'terrain', method: 'sampled',
              ascent_m: Math.round(asc), descent_m: Math.round(desc),
              min_m: Math.min.apply(null, values), max_m: Math.max.apply(null, values)
            }
          };
        });
    },

    geocode: function (q) {
      return getJSONsmart(cfg.trailsplitsApi + '/search/v1/forward?q=' + encodeURIComponent(q) + '&limit=1')
        .then(function (json) {
          var f = json && json.features && json.features[0];
          if (!f || !f.center) throw new Error('not found');
          return { lat: f.center[1], lon: f.center[0], label: f.name + (f.region ? ', ' + f.region : '') };
        });
    },

    reverse: function (lat, lon) {
      return getJSONsmart(cfg.trailsplitsApi + '/search/v1/reverse?lat=' + lat + '&lon=' + lon + '&limit=1&radius_m=30000')
        .then(function (json) {
          var f = json && json.features && json.features[0];
          return f ? (f.name + (f.region ? ', ' + f.region : '')) : null;
        });
    },

    /* served from the main site per the API spec */
    weather: function (lat, lon) {
      return getJSONsmart(cfg.trailsplitsSite + '/api/weather/forecast?p=' + lat.toFixed(4) + ',' + lon.toFixed(4) + '&d=5');
    }
  };

  /* pick up to n evenly-spread [lat, lon] points from a GeoJSON line */
  function sampleGeometryPoints(geometry, n) {
    var coords = [];
    if (!geometry) return coords;
    if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
      coords = geometry.coordinates;
    } else if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
      geometry.coordinates.forEach(function (part) { coords = coords.concat(part); });
    }
    var out = coords
      .filter(function (c) { return typeof c[1] === 'number' && typeof c[0] === 'number'; })
      .map(function (c) { return [c[1], c[0]]; });    /* → [lat, lon] pairs */
    if (out.length <= n) return out;
    var sampled = [], stride = (out.length - 1) / (n - 1);
    for (var i = 0; i < n; i++) sampled.push(out[Math.round(i * stride)]);
    return sampled;
  }

  /* ============================================================
     PROVIDER 2 — OpenStreetMap (Overpass + Nominatim)
     Primary on flaky connections: it is CORS-friendly and has mirrors.
     ============================================================ */
  var OVERPASS_ENDPOINTS = [
    cfg.overpassApi,
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.openstreetmap.fr/api/interpreter'
  ];

  function postOverpass(query, endpointIndex) {
    var ep = OVERPASS_ENDPOINTS[Math.min(endpointIndex || 0, OVERPASS_ENDPOINTS.length - 1)];
    return fetchJSON(ep, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query)
    }, 25000).catch(function (err) {
      if ((endpointIndex || 0) < OVERPASS_ENDPOINTS.length - 1) return postOverpass(query, (endpointIndex || 0) + 1);
      throw err;
    });
  }

  var osm = {
    trailsBBox: function (lat, lon, mode) {
      var dLat = 0.14;
      var dLon = Math.min(0.6, 0.14 / Math.max(0.2, Math.cos(lat * Math.PI / 180)));
      var routeRe = mode === 'bike' ? '^(bicycle|mtb)$' : '^(hiking|foot)$';
      var query = '[out:json][timeout:20];' +
        'relation["type"="route"]["route"~"' + routeRe + '"]["name"]' +
        '(' + (lat - dLat) + ',' + (lon - dLon) + ',' + (lat + dLat) + ',' + (lon + dLon) + ');' +
        'out tags center 80;';
      return postOverpass(query, 0).then(function (json) {
        if (!json || !Array.isArray(json.elements)) throw new Error('bad overpass payload');
        return json.elements.map(function (el) {
          var tags = el.tags || {};
          return {
            id: 'osm-' + el.id,
            osmId: el.id,
            name: String(tags.name || 'Unnamed trail'),
            ref: tags.ref || null,
            network: tags.network || null,
            routeType: tags.route || (mode === 'bike' ? 'bicycle' : 'hiking'),
            distanceM: parseOsmDistance(tags.distance),
            lon: el.center ? el.center.lon : null,
            lat: el.center ? el.center.lat : null,
            source: 'OpenStreetMap'
          };
        }).filter(function (t) { return t.lat != null; });
      });
    },

    geocode: function (q) {
      return fetchJSON(cfg.nominatim + '/search?format=jsonv2&limit=1&q=' + encodeURIComponent(q))
        .then(function (arr) {
          if (!arr || !arr.length) throw new Error('not found');
          return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), label: arr[0].display_name.split(',').slice(0, 2).join(',') };
        });
    }
  };

  function parseOsmDistance(v) {
    if (!v) return null;
    var n = parseFloat(String(v).replace(',', '.'));
    if (isNaN(n)) return null;
    /* OSM distance is usually km; treat implausibly large values as already-meters */
    return n > 400 ? n : n * 1000;
  }

  /* Query both trail providers at once and merge by OSM relation id —
     TrailSplits adds accurate lengths; Overpass is the resilient backbone. */
  function fetchTrailsCombined(lat, lon, mode) {
    var tsP = ts.trailsBBox(lat, lon, mode).catch(function () { return []; });
    var osmP = osm.trailsBBox(lat, lon, mode).catch(function () { return []; });
    return Promise.all([tsP, osmP]).then(function (r) {
      var tsT = r[0], osmT = r[1], byId = {};
      tsT.forEach(function (t) { byId[t.osmId] = t; });
      osmT.forEach(function (t) { if (byId[t.osmId] == null) byId[t.osmId] = t; });
      var merged = Object.keys(byId).map(function (k) { return byId[k]; });
      if (!merged.length) throw new Error('no trails');
      state.dataSource = tsT.length && osmT.length ? 'TrailSplits + OpenStreetMap'
        : tsT.length ? 'TrailSplits'
        : 'OpenStreetMap';
      return merged;
    });
  }

  /* ============================================================
     PROVIDER 3 — Google Places (photos + ratings)
     ============================================================ */
  var google = {
    photoUrl: function (place, w) {
      if (!place || !place.photos || !place.photos.length) return null;
      return 'https://places.googleapis.com/v1/' + place.photos[0].name +
        '/media?maxWidthPx=' + (w || 800) + '&key=' + encodeURIComponent(cfg.googleMapsApiKey);
    },

    placesNearby: function (lat, lon, mode, label) {
      if (!hasGoogleKey()) return Promise.resolve([]);
      var headers = {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': cfg.googleMapsApiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.rating,places.userRatingCount,places.photos,places.formattedAddress,places.googleMapsUri,places.types'
      };
      var center = { latitude: lat, longitude: lon };

      function searchText() {
        return fetchJSON('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST', headers: headers,
          body: JSON.stringify({
            textQuery: (mode === 'bike' ? 'popular mountain bike trails' : 'popular hiking trails') + (label && label.indexOf(',') > -1 ? ' near ' + label : ''),
            locationBias: { circle: { center: center, radius: 25000 } },
            maxResultCount: 12, languageCode: 'en'
          })
        }, 15000);
      }

      function searchNearby() {
        return fetchJSON('https://places.googleapis.com/v1/places:searchNearby', {
          method: 'POST', headers: headers,
          body: JSON.stringify({
            includedTypes: ['hiking_area', 'park', 'national_park'],
            locationRestriction: { circle: { center: center, radius: 20000 } },
            maxResultCount: 12, languageCode: 'en'
          })
        }, 15000);
      }

      return searchText()
        .catch(function () { return searchNearby(); })
        .then(function (json) {
          var places = (json && json.places) || [];
          state.googleOk = true;
          return places.map(function (p) {
            return {
              id: p.id,
              name: p.displayName && p.displayName.text,
              rating: typeof p.rating === 'number' ? p.rating : null,
              count: p.userRatingCount || 0,
              lat: p.location && p.location.latitude,
              lon: p.location && p.location.longitude,
              address: p.formattedAddress || null,
              gmapsUri: p.googleMapsUri || null,
              photo: google.photoUrl(p, 800)
            };
          }).filter(function (p) { return p.name && p.lat != null; });
        })
        .catch(function () { state.googleOk = false; return []; });
    }
  };

  /* Attach the best matching Google place (rating/photo) to each trail. */
  function attachGoogle() {
    if (!state.googlePlaces.length) return;
    var stop = ['trail', 'trailhead', 'route', 'path', 'way', 'loop', 'the', 'de', 'la', 'le', 'di', 'da'];
    function tokens(s) {
      return String(s || '').toLowerCase().normalize('NFKD')
        .replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/)
        .filter(function (w) { return w.length > 2 && stop.indexOf(w) === -1; });
    }
    state.trails.forEach(function (t) {
      var tt = tokens(t.name);
      var best = null, bestScore = 0;
      state.googlePlaces.forEach(function (p) {
        var d = C.haversineM(t.lat, t.lon, p.lat, p.lon);
        if (d > 2500) return;
        var pt = tokens(p.name);
        var shared = pt.filter(function (w) { return tt.indexOf(w) !== -1; }).length;
        var score = shared * 100 - Math.min(d / 25, 40);
        if (shared > 0 && score > bestScore) { bestScore = score; best = p; }
      });
      if (best) t.google = best;
    });
  }

  /* ============================================================
     Map — Google Maps FIRST (as requested). The OSM embed is only a
     last-resort fallback when the Google key is missing/invalid, and it
     says so on the caption + nudges the user to add a key in Settings.
     ============================================================ */
  var gmapsLoaded = false;

  function renderOSMMap() {
    state.mapLib = 'osm';
    els.googleMap.style.display = 'none';
    els.osmMap.style.display = 'block';
    var lat = state.location.lat, lon = state.location.lon;
    var dLat = 0.09, dLon = Math.min(0.5, 0.09 / Math.max(0.2, Math.cos(lat * Math.PI / 180)));
    els.osmMap.src = 'https://www.openstreetmap.org/export/embed.html' +
      '?bbox=' + (lon - dLon) + ',' + (lat - dLat) + ',' + (lon + dLon) + ',' + (lat + dLat) +
      '&layer=mapnik&marker=' + lat + ',' + lon;
    els.mapCaption.innerHTML = hasGoogleKey()
      ? 'Map © OpenStreetMap contributors — <b>Google Maps didn’t load</b> (key rejected or restricted). ' +
        'Add a working Google Maps key via <b>Settings → API keys</b> (link in the footer) to get the full Google map.'
      : 'Map © OpenStreetMap contributors — add a Google Maps key via <b>Settings → API keys</b> (footer) to switch to Google Maps.';
  }

  function renderGoogleMap() {
    state.mapLib = 'google';
    els.googleMap.style.display = 'block';
    els.osmMap.style.display = 'none';
    var g = window.google;
    if (!state.map) {
      state.map = new g.maps.Map(els.googleMap, {
        center: { lat: state.location.lat, lng: state.location.lon },
        zoom: 11,
        mapTypeId: 'terrain',
        streetViewControl: false,
        fullscreenControl: true,
        mapTypeControl: true,
        mapTypeControlOptions: { mapTypeIds: ['roadmap', 'terrain', 'satellite'] },
        gestureHandling: 'greedy',
        clickableIcons: false
      });
    } else {
      state.map.setCenter({ lat: state.location.lat, lng: state.location.lon });
    }
    /* clear markers */
    state.markers.forEach(function (m) { if (m.setMap) m.setMap(null); });
    state.markers = [];
    /* center marker */
    state.markers.push(new g.maps.Marker({
      map: state.map, position: { lat: state.location.lat, lng: state.location.lon },
      title: state.location.label,
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#f59e0b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
    }));
    state.trails.slice(0, 40).forEach(function (t) {
      state.markers.push(new g.maps.Marker({
        map: state.map,
        position: { lat: t.lat, lng: t.lon },
        title: t.name,
        label: { text: state.mode === 'bike' ? '🚴' : '🥾', fontSize: '14px' }
      }));
    });
    /* live tracker path (if any) */
    if (tracker.path.length > 1 && g.maps.Polyline) {
      state.markers.push(new g.maps.Polyline({
        map: state.map,
        path: tracker.path,
        strokeColor: '#16a34a', strokeOpacity: .95, strokeWeight: 5
      }));
    }
    els.mapCaption.textContent = 'Map © Google · trail markers show route start points';
  }

  function renderMap() {
    if (state.mapLib === 'google' && window.google && window.google.maps) { renderGoogleMap(); return; }
    if (!hasGoogleKey()) { renderOSMMap(); return; }
    if (gmapsLoaded === 'failed') { renderOSMMap(); return; }
    if (gmapsLoaded === true) { renderGoogleMap(); return; }

    /* load the Google Maps script once — eagerly, Google is the primary map */
    gmapsLoaded = 'loading';
    window.gm_authFailure = function () {
      gmapsLoaded = 'failed';
      renderOSMMap();
    };
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(cfg.googleMapsApiKey) + '&v=weekly';
    s.async = true; s.defer = true;
    s.onload = function () {
      if (!window.google || !window.google.maps) { gmapsLoaded = 'failed'; renderOSMMap(); return; }
      gmapsLoaded = true;
      try { renderGoogleMap(); } catch (e) { gmapsLoaded = 'failed'; renderOSMMap(); }
    };
    s.onerror = function () { gmapsLoaded = 'failed'; renderOSMMap(); };
    document.head.appendChild(s);
    /* if google is slow, show OSM meanwhile, then swap when ready */
    setTimeout(function () { if (gmapsLoaded === 'loading' && state.mapLib == null) renderOSMMap(); }, 8000);
  }

  /* ============================================================
     LIVE TRACKER — records REAL movement only.

     “Phantom distance” (phone sitting on a desk still logging 0.2 mi)
     comes from GPS jitter. These gates kill it:
       1. accuracy gate  — fixes with accuracy worse than 25 m are ignored
       2. movement gate  — a fix must be ≥ 8 m (hike) / 12 m (bike) from the
                          last accepted point to count as movement
       3. speed gate     — implied speed > 6 m/s (hike) / 15 m/s (bike) is a
                          GPS jump and is discarded
       4. stationary detector — no accepted movement for 60 s ⇒ auto-pause
                          (shown live in the panel), resumes when you move
     Distance = sum of accepted segments only. Tracking runs ONLY after you
     tap “Track hike” — never in the background.
     ============================================================ */
  var MIN_MOVE = { hike: 8, bike: 12 };      /* metres */
  var MAX_SPEED = { hike: 6, bike: 15 };     /* m/s */
  var ACCURACY_MAX = 25;                     /* metres */
  var STATIONARY_MS = 60000;

  var tracker = {
    active: false, paused: false, watchId: null,
    path: [],                    /* accepted {lat, lng, t} */
    distance: 0, elapsedMs: 0,
    lastAccepted: null, lastMoveAt: 0, timer: null,
    rejected: 0
  };

  var trackEls = {
    btn: qs('#trackBtn'), panel: qs('#trackPanel'), btnLabel: qs('#trackBtnLabel'),
    dist: qs('#trackDist'), time: qs('#trackTime'), speed: qs('#trackSpeed'),
    gps: qs('#trackGps'), note: qs('#trackNote'),
    pause: qs('#trackPause'), stop: qs('#trackStop')
  };

  function trackNote(msg) { if (trackEls.note) trackEls.note.textContent = msg; }

  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
  }

  function renderTrackStats() {
    if (!trackEls.dist) return;
    var km = tracker.distance / 1000;
    trackEls.dist.textContent = (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' km';
    trackEls.time.textContent = fmtClock(tracker.elapsedMs);
    var hrs = tracker.elapsedMs / 3600000;
    trackEls.speed.textContent = (hrs > 0 ? (km / hrs).toFixed(1) : '0.0') + ' km/h';
  }

  function trackerTimerTick() {
    if (tracker.active && !tracker.paused) {
      tracker.elapsedMs += 1000;
      /* stationary detector */
      if (tracker.lastMoveAt && Date.now() - tracker.lastMoveAt > STATIONARY_MS) {
        tracker.paused = true;
        trackEls.pause.textContent = 'Resume';
        trackNote('You seem to be standing still — distance paused. It resumes automatically when you really move.');
      }
      renderTrackStats();
    }
  }

  function onTrackPosition(pos) {
    var c = pos.coords;
    if (trackEls.gps) trackEls.gps.textContent = '±' + Math.round(c.accuracy) + ' m';
    if (!tracker.active) return;

    /* gate 1: accuracy */
    if (c.accuracy > ACCURACY_MAX) {
      tracker.rejected++;
      trackNote('Ignoring low-accuracy GPS fix (±' + Math.round(c.accuracy) + ' m) — move outdoors for a better signal.');
      return;
    }

    var pt = { lat: c.latitude, lng: c.longitude, t: pos.timestamp || Date.now() };

    /* first point is the start anchor — no distance yet */
    if (!tracker.lastAccepted) {
      tracker.lastAccepted = pt;
      tracker.path.push(pt);
      tracker.lastMoveAt = Date.now();
      trackNote('Got it — start point locked. Walk or ride to record distance.');
      return;
    }

    var d = C.haversineM(tracker.lastAccepted.lat, tracker.lastAccepted.lng, pt.lat, pt.lng);

    /* gate 2: movement (kills desk jitter) */
    if (d < MIN_MOVE[state.mode]) {
      if (tracker.paused && Date.now() - tracker.lastMoveAt > 3000) return;
      return; /* still within jitter radius — not movement */
    }

    /* gate 3: teleport / speed */
    var dt = (pt.t - tracker.lastAccepted.t) / 1000;
    if (dt > 0 && d / dt > MAX_SPEED[state.mode]) {
      tracker.rejected++;
      trackNote('Skipped a jumpy GPS point — it would have added fake distance.');
      return;
    }

    /* accepted movement */
    tracker.distance += d;
    tracker.path.push(pt);
    tracker.lastAccepted = pt;
    tracker.lastMoveAt = Date.now();
    if (tracker.paused) {
      tracker.paused = false;
      trackEls.pause.textContent = 'Pause';
      trackNote('Moving again — tracking.');
    }
    renderTrackStats();
    if (state.mapLib === 'google' && window.google && state.map && state.markers.length) {
      /* keep the live line fresh */
      var line = state.markers[state.markers.length - 1];
      if (line && line.setPath) line.setPath(tracker.path);
      else renderMap();
    }
  }

  function onTrackError(err) {
    if (err.code === 1) { /* PERMISSION_DENIED */
      stopTracking(false);
      C.toast('Location permission denied — allow location to track your hike.');
    } else if (err.code === 2) { /* POSITION_UNAVAILABLE — usually: device location is OFF */
      C.promptEnableLocation(function () { startTracking(); });
      C.toast('Your device’s location is turned off — turn it on to track.', 4500);
      stopTracking(false);
    } /* code 3 (timeout) — keep watching, next fix may come */
  }

  function startTracking() {
    if (!navigator.geolocation) { C.toast('This browser can’t geolocate'); return; }
    tracker.active = true;
    tracker.paused = false;
    tracker.path = [];
    tracker.distance = 0;
    tracker.elapsedMs = 0;
    tracker.lastAccepted = null;
    tracker.lastMoveAt = Date.now();
    tracker.rejected = 0;
    trackEls.panel.hidden = false;
    trackEls.btn.setAttribute('aria-pressed', 'true');
    trackEls.btn.classList.add('is-on');
    if (trackEls.btnLabel) trackEls.btnLabel.textContent = 'Stop tracking';
    trackEls.pause.textContent = 'Pause';
    trackNote('Waiting for GPS… Go outside for the best signal.');
    renderTrackStats();
    renderMap();
    tracker.watchId = navigator.geolocation.watchPosition(onTrackPosition, onTrackError, {
      enableHighAccuracy: true, timeout: 30000, maximumAge: 1000
    });
    if (!tracker.timer) tracker.timer = setInterval(trackerTimerTick, 1000);
    C.toast('Tracking started — distance only counts when you actually move.');
  }

  function stopTracking(save) {
    if (tracker.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(tracker.watchId);
      tracker.watchId = null;
    }
    tracker.active = false;
    if (tracker.timer) { clearInterval(tracker.timer); tracker.timer = null; }
    trackEls.panel.hidden = true;
    trackEls.btn.setAttribute('aria-pressed', 'false');
    trackEls.btn.classList.remove('is-on');
    if (trackEls.btnLabel) trackEls.btnLabel.textContent = 'Track hike';
    if (save) {
      var km = tracker.distance / 1000;
      var summary = km.toFixed(2) + ' km in ' + fmtClock(tracker.elapsedMs);
      try {
        var logs = JSON.parse(localStorage.getItem('calledit_tracks_v1') || '[]');
        logs.unshift({ km: Math.round(km * 1000) / 1000, ms: tracker.elapsedMs, at: Date.now(), mode: state.mode });
        localStorage.setItem('calledit_tracks_v1', JSON.stringify(logs.slice(0, 50)));
      } catch (e) { }
      C.toast('Hike saved: ' + summary + ' 🎉');
    }
  }

  if (trackEls.btn) trackEls.btn.addEventListener('click', function () {
    if (tracker.active) stopTracking(true); else startTracking();
  });
  if (trackEls.pause) trackEls.pause.addEventListener('click', function () {
    if (!tracker.active) return;
    tracker.paused = !tracker.paused;
    trackEls.pause.textContent = tracker.paused ? 'Resume' : 'Pause';
    if (tracker.paused) {
      trackNote('Paused — GPS is still watched, but distance is frozen.');
    } else {
      tracker.lastMoveAt = Date.now();
      trackNote('Tracking again.');
    }
    renderTrackStats();
  });
  if (trackEls.stop) trackEls.stop.addEventListener('click', function () { stopTracking(true); });

  /* ============================================================
     Weather
     ============================================================ */
  var WMO = [
    [[0], '☀️', 'Clear'], [[1], '🌤', 'Mostly clear'], [[2], '⛅', 'Partly cloudy'], [[3], '☁️', 'Overcast'],
    [[45, 48], '🌫', 'Fog'], [[51, 53, 55, 56, 57], '🌦', 'Drizzle'],
    [[61, 63, 65, 66, 67, 80, 81, 82], '🌧', 'Rain'], [[71, 73, 75, 77, 85, 86], '❄️', 'Snow'],
    [[95, 96, 99], '⛈', 'Thunderstorms']
  ];
  function wmoInfo(code) {
    for (var i = 0; i < WMO.length; i++) {
      for (var j = 0; j < WMO[i][0].length; j++) if (WMO[i][0][j] === code) return { icon: WMO[i][1], label: WMO[i][2] };
    }
    return { icon: '🌡', label: '—' };
  }

  function renderWeather() {
    var w = state.weather;
    if (!w || !w.points || !w.points[0] || !w.points[0].days || !w.points[0].days.length) {
      els.weatherStrip.innerHTML = '';
      els.weatherNote.textContent = '';
      return;
    }
    var days = w.points[0].days.slice(0, 5);
    els.weatherStrip.innerHTML = days.map(function (day) {
      var d = new Date(day.date + 'T12:00:00');
      var dow = d.toLocaleDateString(undefined, { weekday: 'short' });
      var info = wmoInfo(day.weather_code);
      var hi = day.temp_max_c != null ? Math.round(day.temp_max_c) + '°' : '—';
      var lo = day.temp_min_c != null ? Math.round(day.temp_min_c) + '°' : '';
      var pr = (day.precip_probability_max_pct != null ? day.precip_probability_max_pct
        : (day.precip_mm > 0 ? null : 0));
      return '<div class="weather-day" title="' + esc(info.label) + '">' +
        '<div class="dow">' + esc(dow) + '</div>' +
        '<div class="ico" aria-hidden="true">' + info.icon + '</div>' +
        '<div class="temp">' + hi + (lo ? ' <span class="muted">' + lo + '</span>' : '') + '</div>' +
        (pr != null ? '<div class="precip">💧 ' + pr + '%</div>' : '') +
        '</div>';
    }).join('');
    var attr = (w.provider && w.provider.attribution) || 'Open-Meteo';
    els.weatherNote.textContent = 'Weather at ' + state.location.label + ' · ' + attr;
  }

  /* ============================================================
     Rendering — Google highlights strip
     ============================================================ */
  function renderHighlights() {
    var places = state.googlePlaces
      .filter(function (p) { return p.rating != null; })
      .sort(function (a, b) { return (b.rating - a.rating) || (b.count - a.count); })
      .slice(0, 8);
    if (!places.length) { els.highlights.hidden = true; return; }
    els.highlights.hidden = false;
    els.highlightsRow.innerHTML = places.map(function (p, i) {
      var img = p.photo || cfg.fallbackImages[i % cfg.fallbackImages.length];
      var href = p.gmapsUri || ('https://www.google.com/maps/search/?api=1&query=' + p.lat + ',' + p.lon);
      return '<a class="hl-card" href="' + esc(href) + '" target="_blank" rel="noopener">' +
        '<img src="' + esc(img) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src=\'' + cfg.fallbackImages[i % cfg.fallbackImages.length] + '\'">' +
        '<div class="hl-body">' +
        '<div class="hl-name">' + esc(p.name) + '</div>' +
        '<div class="hl-rating">★ ' + p.rating.toFixed(1) + ' · ' + p.count.toLocaleString() + ' reviews</div>' +
        '</div></a>';
    }).join('');
  }

  /* ============================================================
     Rendering — trail list
     ============================================================ */
  function networkLabel(n) {
    return { iwn: 'International', nwn: 'National', rwn: 'Regional', lwn: 'Local' }[n] || null;
  }

  function trailImg(t, i) {
    if (t.google && t.google.photo) return t.google.photo;
    return cfg.fallbackImages[(i + (t.name.length % 3)) % cfg.fallbackImages.length];
  }

  function filteredTrails() {
    var list = state.trails.slice();
    var f = state.filter;
    if (f.maxKm != null) list = list.filter(function (t) { return t.distanceM != null && t.distanceM <= f.maxKm * 1000; });
    if (f.minRating != null) list = list.filter(function (t) { return t.google && t.google.rating != null && t.google.rating >= f.minRating; });
    if (f.easyOnly) list = list.filter(function (t) { return t.distanceM == null || t.distanceM <= 8000; });
    var dist = function (t) { return C.haversineM(state.location.lat, state.location.lon, t.lat, t.lon); };
    if (f.sort === 'rated') list.sort(function (a, b) { return ((b.google && b.google.rating) || 0) - ((a.google && a.google.rating) || 0); });
    else if (f.sort === 'short') list.sort(function (a, b) { return (a.distanceM || 9e9) - (b.distanceM || 9e9); });
    else if (f.sort === 'long') list.sort(function (a, b) { return (b.distanceM || 0) - (a.distanceM || 0); });
    else list.sort(function (a, b) { return dist(a) - dist(b); });
    return list;
  }

  function renderList() {
    var list = filteredTrails();
    if (!state.loading && !list.length) {
      els.trailList.innerHTML =
        '<div class="empty-state"><p><b>No ' + (state.mode === 'bike' ? 'signed biking routes' : 'signed hiking trails') + ' found here.</b></p>' +
        '<p style="margin-top:8px">Try a bigger nearby town, or search another place above.</p></div>';
      return;
    }
    els.trailList.innerHTML = list.map(function (t, i) {
      var km = t.distanceM != null ? C.fmtBoth(t.distanceM) : 'length unlisted';
      var mins = estimateMinutes(t);
      var chips = [];
      var net = networkLabel(t.network);
      if (net) chips.push('<span class="chip chip--grey">' + net + '</span>');
      if (t.ref) chips.push('<span class="chip chip--grey">Ref ' + esc(t.ref) + '</span>');
      var rating = '';
      if (t.google && t.google.rating != null) {
        rating = '<span class="trail-card__rating"><span class="stars" aria-label="' + t.google.rating + ' out of 5 stars">' + C.stars(t.google.rating) + '</span>' +
          t.google.rating.toFixed(1) + ' (' + t.google.count.toLocaleString() + ')' +
          '<span class="g-src">· Google</span></span>';
      }
      var links = C.directionsLinks(t.lat, t.lon);
      var dirLinks = links.map(function (l) {
        return '<a class="btn btn-sm ' + (l.primary ? 'btn-primary' : 'btn-ghost') + '" href="' + esc(l.href) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>';
      }).join('');
      return '<article class="trail-card" data-id="' + esc(t.id) + '">' +
        '<img class="trail-card__img" src="' + esc(trailImg(t, i)) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
        'onerror="this.onerror=null;this.src=\'' + cfg.fallbackImages[i % cfg.fallbackImages.length] + '\'">' +
        '<div class="trail-card__body">' +
        '<h3 class="trail-card__name">' + esc(t.name) + '</h3>' +
        '<div class="trail-card__meta"><span>' + esc(km) + (mins ? ' · ' + C.fmtDuration(mins) : '') + '</span>' + chips.join('') + '</div>' +
        rating +
        '<div class="trail-card__actions">' +
        '<button class="btn btn-sm btn-soft" type="button" data-details="' + esc(t.id) + '">Details</button>' +
        dirLinks +
        '</div>' +
        '</div></article>';
    }).join('');

    qsa('[data-details]', els.trailList).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = state.trails.filter(function (x) { return x.id === btn.dataset.details; })[0];
        if (t) openDetails(t);
      });
    });
  }

  function estimateMinutes(t) {
    if (t.distanceM == null) return null;
    var kmh = state.mode === 'bike' ? 14 : 4.4;
    return (t.distanceM / 1000) / kmh * 60;
  }

  function renderErrors(errors) {
    if (!errors.length) { els.errorBox.innerHTML = ''; return; }
    els.errorBox.innerHTML = errors.map(function (e) {
      return '<div class="error-banner">' + esc(e) + '</div>';
    }).join('');
  }

  function renderStatus() {
    var noSrc = state.dataSource === '…' || state.dataSource === '—';
    var src = noSrc ? '' : ' · via ' + state.dataSource;
    var n = filteredTrails().length;
    var act = state.mode === 'bike' ? 'biking routes' : 'hiking trails';
    els.statusLine.innerHTML =
      'Showing <b>' + n + '</b> signed ' + act + ' around <b>' + esc(state.location.label) + '</b>' + esc(src) +
      (state.location.guessed ? ' · <span class="chip chip--amber">Sample area — tap “Near me” or search</span>' : '') +
      (state.googleOk ? ' · ratings by Google' : '');
  }

  function renderAll() {
    attachGoogle();
    renderStatus();
    renderList();
    renderHighlights();
    renderWeather();
    renderMap();
  }

  /* ============================================================
     Loading an area
     ============================================================ */
  function loadArea(lat, lon, label, guessed) {
    if (state.loading) return Promise.resolve();
    state.loading = true;
    state.location = { lat: lat, lon: lon, label: label, guessed: !!guessed };
    els.trailList.innerHTML = '<div class="loading-state"><p class="loading-dots">Finding signed ' + (state.mode === 'bike' ? 'biking routes' : 'hiking trails') + '</p></div>';
    renderStatus();

    var errors = [];

    var trailsP = fetchTrailsCombined(lat, lon, state.mode)
      .then(function (trails) { state.trails = trails; })
      .catch(function () {
        state.trails = [];
        state.dataSource = '—';
        errors.push('The trail providers are unreachable right now — check your connection and try again in a moment.');
      });

    var placesP = google.placesNearby(lat, lon, state.mode, label)
      .then(function (places) { state.googlePlaces = places; })
      .catch(function () { state.googlePlaces = []; });

    var weatherP = ts.weather(lat, lon)
      .then(function (w) { state.weather = w; })
      .catch(function () { state.weather = null; });

    return Promise.all([trailsP, placesP, weatherP]).then(function () {
      state.loading = false;
      renderErrors(errors);
      renderAll();
    });
  }

  /* ============================================================
     Search + geolocation
     ============================================================ */
  function doSearch(q) {
    if (!q || q.trim().length < 2) { C.toast('Type a place name first'); return; }
    els.statusLine.textContent = 'Looking up “' + q + '”…';
    ts.geocode(q)
      .catch(function () { return osm.geocode(q); })
      .then(function (loc) {
        loadArea(loc.lat, loc.lon, loc.label, false);
      })
      .catch(function () {
        renderAllStatusAfterFail();
        C.toast('Couldn’t find “' + q + '”. Try a nearby town or region.');
      });
    function renderAllStatusAfterFail() { renderStatus(); }
  }

  function locateMe() {
    if (!navigator.geolocation) { C.toast('This browser can’t geolocate'); return; }
    els.statusLine.textContent = 'Getting your position…';
    navigator.geolocation.getCurrentPosition(function (pos) {
      var lat = pos.coords.latitude, lon = pos.coords.longitude;
      ts.reverse(lat, lon)
        .catch(function () { return null; })
        .then(function (label) {
          loadArea(lat, lon, label || 'your location (' + lat.toFixed(3) + ', ' + lon.toFixed(3) + ')', false);
        });
    }, function (err) {
      if (err.code === 1) {
        C.toast('Location permission denied — allow location for CalledIt, or search a place instead.');
      } else if (err.code === 2) {
        /* Permission may be granted while the device’s location (GPS) switch
           is still OFF — exactly the case that never prompts on Android. */
        C.toast('Your device’s location is turned off — turn it on and retry.', 4500);
        C.promptEnableLocation(function () { locateMe(); });
      } else {
        C.toast('Couldn’t get your position (GPS timeout) — try again outdoors, or search a place instead.');
      }
      renderStatus();
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  /* ============================================================
     Details modal + elevation profile
     ============================================================ */
  function openDetails(t) {
    var links = C.directionsLinks(t.lat, t.lon);
    var rating = (t.google && t.google.rating != null)
      ? '<span class="trail-card__rating"><span class="stars">' + C.stars(t.google.rating) + '</span> ' +
        t.google.rating.toFixed(1) + ' (' + t.google.count.toLocaleString() + ' Google reviews)</span>'
      : '<span class="muted">No Google rating for this route yet</span>';

    els.modalBody.innerHTML =
      '<h2 id="modalTitle">' + esc(t.name) + '</h2>' +
      '<div class="trail-card__meta">' +
      '<span class="chip">' + (t.routeType === 'bicycle' || t.routeType === 'mtb' ? '🚴 Biking route' : '🥾 Hiking trail') + '</span>' +
      (networkLabel(t.network) ? '<span class="chip chip--grey">' + networkLabel(t.network) + '</span>' : '') +
      (t.ref ? '<span class="chip chip--grey">Ref ' + esc(t.ref) + '</span>' : '') +
      '<span class="chip chip--grey">via ' + esc(t.source) + (t.osmId ? ' · OSM relation ' + t.osmId : '') + '</span>' +
      '</div>' +
      '<div class="fact-grid" id="factGrid">' +
      '<div class="fact"><div class="k">Length</div><div class="v">' + (t.distanceM != null ? C.fmtBoth(t.distanceM) : 'unlisted') + '</div></div>' +
      '<div class="fact"><div class="k">Typical time</div><div class="v">' + C.fmtDuration(estimateMinutes(t)) + '</div></div>' +
      '<div class="fact"><div class="k">Climb</div><div class="v" id="factClimb">…</div></div>' +
      '</div>' +
      '<p>' + rating + '</p>' +
      '<div class="modal__section" id="elevSection" hidden>' +
      '<h3>Elevation profile</h3>' +
      '<svg class="elev-chart" id="elevChart" role="img" aria-label="Elevation profile chart"></svg>' +
      '<p class="muted" style="font-size:.8rem" id="elevCaption"></p>' +
      '</div>' +
      '<div class="modal__section"><h3>Getting there</h3>' +
      '<div class="btn-row" style="justify-content:flex-start">' +
      links.map(function (l) { return '<a class="btn ' + (l.primary ? 'btn-primary' : 'btn-ghost') + '" href="' + esc(l.href) + '" target="_blank" rel="noopener">' + esc(l.label) + '</a>'; }).join('') +
      (t.google && t.google.gmapsUri ? '<a class="btn btn-ghost" href="' + esc(t.google.gmapsUri) + '" target="_blank" rel="noopener">Open in Google Maps</a>' : '') +
      '</div>' +
      '<p class="muted" style="margin-top:12px; font-size:.85rem">Start point: ' + t.lat.toFixed(5) + ', ' + t.lon.toFixed(5) +
      (t.google && t.google.address ? ' · ' + esc(t.google.address) : '') + '</p></div>';

    els.backdrop.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    /* Android back gesture / back button closes this modal (not the app) */
    C.pushOverlay('details', hideModalVisual);

    /* fetch richer detail from TrailSplits when we know the OSM relation */
    if (t.osmId) {
      ts.relation(t.osmId).then(function (rel) {
        var props = rel.properties || {};
        var climb = qs('#factClimb');
        if (climb && typeof props.ascent_m === 'number') climb.textContent = '↑ ' + Math.round(props.ascent_m) + ' m';
        if (rel.geometry) {
          return ts.elevationProfile(rel.geometry)
            .catch(function () { return ts.elevationSample(rel.geometry); })
            .then(function (prof) {
              drawElevation(prof);
              var climbEl = qs('#factClimb');
              if (climbEl && prof.elevation && typeof prof.elevation.ascent_m === 'number') {
                climbEl.textContent = '↑ ' + Math.round(prof.elevation.ascent_m) + ' m · ↓ ' + Math.round(prof.elevation.descent_m || 0) + ' m';
              }
            });
        }
        return null;
      }).catch(function () {
        var climb = qs('#factClimb');
        if (climb && climb.textContent === '…') climb.textContent = 'not measured';
        var sec = qs('#elevSection');
        if (sec) sec.hidden = true;
      });
    } else {
      var climb = qs('#factClimb'); if (climb) climb.textContent = 'not measured';
    }
  }

  function drawElevation(prof) {
    var sec = qs('#elevSection'), chart = qs('#elevChart'), cap = qs('#elevCaption');
    if (!sec || !chart || !prof || !prof.series || !prof.series.points) return;
    var cols = prof.series.columns || [];
    var di = cols.indexOf('distance_m'), ei = cols.indexOf('elevation_m');
    if (di === -1 || ei === -1) return;
    var pts = prof.series.points.filter(function (p) { return p[ei] != null; });
    if (pts.length < 2) return;
    var W = 600, H = 110, pad = 8;
    var xs = pts.map(function (p) { return p[di]; });
    var ys = pts.map(function (p) { return p[ei]; });
    var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
    var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
    if (y1 === y0) y1 = y0 + 1;
    var sx = function (x) { return pad + (x - x0) / (x1 - x0) * (W - 2 * pad); };
    var sy = function (y) { return H - pad - (y - y0) / (y1 - y0) * (H - 2 * pad); };
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + sx(p[di]).toFixed(1) + ' ' + sy(p[ei]).toFixed(1); }).join(' ');
    var area = d + ' L' + sx(x1).toFixed(1) + ' ' + (H - pad) + ' L' + sx(x0).toFixed(1) + ' ' + (H - pad) + ' Z';
    chart.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    chart.innerHTML =
      '<path d="' + area + '" fill="rgba(22,163,74,.18)"/>' +
      '<path d="' + d + '" fill="none" stroke="#166534" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<text x="' + pad + '" y="' + (pad + 3) + '" font-size="10" fill="#5b6f63" text-anchor="start" dominant-baseline="hanging">' + Math.round(y1) + ' m</text>' +
      '<text x="' + pad + '" y="' + (H - pad - 3) + '" font-size="10" fill="#5b6f63" text-anchor="start" dominant-baseline="baseline">' + Math.round(y0) + ' m</text>' +
      '<text x="' + (W - pad) + '" y="' + (H - pad - 3) + '" font-size="10" fill="#5b6f63" text-anchor="end" dominant-baseline="baseline">' + ((x1 - x0) / 1000).toFixed(1) + ' km</text>';
    var e = prof.elevation || {};
    cap.textContent = (e.source === 'terrain' ? 'Heights from the TrailSplits terrain model' : 'Heights recorded along the route') +
      ' · ascent ' + (e.ascent_m != null ? Math.round(e.ascent_m) : '—') + ' m · descent ' + (e.descent_m != null ? Math.round(e.descent_m) : '—') + ' m';
    sec.hidden = false;
  }

  function hideModalVisual() {
    els.backdrop.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  function closeModal() {
    /* goes through the overlay stack so the history entry is consumed too */
    C.closeOverlay('details');
    hideModalVisual(); /* idempotent visual cleanup if history is unavailable */
  }

  /* ============================================================
     TRAIL ASSISTANT (this page only)
     ============================================================ */
  var sheet = qs('#assistantSheet'), fab = qs('#assistantFab'),
    log = qs('#assistantLog'), form = qs('#assistantForm'),
    input = qs('#assistantText'), suggest = qs('#assistantSuggest');

  var SUGGESTIONS = ['Easiest trails', 'Top rated', 'Weather this week', 'Under 8 km', 'Longest routes', 'What can you do?'];

  function botSay(html, actions) {
    var div = document.createElement('div');
    div.className = 'msg msg--bot';
    div.innerHTML = html;
    if (actions && actions.length) {
      var row = document.createElement('div');
      row.className = 'msg-actions';
      actions.forEach(function (a) {
        var b = document.createElement('button');
        b.className = 'suggest-chip';
        b.type = 'button';
        b.textContent = a.label;
        b.addEventListener('click', a.fn);
        row.appendChild(b);
      });
      div.appendChild(row);
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function userSay(text) {
    var div = document.createElement('div');
    div.className = 'msg msg--user';
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function trailLine(t, withDist) {
    var s = '• <b>' + esc(t.name) + '</b> — ' + (t.distanceM != null ? C.fmtKm(t.distanceM) : 'length unlisted');
    if (withDist) s += ', ' + C.fmtKm(C.haversineM(state.location.lat, state.location.lon, t.lat, t.lon)) + ' from center';
    if (t.google && t.google.rating != null) s += ' · ★ ' + t.google.rating.toFixed(1);
    return s;
  }

  /* ============================================================
     FREE-FORM AI — Grok (xAI) answers any custom question, grounded
     in the trails actually loaded on this page. Falls back to a
     data-driven local answer when no key is set or the call fails.
     ============================================================ */
  function postJSONsmart(url, body, headers, timeoutMs) {
    return fetchJSON(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }, timeoutMs)
      .catch(function () {
        var proxied = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
        return fetchJSON(proxied, {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(body)
        }, (timeoutMs || 20000) + 10000);
      });
  }

  function formatReply(text) {
    return esc(text)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  function typingIndicator() {
    var div = document.createElement('div');
    div.className = 'msg msg--bot msg--typing';
    div.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function buildTrailContext() {
    var lines = state.trails.slice(0, 30).map(function (t, i) {
      var bits = [i + 1 + '. ' + t.name];
      if (t.distanceM != null) bits.push((t.distanceM / 1000).toFixed(1) + ' km');
      if (t.google && t.google.rating != null) bits.push('Google ' + t.google.rating.toFixed(1) + '★ (' + t.google.count + ' reviews)');
      bits.push('type: ' + (t.routeType === 'bicycle' || t.routeType === 'mtb' ? 'biking' : 'hiking'));
      if (t.network) bits.push('network: ' + t.network);
      bits.push('start: ' + t.lat.toFixed(4) + ',' + t.lon.toFixed(4));
      return bits.join(' · ');
    });
    var wtxt = '';
    try {
      var days = state.weather && state.weather.points && state.weather.points[0] && state.weather.points[0].days;
      if (days && days.length) {
        wtxt = ' Weather now/next days: ' + days.slice(0, 3).map(function (d) {
          var info = wmoInfo(d.weather_code);
          return d.date + ' ' + info.label + ' ' + (d.temp_max_c != null ? Math.round(d.temp_max_c) : '?') + '°C';
        }).join('; ') + '.';
      }
    } catch (e) { }
    return 'You are the CalledIt trail assistant for ' + state.location.label +
      ' (' + state.location.lat.toFixed(4) + ', ' + state.location.lon.toFixed(4) + '). ' +
      'The user is browsing ' + (state.mode === 'bike' ? 'biking routes' : 'hiking trails') + '. ' +
      'Data source: ' + state.dataSource + '. There are ' + state.trails.length + ' signed routes loaded:' +
      (lines.length ? '\n' + lines.join('\n') : ' (none)') + '.' + wtxt +
      ' Answer the user\'s questions in a friendly, concise way (2-6 sentences unless asked for more). ' +
      'Use the data above when relevant (names, distances, ratings). If asked something outside trail/hiking knowledge, still answer helpfully.';
  }

  function askGrok(q) {
    var key = (cfg.grokApiKey || '').trim();
    if (!key) return Promise.reject({ noKey: true });
    var models = [cfg.grokModel].concat(cfg.grokModelFallbacks || []);
    var body = {
      model: models[0],
      messages: [
        { role: 'system', content: buildTrailContext() },
        { role: 'user', content: q }
      ],
      temperature: 0.6,
      max_tokens: 700
    };
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key };

    function tryModel(i) {
      if (i >= models.length) return Promise.reject(new Error('all models failed'));
      body.model = models[i];
      return postJSONsmart(cfg.grokApi, body, headers, 25000)
        .then(function (json) {
          var msg = json && json.choices && json.choices[0] && json.choices[0].message;
          var content = msg && msg.content;
          if (!content) throw new Error('empty reply');
          return content;
        })
        .catch(function (err) {
          if (err && err.status && (err.status === 404 || err.status === 400 || err.status === 422)) {
            return tryModel(i + 1);   /* model name not available on this account */
          }
          return Promise.reject(err);
        });
    }
    return tryModel(0);
  }

  /* Local data-driven answers for when Grok isn’t configured/reachable.
     These use the ACTUAL trails on the page — not canned facts. */
  function localAnswer(q) {
    var low = q.toLowerCase();
    /* a question about a specific loaded trail by (partial) name */
    var named = state.trails.filter(function (t) {
      var n = t.name.toLowerCase();
      return n.length > 3 && low.indexOf(n) !== -1;
    });
    if (!named.length) {
      named = state.trails.filter(function (t) {
        var words = t.name.toLowerCase().split(/[^a-z0-9]+/).filter(function (w) { return w.length > 3; });
        return words.some(function (w) { return low.indexOf(w) !== -1; });
      });
    }
    if (named.length) {
      return 'Here’s what I know about <b>' + esc(named[0].name) + '</b> from the data on this page:<br>' +
        trailLine(named[0], true) +
        (named[0].distanceM != null ? '<br>Typical time: ' + C.fmtDuration(estimateMinutes(named[0])) : '') +
        '<br>Tap <b>Details</b> on its card for the elevation profile and directions.';
    }
    if (/(\bkm\b|mile|mi\b|distance|long|short|far)/.test(low)) {
      var withLen = state.trails.filter(function (t) { return t.distanceM != null; })
        .sort(function (a, b) { return a.distanceM - b.distanceM; });
      if (withLen.length) {
        return 'Distances around <b>' + esc(state.location.label) + '</b> (shortest → longest):<br>' +
          withLen.slice(0, 5).map(function (t) { return trailLine(t); }).join('<br>');
      }
    }
    if (/rain|weather|snow|storm|sun|cold|warm|temperature|forecast/.test(low)) {
      var w = state.weather;
      if (w && w.points && w.points[0] && w.points[0].days && w.points[0].days.length) {
        var rows = w.points[0].days.slice(0, 4).map(function (day) {
          var info = wmoInfo(day.weather_code);
          var d = new Date(day.date + 'T12:00:00');
          return '• <b>' + d.toLocaleDateString(undefined, { weekday: 'long' }) + '</b>: ' + info.icon + ' ' + info.label +
            ', ' + (day.temp_max_c != null ? Math.round(day.temp_max_c) : '?') + '° / ' + (day.temp_min_c != null ? Math.round(day.temp_min_c) : '?') + '°';
        }).join('<br>');
        return 'Forecast for <b>' + esc(state.location.label) + '</b>:<br>' + rows;
      }
      return 'The forecast isn’t loading right now — the weather strip above the trail list updates automatically when it’s available.';
    }
    /* last resort: summarize what is actually loaded and how to ask more */
    var sample = state.trails.slice(0, 3).map(function (t) { return trailLine(t, true); }).join('<br>');
    return 'I’m answering from the <b>' + state.trails.length + '</b> routes loaded around <b>' + esc(state.location.label) + '</b>' +
      (sample ? ':<br>' + sample : '.') +
      '<br><br>Right now I’m in limited local mode — to make me answer <b>any</b> question (like “which trail has the best views for a beginner?” or “what should I pack?”), ' +
      'add a <b>Grok (xAI) key</b> under <b>Settings → API keys</b> (link in the footer).';
  }

  function answerAI(q) {
    var typing = typingIndicator();
    askGrok(q)
      .then(function (reply) {
        typing.remove();
        botSay(formatReply(reply));
      })
      .catch(function (err) {
        typing.remove();
        if (err && err.noKey) {
          botSay(localAnswer(q));
        } else {
          botSay(localAnswer(q) + '<br><span class="muted">(AI service unreachable right now — answered from local trail data.)</span>');
        }
      });
  }

  function answer(raw) {
    var q = raw.toLowerCase().trim();
    var hasTrails = state.trails.length > 0;

    if (/^(hi|hello|hey|good (morning|afternoon|evening))/.test(q)) {
      return botSay('Hey! 👋 I can help you pick from the <b>' + state.trails.length + '</b> trails loaded around <b>' + esc(state.location.label) + '</b>. Try “easiest trails”, “top rated”, or “weather this week”.');
    }

    if (/weather|rain|sunny|forecast|storm|temperature/.test(q)) {
      var w = state.weather;
      if (!w || !w.points || !w.points[0] || !w.points[0].days.length) {
        return botSay('I couldn’t load the forecast right now. The weather strip above the list updates automatically when it’s available.');
      }
      var days = w.points[0].days.slice(0, 4).map(function (day) {
        var info = wmoInfo(day.weather_code);
        var d = new Date(day.date + 'T12:00:00');
        return '• <b>' + d.toLocaleDateString(undefined, { weekday: 'long' }) + '</b>: ' + info.icon + ' ' + info.label +
          ', ' + (day.temp_max_c != null ? Math.round(day.temp_max_c) : '?') + '° / ' + (day.temp_min_c != null ? Math.round(day.temp_min_c) : '?') + '°' +
          (day.precip_mm != null && day.precip_mm > 0 ? ', ' + day.precip_mm.toFixed(1) + ' mm rain' : '');
      }).join('<br>');
      return botSay('Here’s the outlook for <b>' + esc(state.location.label) + '</b>:<br>' + days + '<br><span class="muted">Source: Open-Meteo via TrailSplits.</span>');
    }

    if (/bike|biking|cycling|mtb|ride/.test(q) && !/hik/.test(q)) {
      if (state.mode !== 'bike') {
        return botSay('You’re currently browsing <b>hiking</b> trails. Want me to switch to signed <b>biking routes</b>?', [
          { label: '🚴 Switch to biking', fn: function () { setMode('bike'); botSay('Done — showing biking routes now.'); } }
        ]);
      }
      if (hasTrails) {
        var tops = state.trails.slice(0, 3).map(function (t) { return trailLine(t, true); }).join('<br>');
        return botSay('You’re all set — these biking routes are near ' + esc(state.location.label) + ':<br>' + tops);
      }
      return botSay('No signed biking routes were found here. Try searching a nearby town.');
    }

    if (/(easy|easiest|beginner|kid|family|gentle|short walk)/.test(q)) {
      state.filter = { maxKm: null, sort: 'short', easyOnly: true, minRating: null };
      renderAll();
      var easy = filteredTrails().slice(0, 3);
      if (!easy.length) return botSay('Nothing short and gentle was found in this area. Maybe widen the search to a nearby town?');
      return botSay('I sorted the list, easiest first (shorter and local routes are usually friendlier):<br>' +
        easy.map(function (t) { return trailLine(t); }).join('<br>') +
        '<br><span class="muted">Note: signed routes aren’t always graded — check “Details” for the elevation profile, flat lines are kinder on the knees.</span>');
    }

    if (/(top|best|highest).*(rat|popul|review)|^top rated$|^best rated$/.test(q)) {
      state.filter = { maxKm: null, sort: 'rated', easyOnly: false, minRating: 4.3 };
      renderAll();
      var rated = filteredTrails().slice(0, 3);
      if (!rated.length) {
        state.filter.minRating = null; renderAll();
        return botSay('Google hasn’t rated any of these routes yet — or the ratings couldn’t be loaded. The list shows everything found instead.');
      }
      return botSay('Highest Google-rated around here:<br>' + rated.map(function (t) { return trailLine(t); }).join('<br>'));
    }

    var under = q.match(/(?:under|less than|shorter than|max(?:imum)?)\s*(\d+(?:[.,]\d+)?)\s*(km|kilomet|mi|mile)/);
    if (under) {
      var val = parseFloat(under[1].replace(',', '.'));
      var km = /mi/.test(under[2]) ? val * 1.60934 : val;
      state.filter = { maxKm: Math.round(km * 10) / 10, sort: 'near', easyOnly: false, minRating: null };
      renderAll();
      var inRange = filteredTrails().slice(0, 3);
      if (!inRange.length) return botSay('Nothing under ' + km.toFixed(1) + ' km here. Try relaxing the limit or searching a different area.');
      return botSay('Trails under ' + km.toFixed(1) + ' km (list updated):<br>' + inRange.map(function (t) { return trailLine(t); }).join('<br>'), [
        { label: 'Clear filter', fn: function () { state.filter.maxKm = null; renderAll(); botSay('Filter cleared — showing everything again.'); } }
      ]);
    }

    if (/(long|longest|epic|big day|hard|hardest|challenge)/.test(q)) {
      state.filter = { maxKm: null, sort: 'long', easyOnly: false, minRating: null };
      renderAll();
      var longs = filteredTrails().filter(function (t) { return t.distanceM != null; }).slice(0, 3);
      if (!longs.length) return botSay('No routes with a known length here.');
      return botSay('Bring snacks — these are the longest routes around:<br>' + longs.map(function (t) { return trailLine(t); }).join('<br>'));
    }

    if (/(near|nearby|closest|next|around)/.test(q) && hasTrails) {
      state.filter = { maxKm: null, sort: 'near', easyOnly: false, minRating: null };
      renderAll();
      var near = filteredTrails().slice(0, 3);
      return botSay('Closest to ' + esc(state.location.label) + ':<br>' + near.map(function (t) { return trailLine(t, true); }).join('<br>'));
    }

    if (/how many|count/.test(q)) {
      return botSay('I have <b>' + state.trails.length + '</b> signed routes loaded for this area (' + esc(state.dataSource) + '),' +
        (state.googleOk ? ' plus Google ratings and photos where available.' : ' but Google ratings aren’t loading right now.'));
    }

    if (/where|what place|which town|location/.test(q)) {
      return botSay('We’re looking at <b>' + esc(state.location.label) + '</b> (' + state.location.lat.toFixed(4) + ', ' + state.location.lon.toFixed(4) + ')' +
        (state.location.guessed ? ' — that’s the sample area. Tap “Near me” in the search bar to use your real position.' : '.') +
        ' Data come from ' + esc(state.dataSource) + '.');
    }

    if (/thank/.test(q)) return botSay('Anytime! Have a great trip. 🥾');

    if (/what can you|help|commands|options/.test(q)) {
      return botSay('I answer <b>any</b> question about these trails, hiking and biking. Quick commands I handle instantly:<br>' +
        '• “easiest / beginner trails”<br>• “top rated” (Google ratings)<br>• “under 8 km”<br>• “longest routes”<br>• “nearest trails”<br>• “weather this week”<br>• “switch to biking”<br>' +
        'Plus free-form questions like “which of these is best with kids?” or “what should I pack for the long one?”.');
    }

    /* anything else → real AI (Grok), grounded in the trails on this page */
    return answerAI(raw);
  }

  function hideAssistantVisual() {
    sheet.classList.remove('is-open');
    fab.classList.remove('is-hidden');
  }

  function openAssistant() {
    sheet.classList.add('is-open');
    fab.classList.add('is-hidden');
    C.pushOverlay('assistant', hideAssistantVisual);
    if (!log.children.length) {
      botSay('Hi! I’m the trail assistant — ask me <b>anything</b> about the <b>' + state.trails.length + '</b> routes loaded around <b>' + esc(state.location.label) + '</b>, ' +
        'or general hiking/biking questions. Try “easiest trails”, “top rated”, or ask your own question below.');
      suggest.innerHTML = SUGGESTIONS.map(function (s) { return '<button type="button" class="suggest-chip">' + esc(s) + '</button>'; }).join('');
      qsa('.suggest-chip', suggest).forEach(function (chip) {
        chip.addEventListener('click', function () { userSay(chip.textContent); answer(chip.textContent); });
      });
    }
  }
  function closeAssistant() {
    C.closeOverlay('assistant');
    hideAssistantVisual();
  }

  fab.addEventListener('click', openAssistant);
  qs('#assistantClose').addEventListener('click', closeAssistant);

  /* keep the input visible above the on-screen keyboard (esp. WebView APKs) */
  input.addEventListener('focus', function () {
    setTimeout(function () { input.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, 280);
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    userSay(text);
    input.value = '';
    setTimeout(function () { answer(text); }, 200);
    /* keep the conversation going — don't let the keyboard collapse */
    setTimeout(function () { input.focus({ preventScroll: true }); }, 320);
  });

  /* ============================================================
     Mode + boot
     ============================================================ */
  function setMode(mode) {
    if (state.mode === mode) return;
    state.mode = mode;
    try { localStorage.setItem('calledit_mode', mode); } catch (e) { }
    updateModeButtons();
    loadArea(state.location.lat, state.location.lon, state.location.label, state.location.guessed);
  }

  function updateModeButtons() {
    els.modeHike.classList.toggle('is-active', state.mode === 'hike');
    els.modeBike.classList.toggle('is-active', state.mode === 'bike');
  }

  function init() {
    /* mode from URL (?mode=bike) or remembered from the Start page */
    var params = new URLSearchParams(location.search);
    var modeParam = params.get('mode');
    var savedMode = null;
    try { savedMode = localStorage.getItem('calledit_mode'); } catch (e) { }
    state.mode = modeParam === 'bike' || (!modeParam && savedMode === 'bike') ? 'bike' : 'hike';
    updateModeButtons();

    /* optional deep link: ?q=place or ?lat&lon */
    var qParam = params.get('q');
    var latParam = parseFloat(params.get('lat')), lonParam = parseFloat(params.get('lon'));

    els.searchBtn.addEventListener('click', function () { doSearch(els.searchInput.value); });
    els.searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(els.searchInput.value); } });
    els.locateBtn.addEventListener('click', locateMe);
    els.modeHike.addEventListener('click', function () { setMode('hike'); });
    els.modeBike.addEventListener('click', function () { setMode('bike'); });

    els.modalClose.addEventListener('click', closeModal);
    els.backdrop.addEventListener('click', function (e) { if (e.target === els.backdrop) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeModal(); closeAssistant(); } });

    if (qParam) {
      els.searchInput.value = qParam;
      doSearch(qParam);
    } else if (!isNaN(latParam) && !isNaN(lonParam)) {
      loadArea(latParam, lonParam, 'pinned location (' + latParam.toFixed(3) + ', ' + lonParam.toFixed(3) + ')', false);
    } else {
      loadArea(cfg.defaultLocation.lat, cfg.defaultLocation.lon, cfg.defaultLocation.label, true);
    }
  }

  init();
})();
