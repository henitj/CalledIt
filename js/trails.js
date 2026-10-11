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
      return fetchJSON(url).then(function (json) {
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
      return fetchJSON(cfg.trailsplitsApi + '/trails/v1/relation/' + encodeURIComponent(osmId));
    },

    elevationProfile: function (geometry) {
      return fetchJSON(cfg.trailsplitsApi + '/v1/elevation-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ geometry: geometry, points: 400 })
      });
    },

    geocode: function (q) {
      return fetchJSON(cfg.trailsplitsApi + '/search/v1/forward?q=' + encodeURIComponent(q) + '&limit=1')
        .then(function (json) {
          var f = json && json.features && json.features[0];
          if (!f || !f.center) throw new Error('not found');
          return { lat: f.center[1], lon: f.center[0], label: f.name + (f.region ? ', ' + f.region : '') };
        });
    },

    reverse: function (lat, lon) {
      return fetchJSON(cfg.trailsplitsApi + '/search/v1/reverse?lat=' + lat + '&lon=' + lon + '&limit=1&radius_m=30000')
        .then(function (json) {
          var f = json && json.features && json.features[0];
          return f ? (f.name + (f.region ? ', ' + f.region : '')) : null;
        });
    },

    /* served from the main site per the API spec */
    weather: function (lat, lon) {
      return fetchJSON(cfg.trailsplitsSite + '/api/weather/forecast?p=' + lat.toFixed(4) + ',' + lon.toFixed(4) + '&d=5');
    }
  };

  /* ============================================================
     PROVIDER 2 — OpenStreetMap (Overpass + Nominatim) fallback
     ============================================================ */
  var osm = {
    trailsBBox: function (lat, lon, mode) {
      var dLat = 0.14;
      var dLon = Math.min(0.6, 0.14 / Math.max(0.2, Math.cos(lat * Math.PI / 180)));
      var routeRe = mode === 'bike' ? '^(bicycle|mtb)$' : '^(hiking|foot)$';
      var query = '[out:json][timeout:25];' +
        'relation["type"="route"]["route"~"' + routeRe + '"]["name"]' +
        '(' + (lat - dLat) + ',' + (lon - dLon) + ',' + (lat + dLat) + ',' + (lon + dLon) + ');' +
        'out tags center 60;';
      var body = 'data=' + encodeURIComponent(query);
      return fetchJSON(cfg.overpassApi, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body
      }, 30000).then(function (json) {
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
     Map — Google Maps JS with automatic OSM iframe fallback
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
    els.mapCaption.textContent = 'Map © OpenStreetMap contributors';
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
        mapTypeControl: false
      });
    } else {
      state.map.setCenter({ lat: state.location.lat, lng: state.location.lon });
    }
    /* clear markers */
    state.markers.forEach(function (m) { m.setMap(null); });
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
    els.mapCaption.textContent = 'Map © Google · trail markers show route start points';
  }

  function renderMap() {
    if (state.mapLib === 'google' && window.google && window.google.maps) { renderGoogleMap(); return; }
    if (!hasGoogleKey() || gmapsLoaded === 'failed') { renderOSMMap(); return; }
    if (gmapsLoaded === true) { renderGoogleMap(); return; }

    /* load the Google Maps script once */
    gmapsLoaded = 'loading';
    window.gm_authFailure = function () { gmapsLoaded = 'failed'; renderOSMMap(); };
    var s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(cfg.googleMapsApiKey) + '&v=weekly';
    s.async = true; s.defer = true;
    s.onload = function () {
      gmapsLoaded = true;
      try { renderGoogleMap(); } catch (e) { gmapsLoaded = 'failed'; renderOSMMap(); }
    };
    s.onerror = function () { gmapsLoaded = 'failed'; renderOSMMap(); };
    document.head.appendChild(s);
    /* if google is slow, show OSM meanwhile */
    setTimeout(function () { if (gmapsLoaded === 'loading' && state.mapLib == null) renderOSMMap(); }, 8000);
  }

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
    var src = state.dataSource === '…' ? '' : ' · via ' + state.dataSource;
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

    var trailsP = ts.trailsBBox(lat, lon, state.mode)
      .then(function (trails) {
        if (!trails.length) throw new Error('empty');
        state.trails = trails;
        state.dataSource = 'TrailSplits';
      })
      .catch(function () {
        return osm.trailsBBox(lat, lon, state.mode).then(function (trails) {
          state.trails = trails;
          state.dataSource = 'OpenStreetMap';
        }).catch(function () {
          state.trails = [];
          state.dataSource = '—';
          errors.push('Both trail providers are unreachable right now. Check your connection and try again.');
        });
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
      C.toast(err.code === 1 ? 'Location permission denied — search a place instead.' : 'Couldn’t get your position — search a place instead.');
      renderStatus();
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
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

    /* fetch richer detail from TrailSplits when we know the OSM relation */
    if (t.osmId) {
      ts.relation(t.osmId).then(function (rel) {
        var props = rel.properties || {};
        var climb = qs('#factClimb');
        if (climb && typeof props.ascent_m === 'number') climb.textContent = '↑ ' + Math.round(props.ascent_m) + ' m';
        if (rel.geometry) {
          return ts.elevationProfile(rel.geometry).then(function (prof) {
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

  function closeModal() {
    els.backdrop.classList.remove('is-open');
    document.body.style.overflow = '';
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
      return botSay('I work with the trails loaded on this page. You can ask:<br>' +
        '• “easiest / beginner trails”<br>• “top rated” (Google ratings)<br>• “under 8 km”<br>• “longest routes”<br>• “nearest trails”<br>• “weather this week”<br>• “switch to biking”');
    }

    return botSay('Hmm, I didn’t catch that. I can filter the trails shown on this page — try “easiest trails”, “under 8 km”, “top rated” or “weather this week”.');
  }

  fab.addEventListener('click', function () {
    sheet.classList.add('is-open');
    if (!log.children.length) {
      botSay('Hi! I’m the trail assistant — I answer from the routes loaded on this page (' + esc(state.location.label) + '). ' +
        'Ask me for the easiest trails, top-rated ones, short walks, or the weather.');
      suggest.innerHTML = SUGGESTIONS.map(function (s) { return '<button type="button" class="suggest-chip">' + esc(s) + '</button>'; }).join('');
      qsa('.suggest-chip', suggest).forEach(function (chip) {
        chip.addEventListener('click', function () { userSay(chip.textContent); answer(chip.textContent); });
      });
    }
  });
  qs('#assistantClose').addEventListener('click', function () { sheet.classList.remove('is-open'); });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    userSay(text);
    input.value = '';
    setTimeout(function () { answer(text); }, 200);
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
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeModal(); sheet.classList.remove('is-open'); } });

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
