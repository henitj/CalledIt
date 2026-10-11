# CalledIt

**Call your next trail. Then go walk it.** A mobile-first web app (and Android app) that finds hiking and biking trails near you — with Google Maps, photos & ratings, live trailhead weather, a GPS hike tracker that doesn't invent distance, a **Grok-powered AI trail assistant (free via Puter.js — no API key)**, and community features that give back to the trails.

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
| `trails.html` | Trails — search or geolocate, signed routes with length (plus Google “hiking area” places where signed routes are scarce, e.g. most US cities), Google photos/ratings, weather strip, interactive **Google Maps** map, **Track hike** (GPS tracker that filters out phantom movement; the map docks under the tracker and follows you), trail details with elevation profile, and the **AI trail assistant** (this page only) powered by Grok. |
| `social.html` | Community — your profile (photo + name), Pack-It-Out pledge & litter log (sane points: 5/bag, capped), trail condition reports with kudos, cleanup days. |

## Data providers (automatic, with fallbacks)

1. **Google Maps Platform** — Maps JavaScript API for the interactive map, Places API (New) for photos + ratings (and as trail entries where TrailSplits/OSM have no signed routes). The key in `js/config.js` was verified on 2026‑10‑11: it authenticates for the Maps JavaScript API and Places API (New), is unrestricted, and works on the web **and** inside the APK (`http://127.0.0.1:8765`). If Google can't load, a bundled **Leaflet** map with clean CARTO / OpenTopoMap tiles takes over (pins, live track and planned loops still work) — the old plain OSM iframe is gone.
2. **TrailSplits API** — trails by bounding box, route relations, elevation profiles, place search, weather, **round-trip loop planning** (`/v1/roundtrips`) and **outdoor POIs** (`/pois/v1/bbox`: parking, water, toilets, shelters, viewpoints…). Keyless = 500 free credits/day per address; an optional key (Settings) is sent as `Authorization: Bearer …` per the TrailSplits docs.
3. **OpenStreetMap** — Overpass + Nominatim as automatic fallbacks for trail data and geocoding. **Open-Meteo** directly if the TrailSplits forecast is unreachable.

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
npm i jsdom@24 --prefix /tmp/t                           # once
NODE_PATH=/tmp/t/node_modules node test/assistant-check.js   # Grok tool-calling loop (mocked Puter), maps fallback, tracker
NODE_PATH=/tmp/t/node_modules node test/tracker-stress.js    # phantom-distance stress test
```

## Android app (APK)

`android/dist/CalledIt-1.2.0.apk` is a ready-to-install build of the native WebView shell around this same website (see [`android/README.md`](android/README.md)). It installs over earlier CalledIt builds (same signing key). v1.2.0:

* **back gesture** goes back through pages/sheets instead of exiting (the manifest no longer opts into `OnBackInvokedCallback`, which on Android 13+ stopped `onBackPressed()` from ever running)
* **Grok AI works**: Puter's one-time sign-in window opens inside the app (WebView popup support) and hands the login back to the page
* the bundled pages are packaged where the app looks for them (`assets/www/…`) — **the earlier 1.1.0 build had them in the wrong folder and showed “Not found”**; the build script now refuses to produce such an APK
* one native “Turn on location” prompt; when you come back from Settings with location on, *Near me* / *Track hike* continue by themselves
* a sturdier built-in web server (`LocalServer.java`, unit-tested on a JVM by `android/ci/LocalServerTest.java`)
* profile photo upload via the system picker; target=_blank links open in the browser / map apps

## Device awareness

`js/app.js` detects iPhone/iPad (including iPadOS pretending to be a Mac), Android, Windows, macOS and Linux, and tailors directions links (Apple Maps first on Apple devices, Google Maps elsewhere) plus install instructions.

## Attribution

Trail & route data: [TrailSplits](https://trailsplits.com) · Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · backup map tiles © [CARTO](https://carto.com/attributions) / [OpenTopoMap](https://opentopomap.org) · map library [Leaflet](https://leafletjs.com) (BSD-2, `vendor/leaflet`) · Photos & ratings: Google · Weather: Open-Meteo (CC BY 4.0) · AI assistant: xAI Grok via [Puter.js](https://docs.puter.com). Photography-style imagery in `assets/` is AI-generated for this project.
