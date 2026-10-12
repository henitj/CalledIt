/* CalledIt — runtime configuration.
   ---------------------------------------------------------------------------
   Values here are the built-in defaults. The in-app Settings dialog (footer →
   “⚙️ Settings”) can override the Google / TrailSplits keys and the AI model
   per device; those overrides live in localStorage and are merged below.

   Google key status (checked 2026-10-11): the key below authenticates for the
   Maps JavaScript API and Places API (New), and has no referrer restriction,
   so it works on the website AND inside the Android app
   (http://127.0.0.1:8765). If you ever restrict it by HTTP referrer, add your
   web origin plus http://127.0.0.1:8765/* and http://localhost:8765/*.
--------------------------------------------------------------------------- */
window.CALLEDIT_CONFIG = {
  appName: 'CalledIt',

  /* Google Maps Platform — interactive map (Maps JavaScript API) + Places
     photos/ratings (Places API New). */
  googleMapsApiKey: 'AIzaSyD_J-3klu8NxOItUHwmK4bCkfuY3pROmAE',

  /* TrailSplits — trails, relations, elevation, place/weather search.
     Works without a key (500 free credits/day per address); add yours for more. */
  trailsplitsApi: 'https://api.trailsplits.com',
  trailsplitsSite: 'https://trailsplits.com',
  trailsplitsApiKey: '',

  /* Trail assistant AI — Grok through Puter.js (https://docs.puter.com).
     No API key: Puter's “user-pays” model gives every user a free monthly AI
     allowance on their own (free) Puter account. The first question opens a
     one-time Puter sign-in window (a guest account is created automatically). */
  ai: {
    puterJs: 'https://js.puter.com/v2/',
    /* Default = instant answers. Grok 4.7 is smarter but averages ~16 s before
       the first word and costs ~10× more of each user's free allowance. */
    model: 'x-ai/grok-4-1-fast-non-reasoning',
    /* tried in order (after the chosen model) if a model errors/is unavailable */
    fallbackModels: ['x-ai/grok-4-1-fast-non-reasoning', 'x-ai/grok-4.7', 'x-ai/grok-4.5', 'x-ai/grok-2'],
    /* shown in Settings → AI model */
    models: [
      { id: 'x-ai/grok-4-1-fast-non-reasoning', label: 'Grok 4.1 Fast — instant answers (recommended)' },
      { id: 'x-ai/grok-4-1-fast-reasoning', label: 'Grok 4.1 Fast Reasoning — thinks a little first' },
      { id: 'x-ai/grok-4.7', label: 'Grok 4.7 — newest flagship, smartest, slow (~15 s+)' },
      { id: 'x-ai/grok-4.6', label: 'Grok 4.6' },
      { id: 'x-ai/grok-4.5', label: 'Grok 4.5' }
    ]
  },

  /* Fallback map (only used if Google Maps can’t load) — bundled Leaflet with
     clean CARTO / topo / satellite tiles instead of the plain OSM iframe. */
  leafletJs: 'vendor/leaflet/leaflet.js',
  leafletCss: 'vendor/leaflet/leaflet.css',

  /* OpenStreetMap-powered data fallbacks (used automatically if TrailSplits fails) */
  overpassApi: 'https://overpass-api.de/api/interpreter',
  nominatim: 'https://nominatim.openstreetmap.org',

  /* Where to show trails when the user hasn't shared a location or searched yet */
  defaultLocation: { lat: 46.0207, lon: 7.7491, label: 'Zermatt, Switzerland' }

  /* Trail photos: Google Maps photo → freely-licensed Wikimedia Commons photo
     taken near the trail → a map of the trail's area (see js/trails.js,
     “TRAIL PHOTOS”). No stock pictures, so no two trails look the same. */
};

/* Merge per-device overrides saved in Settings over the defaults above. */
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem('calledit_keys_v1') || '{}');
    var cfg = window.CALLEDIT_CONFIG;
    ['googleMapsApiKey', 'trailsplitsApiKey'].forEach(function (k) {
      if (typeof saved[k] === 'string' && saved[k].trim()) cfg[k] = saved[k].trim();
    });
    if (typeof saved.aiModel === 'string' && /^[\w.\-\/]+$/.test(saved.aiModel)) cfg.ai.model = saved.aiModel;
  } catch (e) { /* private mode / corrupt value — keep defaults */ }
})();
