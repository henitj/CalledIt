# Browser tests (website + APK)

Real headless-Chromium end-to-end tests. Every third-party service is mocked
in `harness.mjs`, so runs are offline and deterministic:

- TrailSplits trails, search, POIs, loops, elevation and weather (`test/fixtures/zermatt-trails.json` is real TrailSplits data)
- Google Places search and photos, Wikimedia Commons photo search (real photos mixed with junk the app must reject)
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

- **Every page:** no JS errors, no missing files, no broken images, all internal links resolve, and no AI assistant outside Trails.
- **Start page:** the cartoon walker/biker cards, the accordion, and the bike card opening Trails in bike mode.
- **Community page:**
  - profile photo upload (downscaled to 256 px) that survives a reload;
  - litter points: 5 per bag, capped at 3 logs/day;
  - trail reports and the pledge counter.
- **Trails page:**
  - Lengths: no "0.0 km". TrailSplits values that are really km are fixed, a stub of a long-distance tour shows as "Multi-stage route", and multi-day treks show days.
  - Photos: every card gets its own photo with no repeats. Junk is rejected and credits are shown. Images use 16:9 on phones and a 200 px column on desktop.
  - Fallbacks: if the photo services fail, each card shows a map of the trail's area with its start pinned.
  - Also: the Leaflet fallback map, weather, Google highlights, and the details sheet (photo header, elevation, ✕ and back gesture).
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
