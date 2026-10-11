/* CalledIt — runtime configuration.
   ---------------------------------------------------------------------------
   API keys can be set here (build time) OR at runtime via the in-app
   “API keys” dialog (Settings → API keys, link in the footer). Runtime keys
   are stored in localStorage and override the values below.

   Keys are client-side keys (Maps JS / Places / TrailSplits / Grok are called
   from the browser). Restrict them by HTTP referrer in their consoles:
   - Google Cloud: enable “Maps JavaScript API” + “Places API (New)”, and add
     referrers for your web origin AND (for the Android APK)
     http://localhost:8765/* and http://127.0.0.1:8765/*
   - xAI console: restrict to your origins if available.
--------------------------------------------------------------------------- */
window.CALLEDIT_CONFIG = {
  appName: 'CalledIt',

  /* Google Maps Platform — used for the interactive map AND Places
     photos/ratings. Without a valid key the map falls back to OpenStreetMap. */
  googleMapsApiKey: 'AIzaSyD_J-3klu8NxOItUHwmK4bCkfuY3pROmAE',

  /* TrailSplits — trails, relations, elevation, place/weather search.
     Works without a key (500 free credits/day per address); add yours for more. */
  trailsplitsApi: 'https://api.trailsplits.com',
  trailsplitsSite: 'https://trailsplits.com',
  trailsplitsApiKey: '',

  /* Grok (xAI) — powers the trail assistant’s free-form answers.
     Put any Grok key here (or in the in-app Settings). */
  grokApiKey: '',
  grokApi: 'https://api.x.ai/v1/chat/completions',
  grokModel: 'grok-4-fast',            /* tried first … */
  grokModelFallbacks: ['grok-3-mini', 'grok-3', 'grok-2-latest'], /* … then these */

  /* OpenStreetMap-powered fallbacks (used automatically if Google/TrailSplits fail) */
  overpassApi: 'https://overpass-api.de/api/interpreter',
  nominatim: 'https://nominatim.openstreetmap.org',

  /* Where to show trails when the user hasn't shared a location or searched yet */
  defaultLocation: { lat: 46.0207, lon: 7.7491, label: 'Zermatt, Switzerland' },

  /* Local photos used whenever a trail has no Google photo available */
  fallbackImages: [
    'assets/fallback-forest.jpg',
    'assets/fallback-lake.jpg',
    'assets/fallback-ridge.jpg'
  ]
};

/* Merge keys saved at runtime (Settings → API keys) over the defaults above. */
(function () {
  try {
    var saved = JSON.parse(localStorage.getItem('calledit_keys_v1') || '{}');
    var cfg = window.CALLEDIT_CONFIG;
    ['googleMapsApiKey', 'trailsplitsApiKey', 'grokApiKey', 'grokModel'].forEach(function (k) {
      if (typeof saved[k] === 'string' && saved[k].trim()) cfg[k] = saved[k].trim();
    });
  } catch (e) { /* private mode / corrupt value — keep defaults */ }
})();
