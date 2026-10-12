# Browser tests (website + APK)

Real headless-Chromium end-to-end tests. Every third-party service is mocked
in `harness.mjs`, so runs are offline and deterministic:

- TrailSplits trails, search, POIs, loops, elevation and weather (`test/fixtures/zermatt-trails.json` is real TrailSplits data)
- Google Places search — **without photos by default**, because that is what the real API returns for the configured key (option `googlePhotos: true` adds them)
- Wikimedia Commons and Wikipedia geosearch, replaying **real captured results** (`test/fixtures/photo-pools.json`: Zermatt, Saas valley, Cervinia, Alagna, Austin — real titles, sizes, Swisstopo TIFF floods, astronaut photos and other junk) with the real URL formats; the Wikimedia image hosts refuse non-standard thumbnail widths like the real CDN, and can answer “too busy” like the real API
- map tiles, plus a scripted Puter/Grok that really makes tool calls
- Google Maps JS is blocked, which exercises the Leaflet backup map
- a controllable GPS and the APK's `window.CalledItAndroid` bridge

```bash
cd test/browser && npm install          # @sparticuz/chromium + puppeteer-core
node site-check.mjs                     # the website, as a phone browser (+ one desktop pass)
node apk-check.mjs                      # the site INSIDE the newest android/dist/*.apk (see below)
```

Options:

- `SHOTS=/some/dir` saves screenshots.
- `ONLY='Trails|assistant'` runs only the matching sections.
- `CHROME_PATH=/usr/bin/google-chrome` uses an installed Chrome instead of `@sparticuz/chromium`.

## `site-check.mjs` covers

- **Every page:** no JS errors, no missing files, no broken images, all internal links resolve, no AI assistant outside Trails, and no sideways scrolling on 320 / 360 / 412 px phones.
- **Start page:** the cartoon walker/biker cards, the accordion, and the bike card opening Trails in bike mode.
- **Community page:**
  - profile photo upload (downscaled to 256 px) that survives a reload;
  - litter points: 5 per bag, capped at 3 logs/day;
  - trail reports and the pledge counter.
- **Trails page:**
  - Lengths: no "0.0 km". TrailSplits values that are really km are fixed, a stub of a long-distance tour shows as "Multi-stage route", and multi-day treks show days.
  - Photos: most cards get a real photo although Google sends none; the Hörnliweg card shows the Hörnliweg, the glacier trail its own photos; no repeats on the page (cards + top-rated strip); real junk never shows; credits with author + licence; only standard 960 px thumbnails; TIFF scans never looked up; 16:9 on phones, a 200 px column on desktop.
  - Fallbacks: if the photo services fail, if Wikimedia refuses every image (rate limit), or answers “too busy” first (retried, not cached), every card still ends with a photo or a map of the trail's area; nothing broken.
  - When Google does send photos they're used and credited, one place per trail.
  - Austin (few signed routes, Google places as trails): real Barton Creek / Lady Bird Lake photos, no Austin junk.
  - Also: the Leaflet fallback map, weather, the top-rated strip, and the details sheet (photo header, elevation, Directions to the trailhead, ✕ and back gesture).
  - Also: hike/bike switch, search, and unknown places.
- **Assistant:** Grok via Puter with tool calls:
  - easiest trail, plan a loop (drawn in purple), and parking/water;
  - free-form questions;
  - temporary-account sign-in;
  - model choice in Settings.
- **GPS:**
  - 10 minutes of desk jitter counts 0 m, and a 420 m walk is counted;
  - Near me works;
  - with location switched off, you get one prompt, then it continues by itself.
- **Back gesture:** closes sheets first, then walks page history.

## `apk-check.mjs`

1. Extracts `assets/` from the APK. It checks that every bundled file is byte-identical to the repo and that nothing is missing.
2. Compiles the app's own `LocalServer.java` plus `android/ci/ServeAssets.java`, and serves the extracted files on `http://127.0.0.1:8765`, the same origin the app uses.
3. Runs `site-check.mjs` against that server with an Android WebView user agent and the `CalledItAndroid` bridge. This adds checks for the native "turn on location" prompt, auto-continue on return, and "no GPS fix yet" without looping prompts.

It needs `unzip` and a JDK (`javac`). Alternatively, set `JAVA`, `ECJ_JAR` and `ANDROID_JAR` to use ECJ.
