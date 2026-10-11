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
    mapLib: null,                       // 'google' | 'leaflet' | null
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
    googleMap: qs('#googleMap'), leafletMap: qs('#leafletMap'), mapCaption: qs('#mapCaption'),
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

  /* TrailSplits API key (optional) goes in an Authorization: Bearer header
     (https://trailsplits.com/api#auth). Keyless = 500 free credits/day. */
  function tsAuthHeaders(url) {
    var key = (cfg.trailsplitsApiKey || '').trim();
    if (key && url.indexOf(cfg.trailsplitsApi) === 0) return { 'Authorization': 'Bearer ' + key };
    return null;
  }

  /* GET that survives CORS-blocked endpoints: try direct first, then a
     public CORS proxy (api.allorigins.win). */
  function getJSONsmart(url, timeoutMs) {
    var h = tsAuthHeaders(url);
    return fetchJSON(url, h ? { headers: h } : null, timeoutMs).catch(function () {
      var proxied = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
      return fetchJSON(proxied, null, (timeoutMs || 12000) + 8000);
    });
  }

  /* POST JSON to the TrailSplits API (permissive CORS, key optional) */
  function tsPost(path, body, timeoutMs) {
    var url = cfg.trailsplitsApi + path;
    var headers = { 'Content-Type': 'application/json' };
    var h = tsAuthHeaders(url);
    if (h) headers.Authorization = h.Authorization;
    return fetchJSON(url, { method: 'POST', headers: headers, body: JSON.stringify(body) }, timeoutMs || 20000);
  }

  function hasGoogleKey() {
    return !!cfg.googleMapsApiKey && cfg.googleMapsApiKey.indexOf('AIza') === 0;
  }

  /* TrailSplits passes OSM's `distance` tag straight through as distance_m for
     many relations — and that tag is in KILOMETRES (“24.5” = 24.5 km), which
     made those trails show “0.0 km · ~0 min”. A route can't be shorter than
     half its own extent, so such values are converted. */
  function normalizeTrailDistance(d, bbox) {
    if (typeof d !== 'number' || !isFinite(d) || d <= 0) return null;
    if (Array.isArray(bbox) && bbox.length === 4) {
      var span = Math.max(C.haversineM(bbox[1], bbox[0], bbox[3], bbox[0]), C.haversineM(bbox[1], bbox[0], bbox[1], bbox[2]));
      if (d < span * 0.5 && d * 1000 >= span * 0.5) return d * 1000;
      return d;
    }
    return d < 100 ? d * 1000 : d;
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
            nameEn: p.name_en || null,
            ref: p.ref || null,
            network: p.network || null,
            routeType: p.route_type || (mode === 'bike' ? 'bicycle' : 'hiking'),
            distanceM: normalizeTrailDistance(p.distance_m, p.bbox),
            ascentM: typeof p.ascent_m === 'number' ? p.ascent_m : null,
            descentM: typeof p.descent_m === 'number' ? p.descent_m : null,
            bbox: Array.isArray(p.bbox) && p.bbox.length === 4 ? p.bbox : null,
            description: p.description || null,
            lon: typeof c[0] === 'number' ? c[0] : null,
            lat: typeof c[1] === 'number' ? c[1] : null,
            source: 'TrailSplits'
          };
        }).map(function (t) {
          /* a national/international route “1 km long” is an OSM super-relation
             (e.g. Tour Monte Rosa, ~160 km) of which only a stub is mapped —
             don’t show a fake length or call it the easiest trail */
          if ((t.network === 'iwn' || t.network === 'nwn') && t.distanceM != null && t.distanceM < 3000) {
            t.distanceM = null;
            t.multiStage = true;
          }
          return t;
        }).filter(function (t) { return t.lat != null; });
      });
    },

    relation: function (osmId) {
      return getJSONsmart(cfg.trailsplitsApi + '/trails/v1/relation/' + encodeURIComponent(osmId));
    },

    elevationProfile: function (geometry) {
      return tsPost('/v1/elevation-profile', { geometry: geometry, points: 400 }, 15000);
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
    weather: function (lat, lon, days) {
      return getJSONsmart(cfg.trailsplitsSite + '/api/weather/forecast?p=' + lat.toFixed(4) + ',' + lon.toFixed(4) + '&d=' + (days || 5));
    }
  };

  /* Open-Meteo directly (CORS-friendly) in the TrailSplits weather shape —
     used only if the TrailSplits forecast can’t be reached. */
  function openMeteoForecast(lat, lon, days) {
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,wind_gusts_10m_max' +
      '&timezone=auto&forecast_days=' + (days || 5);
    return fetchJSON(url, null, 12000).then(function (j) {
      var d = j && j.daily;
      if (!d || !d.time) throw new Error('bad forecast');
      return {
        provider: { attribution: 'Weather data by Open-Meteo.com (CC BY 4.0)' },
        points: [{ days: d.time.map(function (date, i) {
          return {
            date: date, weather_code: d.weather_code[i], temp_max_c: d.temperature_2m_max[i], temp_min_c: d.temperature_2m_min[i],
            precip_mm: d.precipitation_sum[i], precip_probability_max_pct: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
            wind_max_kmh: d.wind_speed_10m_max ? d.wind_speed_10m_max[i] : null, gust_max_kmh: d.wind_gusts_10m_max ? d.wind_gusts_10m_max[i] : null
          };
        }) }]
      };
    });
  }

  function getForecast(lat, lon, days) {
    return ts.weather(lat, lon, days).then(function (w) {
      if (!w || !w.points || !w.points[0] || !w.points[0].days || !w.points[0].days.length) throw new Error('empty forecast');
      return w;
    }).catch(function () { return openMeteoForecast(lat, lon, days); });
  }

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
              photo: google.photoUrl(p, 800),
              photoBy: (p.photos && p.photos[0] && p.photos[0].authorAttributions && p.photos[0].authorAttributions[0] &&
                p.photos[0].authorAttributions[0].displayName) || null
            };
          }).filter(function (p) { return p.name && p.lat != null; });
        })
        .catch(function () { state.googleOk = false; return []; });
    }
  };

  /* Attach the best matching Google place (rating/photo) to each trail. */
  /* Pair Google places with trails: best name match first, one place per
     trail and one trail per place (so two cards never share a photo).
     Generic words (“walk”, “trail”, “weg”…) and the town's own name don't
     count as a match — “Swiss Top Walk” is not the “5 Lakes Walk”. */
  function attachGoogle() {
    if (!state.googlePlaces.length) return;
    var stop = ['trail', 'trails', 'trailhead', 'route', 'path', 'way', 'loop', 'the', 'and', 'walk', 'walks', 'hike', 'hiking',
      'tour', 'trek', 'weg', 'wanderweg', 'sentier', 'sentiero', 'sendero', 'chemin', 'panorama', 'panoramaweg', 'park', 'swiss',
      'top', 'nature', 'naturweg', 'de', 'la', 'le', 'di', 'da', 'del', 'des', 'von'];
    plainWords(state.location.label).forEach(function (w) { if (w.length > 2) stop.push(w); });
    function tokens(s) {
      return plainWords(s).filter(function (w) { return w.length > 2 && stop.indexOf(w) === -1; });
    }
    function same(a, b) { return a === b || (a.length >= 5 && b.indexOf(a) === 0) || (b.length >= 5 && a.indexOf(b) === 0); }
    var pairs = [];
    state.trails.forEach(function (t) {
      if (t.source === 'Google Maps') return;
      t.google = null;
      var tt = tokens(t.name + ' ' + (t.nameEn || ''));
      if (!tt.length) return;
      state.googlePlaces.forEach(function (p) {
        var d = C.haversineM(t.lat, t.lon, p.lat, p.lon);
        if (d > 3000) return;
        var shared = tokens(p.name).filter(function (w) { return tt.some(function (x) { return same(w, x); }); }).length;
        if (shared > 0) pairs.push({ t: t, p: p, score: shared * 100 - Math.min(d / 25, 40) });
      });
    });
    pairs.sort(function (a, b) { return b.score - a.score; });
    var placeTaken = {};
    pairs.forEach(function (x) {
      if (x.t.google || placeTaken[x.p.id]) return;
      x.t.google = x.p;
      placeTaken[x.p.id] = true;
    });
  }

  /* ============================================================
     TRAIL PHOTOS — every card shows an image of THAT trail:
       1. its Google Maps photo (when Google knows the trail), else
       2. a real, freely-licensed photo taken near the trail start
          (Wikimedia Commons geosearch — filtered hard so board games,
          maps, signs or buildings never show up; credited; never the
          same photo on two cards), else
       3. a small map of the trail’s own area with its start pinned.
     No more repeating stock pictures. Lookups are lazy (only cards you
     scroll to) and cached on the device for 30 days.
     ============================================================ */
  var PHOTO_CACHE_KEY = 'calledit_photos_v2';
  var PHOTO_TTL = 30 * 864e5;
  var photoCache = (function () {
    try { return JSON.parse(localStorage.getItem(PHOTO_CACHE_KEY) || '{}') || {}; } catch (e) { return {}; }
  })();
  var photoCacheTimer = null;
  function savePhotoCache() {
    clearTimeout(photoCacheTimer);
    photoCacheTimer = setTimeout(function () {
      var keys = Object.keys(photoCache);
      if (keys.length > 400) {                      /* keep the newest 400 */
        keys.sort(function (a, b) { return (photoCache[b].at || 0) - (photoCache[a].at || 0); })
          .slice(400).forEach(function (k) { delete photoCache[k]; });
      }
      try { localStorage.setItem(PHOTO_CACHE_KEY, JSON.stringify(photoCache)); } catch (e) { }
    }, 400);
  }
  function photoKey(t) { return t.lat.toFixed(3) + ',' + t.lon.toFixed(3); }

  function plainWords(s) {
    return String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/\.(jpe?g|png|webp|tiff?|gif)$/, '').split(/[^a-z0-9]+/).filter(Boolean);
  }
  var GOOD = ('lake lakes lac lago laghi see seen trail trails path paths sentier sentiero sendero hike hiking wanderweg mountain mountains ' +
    'peak peaks piz mont monte glacier gletscher valley tal val vallee view views panorama aussicht creek river fluss springs spring falls ' +
    'waterfall wasserfall cascade forest wald woods park preserve canyon gorge schlucht ridge alp alpe alpine pass summit gipfel hill hills ' +
    'trailhead greenbelt nature landscape meadow wiese sunset sunrise cliff cliffs overlook bluff dunes prairie wetland marsh bridge ' +
    'hangebrucke hut hutte cabane rifugio refuge horn berg spitze bach stream pond reservoir lagoon coast beach bay island wilderness ' +
    'matterhorn jungfrau eiger dolomites rockies sierra appalachian').split(' ');
  var SUFFIX = ['tal', 'horn', 'berg', 'see', 'gletscher', 'weg', 'wald', 'bach', 'spitze', 'brucke', 'hutte', 'alp', 'alpe', 'pass', 'joch', 'grat'];
  var BAD = ('map maps karte plan plans logo diagram chart board game games dungeon voting machine poster document screenshot scan flag ' +
    'coat arms wappen sign signs signpost ticket menu portrait selfie interior inside microscope specimen insect beetle moth spider ' +
    'fungus plaque memorial grave cemetery tombstone church chapel kirche cathedral hotel restaurant bar cafe shop store building ' +
    'house street car cars bus tram train trains railway railroad station bahnhof airport aircraft airplane helicopter construction ' +
    'crane text book page cover newspaper stamp coin banknote advertisement graffiti crowd concert festival parade protest meeting ' +
    'conference election number sticker label bottle food dish meal logo icon svg drawing sketch painting museum exhibit statue sculpture ' +
    'swisstopo survey aerial orthophoto satellite hall capitol tower office school university campus hospital stadium mall garage ' +
    'apartment apartments room lobby kitchen people wedding dog cat portrait headshot').split(' ');
  var STOP = ['the', 'and', 'trail', 'weg', 'route', 'tour', 'stage', 'tappa', 'via', 'chemin', 'des', 'del', 'della', 'von', 'zum', 'zur'];

  function scoreCommons(info, title, t) {
    if (!info || !/^image\/(jpeg|webp)$/.test(info.mime || '')) return -99;
    var words = plainWords(title.replace(/^File:/i, ''));
    var score = 0, good = 0;
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (BAD.indexOf(w) !== -1) score -= 10;
      if (GOOD.indexOf(w) !== -1) good++;
      else for (var j = 0; j < SUFFIX.length; j++) {
        if (w.length >= SUFFIX[j].length + 3 && w.slice(-SUFFIX[j].length) === SUFFIX[j]) { good++; break; }
      }
    }
    score += Math.min(2, good) * 3;
    /* words from the trail’s own name or the area name */
    var name = plainWords(t.name + ' ' + (t.nameEn || '')).filter(function (w) { return w.length >= 4 && STOP.indexOf(w) === -1; });
    var area = plainWords(state.location.label).filter(function (w) { return w.length >= 4; });
    var nameHit = name.some(function (n) { return words.some(function (w) { return w === n || (n.length >= 5 && w.indexOf(n) === 0) || (w.length >= 5 && n.indexOf(w) === 0); }); });
    if (!good && !nameHit) return -5;            /* must show nature/trail — or be named after this trail */
    if (nameHit) score += 3;
    if (area.some(function (a) { return words.indexOf(a) !== -1; })) score += 2;
    var wpx = info.width || 0, hpx = info.height || 0;
    if (wpx >= hpx * 1.2) score += 1;            /* landscape suits the cards */
    if (hpx > wpx * 1.1) score -= 2;             /* portrait crops badly */
    if (wpx && wpx < 900) score -= 2;
    return score;
  }

  function stripTags(html) {
    var d = document.createElement('div');
    d.innerHTML = String(html || '');
    return (d.textContent || '').replace(/\s+/g, ' ').trim();
  }

  /* concurrency-limited queue for photo lookups (be gentle with Commons) */
  var photoQueue = [], photoActive = 0;
  function enqueuePhoto(job) {
    photoQueue.push(job);
    pumpPhotos();
  }
  function pumpPhotos() {
    while (photoActive < 2 && photoQueue.length) {
      var job = photoQueue.shift();
      photoActive++;
      Promise.resolve().then(job).catch(function () { }).then(function () { photoActive--; pumpPhotos(); });
    }
  }

  var commonsPending = {};
  function commonsCandidates(t) {
    var key = photoKey(t);
    var hit = photoCache[key];
    if (hit && Date.now() - hit.at < PHOTO_TTL) return Promise.resolve(hit.c || []);
    if (commonsPending[key]) return commonsPending[key];
    var url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*' +
      '&generator=geosearch&ggscoord=' + t.lat.toFixed(5) + '%7C' + t.lon.toFixed(5) + '&ggsradius=1500&ggsnamespace=6&ggslimit=20' +
      '&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&iiextmetadatafilter=Artist%7CLicenseShortName&iiurlwidth=640';
    commonsPending[key] = new Promise(function (resolve) {
      enqueuePhoto(function () {
        return fetchJSON(url, null, 9000).then(function (json) {
          var pages = (json && json.query && json.query.pages) || {};
          var list = Object.keys(pages).map(function (id) {
            var p = pages[id], info = p.imageinfo && p.imageinfo[0];
            if (!info || !info.thumburl) return null;
            var md = info.extmetadata || {};
            return {
              id: p.pageid, s: scoreCommons(info, p.title || '', t), i: typeof p.index === 'number' ? p.index : 99,
              src: info.thumburl, link: info.descriptionurl || '',
              by: stripTags(md.Artist && md.Artist.value).slice(0, 40), lic: stripTags(md.LicenseShortName && md.LicenseShortName.value).slice(0, 20)
            };
          }).filter(function (c) { return c && c.s >= 3; })
            .sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); })
            .slice(0, 6)
            .map(function (c) { return { id: c.id, src: c.src, link: c.link, by: c.by, lic: c.lic }; });
          photoCache[key] = { at: Date.now(), c: list };
          savePhotoCache();
          resolve(list);
        }).catch(function () { resolve([]); });        /* offline etc. — not cached, retried next time */
      });
    });
    commonsPending[key].then(function () { delete commonsPending[key]; });
    return commonsPending[key];
  }

  /* ---------- rendering helpers ---------- */
  var usedPhotoIds = {};                              /* Commons photo id → trail id (no duplicates on the page) */
  function googleCredit(g) {
    return g && g.photoBy ? 'Photo: ' + g.photoBy + ' · Google Maps' : 'Photo · Google Maps';
  }

  function setPhoto(box, src, credit, link, onFail) {
    box.innerHTML = '<span class="photo-skeleton"></span>';
    var img = document.createElement('img');
    img.className = 'trail-photo';
    img.alt = '';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', function () {
      img.classList.add('is-in');
      var sk = box.querySelector('.photo-skeleton');
      setTimeout(function () { if (sk && sk.parentNode) sk.parentNode.removeChild(sk); }, 400);
    });
    img.addEventListener('error', function () { if (onFail) onFail(); });
    img.src = src;
    box.appendChild(img);
    if (credit) {
      var c = document.createElement(link ? 'a' : 'span');
      c.className = 'photo-credit';
      c.textContent = credit;
      if (link) { c.href = link; c.target = '_blank'; c.rel = 'noopener'; }
      box.appendChild(c);
    }
    box.dataset.kind = 'photo';
  }

  /* Web-Mercator tile mosaic of the trail’s area, sized to the box, start pinned */
  function lon2x(lon, z) { return (lon + 180) / 360 * 256 * Math.pow(2, z); }
  function lat2y(lat, z) {
    var s = Math.sin(lat * Math.PI / 180);
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
  }
  function setMapThumb(box, t) {
    var r = box.getBoundingClientRect();
    var W = Math.max(160, Math.round(r.width || 360)), H = Math.max(110, Math.round(r.height || 200));
    var cLat = t.lat, cLon = t.lon, z = 14;
    var bb = t.bbox;
    if (bb && bb.length === 4 && bb[2] > bb[0] && bb[3] > bb[1]) {
      cLon = (bb[0] + bb[2]) / 2; cLat = (bb[1] + bb[3]) / 2;
      for (z = 15; z > 10; z--) {                 /* zoom that fits the whole route */
        if (lon2x(bb[2], z) - lon2x(bb[0], z) <= W * 0.85 && lat2y(bb[1], z) - lat2y(bb[3], z) <= H * 0.85) break;
      }
    }
    var cx = lon2x(cLon, z), cy = lat2y(cLat, z);
    var x0 = cx - W / 2, y0 = cy - H / 2;
    var retina = (window.devicePixelRatio || 1) > 1.4 ? '@2x' : '';
    var html = '';
    for (var tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + W) / 256); tx++) {
      for (var ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + H) / 256); ty++) {
        var n = Math.pow(2, z), wx = ((tx % n) + n) % n;
        var sub = 'abcd'.charAt((wx + ty) % 4);
        html += '<img class="tile" alt="" draggable="false" referrerpolicy="no-referrer" style="left:' + Math.round(tx * 256 - x0) + 'px;top:' + Math.round(ty * 256 - y0) + 'px" ' +
          'src="https://' + sub + '.basemaps.cartocdn.com/rastertiles/voyager/' + z + '/' + wx + '/' + ty + retina + '.png">';
      }
    }
    var px = lon2x(t.lon, z) - x0, py = lat2y(t.lat, z) - y0;
    box.innerHTML = '<div class="map-thumb">' + html +
      '<span class="map-thumb__pin" style="left:' + Math.round(px) + 'px;top:' + Math.round(py) + 'px">' +
      '<svg viewBox="0 0 24 32" width="26" height="34" aria-hidden="true"><path d="M12 1C6 1 1.5 5.4 1.5 11.3 1.5 19 12 31 12 31s10.5-12 10.5-19.7C22.5 5.4 18 1 12 1z" fill="#16a34a" stroke="#fff" stroke-width="2"/><circle cx="12" cy="11.5" r="4" fill="#fff"/></svg></span>' +
      '<span class="map-thumb__tag">' + (state.mode === 'bike' ? 'Route area' : 'Trail area') + '</span></div>' +
      '<span class="photo-credit">© OpenStreetMap · CARTO</span>';
    box.dataset.kind = 'map';
  }

  /* Fill one media box for trail t (card thumbnail or details hero). */
  function fillTrailMedia(box, t) {
    if (!box || box.dataset.filled === '1') return;
    box.dataset.filled = '1';
    var fallback = function () { setMapThumb(box, t); };
    if (t.google && t.google.photo) {
      setPhoto(box, t.google.photo, googleCredit(t.google), t.google.gmapsUri, function () { tryCommons(); });
      return;
    }
    tryCommons();
    function tryCommons() {
      box.innerHTML = '<span class="photo-skeleton"></span>';
      var done = false;
      var timer = setTimeout(function () { if (!done) { done = true; fallback(); } }, 7000);
      commonsCandidates(t).then(function (list) {
        if (done) {                                 /* map already shown — upgrade if a photo turned up */
          if (!list.length || box.dataset.kind !== 'map') return;
        }
        done = true;
        clearTimeout(timer);
        var pick = null;
        for (var i = 0; i < list.length; i++) {
          var owner = usedPhotoIds[list[i].id];
          if (!owner || owner === t.id) { pick = list[i]; break; }
        }
        if (!pick) { fallback(); return; }
        usedPhotoIds[pick.id] = t.id;
        var credit = '📷 ' + (pick.by || 'Wikimedia Commons') + (pick.lic ? ' · ' + pick.lic : '');
        setPhoto(box, pick.src, credit, pick.link, function () { delete usedPhotoIds[pick.id]; fallback(); });
      });
    }
  }

  /* lazy: fill boxes as they approach the viewport */
  var mediaObserver = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      mediaObserver.unobserve(e.target);
      var t = trailById(e.target.dataset.trail);
      if (t) fillTrailMedia(e.target, t);
    });
  }, { rootMargin: '300px 0px' }) : null;

  function observeMedia(root) {
    qsa('.trail-media[data-trail]', root).forEach(function (box) {
      if (mediaObserver) mediaObserver.observe(box);
      else { var t = trailById(box.dataset.trail); if (t) fillTrailMedia(box, t); }
    });
  }

  function trailById(id) {
    for (var i = 0; i < state.trails.length; i++) if (state.trails[i].id === id) return state.trails[i];
    return null;
  }

  /* ============================================================
     Map — Google Maps first. (The configured key was verified on
     2026-10-11 for the Maps JavaScript API, unrestricted, so it also works
     inside the Android app.) If Google can’t load for any reason, a
     bundled Leaflet map with clean CARTO / topo tiles takes over — never
     the old plain OSM iframe — so trail pins, the live hike track and
     loops planned by the assistant still show.
     ============================================================ */
  var gmaps = { status: 'idle', error: null, slow: false };   /* idle | loading | ready | failed */
  var lmap = { map: null, group: null };                      /* Leaflet fallback */
  var gOv = { pins: [], track: null, me: null, loop: null };  /* Google overlays */
  var lOv = { track: null, me: null, loop: null };            /* Leaflet overlays */
  var loopPath = null;          /* [{lat,lng}] loop planned by the assistant */
  var followMe = true;          /* keep the live position centred while tracking */
  var fittedKey = '';           /* area the map was last fitted to */

  function setMapCaption(html) { if (els.mapCaption) els.mapCaption.innerHTML = html; }

  function friendlyMapsError(code) {
    return ({
      InvalidKeyMapError: 'the Google key is invalid',
      RefererNotAllowedMapError: 'the Google key doesn’t allow this web address',
      ApiNotActivatedMapError: 'the Maps JavaScript API isn’t enabled for the key',
      BillingNotEnabledMapError: 'billing isn’t enabled on the key’s Google Cloud project',
      MissingKeyMapError: 'no Google key is set',
      ExpiredKeyMapError: 'the Google key has expired',
      OverQuotaMapError: 'the Google key is over its quota',
      offline: 'Google can’t be reached right now (offline?)',
      auth: 'Google rejected the key',
      'gm-err': 'Google rejected the key',
      render: 'the Google map failed to draw'
    })[code] || ('Google Maps reported “' + code + '”');
  }

  function googleFailed(code) {
    if (gmaps.status === 'failed') return;
    gmaps.status = 'failed';
    gmaps.error = code || 'unknown';
    renderLeafletMap();
  }

  /* Google reports key/billing problems through console.error and a grey
     “can’t load Google Maps” box — catch both, plus gm_authFailure. */
  (function watchGoogleErrors() {
    var orig = console.error;
    console.error = function () {
      try {
        var m = String(arguments[0] || '').match(/Google Maps JavaScript API error: (\w+)/);
        if (m && /MapError$|AuthenticationCommonError$/.test(m[1])) googleFailed(m[1]);
      } catch (e) { /* never break logging */ }
      return orig.apply(console, arguments);
    };
    window.gm_authFailure = function () { googleFailed('auth'); };
  })();

  function loadGoogleMaps() {
    if (gmaps.status !== 'idle') return;
    if (!hasGoogleKey()) { googleFailed('MissingKeyMapError'); return; }
    gmaps.status = 'loading';
    window.__calleditMapsReady = function () {
      if (gmaps.status === 'failed') return;
      gmaps.status = 'ready';
      try { renderMap(); } catch (e) { googleFailed('render'); }
      [2500, 7000].forEach(function (ms) {
        setTimeout(function () {
          if (els.googleMap && els.googleMap.querySelector('.gm-err-container')) googleFailed('gm-err');
        }, ms);
      });
    };
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(cfg.googleMapsApiKey) +
      '&v=weekly&callback=__calleditMapsReady';
    s.async = true;
    s.onerror = function () { googleFailed('offline'); };
    document.head.appendChild(s);
    /* very slow network: show the fallback meanwhile, swap to Google when it arrives */
    setTimeout(function () {
      if (gmaps.status === 'loading') { gmaps.slow = true; renderLeafletMap(); }
    }, 12000);
  }

  function renderMap() {
    if (gmaps.status === 'ready' && window.google && window.google.maps) { renderGoogleMap(); return; }
    if (gmaps.status === 'idle') loadGoogleMaps();
    if (gmaps.status === 'failed' || gmaps.slow) renderLeafletMap();
    else setMapCaption('Loading Google Maps…');
  }

  function areaKey() { return state.location.lat.toFixed(4) + ',' + state.location.lon.toFixed(4) + ',' + state.mode + ',' + state.trails.length; }

  function pinTrails() {
    var list = filteredTrails();
    return (list.length ? list : state.trails).slice(0, 40);
  }

  function mapCaptionText(lib) {
    var bits = [];
    bits.push(lib === 'google' ? 'Map © Google' : 'Map © OpenStreetMap contributors © CARTO');
    bits.push((state.mode === 'bike' ? '🚴' : '🥾') + ' pins = trail starts (tap one for details)');
    if (tracker.active) bits.push('<span style="color:#16a34a">━</span> your track · 🔵 you');
    if (loopPath) bits.push('<span style="color:#7c3aed">━</span> planned loop');
    var cap = bits.join(' · ');
    if (lib !== 'google') {
      cap += gmaps.status === 'failed'
        ? '<br><b>Google Maps couldn’t load</b> — ' + esc(friendlyMapsError(gmaps.error)) + '. Showing the backup map.'
        : '<br>Google Maps is still loading on this slow connection — it replaces this map as soon as it’s ready.';
    }
    return cap;
  }

  /* ---------------- Google ---------------- */
  function renderGoogleMap() {
    var g = window.google;
    state.mapLib = 'google';
    els.googleMap.style.display = 'block';
    if (els.leafletMap) els.leafletMap.style.display = 'none';
    if (!state.map) {
      state.map = new g.maps.Map(els.googleMap, {
        center: { lat: state.location.lat, lng: state.location.lon },
        zoom: 12,
        mapTypeId: 'terrain',
        streetViewControl: false,
        fullscreenControl: true,
        mapTypeControl: true,
        mapTypeControlOptions: { mapTypeIds: ['roadmap', 'terrain', 'hybrid'], style: g.maps.MapTypeControlStyle.DROPDOWN_MENU },
        gestureHandling: 'cooperative',
        clickableIcons: false
      });
      state.map.addListener('dragstart', function () { if (tracker.active) followMe = false; });
    }
    /* pins */
    gOv.pins.forEach(function (m) { m.setMap(null); });
    gOv.pins = [];
    gOv.pins.push(new g.maps.Marker({
      map: state.map, position: { lat: state.location.lat, lng: state.location.lon },
      title: state.location.label, zIndex: 5,
      icon: { path: g.maps.SymbolPath.CIRCLE, scale: 7, fillColor: '#f59e0b', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 2 }
    }));
    var bounds = new g.maps.LatLngBounds();
    bounds.extend({ lat: state.location.lat, lng: state.location.lon });
    pinTrails().forEach(function (t, i) {
      var mk = new g.maps.Marker({
        map: state.map, position: { lat: t.lat, lng: t.lon }, title: t.name, zIndex: 10,
        label: { text: state.mode === 'bike' ? '🚴' : '🥾', fontSize: '14px' }
      });
      mk.addListener('click', function () { openDetails(t); });
      gOv.pins.push(mk);
      if (i < 25) bounds.extend({ lat: t.lat, lng: t.lon });
    });
    /* fit the view once per loaded area (not while you’re tracking) */
    var key = areaKey();
    if (key !== fittedKey && !tracker.active) {
      fittedKey = key;
      if (gOv.pins.length > 1) {
        state.map.fitBounds(bounds, 36);
        g.maps.event.addListenerOnce(state.map, 'idle', function () { if (state.map.getZoom() > 14) state.map.setZoom(14); });
      } else {
        state.map.setCenter({ lat: state.location.lat, lng: state.location.lon });
        state.map.setZoom(12);
      }
    }
    drawGoogleOverlays();
    setMapCaption(mapCaptionText('google'));
  }

  function drawGoogleOverlays() {
    var g = window.google;
    if (!g || !state.map) return;
    /* planned loop */
    if (loopPath && loopPath.length > 1) {
      if (!gOv.loop) gOv.loop = new g.maps.Polyline({ strokeColor: '#7c3aed', strokeOpacity: .85, strokeWeight: 5, zIndex: 15 });
      gOv.loop.setPath(loopPath);
      gOv.loop.setMap(state.map);
    } else if (gOv.loop) gOv.loop.setMap(null);
    /* live track */
    if (tracker.path.length > 1) {
      if (!gOv.track) gOv.track = new g.maps.Polyline({ strokeColor: '#16a34a', strokeOpacity: .95, strokeWeight: 6, zIndex: 20 });
      gOv.track.setPath(tracker.path.map(function (p) { return { lat: p.lat, lng: p.lng }; }));
      gOv.track.setMap(state.map);
    } else if (gOv.track) gOv.track.setMap(null);
    /* you */
    if (tracker.active && tracker.lastFix) {
      var pos = { lat: tracker.lastFix.lat, lng: tracker.lastFix.lng };
      if (!gOv.me) {
        gOv.me = new g.maps.Marker({
          zIndex: 30, title: 'You',
          icon: { path: g.maps.SymbolPath.CIRCLE, scale: 8, fillColor: '#2563eb', fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 }
        });
      }
      gOv.me.setPosition(pos);
      gOv.me.setMap(state.map);
      if (followMe) {
        if (state.map.getZoom() < 15) state.map.setZoom(16);
        state.map.panTo(pos);
      }
    } else if (gOv.me) gOv.me.setMap(null);
  }

  /* ---------------- Leaflet fallback ---------------- */
  var leafletPromise = null;
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve(window.L);
    if (leafletPromise) return leafletPromise;
    leafletPromise = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = cfg.leafletCss || 'vendor/leaflet/leaflet.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = cfg.leafletJs || 'vendor/leaflet/leaflet.js';
      s.async = true;
      s.onload = function () { if (window.L && window.L.map) resolve(window.L); else reject(new Error('Leaflet missing')); };
      s.onerror = function () { leafletPromise = null; reject(new Error('Leaflet failed to load')); };
      document.head.appendChild(s);
    });
    return leafletPromise;
  }

  function renderLeafletMap() {
    if (gmaps.status === 'ready') return;          /* Google is up — it wins */
    loadLeaflet().then(function (L) {
      if (gmaps.status === 'ready') return;
      state.mapLib = 'leaflet';
      els.googleMap.style.display = 'none';
      els.leafletMap.style.display = 'block';
      if (!lmap.map) {
        lmap.map = L.map(els.leafletMap, { scrollWheelZoom: false, zoomControl: true, attributionControl: true });
        var voyager = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
          subdomains: 'abcd', maxZoom: 20,
          attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>'
        });
        var topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
          subdomains: 'abc', maxZoom: 17,
          attribution: '© OpenStreetMap contributors, SRTM · style © <a href="https://opentopomap.org" target="_blank" rel="noopener">OpenTopoMap</a> (CC-BY-SA)'
        });
        voyager.addTo(lmap.map);
        L.control.layers({ 'Map': voyager, 'Terrain': topo }, null, { position: 'topright' }).addTo(lmap.map);
        lmap.group = L.layerGroup().addTo(lmap.map);
        lmap.map.on('dragstart', function () { if (tracker.active) followMe = false; });
        lmap.map.setView([state.location.lat, state.location.lon], 12);
      }
      lmap.group.clearLayers();
      L.circleMarker([state.location.lat, state.location.lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#f59e0b', fillOpacity: 1 })
        .bindTooltip(state.location.label).addTo(lmap.group);
      var pts = [[state.location.lat, state.location.lon]];
      pinTrails().forEach(function (t, i) {
        var mk = L.marker([t.lat, t.lon], {
          title: t.name,
          icon: L.divIcon({ className: 'lf-pin', html: state.mode === 'bike' ? '🚴' : '🥾', iconSize: [26, 26], iconAnchor: [13, 13] })
        }).addTo(lmap.group);
        mk.on('click', function () { openDetails(t); });
        if (i < 25) pts.push([t.lat, t.lon]);
      });
      var key = areaKey();
      if (key !== fittedKey && !tracker.active) {
        fittedKey = key;
        if (pts.length > 1) lmap.map.fitBounds(pts, { padding: [28, 28], maxZoom: 14 });
        else lmap.map.setView(pts[0], 12);
      }
      lmap.map.invalidateSize();
      drawLeafletOverlays();
      setMapCaption(mapCaptionText('leaflet'));
    }).catch(function () {
      setMapCaption('The map couldn’t load (offline?). Trails are still listed above.');
    });
  }

  function drawLeafletOverlays() {
    var L = window.L;
    if (!L || !lmap.map) return;
    if (loopPath && loopPath.length > 1) {
      var ll = loopPath.map(function (p) { return [p.lat, p.lng]; });
      if (!lOv.loop) lOv.loop = L.polyline(ll, { color: '#7c3aed', weight: 5, opacity: .85 }).addTo(lmap.map);
      else lOv.loop.setLatLngs(ll).addTo(lmap.map);
    } else if (lOv.loop) lOv.loop.remove();
    if (tracker.path.length > 1) {
      var tl = tracker.path.map(function (p) { return [p.lat, p.lng]; });
      if (!lOv.track) lOv.track = L.polyline(tl, { color: '#16a34a', weight: 6, opacity: .95 }).addTo(lmap.map);
      else lOv.track.setLatLngs(tl).addTo(lmap.map);
    } else if (lOv.track) lOv.track.remove();
    if (tracker.active && tracker.lastFix) {
      var me = [tracker.lastFix.lat, tracker.lastFix.lng];
      if (!lOv.me) lOv.me = L.circleMarker(me, { radius: 8, color: '#fff', weight: 3, fillColor: '#2563eb', fillOpacity: 1 }).addTo(lmap.map);
      else lOv.me.setLatLng(me).addTo(lmap.map);
      if (followMe) lmap.map.setView(me, Math.max(lmap.map.getZoom(), 16));
    } else if (lOv.me) lOv.me.remove();
  }

  /* live track / loop changed → redraw just the overlays */
  function refreshMapOverlays() {
    try {   /* a map hiccup must never break tracking or the assistant */
      if (state.mapLib === 'google') drawGoogleOverlays();
      else if (state.mapLib === 'leaflet') drawLeafletOverlays();
      if (state.mapLib) setMapCaption(mapCaptionText(state.mapLib));
    } catch (e) { if (window.console && console.warn) console.warn('map overlay update failed', e); }
  }

  function refreshMapSize() {
    setTimeout(function () {
      try {
        if (state.mapLib === 'google' && state.map && window.google) window.google.maps.event.trigger(state.map, 'resize');
        if (state.mapLib === 'leaflet' && lmap.map) lmap.map.invalidateSize();
      } catch (e) { }
      refreshMapOverlays();
    }, 60);
  }

  function showLoopOnMap(path) {
    loopPath = path && path.length > 1 ? path : null;
    refreshMapOverlays();
    if (!loopPath) return;
    if (state.mapLib === 'google' && state.map && window.google) {
      var b = new window.google.maps.LatLngBounds();
      loopPath.forEach(function (p) { b.extend(p); });
      state.map.fitBounds(b, 30);
    } else if (state.mapLib === 'leaflet' && lmap.map) {
      lmap.map.fitBounds(loopPath.map(function (p) { return [p.lat, p.lng]; }), { padding: [24, 24] });
    }
  }

  /* polyline6 (TrailSplits routes) → [{lat,lng}] */
  function decodePolyline(str, precision) {
    var index = 0, lat = 0, lng = 0, out = [], factor = Math.pow(10, precision || 6);
    while (str && index < str.length) {
      var b, shift = 0, result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index < str.length);
      lat += (result & 1) ? ~(result >> 1) : (result >> 1);
      shift = 0; result = 0;
      do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && index < str.length);
      lng += (result & 1) ? ~(result >> 1) : (result >> 1);
      out.push({ lat: lat / factor, lng: lng / factor });
    }
    return out;
  }

  /* ============================================================
     LIVE TRACKER — records REAL movement only.

     “Phantom distance” (phone on a desk logging 0.2 mi) is GPS jitter:
     indoors a stationary phone’s fixes wander 10–30 m while reporting
     ±15–20 m accuracy. These gates kill it:
       1. accuracy gate   — fixes worse than ±20 m are ignored
       2. smoothing       — movement is measured on the accuracy-weighted
                            average of the last 5 fixes (random jitter
                            cancels out; real walking barely changes)
       3. jitter circle   — while you stand still the app keeps averaging
                            “where you are”; you must leave that spot by
                            more than the combined GPS uncertainty
                            (√(a1²+a2²)·1.2, at least 10 m / 15 m)
       4. still sensor    — if the phone itself reports ~0 speed, the
                            move must be twice that big
       5. confirmation    — two consecutive readings must agree you left
                            and keep moving away (a random jump never counts)
       6. spike filter    — a jump faster than 6 m/s hiking / 18 m/s biking
                            is a GPS glitch and is discarded
       7. auto-pause      — 45 s without counted movement pauses the clock
     Your own Pause is a real pause: walking while paused adds nothing.
     Tracking runs ONLY after you tap “Track hike” — never in the background.
     ============================================================ */
  var MIN_MOVE = { hike: 10, bike: 15 };     /* metres — floor of the jitter circle */
  var MAX_SPEED = { hike: 6, bike: 18 };     /* m/s */
  var ACCURACY_MAX = 20;                     /* metres */
  var STATIONARY_MS = 45000;
  var USE_MILES = /-(US|LR|MM)$/i.test(navigator.language || '');

  var tracker = {
    active: false, userPaused: false, autoPaused: false, watchId: null,
    path: [],                    /* counted points {lat, lng, t} */
    distance: 0, elapsedMs: 0,
    lastCounted: null,           /* distance is summed from here */
    anchor: null,                /* averaged “where you stand” for the movement test */
    jumps: 0,
    candidate: null,             /* first reading outside the jitter circle, awaiting confirmation */
    recent: [],                  /* last good fixes, for smoothing */
    lastFix: null,               /* latest usable fix (map “you” dot) */
    lastMoveAt: 0, timer: null, rejected: 0
  };

  var trackEls = {
    btn: qs('#trackBtn'), panel: qs('#trackPanel'), btnLabel: qs('#trackBtnLabel'),
    dist: qs('#trackDist'), time: qs('#trackTime'), speed: qs('#trackSpeed'),
    gps: qs('#trackGps'), note: qs('#trackNote'),
    pause: qs('#trackPause'), stop: qs('#trackStop'), center: qs('#trackCenter')
  };

  function trackNote(msg) { if (trackEls.note) trackEls.note.textContent = msg; }

  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(sec).padStart(2, '0');
  }

  function fmtTrackDist(m) {
    if (USE_MILES) { var mi = m / 1609.344; return (mi < 10 ? mi.toFixed(2) : mi.toFixed(1)) + ' mi'; }
    var km = m / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' km';
  }

  function renderTrackStats() {
    if (!trackEls.dist) return;
    trackEls.dist.textContent = fmtTrackDist(tracker.distance);
    trackEls.time.textContent = fmtClock(tracker.elapsedMs);
    var hrs = tracker.elapsedMs / 3600000;
    var v = hrs > 0 ? (tracker.distance / (USE_MILES ? 1609.344 : 1000)) / hrs : 0;
    trackEls.speed.textContent = v.toFixed(1) + (USE_MILES ? ' mph' : ' km/h');
  }

  function setPauseLabel() {
    if (trackEls.pause) trackEls.pause.textContent = tracker.userPaused ? 'Resume' : 'Pause';
  }

  function trackerTimerTick() {
    if (!tracker.active || tracker.userPaused) return;
    if (!tracker.autoPaused && tracker.lastMoveAt && Date.now() - tracker.lastMoveAt > STATIONARY_MS) {
      tracker.autoPaused = true;
      trackNote('You seem to be standing still — the clock is paused. It resumes by itself when you really move.');
    }
    if (!tracker.autoPaused) {
      tracker.elapsedMs += 1000;
      renderTrackStats();
    }
  }

  /* accuracy-weighted average of the recent fixes (weights 1/acc²) */
  function smoothedFix() {
    var r = tracker.recent, sw = 0, la = 0, ln = 0, accSum = 0;
    for (var i = 0; i < r.length; i++) {
      var w = 1 / Math.max(1, r[i].acc * r[i].acc);
      sw += w; la += r[i].lat * w; ln += r[i].lng * w; accSum += r[i].acc;
    }
    var last = r[r.length - 1];
    return { lat: la / sw, lng: ln / sw, acc: accSum / r.length, t: last.t };
  }

  /* “where you are standing” — keeps averaging while you don’t move, so it
     settles on your true position and desk jitter can’t escape it */
  function newAnchor(p) {
    var w = 1 / Math.max(1, p.acc * p.acc);
    return { lat: p.lat, lng: p.lng, acc: p.acc, sw: w, sla: p.lat * w, sln: p.lng * w, accSum: p.acc, n: 1 };
  }
  function refineAnchor(a, p) {
    var w = 1 / Math.max(1, p.acc * p.acc);
    if (a.n >= 60) { var k = 59 / 60; a.sw *= k; a.sla *= k; a.sln *= k; a.accSum *= k; a.n = 59; }
    a.sw += w; a.sla += p.lat * w; a.sln += p.lng * w; a.accSum += p.acc; a.n++;
    a.lat = a.sla / a.sw; a.lng = a.sln / a.sw; a.acc = a.accSum / a.n;
  }

  function onTrackPosition(pos) {
    var c = pos.coords;
    if (trackEls.gps) trackEls.gps.textContent = '±' + Math.round(c.accuracy) + ' m';
    if (!tracker.active) return;
    var fix = { lat: c.latitude, lng: c.longitude, t: pos.timestamp || Date.now(), acc: c.accuracy };

    /* gate 1: accuracy */
    if (c.accuracy > ACCURACY_MAX) {
      tracker.rejected++;
      tracker.candidate = null;
      trackNote('Weak GPS (±' + Math.round(c.accuracy) + ' m) — not counting distance until the signal improves. Outdoors works best.');
      return;
    }

    /* gate 6: GPS spikes — an impossible jump from the previous fix is dropped;
       three in a row means you really moved (lift, car): re-lock, add nothing */
    var prev = tracker.recent[tracker.recent.length - 1];
    if (prev) {
      var rd = C.haversineM(prev.lat, prev.lng, fix.lat, fix.lng);
      var rdt = Math.max(0.5, (fix.t - prev.t) / 1000);
      if (rd / rdt > MAX_SPEED[state.mode] && rd > 2 * (prev.acc + fix.acc)) {
        tracker.jumps = (tracker.jumps || 0) + 1;
        if (tracker.jumps < 3) {
          tracker.rejected++;
          trackNote('Skipped a jumpy GPS point — it would have added fake distance.');
          return;
        }
        tracker.recent = []; tracker.lastCounted = null; tracker.anchor = null; tracker.candidate = null;
        trackNote('Big position change — re-locking your position (no distance added).');
      }
    }
    tracker.jumps = 0;
    tracker.lastFix = fix;

    /* gate 2: smoothing */
    tracker.recent.push(fix);
    if (tracker.recent.length > 5) tracker.recent.shift();
    var here = smoothedFix();

    /* start point once a few fixes agree — no distance yet */
    if (!tracker.lastCounted) {
      if (tracker.recent.length < 3) { trackNote('Locking your start point…'); refreshMapOverlays(); return; }
      tracker.lastCounted = here;
      tracker.anchor = newAnchor(here);
      tracker.path.push(here);
      tracker.lastMoveAt = Date.now();
      trackNote('Start point locked. Walk or ride — only real movement is counted.');
      refreshMapOverlays();
      return;
    }

    /* gate 3 + 4: still inside the jitter circle around where you stand? */
    var a = tracker.anchor;
    var d = C.haversineM(a.lat, a.lng, here.lat, here.lng);
    var need = Math.max(MIN_MOVE[state.mode] || 10, Math.sqrt(a.acc * a.acc + here.acc * here.acc) * 1.2);
    var phoneSaysStill = typeof c.speed === 'number' && isFinite(c.speed) && c.speed >= 0 && c.speed < 0.3;
    if (d < need || (phoneSaysStill && d < need * 2)) {
      refineAnchor(a, here);
      tracker.candidate = null;
      refreshMapOverlays();
      return;
    }

    /* gate 5: a second reading must confirm, and keep moving away */
    var dc = C.haversineM(tracker.lastCounted.lat, tracker.lastCounted.lng, here.lat, here.lng);
    if (!tracker.candidate || dc <= tracker.candidate.dc) { here.dc = dc; tracker.candidate = here; return; }
    tracker.candidate = null;

    if (tracker.userPaused) {         /* paused by you: move on, add nothing */
      tracker.lastCounted = here;
      tracker.anchor = newAnchor(here);
      return;
    }

    tracker.distance += dc;           /* counted from the last counted point — nothing lost */
    tracker.path.push(here);
    tracker.lastCounted = here;
    tracker.anchor = newAnchor(here);
    tracker.lastMoveAt = Date.now();
    if (tracker.autoPaused) {
      tracker.autoPaused = false;
      trackNote('Moving again — tracking.');
    }
    renderTrackStats();
    refreshMapOverlays();
  }

  /* On Pause / Finish: count the last stretch you walked since the previous
     counted point, if it clearly exceeds the GPS uncertainty. */
  function commitPending() {
    if (!tracker.lastCounted || !tracker.recent.length || tracker.userPaused) return;
    var here = smoothedFix(), a = tracker.anchor || here;
    var need = Math.max(MIN_MOVE[state.mode] || 10, Math.sqrt(a.acc * a.acc + here.acc * here.acc) * 1.2);
    var dc = C.haversineM(tracker.lastCounted.lat, tracker.lastCounted.lng, here.lat, here.lng);
    if (dc > need) {
      tracker.distance += dc;
      tracker.path.push(here);
      tracker.lastCounted = here;
      tracker.anchor = newAnchor(here);
    }
  }

  function onTrackError(err) {
    if (err.code === 1) { /* PERMISSION_DENIED */
      stopTracking(false);
      C.toast('Location permission denied — allow location to track your hike.');
    } else if (err.code === 2) { /* POSITION_UNAVAILABLE — usually: device location is OFF */
      stopTracking(false);
      C.toast('Your device’s location is turned off — turn it on to track.', 4500);
      C.promptEnableLocation(function () { startTracking(); });
    } /* code 3 (timeout) — keep watching, the next fix may come */
  }

  /* phones: while tracking, dock the map right under the tracker panel */
  var mapPanel = qs('.map-panel'), mapHome = null;
  function dockMapForTracking(on) {
    if (!mapPanel || !trackEls.panel) return;
    var narrow = !window.matchMedia || window.matchMedia('(max-width: 979px)').matches;
    if (on && narrow && !mapHome) {
      mapHome = document.createComment('map-home');
      mapPanel.parentNode.insertBefore(mapHome, mapPanel);
      trackEls.panel.parentNode.insertBefore(mapPanel, trackEls.panel.nextSibling);
      mapPanel.classList.add('is-docked');
    } else if (!on && mapHome) {
      mapHome.parentNode.insertBefore(mapPanel, mapHome);
      mapHome.parentNode.removeChild(mapHome);
      mapHome = null;
      mapPanel.classList.remove('is-docked');
    }
    refreshMapSize();
  }

  function startTracking() {
    if (!navigator.geolocation) { C.toast('This browser can’t geolocate'); return; }
    tracker.active = true;
    tracker.userPaused = false;
    tracker.autoPaused = false;
    tracker.path = [];
    tracker.distance = 0;
    tracker.elapsedMs = 0;
    tracker.anchor = null;
    tracker.lastCounted = null;
    tracker.candidate = null;
    tracker.recent = [];
    tracker.jumps = 0;
    tracker.lastFix = null;
    tracker.lastMoveAt = Date.now();
    tracker.rejected = 0;
    followMe = true;
    trackEls.panel.hidden = false;
    trackEls.btn.setAttribute('aria-pressed', 'true');
    trackEls.btn.classList.add('is-on');
    if (trackEls.btnLabel) trackEls.btnLabel.textContent = 'Stop tracking';
    setPauseLabel();
    trackNote('Waiting for GPS… Go outside for the best signal.');
    renderTrackStats();
    dockMapForTracking(true);
    renderMap();
    tracker.watchId = navigator.geolocation.watchPosition(onTrackPosition, onTrackError, {
      enableHighAccuracy: true, timeout: 30000, maximumAge: 0
    });
    if (!tracker.timer) tracker.timer = setInterval(trackerTimerTick, 1000);
    C.toast('Tracking started — distance only counts when you actually move.');
  }

  function stopTracking(save) {
    if (tracker.watchId != null && navigator.geolocation) {
      navigator.geolocation.clearWatch(tracker.watchId);
      tracker.watchId = null;
    }
    var wasActive = tracker.active;
    if (save && wasActive) commitPending();
    tracker.active = false;
    if (tracker.timer) { clearInterval(tracker.timer); tracker.timer = null; }
    trackEls.panel.hidden = true;
    trackEls.btn.setAttribute('aria-pressed', 'false');
    trackEls.btn.classList.remove('is-on');
    if (trackEls.btnLabel) trackEls.btnLabel.textContent = state.mode === 'bike' ? 'Track ride' : 'Track hike';
    dockMapForTracking(false);
    if (save && wasActive) {
      var km = tracker.distance / 1000;
      var summary = fmtTrackDist(tracker.distance) + ' in ' + fmtClock(tracker.elapsedMs);
      try {
        var logs = JSON.parse(localStorage.getItem('calledit_tracks_v1') || '[]');
        logs.unshift({ km: Math.round(km * 1000) / 1000, ms: tracker.elapsedMs, at: Date.now(), mode: state.mode });
        localStorage.setItem('calledit_tracks_v1', JSON.stringify(logs.slice(0, 50)));
      } catch (e) { }
      C.toast((state.mode === 'bike' ? 'Ride' : 'Hike') + ' saved: ' + summary + ' 🎉');
    }
    refreshMapOverlays();
  }

  if (trackEls.btn) trackEls.btn.addEventListener('click', function () {
    if (tracker.active) stopTracking(true); else startTracking();
  });
  if (trackEls.pause) trackEls.pause.addEventListener('click', function () {
    if (!tracker.active) return;
    if (!tracker.userPaused) commitPending();
    tracker.userPaused = !tracker.userPaused;
    tracker.candidate = null;
    if (tracker.userPaused) {
      trackNote('Paused — nothing is added while paused, even if you walk.');
    } else {
      if (tracker.recent.length) {                 /* don’t count the paused stretch */
        tracker.lastCounted = smoothedFix();
        tracker.anchor = newAnchor(tracker.lastCounted);
      }
      tracker.autoPaused = false;
      tracker.lastMoveAt = Date.now();
      trackNote('Tracking again.');
    }
    setPauseLabel();
    renderTrackStats();
  });
  if (trackEls.stop) trackEls.stop.addEventListener('click', function () { stopTracking(true); });
  if (trackEls.center) trackEls.center.addEventListener('click', function () {
    followMe = true;
    refreshMapOverlays();
    if (!tracker.lastFix) C.toast('Waiting for your first GPS fix…');
  });

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
      var href = p.gmapsUri || ('https://www.google.com/maps/search/?api=1&query=' + p.lat + ',' + p.lon);
      return '<a class="hl-card" href="' + esc(href) + '" target="_blank" rel="noopener">' +
        '<div class="hl-media" data-hl="' + i + '"></div>' +
        '<div class="hl-body">' +
        '<div class="hl-name">' + esc(p.name) + '</div>' +
        '<div class="hl-rating">★ ' + p.rating.toFixed(1) + ' · ' + p.count.toLocaleString() + ' reviews</div>' +
        '</div></a>';
    }).join('');
    qsa('.hl-media', els.highlightsRow).forEach(function (box) {
      var p = places[+box.dataset.hl];
      if (p.photo) setPhoto(box, p.photo, p.photoBy ? p.photoBy + ' · Google' : 'Google', null, function () { setMapThumb(box, p); });
      else setMapThumb(box, p);
    });
  }

  /* ============================================================
     Rendering — trail list
     ============================================================ */
  function networkLabel(n) {
    return { iwn: 'International', nwn: 'National', rwn: 'Regional', lwn: 'Local' }[n] || null;
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
        '<p style="margin-top:8px">Try a bigger nearby town, search another place above, or ask the assistant to plan a loop.</p></div>';
      return;
    }
    els.trailList.innerHTML = list.map(function (t) {
      var km = t.distanceM != null ? C.fmtBoth(t.distanceM) : (t.multiStage ? 'Multi-stage route' : 'length unlisted');
      var mins = estimateMinutes(t);
      var chips = [];
      var net = networkLabel(t.network);
      if (net) chips.push('<span class="chip chip--grey">' + net + '</span>');
      if (t.ref) chips.push('<span class="chip chip--grey">Ref ' + esc(t.ref) + '</span>');
      if (t.ascentM) chips.push('<span class="chip chip--grey" title="Total climb">↑ ' + Math.round(t.ascentM) + ' m</span>');
      var rating = '';
      if (t.google && t.google.rating != null) {
        rating = '<span class="trail-card__rating"><span class="stars" aria-label="' + t.google.rating + ' out of 5 stars">' + C.stars(t.google.rating) + '</span>' +
          t.google.rating.toFixed(1) + ' (' + t.google.count.toLocaleString() + ')' +
          '<span class="g-src">· Google</span></span>';
      }
      var dir = C.directionsLinks(t.lat, t.lon)[0];
      return '<article class="trail-card" data-id="' + esc(t.id) + '">' +
        '<div class="trail-card__media trail-media" data-trail="' + esc(t.id) + '" role="button" tabindex="-1" aria-label="Details for ' + esc(t.name) + '">' +
        '<span class="photo-skeleton"></span></div>' +
        '<div class="trail-card__body">' +
        '<h3 class="trail-card__name">' + esc(t.name) + '</h3>' +
        '<div class="trail-card__meta"><span>' + esc(km) + (mins ? ' · ' + C.fmtDuration(mins) : '') + '</span>' + chips.join('') + '</div>' +
        rating +
        '<div class="trail-card__actions">' +
        '<button class="btn btn-sm btn-soft" type="button" data-details="' + esc(t.id) + '">Details</button>' +
        '<a class="btn btn-sm btn-primary" href="' + esc(dir.href) + '" target="_blank" rel="noopener">Directions</a>' +
        '</div>' +
        '</div></article>';
    }).join('');

    qsa('[data-details]', els.trailList).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var t = trailById(btn.dataset.details);
        if (t) openDetails(t);
      });
    });
    qsa('.trail-card__media', els.trailList).forEach(function (box) {
      box.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('.photo-credit')) return;   /* credit links open the source */
        var t = trailById(box.dataset.trail);
        if (t) openDetails(t);
      });
    });
    observeMedia(els.trailList);
  }

  /* Hiking time: DIN 33466 (the Swiss/German trail-sign formula) when the
     climb is known — 4.2 km/h on the flat, 300 m/h up, 500 m/h down;
     biking: ~15 km/h plus 6 min per 100 m of climb. */
  function estimateMinutes(t) {
    if (t.distanceM == null) return null;
    var km = t.distanceM / 1000;
    if (state.mode === 'bike') return km / 15 * 60 + (t.ascentM ? t.ascentM / 100 * 6 : 0);
    var horiz = km / 4.2;
    if (t.ascentM == null && t.descentM == null) return horiz * 60;
    var vert = (t.ascentM || 0) / 300 + (t.descentM || 0) / 500;
    return (Math.max(horiz, vert) + Math.min(horiz, vert) / 2) * 60;
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
  /* A newer request (Near me, a search, the hike/bike switch, the assistant)
     that arrives while an area is still loading used to be dropped silently
     — e.g. tapping “Near me” right after opening the page did nothing. Now
     the latest one waits and runs as soon as the current load finishes. */
  var pendingArea = null;
  function loadArea(lat, lon, label, guessed) {
    if (state.loading) {
      return new Promise(function (resolve) {
        if (pendingArea) pendingArea.resolve();            /* superseded by this one */
        pendingArea = { args: [lat, lon, label, guessed], resolve: resolve };
        els.statusLine.textContent = 'Loading ' + (label || 'that area') + ' next…';
      });
    }
    state.loading = true;
    usedPhotoIds = {};
    state.location = { lat: lat, lon: lon, label: label, guessed: !!guessed };
    els.trailList.innerHTML = '<div class="loading-state"><p class="loading-dots">Finding ' + (state.mode === 'bike' ? 'biking routes' : 'hiking trails') + '</p></div>';
    renderStatus();

    var trailsP = fetchTrailsCombined(lat, lon, state.mode)
      .then(function (trails) { state.trails = trails; })
      .catch(function () { state.trails = []; state.dataSource = '—'; });

    var placesP = google.placesNearby(lat, lon, state.mode, label)
      .then(function (places) { state.googlePlaces = places; })
      .catch(function () { state.googlePlaces = []; });

    var weatherP = getForecast(lat, lon, 5)
      .then(function (w) { state.weather = w; })
      .catch(function () { state.weather = null; });

    return Promise.all([trailsP, placesP, weatherP]).then(function () {
      state.loading = false;
      if (pendingArea) {                                    /* someone asked for another area meanwhile */
        var next = pendingArea;
        pendingArea = null;
        return loadArea.apply(null, next.args).then(next.resolve);
      }
      addGooglePlacesAsTrails();
      renderErrors(state.trails.length ? [] : ['No trails could be loaded here — the trail services may be unreachable, or nothing is mapped nearby. Try a bigger nearby town, or ask the assistant to plan a loop.']);
      renderAll();
    });
  }

  /* Signed route relations (TrailSplits/OSM) are rare in many US areas, so
     when only a few are found, Google’s “hiking area / park” results join
     the list as trails too — with their rating and photo. */
  function addGooglePlacesAsTrails() {
    if (state.trails.length >= 8 || !state.googlePlaces.length) return;
    attachGoogle();
    var used = {};
    state.trails.forEach(function (t) { if (t.google) used[t.google.id] = true; });
    var added = 0;
    state.googlePlaces.forEach(function (p) {
      if (used[p.id] || p.lat == null) return;
      state.trails.push({
        id: 'g-' + p.id, osmId: null, name: p.name, ref: null, network: null,
        routeType: state.mode === 'bike' ? 'bicycle' : 'hiking', distanceM: null,
        lat: p.lat, lon: p.lon, source: 'Google Maps', google: p
      });
      added++;
    });
    if (!added) return;
    state.dataSource = (state.dataSource === '—' || state.dataSource === '…') ? 'Google Maps' : state.dataSource + ' + Google Maps';
  }

  /* ============================================================
     Search + geolocation
     ============================================================ */
  function doSearch(q) {
    if (!q || q.trim().length < 2) { C.toast('Type a place name first'); return Promise.reject(new Error('empty search')); }
    els.statusLine.textContent = 'Looking up “' + q + '”…';
    return ts.geocode(q)
      .catch(function () { return osm.geocode(q); })
      .then(function (loc) {
        return loadArea(loc.lat, loc.lon, loc.label, false).then(function () { return loc; });
      }, function (err) {
        renderStatus();
        C.toast('Couldn’t find “' + q + '”. Try a nearby town or region.');
        throw err;
      });
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
      '<div class="modal-hero trail-media" data-trail="' + esc(t.id) + '"><span class="photo-skeleton"></span></div>' +
      '<h2 id="modalTitle">' + esc(t.name) + '</h2>' +
      '<div class="trail-card__meta">' +
      '<span class="chip">' + (t.routeType === 'bicycle' || t.routeType === 'mtb' ? '🚴 Biking route' : '🥾 Hiking trail') + '</span>' +
      (networkLabel(t.network) ? '<span class="chip chip--grey">' + networkLabel(t.network) + '</span>' : '') +
      (t.ref ? '<span class="chip chip--grey">Ref ' + esc(t.ref) + '</span>' : '') +
      '<span class="chip chip--grey">via ' + esc(t.source) + (t.osmId ? ' · OSM relation ' + t.osmId : '') + '</span>' +
      '</div>' +
      '<div class="fact-grid" id="factGrid">' +
      '<div class="fact"><div class="k">Length</div><div class="v">' + (t.distanceM != null ? C.fmtBoth(t.distanceM) : (t.multiStage ? 'multi-stage' : 'unlisted')) + '</div></div>' +
      '<div class="fact"><div class="k">Typical time</div><div class="v">' + C.fmtDuration(estimateMinutes(t)) + '</div></div>' +
      '<div class="fact"><div class="k">Climb</div><div class="v" id="factClimb">' +
        (t.ascentM != null ? '↑ ' + Math.round(t.ascentM) + ' m' + (t.descentM != null ? ' · ↓ ' + Math.round(t.descentM) + ' m' : '') : '…') + '</div></div>' +
      '</div>' +
      '<p>' + rating + '</p>' +
      (t.description ? '<p class="muted" style="font-size:.9rem">' + esc(t.description) + '</p>' : '') +
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
    fillTrailMedia(qs('.modal-hero', els.modalBody), t);
    /* Android back gesture / back button closes this modal (not the app) */
    C.pushOverlay('details', hideModalVisual);

    /* fetch richer detail from TrailSplits when we know the OSM relation */
    if (t.osmId) {
      ts.relation(t.osmId).then(function (rel) {
        var props = rel.properties || {};
        var climb = qs('#factClimb');
        if (climb && typeof props.ascent_m === 'number') {
          climb.textContent = '↑ ' + Math.round(props.ascent_m) + ' m' + (typeof props.descent_m === 'number' ? ' · ↓ ' + Math.round(props.descent_m) + ' m' : '');
        }
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
     TRAIL ASSISTANT (this page only) — Grok via Puter.js

     • Every typed question (and every suggestion chip) goes to Grok.
     • Grok can call real app tools (function calling): search the loaded
       trails, trail details, weather, loop planning + outdoor places
       (TrailSplits API), filter the list, switch area / activity, open a
       trail, and read your tracked hikes.
     • No API key: Puter’s user-pays model — the first question opens a
       one-time free Puter sign-in (a guest account is created for you).
     • If the AI is unreachable (offline, sign-in cancelled, allowance used
       up) you get an answer from the trail data plus a Retry button.
     ============================================================ */
  var sheet = qs('#assistantSheet'), fab = qs('#assistantFab'),
    log = qs('#assistantLog'), form = qs('#assistantForm'),
    input = qs('#assistantText'), suggest = qs('#assistantSuggest'),
    aiStatusEl = qs('#assistantStatus'), newChatBtn = qs('#assistantNew'),
    sendBtn = form ? form.querySelector('button[type="submit"]') : null;

  var SUGGESTIONS = ['Easiest trails here', 'Plan a 5 km loop near me', 'Weather this week?', 'Where can I park & get water?', 'Best trail for a sunset', 'What can you do?'];
  var MAX_TOOL_ROUNDS = 4;
  var ai = { history: [], busy: false, model: null };

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
    return div;
  }

  function userSay(text) {
    var div = document.createElement('div');
    div.className = 'msg msg--user';
    div.textContent = text;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function trailLine(t, withDist) {
    var s = '• <b>' + esc(t.name) + '</b> — ' + (t.distanceM != null ? C.fmtBoth(t.distanceM) : 'length unlisted');
    if (withDist) s += ', ' + C.fmtKm(C.haversineM(state.location.lat, state.location.lon, t.lat, t.lon)) + ' from center';
    if (t.google && t.google.rating != null) s += ' · ★ ' + t.google.rating.toFixed(1);
    return s;
  }

  /* Markdown-lite → safe HTML (bold, italics, code, links, bullet/numbered lists) */
  function formatReply(text) {
    function inline(s) {
      return esc(s)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/__(.+?)__/g, '<b>$1</b>')
        .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    }
    var out = [], listType = null;
    function closeList() { if (listType) { out.push('</' + listType + '>'); listType = null; } }
    String(text || '').replace(/\r/g, '').split('\n').forEach(function (line) {
      var t = line.trim();
      var bullet = t.match(/^[-*•]\s+(.*)$/), num = t.match(/^\d+[.)]\s+(.*)$/), head = t.match(/^#{1,6}\s+(.*)$/);
      if (bullet || num) {
        var want = bullet ? 'ul' : 'ol';
        if (listType !== want) { closeList(); out.push('<' + want + '>'); listType = want; }
        out.push('<li>' + inline((bullet || num)[1]) + '</li>');
        return;
      }
      closeList();
      if (!t) { out.push('<br>'); return; }
      if (head) { out.push('<b>' + inline(head[1]) + '</b><br>'); return; }
      out.push(inline(t) + '<br>');
    });
    closeList();
    return out.join('').replace(/(<br>){3,}/g, '<br><br>').replace(/^(<br>)+|(<br>)+$/g, '');
  }

  function typingIndicator(label) {
    var div = document.createElement('div');
    div.className = 'msg msg--bot msg--typing';
    div.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="typing-label"></span>';
    var lab = div.querySelector('.typing-label');
    div.setLabel = function (txt) { lab.textContent = txt || ''; log.scrollTop = log.scrollHeight; };
    div.setLabel(label);
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div;
  }

  function setComposerBusy(on) {
    if (sendBtn) { sendBtn.disabled = on; sendBtn.textContent = on ? '…' : 'Send'; }
  }

  /* ---------------- Puter.js (loaded only when the assistant is used) ---------------- */
  var puterPromise = null;
  function loadPuter() {
    if (window.puter && window.puter.ai && window.puter.auth) return Promise.resolve(window.puter);
    if (puterPromise) return puterPromise;
    puterPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = (cfg.ai && cfg.ai.puterJs) || 'https://js.puter.com/v2/';
      s.async = true;
      var timer = setTimeout(function () { fail(new Error('Puter.js took too long to load')); }, 25000);
      function fail(err) { clearTimeout(timer); puterPromise = null; reject(err); }
      s.onload = function () {
        clearTimeout(timer);
        if (window.puter && window.puter.ai && window.puter.auth) { resolve(window.puter); renderAiStatus(); }
        else fail(new Error('Puter.js loaded but isn’t usable'));
      };
      s.onerror = function () { fail(new Error('Couldn’t download Puter.js — are you offline?')); };
      document.head.appendChild(s);
    });
    return puterPromise;
  }

  function puterSignedIn() {
    var p = window.puter;
    try { return !!(p && p.auth && p.auth.isSignedIn()); } catch (e) { return false; }
  }

  function modelLabel(id) {
    var m = ((cfg.ai && cfg.ai.models) || []).filter(function (x) { return x.id === id; })[0];
    return m ? m.label.split(' — ')[0] : String(id || '').replace(/^x-ai\//, '');
  }

  function renderAiStatus() {
    if (!aiStatusEl) return;
    var model = ai.model || (cfg.ai && cfg.ai.model);
    aiStatusEl.textContent = modelLabel(model) + ' by xAI · via Puter' + (puterSignedIn() ? ' · connected' : ' · free, no key');
  }

  function modelChain() {
    var chosen = (cfg.ai && cfg.ai.model) || 'x-ai/grok-4-1-fast-non-reasoning';
    var list = [chosen].concat((cfg.ai && cfg.ai.fallbackModels) || []);
    return list.filter(function (m, i) { return m && list.indexOf(m) === i; });
  }

  function errText(err) {
    if (!err) return 'unknown error';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    if (err.error && typeof err.error === 'object' && err.error.message) return String(err.error.message);
    if (err.msg) return String(err.msg);
    if (typeof err.error === 'string') return err.error;
    try { return JSON.stringify(err).slice(0, 180); } catch (e) { return String(err); }
  }
  function errCode(err) {
    if (!err || typeof err !== 'object') return '';
    return String(err.code || (err.error && (err.error.code || (typeof err.error === 'string' ? err.error : ''))) || err.status || '');
  }
  function isAuthError(err) {
    return /auth_canceled|auth_window_closed|popup_blocked|unsupported_origin|reauth_required|token_auth_failed/i.test(errCode(err) + ' ' + errText(err));
  }
  function isQuotaError(err) {
    return /insufficient_funds|subscription_required|402|usage.?limit|allowance/i.test(errCode(err) + ' ' + errText(err));
  }

  /* one Grok call through Puter, walking the model fallback chain */
  function grokChat(messages, withTools) {
    var models = modelChain(), lastErr = null;
    function attempt(i) {
      if (i >= models.length) return Promise.reject(lastErr || new Error('No Grok model answered'));
      var opts = { model: models[i], normalize: true };   /* no temperature: some Grok reasoning models reject it */
      if (withTools) opts.tools = TOOL_DEFS;
      return Promise.resolve().then(function () { return window.puter.ai.chat(messages, opts); }).then(function (res) {
        if (!res || !res.message) throw new Error('Empty reply from Grok');
        ai.model = models[i];
        return res;
      }, function (err) {
        lastErr = err;
        if (isAuthError(err) || isQuotaError(err)) throw err;   /* another model won’t help */
        return attempt(i + 1);
      });
    }
    return attempt(0);
  }

  function textOf(content) {
    if (content == null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(function (p) { return typeof p === 'string' ? p : (p && (p.text || p.content)) || ''; }).join('');
    }
    if (typeof content === 'object' && content.text) return String(content.text);
    return String(content);
  }

  /* ---------------- tools Grok can call ---------------- */
  var TOOL_DEFS = [
    fn('search_trails', 'Search the trails/routes currently loaded in the app around the area the user is viewing. Use for questions about which trails exist, lengths, ratings, nearest, easiest, longest. Returns trail ids for the other tools.', {
      query: { type: 'string', description: 'Optional words that must appear in the trail name, e.g. "lake"' },
      min_km: { type: 'number', description: 'Minimum length in km' },
      max_km: { type: 'number', description: 'Maximum length in km' },
      min_rating: { type: 'number', description: 'Minimum Google rating (1-5)' },
      sort: { type: 'string', enum: ['nearest', 'shortest', 'longest', 'top_rated'] },
      limit: { type: 'integer', description: 'How many results (default 8, max 20)' }
    }),
    fn('get_trail_details', 'Full details for one loaded trail: length, climb/descent, estimated time, route endpoints, operator, description, Google rating, coordinates.', {
      trail_id: { type: 'string', description: 'id from search_trails or the trail list in the system message' }
    }, ['trail_id']),
    fn('get_weather', 'Daily weather forecast (up to 7 days) for the current area, a loaded trail, or any named place.', {
      trail_id: { type: 'string', description: 'Forecast at this trail’s start' },
      place: { type: 'string', description: 'Any place name, e.g. "Zion National Park"' },
      days: { type: 'integer', description: '1-7, default 5' }
    }),
    fn('plan_loop_route', 'Plan a real round-trip loop (starts and ends at the same point) on mapped paths with the TrailSplits router, and draw it on the app map. Works anywhere, including places with few official trails.', {
      distance_km: { type: 'number', description: 'Target loop length in km (0.5-40 on foot, up to 60 by bike)' },
      start: { type: 'string', description: '"my_location" (user GPS), "area_center" (default), or a trail_id to start at that trail' },
      profile: { type: 'string', enum: ['hike', 'run', 'bike'] },
      max_difficulty: { type: 'integer', description: 'Hiking only: hardest SAC grade allowed, 1 (easy) to 6 (alpine). Default 3.' }
    }, ['distance_km']),
    fn('find_places_nearby', 'Find mapped parking, drinking water, toilets, shelters/huts, viewpoints, peaks or bus stops near a trail or the area centre (OpenStreetMap data via TrailSplits).', {
      kinds: { type: 'array', items: { type: 'string', enum: ['parking', 'water', 'toilets', 'shelter', 'hut', 'viewpoint', 'peak', 'bus_stop', 'spring'] }, description: 'What to look for' },
      trail_id: { type: 'string', description: 'Search around this trail’s start (otherwise the area centre)' },
      radius_km: { type: 'number', description: 'Search radius, default 2, max 10' }
    }, ['kinds']),
    fn('update_trail_list', 'Filter/sort the trail list the user sees on screen (also updates the map pins).', {
      sort: { type: 'string', enum: ['nearest', 'shortest', 'longest', 'top_rated'] },
      max_km: { type: 'number', description: 'Only trails up to this length (km); 0 removes the limit' },
      min_rating: { type: 'number', description: 'Only trails with at least this Google rating; 0 removes it' },
      easy_only: { type: 'boolean', description: 'Only short/easy routes' },
      clear: { type: 'boolean', description: 'Remove all filters first' }
    }),
    fn('change_area', 'Move the app to another place (or to the user’s GPS position) and load its trails. Use when the user asks about trails somewhere else.', {
      place: { type: 'string', description: 'Place name, e.g. "Boulder, Colorado"' },
      use_my_location: { type: 'boolean', description: 'Use the device GPS position instead of a place name' }
    }),
    fn('set_activity', 'Switch the app between hiking trails and biking routes (reloads the list).', {
      mode: { type: 'string', enum: ['hike', 'bike'] }
    }, ['mode']),
    fn('open_trail', 'Open a trail’s details sheet on screen (photos, elevation profile, directions buttons).', {
      trail_id: { type: 'string' }
    }, ['trail_id']),
    fn('get_my_activity', 'The user’s own saved hikes/rides tracked in this app (distance, time, dates) and litter-pickup points.', {})
  ];

  function fn(name, description, props, required) {
    return {
      type: 'function',
      function: { name: name, description: description, parameters: { type: 'object', properties: props || {}, required: required || [] } }
    };
  }

  var TOOL_LABELS = {
    search_trails: 'Searching the trails…', get_trail_details: 'Reading trail details…', get_weather: 'Checking the forecast…',
    plan_loop_route: 'Planning a loop with TrailSplits…', find_places_nearby: 'Looking for parking, water & more…',
    update_trail_list: 'Updating your list…', change_area: 'Loading trails there…', set_activity: 'Switching activity…',
    open_trail: 'Opening the trail…', get_my_activity: 'Reading your tracked hikes…'
  };

  function round1(n) { return n == null || isNaN(n) ? null : Math.round(n * 10) / 10; }
  function kmMi(m) { return m == null ? null : { km: round1(m / 1000), mi: round1(m / 1609.344) }; }
  function findTrail(id) {
    if (!id) return null;
    var key = String(id).trim();
    var t = state.trails.filter(function (x) { return x.id === key || String(x.osmId) === key; })[0];
    if (!t) {
      var low = key.toLowerCase();
      t = state.trails.filter(function (x) { return x.name.toLowerCase() === low; })[0] ||
        state.trails.filter(function (x) { return x.name.toLowerCase().indexOf(low) !== -1; })[0];
    }
    return t || null;
  }
  function trailBrief(t) {
    var o = {
      id: t.id, name: t.name,
      type: t.routeType === 'bicycle' || t.routeType === 'mtb' ? 'biking' : 'hiking',
      length: kmMi(t.distanceM),
      est_time_min: estimateMinutes(t) != null ? Math.round(estimateMinutes(t)) : null,
      from_area_center_km: round1(C.haversineM(state.location.lat, state.location.lon, t.lat, t.lon) / 1000)
    };
    if (t.google && t.google.rating != null) { o.google_rating = t.google.rating; o.google_reviews = t.google.count; }
    if (t.ascentM != null) o.climb_up_m = Math.round(t.ascentM);
    if (t.descentM != null) o.climb_down_m = Math.round(t.descentM);
    if (t.network) o.network = networkLabel(t.network) || t.network;
    if (t.ref) o.ref = t.ref;
    o.source = t.source;
    return o;
  }
  function withTimeout(p, ms, label) {
    return new Promise(function (resolve, reject) {
      var done = false;
      var tm = setTimeout(function () { if (!done) { done = true; reject(new Error((label || 'request') + ' timed out')); } }, ms);
      p.then(function (v) { if (!done) { done = true; clearTimeout(tm); resolve(v); } },
        function (e) { if (!done) { done = true; clearTimeout(tm); reject(e); } });
    });
  }
  function waitForIdle() {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() { if (!state.loading || Date.now() - start > 40000) resolve(); else setTimeout(poll, 250); })();
    });
  }
  function areaSummary(extra) {
    var o = {
      area: state.location.label, lat: round1(state.location.lat * 1000) / 1000, lon: round1(state.location.lon * 1000) / 1000,
      activity: state.mode === 'bike' ? 'biking' : 'hiking',
      trails_loaded: state.trails.length, data_source: state.dataSource,
      top_trails: filteredTrails().slice(0, 8).map(trailBrief)
    };
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }
  function locateOnce() {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) { reject(new Error('This device can’t geolocate')); return; }
      navigator.geolocation.getCurrentPosition(function (pos) {
        resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy });
      }, function (err) {
        if (err && err.code === 2) C.promptEnableLocation(null);
        reject(new Error(err && err.code === 1 ? 'location permission denied' : err && err.code === 2 ? 'device location is turned off' : 'GPS timeout'));
      }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 120000 });
    });
  }
  function weatherDays(w, n) {
    var days = (w && w.points && w.points[0] && w.points[0].days) || [];
    return days.slice(0, n || 5).map(function (d) {
      var info = wmoInfo(d.weather_code);
      var c2f = function (c) { return c == null ? null : Math.round(c * 9 / 5 + 32); };
      return {
        date: d.date,
        weekday: new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }),
        conditions: info.label,
        high_c: d.temp_max_c != null ? Math.round(d.temp_max_c) : null, low_c: d.temp_min_c != null ? Math.round(d.temp_min_c) : null,
        high_f: c2f(d.temp_max_c), low_f: c2f(d.temp_min_c),
        rain_chance_pct: d.precip_probability_max_pct != null ? d.precip_probability_max_pct : null,
        precip_mm: d.precip_mm != null ? round1(d.precip_mm) : null,
        wind_max_kmh: d.wind_max_kmh != null ? Math.round(d.wind_max_kmh) : null,
        gusts_kmh: d.gust_max_kmh != null ? Math.round(d.gust_max_kmh) : null
      };
    });
  }

  var TOOLS = {
    search_trails: function (a) {
      var list = state.trails.slice();
      if (a.query) {
        var words = String(a.query).toLowerCase().split(/\s+/).filter(Boolean);
        list = list.filter(function (t) { var n = t.name.toLowerCase(); return words.every(function (w) { return n.indexOf(w) !== -1; }); });
      }
      if (a.min_km != null) list = list.filter(function (t) { return t.distanceM != null && t.distanceM >= a.min_km * 1000; });
      if (a.max_km != null && a.max_km > 0) list = list.filter(function (t) { return t.distanceM != null && t.distanceM <= a.max_km * 1000; });
      if (a.min_rating) list = list.filter(function (t) { return t.google && t.google.rating != null && t.google.rating >= a.min_rating; });
      var dist = function (t) { return C.haversineM(state.location.lat, state.location.lon, t.lat, t.lon); };
      if (a.sort === 'shortest') list.sort(function (x, y) { return (x.distanceM || 9e9) - (y.distanceM || 9e9); });
      else if (a.sort === 'longest') list.sort(function (x, y) { return (y.distanceM || 0) - (x.distanceM || 0); });
      else if (a.sort === 'top_rated') list.sort(function (x, y) { return ((y.google && y.google.rating) || 0) - ((x.google && x.google.rating) || 0); });
      else list.sort(function (x, y) { return dist(x) - dist(y); });
      var limit = Math.max(1, Math.min(20, a.limit || 8));
      return { area: state.location.label, total_matches: list.length, trails: list.slice(0, limit).map(trailBrief) };
    },

    get_trail_details: function (a) {
      var t = findTrail(a.trail_id);
      if (!t) return { error: 'No loaded trail matches "' + a.trail_id + '". Use search_trails first.' };
      var out = trailBrief(t);
      out.start = { lat: round1(t.lat * 1e5) / 1e5, lon: round1(t.lon * 1e5) / 1e5 };
      if (t.google) { out.google_maps_url = t.google.gmapsUri || null; out.address = t.google.address || null; }
      if (!t.osmId) return out;
      return withTimeout(ts.relation(t.osmId), 9000, 'trail details').then(function (rel) {
        var p = (rel && rel.properties) || {};
        ['from', 'to', 'description', 'operator', 'website', 'roundtrip', 'symbol', 'osmc_symbol', 'name_en', 'note'].forEach(function (k) {
          if (p[k] != null && p[k] !== '') out[k] = String(p[k]).slice(0, 300);
        });
        if (typeof p.ascent_m === 'number') out.climb_up_m = Math.round(p.ascent_m);
        if (typeof p.descent_m === 'number') out.climb_down_m = Math.round(p.descent_m);
        if (typeof p.distance_m === 'number' && t.distanceM == null) out.length = kmMi(normalizeTrailDistance(p.distance_m, p.bbox));
        return out;
      }).catch(function () { return out; });
    },

    get_weather: function (a) {
      var days = Math.max(1, Math.min(7, a.days || 5));
      var t = a.trail_id ? findTrail(a.trail_id) : null;
      var where;
      if (t) where = Promise.resolve({ lat: t.lat, lon: t.lon, label: t.name });
      else if (a.place) where = ts.geocode(a.place).catch(function () { return osm.geocode(a.place); });
      else if (state.weather && days <= 5) return { place: state.location.label, source: 'Open-Meteo via TrailSplits', days: weatherDays(state.weather, days) };
      else where = Promise.resolve({ lat: state.location.lat, lon: state.location.lon, label: state.location.label });
      return where.then(function (loc) {
        return getForecast(loc.lat, loc.lon, days).then(function (w) {
          return { place: loc.label, source: (w.provider && w.provider.attribution) || 'Open-Meteo', days: weatherDays(w, days) };
        });
      }).catch(function (e) { return { error: 'Forecast unavailable: ' + errText(e) }; });
    },

    plan_loop_route: function (a) {
      var profile = a.profile || (state.mode === 'bike' ? 'bike' : 'hike');
      var maxKm = profile === 'bike' ? 60 : 40;
      var km = Math.max(0.5, Math.min(maxKm, Number(a.distance_km) || 5));
      var startP;
      var t = a.start && a.start !== 'my_location' && a.start !== 'area_center' ? findTrail(a.start) : null;
      if (a.start === 'my_location') {
        startP = locateOnce().then(function (p) { return { lat: p.lat, lon: p.lon, label: 'your location' }; })
          .catch(function () { return { lat: state.location.lat, lon: state.location.lon, label: state.location.label + ' (GPS unavailable — used the area centre)' }; });
      } else if (t) startP = Promise.resolve({ lat: t.lat, lon: t.lon, label: t.name + ' (start)' });
      else startP = Promise.resolve({ lat: state.location.lat, lon: state.location.lon, label: state.location.label });
      return startP.then(function (start) {
        var body = { start: [start.lon, start.lat], distance_km: km, profile: profile, alternatives: 1 };
        if (profile !== 'bike' && a.max_difficulty) body.max_sac = Math.max(1, Math.min(6, Math.round(a.max_difficulty)));
        return tsPost('/v1/roundtrips', body, 30000).then(function (res) {
          var loops = (res && res.loops) || [];
          if (!loops.length) return { error: 'TrailSplits found no good loop of ' + km + ' km from ' + start.label + '.' };
          var best = loops[0];
          var path = decodePolyline(best.shape, 6);
          if (path.length > 1) showLoopOnMap(path);
          return {
            start: start.label, profile: profile, status: res.status, note: res.reason || null,
            drawn_on_map: path.length > 1,
            loops: loops.slice(0, 2).map(function (l) {
              var time = l.time || {};
              var mins = time.moving_s != null ? time.moving_s / 60 : time.duration_s != null ? time.duration_s / 60 : time.minutes != null ? time.minutes : null;
              return {
                rank: l.rank, length: kmMi(l.distance_m), target_off_by_pct: round1(l.target_error_pct),
                climb_m: l.ascent_m != null ? Math.round(l.ascent_m) : null,
                est_time_min: mins != null ? Math.round(mins) : null,
                walked_twice_pct: l.repeated_share != null ? Math.round(l.repeated_share * 100) : null,
                on_marked_trails_score: l.score && l.score.marked != null ? round1(l.score.marked) : null,
                quality: l.status
              };
            })
          };
        });
      }).catch(function (e) {
        var msg = errText(e);
        if (/422/.test(msg)) msg = 'no good loop of that length from there (try another distance or start)';
        return { error: 'Loop planning failed: ' + msg };
      });
    },

    find_places_nearby: function (a) {
      var t = a.trail_id ? findTrail(a.trail_id) : null;
      var lat = t ? t.lat : state.location.lat, lon = t ? t.lon : state.location.lon;
      var r = Math.max(0.3, Math.min(10, a.radius_km || 2));
      var dLat = r / 111, dLon = r / (111 * Math.max(0.2, Math.cos(lat * Math.PI / 180)));
      var kinds = (a.kinds && a.kinds.length ? a.kinds : ['parking', 'water', 'toilets']).map(String);
      var apiKinds = kinds.concat(kinds.indexOf('water') !== -1 ? ['drinking_water'] : []);
      var url = cfg.trailsplitsApi + '/pois/v1/bbox?min_lat=' + (lat - dLat).toFixed(5) + '&max_lat=' + (lat + dLat).toFixed(5) +
        '&min_lon=' + (lon - dLon).toFixed(5) + '&max_lon=' + (lon + dLon).toFixed(5) + '&limit=300&kind=' + encodeURIComponent(apiKinds.join(','));
      var KIND_LABEL = { parking: 'car park', water: 'drinking water', drinking_water: 'drinking water', toilets: 'toilets',
        shelter: 'shelter', viewpoint: 'viewpoint', picnic_site: 'picnic spot', alpine_hut: 'mountain hut', bus_stop: 'bus stop' };
      return getJSONsmart(url, 15000).then(function (json) {
        var feats = ((json && json.features) || []).filter(function (f) {
          return f && typeof f.lat === 'number' && typeof f.lon === 'number' && apiKinds.indexOf(f.kind) !== -1;
        });
        var list = feats.map(function (f) {
          var kind = f.kind === 'drinking_water' ? 'water' : f.kind;
          return { kind: kind, name: f.name || ('unnamed ' + (KIND_LABEL[f.kind] || f.kind)), km_away: round1(C.haversineM(lat, lon, f.lat, f.lon) / 1000), lat: f.lat, lon: f.lon };
        }).sort(function (x, y) { return x.km_away - y.km_away; });
        var byKind = {}, nearestEach = {};
        list.forEach(function (p) {
          byKind[p.kind] = (byKind[p.kind] || 0) + 1;
          if (!nearestEach[p.kind]) nearestEach[p.kind] = { name: p.name, km_away: p.km_away };
        });
        return {
          around: t ? t.name + ' (trail start)' : state.location.label, radius_km: r,
          counts: byKind, nearest_each: nearestEach,
          nearest: list.slice(0, 15).map(function (p) { return { kind: p.kind, name: p.name, km_away: p.km_away }; }),
          note: 'Mapped OpenStreetMap features — not a guarantee they are open or working.'
        };
      }).catch(function (e) { return { error: 'Places lookup failed: ' + errText(e) }; });
    },

    update_trail_list: function (a) {
      var f = a.clear ? { maxKm: null, sort: 'near', easyOnly: false, minRating: null } : state.filter;
      if (a.sort) f.sort = { nearest: 'near', shortest: 'short', longest: 'long', top_rated: 'rated' }[a.sort] || 'near';
      if (a.max_km != null) f.maxKm = a.max_km > 0 ? a.max_km : null;
      if (a.min_rating != null) f.minRating = a.min_rating > 0 ? a.min_rating : null;
      if (a.easy_only != null) f.easyOnly = !!a.easy_only;
      state.filter = f;
      renderAll();
      var shown = filteredTrails();
      return { shown_on_screen: shown.length, of_total: state.trails.length, top: shown.slice(0, 6).map(trailBrief) };
    },

    change_area: function (a) {
      var p;
      if (a.use_my_location) {
        p = locateOnce().then(function (pos) {
          return ts.reverse(pos.lat, pos.lon).catch(function () { return null; }).then(function (label) {
            return loadArea(pos.lat, pos.lon, label || 'your location (' + pos.lat.toFixed(3) + ', ' + pos.lon.toFixed(3) + ')', false);
          });
        });
      } else if (a.place) {
        if (els.searchInput) els.searchInput.value = a.place;
        p = waitForIdle().then(function () { return doSearch(a.place); });
      } else return { error: 'Give a place or use_my_location.' };
      return p.then(waitForIdle).then(function () { return areaSummary(); })
        .catch(function (e) { return { error: 'Couldn’t move there: ' + errText(e) }; });
    },

    set_activity: function (a) {
      var mode = a.mode === 'bike' ? 'bike' : 'hike';
      return Promise.resolve(setMode(mode)).then(waitForIdle).then(function () { return areaSummary(); });
    },

    open_trail: function (a) {
      var t = findTrail(a.trail_id);
      if (!t) return { error: 'No loaded trail matches "' + a.trail_id + '".' };
      openDetails(t);
      return { opened: t.name };
    },

    get_my_activity: function () {
      var logs = [], litter = [], points = null, bags = null;
      try { logs = JSON.parse(localStorage.getItem('calledit_tracks_v1') || '[]') || []; } catch (e) { }
      try { litter = JSON.parse(localStorage.getItem('calledit_litter_v1') || '[]') || []; } catch (e) { }
      try { points = JSON.parse(localStorage.getItem('calledit_points_v1') || 'null'); } catch (e) { }
      try { bags = JSON.parse(localStorage.getItem('calledit_bags_v1') || 'null'); } catch (e) { }
      var weekAgo = Date.now() - 7 * 864e5;
      var totalKm = 0, weekKm = 0, totalMs = 0;
      logs.forEach(function (l) { totalKm += l.km || 0; totalMs += l.ms || 0; if (l.at > weekAgo) weekKm += l.km || 0; });
      return {
        tracked_sessions: logs.length,
        total: { km: round1(totalKm), mi: round1(totalKm / 1.609344), moving_time_min: Math.round(totalMs / 60000) },
        last_7_days: { km: round1(weekKm), mi: round1(weekKm / 1.609344) },
        recent: logs.slice(0, 8).map(function (l) {
          return { date: new Date(l.at).toLocaleDateString('en-US'), activity: l.mode === 'bike' ? 'ride' : 'hike', km: round1(l.km), mi: round1((l.km || 0) / 1.609344), minutes: Math.round((l.ms || 0) / 60000) };
        }),
        litter: { logs: Array.isArray(litter) ? litter.length : 0, points: typeof points === 'number' ? points : (points && points.total) || null, bags: typeof bags === 'number' ? bags : null },
        currently_tracking: tracker.active ? { distance: kmMi(tracker.distance), minutes: Math.round(tracker.elapsedMs / 60000) } : null
      };
    }
  };

  function runTool(call, typing) {
    var name = call.function.name, args = {};
    try { args = call.function.arguments ? (typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments) : {}; }
    catch (e) { return Promise.resolve({ error: 'Arguments were not valid JSON' }); }
    if (!TOOLS[name]) return Promise.resolve({ error: 'Unknown tool ' + name });
    if (typing) typing.setLabel(TOOL_LABELS[name] || 'Working…');
    return Promise.resolve().then(function () { return TOOLS[name](args || {}); })
      .catch(function (e) { return { error: errText(e) }; });
  }

  function buildSystemPrompt() {
    var now = new Date();
    var top = filteredTrails().slice(0, 15).map(function (t) {
      var b = trailBrief(t);
      return '- ' + b.id + ' · ' + b.name + ' · ' + (b.length ? b.length.km + ' km (' + b.length.mi + ' mi)' : 'length unlisted') +
        (b.google_rating ? ' · Google ' + b.google_rating + '★ (' + b.google_reviews + ')' : '') + ' · ' + b.from_area_center_km + ' km from centre';
    }).join('\n');
    var wx = weatherDays(state.weather, 3).map(function (d) {
      return d.weekday + ': ' + d.conditions + ', ' + d.high_f + '/' + d.low_f + '°F (' + d.high_c + '/' + d.low_c + '°C)' + (d.rain_chance_pct != null ? ', rain ' + d.rain_chance_pct + '%' : '');
    }).join('; ');
    var f = state.filter, filt = [];
    if (f.maxKm) filt.push('max ' + f.maxKm + ' km');
    if (f.minRating) filt.push('rating ≥ ' + f.minRating);
    if (f.easyOnly) filt.push('easy only');
    filt.push('sorted by ' + ({ near: 'distance', short: 'shortest', long: 'longest', rated: 'rating' }[f.sort] || 'distance'));
    return [
      'You are the CalledIt trail assistant: a friendly, expert hiking and biking guide inside the CalledIt app (Trails page), powered by Grok.',
      'Today is ' + now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) + '. ' +
        (USE_MILES ? 'The user is in the US: give miles first (km in brackets) and °F first.' : 'Use km and °C (add miles/°F only if asked).'),
      'Area on screen: ' + state.location.label + ' (' + state.location.lat.toFixed(4) + ', ' + state.location.lon.toFixed(4) + ')' +
        (state.location.guessed ? ' — this is only the SAMPLE area; the user has not shared a location or searched yet.' : '.') +
        ' Activity: ' + (state.mode === 'bike' ? 'biking routes' : 'hiking trails') + '. ' + state.trails.length + ' routes loaded (data: ' + state.dataSource + '). List filter: ' + filt.join(', ') + '.' +
        (tracker.active ? ' The user is tracking a ' + (state.mode === 'bike' ? 'ride' : 'hike') + ' right now (' + fmtTrackDist(tracker.distance) + ' so far).' : ''),
      top ? 'Loaded routes (id · name · length · rating · distance):\n' + top : 'No routes are loaded for this area.',
      wx ? 'Forecast here: ' + wx + '.' : '',
      'How to work:',
      '- For facts about trails, weather, loops, parking/water or the user’s own hikes, use the tools. Never invent trail names, lengths, ratings, distances or forecasts; if data is missing, say so.',
      '- Answer general outdoor questions (gear, safety, training, etiquette, wildlife, first aid basics, what to pack) from your own knowledge.',
      '- When the user wants to see, filter, switch, open or plan something, do it with update_trail_list, change_area, set_activity, open_trail or plan_loop_route — the app updates on screen; then tell them what changed.',
      '- If no trails fit (or none are loaded), suggest plan_loop_route, which builds loops on any mapped paths.',
      '- Keep replies short for a phone: 1-3 short paragraphs or up to 6 bullets, **bold** trail names, no tables, no HTML, no raw ids.',
      '- Safety first: mention heat, water and daylight when relevant. For emergencies tell them to call local emergency services (911 in the US).'
    ].filter(Boolean).join('\n');
  }

  function ensureSignedIn(typing) {
    if (puterSignedIn()) return Promise.resolve();
    if (typing) typing.setLabel('Opening the free Puter sign-in…');
    return window.puter.auth.signIn({ attempt_temp_user_creation: true }).then(function () { renderAiStatus(); });
  }

  function runAgent(question, typing) {
    var messages = [{ role: 'system', content: buildSystemPrompt() }]
      .concat(ai.history.slice(-12))
      .concat([{ role: 'user', content: question }]);
    var rounds = 0;
    function step() {
      if (typing) typing.setLabel(rounds ? 'Grok is writing…' : 'Grok is thinking…');
      return grokChat(messages, rounds < MAX_TOOL_ROUNDS).then(function (res) {
        var msg = res.message || {};
        var calls = (msg.tool_calls || []).filter(function (c) { return c && c.function && c.function.name; });
        if (calls.length && rounds < MAX_TOOL_ROUNDS) {
          rounds++;
          var am = {};
          Object.keys(msg).forEach(function (k) { am[k] = msg[k]; });
          am.role = 'assistant';
          if (am.content == null) am.content = '';
          messages.push(am);
          /* run tools one after another — some change what the next one sees */
          return calls.reduce(function (p, call) {
            return p.then(function () {
              return runTool(call, typing).then(function (result) {
                var json;
                try { json = JSON.stringify(result); } catch (e) { json = '{"error":"unserializable result"}'; }
                if (json.length > 12000) json = JSON.stringify({ note: 'result truncated', preview: json.slice(0, 11000) });
                messages.push({ role: 'tool', tool_call_id: call.id, content: json });
              });
            });
          }, Promise.resolve()).then(step);
        }
        var text = textOf(msg.content).trim();
        if (!text) throw new Error('Grok sent an empty answer');
        return text;
      });
    }
    return step().then(function (text) {
      ai.history.push({ role: 'user', content: question }, { role: 'assistant', content: text });
      if (ai.history.length > 24) ai.history = ai.history.slice(-24);
      return text;
    });
  }

  function answer(raw) {
    var q = String(raw || '').trim();
    if (!q) return;
    if (ai.busy) { C.toast('One moment — still answering your last question…'); return; }
    ai.busy = true;
    setComposerBusy(true);
    var typing = typingIndicator('Connecting to Grok…');
    loadPuter()
      .then(function () { return ensureSignedIn(typing); })
      .then(function () { return runAgent(q, typing); })
      .then(function (text) {
        typing.remove();
        botSay(formatReply(text));
      }, function (err) {
        typing.remove();
        handleAiFailure(q, err);
      })
      .then(function () { ai.busy = false; setComposerBusy(false); renderAiStatus(); });
  }

  function retryWith(q) {
    return function () { userSay(q); answer(q); };
  }

  function handleAiFailure(q, err) {
    var local = '';
    try { local = localAnswer(q); } catch (e) { local = ''; }
    var tail = local ? '<div class="msg-local"><span class="muted">Meanwhile, from the trail data on this page:</span><br>' + local + '</div>' : '';
    if (isAuthError(err)) {
      botSay('To answer that, Grok needs a <b>free Puter account</b> — a one-time sign-in (a guest account is created for you; no card, no API key). ' +
        'The sign-in window was closed or blocked.' + tail, [{
          label: '🔓 Sign in & ask again', fn: function () {
            /* runs inside the tap, so the sign-in window is allowed to open */
            loadPuter().then(function (p) {
              return p.auth.signIn({ attempt_temp_user_creation: true });
            }).then(function () { renderAiStatus(); retryWith(q)(); }, function () {
              C.toast('Sign-in didn’t finish — tap again when you’re ready.');
            });
          }
        }]);
    } else if (isQuotaError(err)) {
      botSay('Your <b>free Puter AI allowance</b> for this month is used up, so Grok can’t answer right now. It resets monthly — or top it up in your Puter account.' + tail, [
        { label: 'Open Puter usage', fn: function () { window.open('https://puter.com/dashboard#usage', '_blank', 'noopener'); } }
      ]);
    } else {
      botSay('Grok couldn’t be reached just now (' + esc(errText(err)) + ').' + tail, [{ label: '↻ Try again', fn: retryWith(q) }]);
    }
  }

  /* Local data-driven answers — ONLY used when the AI is unreachable. */
  function localAnswer(q) {
    var low = q.toLowerCase();
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
      return trailLine(named[0], true) +
        (named[0].distanceM != null ? '<br>Typical time: ' + C.fmtDuration(estimateMinutes(named[0])) : '');
    }
    if (/rain|weather|snow|storm|sun|cold|warm|hot|temperature|forecast/.test(low)) {
      var days = weatherDays(state.weather, 4);
      if (days.length) {
        return days.map(function (d) {
          return '• <b>' + esc(d.weekday) + '</b>: ' + esc(d.conditions) + ', ' + d.high_c + '° / ' + d.low_c + '°C' + (d.rain_chance_pct != null ? ', rain ' + d.rain_chance_pct + '%' : '');
        }).join('<br>');
      }
      return '';
    }
    var list = state.trails.slice();
    if (/(easy|easiest|beginner|kid|family|short)/.test(low)) list.sort(function (a, b) { return (a.distanceM || 9e9) - (b.distanceM || 9e9); });
    else if (/(long|longest|hard|challenge|epic)/.test(low)) list.sort(function (a, b) { return (b.distanceM || 0) - (a.distanceM || 0); });
    else if (/(top|best|rated|popular)/.test(low)) list.sort(function (a, b) { return ((b.google && b.google.rating) || 0) - ((a.google && a.google.rating) || 0); });
    return list.slice(0, 3).map(function (t) { return trailLine(t, true); }).join('<br>');
  }

  /* ---------------- open / close / new chat ---------------- */
  function greet() {
    botSay(formatReply(
      'Hi! I’m your trail assistant, powered by **Grok** (xAI). Ask me anything — which of the **' + state.trails.length + '** routes around **' +
      state.location.label + '** suits you, the weather, a loop of a certain length, where to park or find water, gear and safety tips…\n' +
      'I can also filter the list, switch areas or activity, open a trail and draw a planned loop on the map for you.'
    ) + (puterSignedIn() ? '' :
      '<div class="msg-note">🔓 Your first question opens a <b>one-time free Puter sign-in</b> (Puter pays for the AI through your free monthly allowance — no API key, no card).</div>'));
  }

  function renderSuggestions() {
    suggest.innerHTML = SUGGESTIONS.map(function (s) { return '<button type="button" class="suggest-chip">' + esc(s) + '</button>'; }).join('');
    qsa('.suggest-chip', suggest).forEach(function (chip) {
      chip.addEventListener('click', function () { userSay(chip.textContent); answer(chip.textContent); });
    });
  }

  function hideAssistantVisual() {
    sheet.classList.remove('is-open');
    fab.classList.remove('is-hidden');
  }

  function openAssistant() {
    sheet.classList.add('is-open');
    fab.classList.add('is-hidden');
    C.pushOverlay('assistant', hideAssistantVisual);
    loadPuter().catch(function () { /* surfaced on the first question */ });   /* warm up while you type */
    renderAiStatus();
    if (!log.children.length) { greet(); renderSuggestions(); }
  }
  function closeAssistant() {
    C.closeOverlay('assistant');
    hideAssistantVisual();
  }

  fab.addEventListener('click', openAssistant);
  qs('#assistantClose').addEventListener('click', closeAssistant);
  if (newChatBtn) newChatBtn.addEventListener('click', function () {
    if (ai.busy) { C.toast('One moment — still answering…'); return; }
    ai.history = [];
    log.innerHTML = '';
    if (loopPath) showLoopOnMap(null);
    greet();
    C.toast('New chat started');
  });

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
    answer(text);     /* immediately — keeps the tap’s permission to open the sign-in window */
    setTimeout(function () { input.focus({ preventScroll: true }); }, 320);
  });

  /* ============================================================
     Mode + boot
     ============================================================ */
  function setMode(mode) {
    if (state.mode === mode) return Promise.resolve();
    state.mode = mode;
    try { localStorage.setItem('calledit_mode', mode); } catch (e) { }
    updateModeButtons();
    if (trackEls.btnLabel && !tracker.active) trackEls.btnLabel.textContent = mode === 'bike' ? 'Track ride' : 'Track hike';
    return loadArea(state.location.lat, state.location.lon, state.location.label, state.location.guessed);
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
    if (trackEls.btnLabel) trackEls.btnLabel.textContent = state.mode === 'bike' ? 'Track ride' : 'Track hike';

    /* optional deep link: ?q=place or ?lat&lon */
    var qParam = params.get('q');
    var latParam = parseFloat(params.get('lat')), lonParam = parseFloat(params.get('lon'));

    els.searchBtn.addEventListener('click', function () { doSearch(els.searchInput.value).catch(function () { }); });
    els.searchInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(els.searchInput.value).catch(function () { }); } });
    els.locateBtn.addEventListener('click', locateMe);
    els.modeHike.addEventListener('click', function () { setMode('hike'); });
    els.modeBike.addEventListener('click', function () { setMode('bike'); });

    els.modalClose.addEventListener('click', closeModal);
    els.backdrop.addEventListener('click', function (e) { if (e.target === els.backdrop) closeModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeModal(); closeAssistant(); } });

    if (qParam) {
      els.searchInput.value = qParam;
      doSearch(qParam).catch(function () {
        loadArea(cfg.defaultLocation.lat, cfg.defaultLocation.lon, cfg.defaultLocation.label, true);
      });
    } else if (!isNaN(latParam) && !isNaN(lonParam)) {
      loadArea(latParam, lonParam, 'pinned location (' + latParam.toFixed(3) + ', ' + lonParam.toFixed(3) + ')', false);
    } else {
      loadArea(cfg.defaultLocation.lat, cfg.defaultLocation.lon, cfg.defaultLocation.label, true);
    }
  }

  init();
})();
