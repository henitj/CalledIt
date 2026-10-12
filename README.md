# CalledIt

**Call your next trail. Then go walk it.** A mobile-first web app (and Android app) that finds hiking and biking trails near you — with Google Maps, real trail photos, Google ratings, live trailhead weather, a GPS hike tracker that doesn't invent distance, a **Grok-powered AI trail assistant (free via Puter.js — no API key)**, and community features that give back to the trails.

## Run it

Any static file server works:

```bash
cd CalledIt
python3 -m http.server 8000
# open http://localhost:8000
```

## Pages

| Page | What it does |
| --- | --- |
| `index.html` | Home — intro, device detection summary (Apple/Android/desktop), big navigation cards. (No AI here — the assistant lives on Trails only.) |
| `start.html` | Start — pick **hiker** or **biker** (cartoon illustrations), SAC difficulty scale, pre-trip checklist. |
| `trails.html` | Trails — search or geolocate, signed routes with length (plus Google “hiking area” places where signed routes are scarce, e.g. most US cities), real trail photos, Google ratings, weather strip, interactive **Google Maps** map, **Track hike** (GPS tracker that filters out phantom movement; the map docks under the tracker and follows you), trail details with elevation profile, and the **AI trail assistant** (this page only) powered by Grok. |
| `social.html` | Community — your profile (photo + name), Pack-It-Out pledge & litter log (sane points: 5/bag, capped), trail condition reports with kudos, cleanup days. |

## Data providers (automatic, with fallbacks)

1. **Google Maps Platform** — Maps JavaScript API for the interactive map, Places API (New) for ratings (and as trail entries where TrailSplits/OSM have no signed routes). The key in `js/config.js` was verified on 2026‑10‑11: it authenticates for the Maps JavaScript API and Places API (New), is unrestricted, and works on the web **and** inside the APK (`http://127.0.0.1:8765`). If Google can't load, a bundled **Leaflet** map with clean CARTO / OpenTopoMap tiles takes over (pins, live track and planned loops still work) — the old plain OSM iframe is gone.
2. **TrailSplits API** — trails by bounding box, route relations, elevation profiles, place search, weather, **round-trip loop planning** (`/v1/roundtrips`) and **outdoor POIs** (`/pois/v1/bbox`: parking, water, toilets, shelters, viewpoints…). Keyless = 500 free credits/day per address; an optional key (Settings) is sent as `Authorization: Bearer …` per the TrailSplits docs.
   **There is no public TrailSplits key** — keys are issued only after signing in at <https://trailsplits.com/api/console> (free plan: 30,000 credits/month). For a website/APK, create a *browser* key (`ts_pub_…`) and allow your origins, e.g. `https://<you>.github.io` and `http://127.0.0.1:8765` (the APK); never put a server key in client code. Typical use: a trail search costs 1 credit, opening trail details 3 (relation + elevation), a planned loop 10; weather is free.
   TrailSplits sometimes passes OSM's `distance` tag (which is in **km**) through as `distance_m`; the app detects that against the route's own extent, so such trails no longer show “0.0 km · ~0 min”. National/international routes that TrailSplits only knows as a short stub (e.g. *Tour Monte Rosa*, really ~160 km) show as “Multi-stage route” instead of a fake 1 km. Times use the DIN 33466 hiking formula (4.2 km/h, 300 m/h up, 500 m/h down) when the climb is known; multi-day treks show days.
3. **OpenStreetMap** — Overpass + Nominatim as automatic fallbacks for trail data and geocoding. **Open-Meteo** directly if the TrailSplits forecast is unreachable.
4. **Trail photos** — Google Places returns **no photos for the configured key** (checked 2026‑10‑12: Place Details with `fields=*` returns every field *except* `photos` and `reviews`, even for the Eiffel Tower), so each card shows, in order:
   1. its Google Maps photo, if Google ever sends one (matched one-to-one by name);
   2. a free **Wikimedia Commons** photo taken around the trail — the 100 nearest files are listed (Swisstopo's geotagged aerial-survey TIFFs can fill 23 of the 24 nearest slots in Switzerland), the best 20 JPEGs are looked up, and each is scored by `js/photos.js`: scenery words (incl. German compounds like *Grindjisee*, *Findelgletscher*), the trail's own name and the town count; signposts, vehicles, streets (*Bahnhofstrasse*), stations, buildings, plants and insects (Latin species names), astronaut “View of Earth” shots, aircraft, paintings, portraits and people never show. A photo named after a trail (*Hörnliweg, Zermatt.jpg*) is kept for that trail's card;
   3. the lead photo of a nearby lake / peak / park article on **Wikipedia**;
   4. a **map of the trail's own area**.
   Author + licence are credited on every photo, no photo appears twice, thumbnails are Wikimedia's standard 960 px size (other widths are refused by its CDN since 2026), Wikimedia's “too busy” answers are retried instead of being remembered as “no photo”, and lookups are lazy and cached for 30 days. The rules are calibrated on **real** Commons/Wikipedia results around Zermatt, Saas‑Fee, Cervinia, Alagna and Austin (`test/fixtures/photo-pools.json`, checked by `test/photo-check.js`). **Directions** go to the trailhead — the route end nearest you, taken from the route's geometry — not to the middle of its area.

Per-device overrides (Google key, TrailSplits key, AI model) live in the footer's **⚙️ Settings** dialog and are merged over `js/config.js`. If you ever restrict the Google key by HTTP referrer, add your web origin and, for the APK, `http://localhost:8765/*` + `http://127.0.0.1:8765/*`.

## The trail assistant — Grok via Puter.js (no API key)

On the Trails page, **Ask** opens an assistant that answers *any* question. It runs on **Grok (xAI) through [Puter.js](https://docs.puter.com)**, which uses Puter's *user-pays* model: no API key at all — each user gets a free monthly AI allowance on their own Puter account. The **first question opens a one-time Puter sign-in window** (a guest account is created automatically; they can sign up later).

* Every typed question and suggestion chip goes to Grok — nothing is canned. A local data answer is shown only if the AI can't be reached (offline, sign-in closed, allowance used up), together with a retry button.
* **Function/tool calling** (like Puter's Example 5): Grok can call real app tools — `search_trails`, `get_trail_details`, `get_weather`, `plan_loop_route` (TrailSplits round trips, drawn on the map in purple), `find_places_nearby` (parking/water/…), `update_trail_list`, `change_area`, `set_activity`, `open_trail`, `get_my_activity` (your tracked hikes). Up to 4 tool rounds per answer; the conversation keeps context.
* Model: **Grok 4.1 Fast** by default (instant answers). **Grok 4.7** — xAI's newest flagship — is one tap away in Settings; it is smarter but averages ~16 s before its first word and costs ~10× more of each user's free allowance. If a model errors, the next Grok model is tried automatically.

## Hike tracker (no phantom distance)

Tap **Track hike** on the Trails page. GPS jitter is what made a phone lying on a desk “walk” 0.2 mi. Distance now only counts when you really move:

1. fixes worse than ±20 m are ignored;
2. movement is measured on the accuracy-weighted average of the last 5 fixes;
3. while you stand still the app keeps averaging *where you are*, and you must leave that spot by more than the combined GPS uncertainty (≥ 10 m hiking / 15 m biking);
4. if the phone reports ~0 speed, the move must be twice as big;
5. two consecutive readings must confirm you left and keep moving away;
6. GPS spikes (faster than 6 m/s hiking / 18 m/s biking) are dropped;
7. 45 s without movement auto-pauses the clock; your own **Pause** really pauses (walking while paused adds nothing).

`test/tracker-stress.js` checks this against the real code: 42 ten-minute “phone on a desk” runs (±4–22 m jitter) record **0.0 m**, while walking/biking is counted at 97–99 %. Distances show in miles for US users. Tracking runs only after you start it — never in the background.

## Tests

```bash
for f in js/*.js; do node --check "$f"; done
node test/dom-check.js                                   # shell + helpers (no deps)
node test/photo-check.js                                 # photo rules vs REAL Wikimedia data (no deps)
npm i jsdom@24 --prefix /tmp/t                           # once
NODE_PATH=/tmp/t/node_modules node test/assistant-check.js   # Grok tool-calling loop (mocked Puter), maps fallback, tracker
NODE_PATH=/tmp/t/node_modules node test/tracker-stress.js    # phantom-distance stress test
cd test/browser && npm install                           # once — headless Chromium
node test/browser/site-check.mjs                         # real-browser end-to-end: all pages, photos, assistant, GPS, back gesture (139 checks)
node test/browser/apk-check.mjs                          # the same suite against the site INSIDE the APK, served by the app's LocalServer (138 checks)
```

See [`test/browser/README.md`](test/browser/README.md) for what the browser suites cover. All third-party APIs are mocked there, replaying **real** captured data (`test/fixtures/`: TrailSplits trails, Wikimedia Commons and Wikipedia results with their real URL formats); Google is mocked the way it really answers this key — without photos — and Wikimedia's image hosts refuse non-standard thumbnail widths like the real CDN. So the suites run offline and can't be fooled by friendly fake data again.

## Android app (APK)

`android/dist/CalledIt-1.2.2.apk` is a ready-to-install build of the native WebView shell around this same website (see [`android/README.md`](android/README.md)).

> **Installing 1.2.2 over 1.2.1: uninstall the old CalledIt first (once).** The signing key of 1.2.1 was lost when the build machine was reset, and Android only updates an app with the same key. The new key (`android/ci/debug.keystore`) is now kept in the repo, so every later build updates in place.

v1.2.2 (website 139/139 · APK 138/138 · photo rules 60/60 on real data):

* **trail photos really show up now** — with the real services (not just test mocks): Google sends no photos for this key, and the old Wikimedia filter rejected almost every real title (*“Zermatt 2019.jpg”*, *“… - panoramio (53).jpg”*). New photo rules in `js/photos.js`, calibrated on real Commons/Wikipedia results; Wikipedia lead photos as a second source; the top-rated strip gets real photos too
* survives the real world: Swisstopo TIFF floods, astronaut photos, Wikimedia “too busy” errors (retried, never cached), 2026 thumbnail-size rules, images that fail to load (next photo is tried)
* **Directions lead to the trailhead** (the route end nearest you), not the middle of the route's area
* Home no longer scrolls sideways on phones; small copy and layout polish (credits, icons, chart labels, footer clear of the Ask button)

v1.2.1:

* **trail photos fixed** — a real photo of each trail (Google → Wikimedia Commons → trail-area map), full-width 16:9 on phones instead of tall narrow strips, no repeated stock pictures, credits shown; the details sheet opens with the trail's photo
* **trail lengths fixed** — no more “0.0 km · ~0 min” (km-tagged OSM routes), no fake “1 km” for long-distance tours, realistic times from the climb (DIN 33466)
* “Near me” / search / hike-bike taps made while an area is still loading are queued instead of silently ignored
* the assistant's parking/water answers use only the kinds asked for, with readable names for unnamed spots
* the “Got it” navigation hint no longer swallows taps on **Ask** while it fades out; the empty profile picture no longer shows as a broken image; “📷 Edit” label no longer clipped

v1.2.0:

* **back gesture** goes back through pages/sheets instead of exiting (the manifest no longer opts into `OnBackInvokedCallback`, which on Android 13+ stopped `onBackPressed()` from ever running)
* **Grok AI works**: Puter's one-time sign-in window opens inside the app (WebView popup support) and hands the login back to the page
* the bundled pages are packaged where the app looks for them (`assets/www/…`) — **the earlier 1.1.0 build had them in the wrong folder and showed “Not found”**; the build script now refuses to produce such an APK
* one native “Turn on location” prompt; when you come back from Settings with location on, *Near me* / *Track hike* continue by themselves
* a sturdier built-in web server (`LocalServer.java`, unit-tested on a JVM by `android/ci/LocalServerTest.java`)
* profile photo upload via the system picker; target=_blank links open in the browser / map apps

## Device awareness

`js/app.js` detects iPhone/iPad (including iPadOS pretending to be a Mac), Android, Windows, macOS and Linux, and tailors directions links (Apple Maps first on Apple devices, Google Maps elsewhere) plus install instructions.

## Attribution

Trail & route data: [TrailSplits](https://trailsplits.com) · Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · backup map tiles © [CARTO](https://carto.com/attributions) / [OpenTopoMap](https://opentopomap.org) · map library [Leaflet](https://leafletjs.com) (BSD-2, `vendor/leaflet`) · Trail photos: [Wikimedia Commons](https://commons.wikimedia.org) photographers (credited on each photo) · Ratings: Google · Weather: Open-Meteo (CC BY 4.0) · AI assistant: xAI Grok via [Puter.js](https://docs.puter.com). Photography-style imagery in `assets/` is AI-generated for this project.
