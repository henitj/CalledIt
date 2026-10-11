# CalledIt

**Call your next trail. Then go walk it.** A mobile-first web app that finds signed hiking and biking trails near you — with Google Maps photos & ratings, live trailhead weather, a GPS hike tracker, an AI trail assistant (Grok), and community features that give back to the trails.

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
| `trails.html` | Trails — search or geolocate, signed routes with length, Google photos/ratings, weather strip, interactive **Google Maps** map, **Track hike** (GPS tracker that filters out phantom movement), trail details with elevation profile, and the **AI trail assistant** (this page only) powered by Grok. |
| `social.html` | Community — your profile (photo + name), Pack-It-Out pledge & litter log (sane points: 5/bag, capped), trail condition reports with kudos, cleanup days. |

## Data providers (automatic, with fallbacks)

1. **Google Maps Platform** — Maps JavaScript API for the interactive map (primary), Places API (New) for photos + ratings. Only falls back to an OpenStreetMap embed when the key is missing/rejected.
2. **TrailSplits API** — trail search by bounding box, route relations, elevation profiles, place search, weather (works keyless; add your key in **Settings → API keys** for more credits).
3. **OpenStreetMap** — Overpass + Nominatim used automatically as fallback for trail data when TrailSplits is unreachable.

**API keys** live in `js/config.js` and can be overridden per-device via the
**⚙️ API keys & settings** link in the footer (Google Maps, TrailSplits, Grok/xAI).
For production, restrict the Google key by HTTP referrer (add your web origin and,
for the APK, `http://localhost:8765/*` + `http://127.0.0.1:8765/*`) and enable
**Maps JavaScript API** and **Places API (New)**.

## The trail assistant (Grok)

On the Trails page, the **Ask** button opens an assistant that can answer *any*
question (“which of these is best with kids?”, “what should I pack for the long
one?”) — it calls the Grok (xAI) API grounded in the trails actually loaded on
the page. Quick commands (“easiest trails”, “under 8 km”, “weather this week”)
are handled instantly and also drive the list filters. Add a Grok key in
Settings → API keys to enable free-form answers.

## Hike tracker (no phantom distance)

Tap **Track hike** on the Trails page. Distance only accumulates from GPS fixes
that pass strict gates: accuracy ≤ 25 m, movement ≥ 8 m (hike) / 12 m (bike)
between points, implied speed below 6/15 m/s, and auto-pause after 60 s of
standing still. A phone sitting on a desk records **0 km**. Tracking runs only
while you’ve started it — never in the background.

## Android app (APK)

The `android/` folder is a native WebView shell around the same website, built
automatically by GitHub Actions (`.github/workflows/apk.yml`) — see
[`android/README.md`](android/README.md). It fixes the WebView-specific bugs:

* back gesture goes back through pages/modals instead of exiting the app
* after granting location permission it prompts to turn device location on
* profile photo upload uses the system file picker
* the site is served from `http://127.0.0.1:8765` so referrer-restricted Google keys work

## Device awareness

`js/app.js` detects iPhone/iPad (including iPadOS pretending to be a Mac), Android, Windows, macOS and Linux, and tailors directions links (Apple Maps first on Apple devices, Google Maps elsewhere) plus install instructions.

## Attribution

Trail & route data: [TrailSplits](https://trailsplits.com) · Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · Photos & ratings: Google · Weather: Open-Meteo (CC BY 4.0) · AI assistant: xAI Grok. Photography-style imagery in `assets/` is AI-generated for this project.
