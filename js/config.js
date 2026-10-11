/* CalledIt — runtime configuration.
   The Google Maps key is a client-side key (as Google Maps keys are meant to be
   used in browsers). Restrict it by HTTP referrer in the Google Cloud console. */
window.CALLEDIT_CONFIG = {
  appName: 'CalledIt',

  googleMapsApiKey: 'AIzaSyD_J-3klu8NxOItUHwmK4bCkfuY3pROmAE',

  /* TrailSplits — works without a key (500 credits/day per address in preview) */
  trailsplitsApi: 'https://api.trailsplits.com',
  trailsplitsSite: 'https://trailsplits.com',

  /* OpenStreetMap-powered fallbacks (used automatically if TrailSplits fails) */
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
