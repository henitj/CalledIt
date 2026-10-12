# CalledIt

**Call your next trail. Then go walk it.**

CalledIt is a mobile-first web app, also packaged as an Android app, that finds hiking and biking trails near you. It shows real trail photos, Google ratings, live weather and an interactive Google map, and includes a GPS hike tracker that doesn't invent distance. On the Trails page, a **Grok-powered trail assistant** answers any question, free through Puter.js with no API key. Community features give back to the trails.

- **Website:** plain HTML, CSS and JavaScript, no build step. [Run it](#run-it) with any static file server.
- **Android:** [**Download CalledIt 1.2.2** (APK, 3.5 MB)](https://github.com/henitj/CalledIt/raw/main/android/dist/CalledIt-1.2.2.apk). If 1.2.1 or older is installed, uninstall it once first ([why](#android-app)).
- **Tests:** website 139/139 · APK 138/138 · photo rules 60/60, all passing on 1.2.2 ([how to run them](#tests)).

## Features

- **Trails near you:** search a place or tap *Near me* to get signed hiking or biking routes with length and estimated time. Where signed routes are scarce, as in most US cities, Google "hiking area" places fill in.
- **Real photos:** every trail card shows a photo taken around that trail, credited to its photographer. If no good photo exists, the card shows a map of the trail's own area instead. There are no stock pictures and no repeats ([details](#trail-photos)).
- **Google Maps:** an interactive map, Google ratings and a "Top-rated spots nearby" strip. If Google can't load, a bundled Leaflet map takes over.
- **Trail details:** photo, facts, rating, elevation profile, and **directions to the trailhead**. The trailhead is the end of the route nearest you; directions open in Apple Maps on Apple devices and Google Maps elsewhere.
- **Hike tracker:** a phone lying on a desk records 0 m. It has auto-pause and a real Pause button, and shows miles for US users ([how it works](#hike-tracker--no-phantom-distance)).
- **AI trail assistant (Trails page only):** Grok answers any question and can use the app itself, for example to search trails, plan a loop, or find parking and water ([how it works](#trail-assistant--grok-via-puterjs)).
- **Community:** a profile with your photo and name, the Pack-It-Out pledge and a litter log (5 points per bag, at most 3 logs a day). There are also trail condition reports with kudos, and cleanup days.
- **Android app:** the same site inside a small native shell. The back gesture goes back instead of exiting the app, there is one "turn on location" prompt, and photo upload works ([details](#android-app)).

## Run it

Any static file server works:

```bash
git clone https://github.com/henitj/CalledIt.git
cd CalledIt
python3 -m http.server 8000
# open http://localhost:8000
```

Location features (*Near me*, *Track hike*) need a secure origin: `localhost` works, but anywhere else the site must be served over HTTPS.

To publish the site, use any static host. On GitHub Pages: *Settings → Pages → Deploy from a branch → `main`, `/ (root)`*. If you restrict the Google key or create a TrailSplits browser key, allow that origin too ([keys](#keys-and-settings)).

## Pages

| Page | What it does |
| --- | --- |
| `index.html` | **Home:** intro, big navigation cards, a "Made for your device" summary (iPhone, Android or desktop) and an overview of what CalledIt does. No AI here. |
| `start.html` | **Start:** pick **hiker** or **biker** (cartoon illustrations). Also a "Before you go" checklist and the SAC difficulty scale explained in plain language. |
| `trails.html` | **Trails:** search or *Near me*, a hike/bike switch, and trail cards with photo, length, time and rating. Also a weather strip, the map, the top-rated strip, and trail details with an elevation profile and directions to the trailhead. **Track hike** and the **AI trail assistant** live here. |
| `social.html` | **Community:** your profile (photo and name), Pack-It-Out pledge and litter log, trail condition reports with kudos, cleanup days, and ideas. |

## How it works

### Data sources (with automatic fallbacks)

| For | Primary | Fallback |
| --- | --- | --- |
| Trails, routes, elevation | [TrailSplits API](https://trailsplits.com/api) | OpenStreetMap Overpass |
| Place search | TrailSplits | Nominatim |
| Interactive map | Google Maps JavaScript API | bundled Leaflet with CARTO / OpenTopoMap tiles |
| Ratings, trail places in cities | Google Places API (New) | — |
| Weather | TrailSplits forecast | Open-Meteo |
| Trail photos | Google photo (if sent) → Wikimedia Commons → Wikipedia | map of the trail's area |
| Assistant | Grok via Puter.js | answer from the loaded data, with a retry button |

TrailSplits also provides round-trip loop planning (`/v1/roundtrips`) and outdoor points of interest (`/pois/v1/bbox`: parking, water, toilets, shelters, viewpoints and more). The app corrects two quirks in its data:
- **Lengths in km:** TrailSplits sometimes passes OSM's `distance` tag, which is in km, through as `distance_m`. The app detects this against the route's own extent, so no trail shows "0.0 km · ~0 min".
- **Long-route stubs:** some long routes are known only as a short stub, such as *Tour Monte Rosa*, which is really about 160 km. These show as "Multi-stage route" instead of a fake length.

Walking times use the DIN 33466 hiking formula (4.2 km/h, 300 m/h up, 500 m/h down) when the climb is known, and multi-day treks show days.

### Keys and settings

Defaults live in `js/config.js`. The footer's **⚙️ Settings** dialog saves per-device overrides for the Google Maps key, the TrailSplits key and the AI model, and merges them over those defaults.

- **Google Maps Platform:** the key in `js/config.js` was verified on 2026-10-11 for the Maps JavaScript API and Places API (New). It works on the website and inside the APK, whose origin is `http://127.0.0.1:8765`. The key is currently **unrestricted**. Before a public launch, restrict it by HTTP referrer to your site plus `http://127.0.0.1:8765/*` and `http://localhost:8765/*` for the APK.
- **TrailSplits:** works without a key, with 500 free credits per day per IP address. A trail search costs 1 credit, trail details 3, a planned loop 10, and weather is free. There is no public key. To get one, sign in at <https://trailsplits.com/api/console> (the free plan has 30,000 credits a month) and create a *browser* key (`ts_pub_…`) that allows your origins. Paste it into Settings or `js/config.js`. Never put a server key in client code.
- **Grok:** needs no key ([see below](#trail-assistant--grok-via-puterjs)).

### Trail photos

Google Places returns **no photos for the configured key**. A check on 2026-10-12 showed that Place Details with `fields=*` returns every field except `photos` and `reviews`, even for the Eiffel Tower. So each card tries these sources in order:

1. its Google Maps photo, if Google ever sends one (matched one-to-one by name);
2. a **Wikimedia Commons** photo taken near the trail;
3. the lead photo of a nearby lake, peak or park article on **Wikipedia**;
4. a **map of the trail's own area**.

For Commons, the app lists the 100 nearest files, looks up the best 20 and scores each one with `js/photos.js`:
- **Counts in a photo's favour:** scenery words (including German compounds like *Findelgletscher*), the trail's own name, and the town.
- **Never shown:** signposts, vehicles, streets, stations, buildings, plants and insects (detected by Latin species names), astronaut "View of Earth" shots, aircraft, paintings and people.
- **Skipped:** Swisstopo's aerial-survey TIFFs, which can fill 23 of the 24 nearest slots in Switzerland.
- **Reserved for one card:** a photo named after a trail (*Hörnliweg, Zermatt.jpg*) only appears on that trail's card.

Every photo is credited with its author and licence, and no photo appears twice on a page. Other safeguards:
- **Thumbnail size:** thumbnails use Wikimedia's standard 960 px width, because its image servers refuse non-standard widths.
- **Errors:** "too busy" answers are retried rather than remembered as "no photo", and an image that fails to load is replaced by the next candidate.
- **Loading:** lookups are lazy and cached for 30 days.

The rules are calibrated on **real** Commons and Wikipedia results around Zermatt, Saas-Fee, Cervinia, Alagna and Austin, saved in `test/fixtures/photo-pools.json` and checked by `test/photo-check.js`.

### Trail assistant — Grok via Puter.js

On the Trails page, **Ask** opens an assistant that answers *any* question. It runs on **Grok (xAI) through [Puter.js](https://docs.puter.com)**, which uses Puter's *user-pays* model. There is no API key; each user gets a free monthly AI allowance on their own Puter account. **The first question opens a one-time Puter sign-in window.** A guest account is created automatically, and the user can sign up later.

- **Nothing is canned:** every typed question and suggestion chip goes to Grok. A local data answer is shown only if the AI can't be reached (offline, sign-in closed or allowance used up), together with a retry button.
- **Tool calling:** as in Puter's Example 5, Grok can call real app tools, with up to 4 tool rounds per answer. The conversation keeps its context. The tools are:
  - `search_trails`, `get_trail_details` and `get_weather`;
  - `plan_loop_route`, which plans TrailSplits round trips and draws them on the map in purple;
  - `find_places_nearby`, for parking, water and similar places;
  - `update_trail_list`, `change_area`, `set_activity` and `open_trail`;
  - `get_my_activity`, which reads your tracked hikes.
- **Model:** **Grok 4.1 Fast** is the default and answers instantly. **Grok 4.7**, xAI's newest flagship, is one tap away in Settings. It is smarter, but averages about 16 s before its first word and uses about 10× more of each user's free allowance. If a model errors, the next Grok model is tried automatically.

### Hike tracker — no phantom distance

Tap **Track hike** on the Trails page. GPS jitter used to make a phone lying on a desk "walk" 0.2 mi. Now distance only counts when you really move:

1. fixes less accurate than ±20 m are ignored;
2. movement is measured on the accuracy-weighted average of the last 5 fixes;
3. while you stand still, the app keeps averaging *where you are*, and you must leave that spot by more than the combined GPS uncertainty (at least 10 m hiking or 15 m biking);
4. if the phone reports a speed of about 0, the move must be twice as big;
5. two consecutive readings must confirm that you left and keep moving away;
6. GPS spikes faster than 6 m/s hiking or 18 m/s biking are dropped;
7. 45 s without movement auto-pauses the clock. Your own **Pause** really pauses: walking while paused adds nothing.

`test/tracker-stress.js` checks this against the real code. 42 ten-minute "phone on a desk" runs with ±4–22 m of jitter record **0.0 m**, while walking and biking are counted at 97–99 %. Tracking only runs after you start it, never in the background.

### Device awareness

`js/app.js` detects iPhone and iPad (including iPadOS pretending to be a Mac), Android, Windows, macOS and Linux. It uses this to tailor directions links (Apple Maps first on Apple devices, Google Maps elsewhere) and install instructions.

## Project structure

```text
index.html  start.html  trails.html  social.html   the four pages
manifest.webmanifest                               installable web-app manifest
css/styles.css                                     all styles
js/config.js       defaults: API keys, AI models, default location (Zermatt)
js/app.js          shared shell: header, bottom nav, footer, Settings, device detection,
                   back-gesture overlays, location prompts, formatting helpers
js/home.js  js/start.js  js/social.js              page scripts
js/trails.js       trails, map, photos, weather, tracker and assistant
js/photos.js       photo scoring rules (shared with test/photo-check.js)
assets/            illustrations and app icon
vendor/leaflet/    bundled Leaflet (backup map)
android/           native Android shell, standalone APK build and the built APK (android/README.md)
test/              unit, stress and headless-browser tests, plus real captured API data
```

## Tests

```bash
# No dependencies
for f in js/*.js; do node --check "$f"; done
node test/dom-check.js                  # shared shell and helpers
node test/photo-check.js                # photo rules against REAL Wikimedia data (60 checks)

# jsdom
npm i jsdom@24 --prefix /tmp/t          # once
NODE_PATH=/tmp/t/node_modules node test/assistant-check.js   # Grok tool-calling loop (mocked Puter), map fallback, tracker
NODE_PATH=/tmp/t/node_modules node test/tracker-stress.js    # phantom-distance stress test

# Real headless Chromium (Linux; elsewhere set CHROME_PATH to an installed Chrome)
npm install --prefix test/browser       # once
node test/browser/site-check.mjs        # the website end to end: all pages, photos, assistant, GPS, back gesture (139 checks)
node test/browser/apk-check.mjs         # the same suite on the site INSIDE the APK, served by the app's own LocalServer (138 checks; needs unzip and a JDK)
```

[`test/browser/README.md`](test/browser/README.md) describes what the browser suites cover. They mock every third-party API by replaying **real** captured data from `test/fixtures/`: TrailSplits trails, plus Wikimedia Commons and Wikipedia results with their real URL formats. The mocks also behave like the real services:
- **Google** answers the way it really does for this key, without photos.
- **Wikimedia's image servers** refuse non-standard thumbnail widths, like the real ones.

So the suites run offline and can't be fooled by friendly fake data. The app's built-in web server also has its own JVM test, described in [`android/README.md`](android/README.md#tests).

## Android app

`android/dist/CalledIt-1.2.2.apk` ([download](https://github.com/henitj/CalledIt/raw/main/android/dist/CalledIt-1.2.2.apk)) is a native WebView shell around this same website. It uses only framework APIs, with no external libraries. Install it with "Install unknown apps" or `adb install -r`.

The app serves the bundled site from `http://127.0.0.1:8765`. On top of the website it adds:
- a back gesture that steps back through sheets and pages;
- the Puter sign-in window;
- a single native "turn on location" prompt;
- the system photo picker.

> **Upgrading from 1.2.1 or older: uninstall the old CalledIt once first.** The 1.2.1 signing key was lost when the build machine was reset, and Android only updates an app signed with the same key. The new key (`android/ci/debug.keystore`) is now kept in the repo, so every later build updates in place.

To build the APK, run `bash android/ci/build-apk.sh` (no Android Studio needed), or open `android/` in Android Studio. To build automatically on every push, copy `android/ci/apk-workflow.yml` to `.github/workflows/apk.yml`. The details are in [`android/README.md`](android/README.md).

## Known limitations

- **No Google photos:** Google sends none for the configured key, so photos come from Wikimedia Commons and Wikipedia. If the key's Google Cloud project starts returning photos, the app uses them first, with no code change.
- **TrailSplits without a key** allows 500 credits per day per IP address. Heavy use needs your own browser key ([keys](#keys-and-settings)).
- **AI allowance:** each user signs in to Puter once (a guest account works) and uses their own free monthly allowance. When the allowance runs out, the assistant answers from the loaded trail data and offers a retry.
- **The Google key is public and unrestricted:** it ships inside the page, so restrict it by HTTP referrer before a public launch.
- **The APK is signed with a debug key:** that's fine for sideloading but not for Google Play. For a store release, create a private release key and keep it out of the repo.

## Changelog

Versions 1.1.0 to 1.2.2 were developed in [PR #2](https://github.com/henitj/CalledIt/pull/2).

### 1.2.2

Tested: website 139/139 · APK 138/138 · photo rules 60/60 on real data.

- **Trail photos really show up now**, with the real services and not just test mocks. Google sends no photos for this key, and the old Wikimedia filter rejected almost every real title (*"Zermatt 2019.jpg"*, *"… - panoramio (53).jpg"*). The fix:
  - new photo rules in `js/photos.js`, calibrated on real Commons and Wikipedia results;
  - Wikipedia lead photos as a second source;
  - real photos in the top-rated strip too.
- **Real-world problems handled:** Swisstopo TIFF floods, astronaut photos, Wikimedia "too busy" errors (retried, never cached), Wikimedia's thumbnail-size rules, and images that fail to load (the next photo is tried).
- **Directions lead to the trailhead** (the route end nearest you), not to the middle of the route's area.
- **Home no longer scrolls sideways** on phones, plus small copy and layout fixes: credits, icons, chart labels, and a footer that stays clear of the Ask button.
- **New signing key:** see the uninstall note above.

### 1.2.1

- **Trail photos fixed:** a real photo of each trail (Google → Wikimedia Commons → trail-area map), shown full-width 16:9 on phones instead of tall narrow strips. No repeated stock pictures, credits are shown, and the details sheet opens with the trail's photo.
- **Trail lengths fixed:** no more "0.0 km · ~0 min" (km-tagged OSM routes) and no fake "1 km" for long-distance tours. Times are realistic, based on the climb (DIN 33466).
- **Taps while loading:** *Near me*, search and hike/bike taps made while an area is still loading are queued instead of silently ignored.
- **Assistant answers:** parking and water answers only include the kinds of place asked for, and unnamed spots get readable names.
- **Small fixes:** the fading "Got it" navigation hint no longer swallows taps on **Ask**, an empty profile picture no longer shows as a broken image, and the "📷 Edit" label is no longer clipped.

### 1.2.0

- **Back gesture:** goes back through pages and sheets instead of exiting. The manifest no longer opts into `OnBackInvokedCallback`, which on Android 13+ had stopped `onBackPressed()` from ever running.
- **Grok AI works in the app:** Puter's one-time sign-in window opens inside the app (WebView popup support) and hands the login back to the page.
- **Pages packaged correctly:** they now sit where the app looks for them (`assets/www/…`), and the build script refuses to produce an APK without them.
- **Location:** a single native "Turn on location" prompt. When you come back from Settings with location on, *Near me* and *Track hike* continue by themselves.
- **Sturdier built-in web server:** `LocalServer.java`, unit-tested on a JVM by `android/ci/LocalServerTest.java`.
- **Uploads and links:** profile photo upload via the system picker, and `target=_blank` links open in the browser or map apps.

### 1.1.0

- **Hike tracker:** a new *Track hike* feature that filters GPS readings, so there is no phantom distance.
- **Google Maps:** the primary map again.
- **Start page:** cartoon hiker and biker illustrations.
- **Details sheet:** a sticky ✕ that is always reachable.
- **Back gesture:** closes overlays instead of exiting.
- **Location:** a prompt to turn location on.
- **Community:** profile photo upload and fair litter points.
- **Assistant:** Grok answers custom questions and lives on the Trails page only.
- **Settings:** a new in-app Settings dialog.
- **Android:** the first Android project. *Its APK packaged the pages in the wrong folder and opened to "Not found"; 1.2.0 fixed this and the old file was removed.*

### 1.0

- First version of the website ([PR #1](https://github.com/henitj/CalledIt/pull/1)).

## Attribution

Trail & route data: [TrailSplits](https://trailsplits.com) · Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · backup map tiles © [CARTO](https://carto.com/attributions) / [OpenTopoMap](https://opentopomap.org) · map library [Leaflet](https://leafletjs.com) (BSD-2, `vendor/leaflet`) · Trail photos: [Wikimedia Commons](https://commons.wikimedia.org) photographers (credited on each photo) · Ratings: Google · Weather: Open-Meteo (CC BY 4.0) · AI assistant: xAI Grok via [Puter.js](https://docs.puter.com). The illustrations and photography-style images in `assets/` are AI-generated for this project.
