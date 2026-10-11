# CalledIt

**Call your next trail. Then go walk it.** A mobile-first web app that finds signed hiking and biking trails near you — with Google Maps photos and ratings, live trailhead weather, an on-page trail assistant, and community features that give back to the trails.

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
| `index.html` | Home — intro, device detection summary (Apple/Android/desktop), big navigation cards. |
| `start.html` | Start — pick **hiker** or **biker** (real photos), SAC difficulty scale, pre-trip checklist. |
| `trails.html` | Trails — search or geolocate, signed routes with length, Google photos/ratings, weather strip, interactive map, trail details with elevation profile, and the **trail assistant** (lives on this page only). |
| `social.html` | Community — Pack-It-Out pledge, trail condition reports with kudos, cleanup days, roadmap ideas. |

## Data providers (automatic, with fallbacks)

1. **TrailSplits API** — trail search by bounding box, route relations, elevation profiles, place search, weather (500 free credits/day per address without a key; see `js/config.js`).
2. **OpenStreetMap** — Overpass + Nominatim used automatically as fallback when TrailSplits is unreachable.
3. **Google Maps Platform** — Places API (New) for photos + ratings, Maps JavaScript API for the interactive map (falls back to an OpenStreetMap embed if the key is unavailable/restricted).

The Google Maps key lives in `js/config.js`. For production, restrict it by HTTP referrer in Google Cloud Console and enable **Maps JavaScript API** and **Places API (New)**.

## Device awareness

`js/app.js` detects iPhone/iPad (including iPadOS pretending to be a Mac), Android, Windows, macOS and Linux, and tailors directions links (Apple Maps first on Apple devices, Google Maps elsewhere) plus install instructions.

## Attribution

Trail & route data: [TrailSplits](https://trailsplits.com) · Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors · Photos & ratings: Google · Weather: Open-Meteo (CC BY 4.0). Photography-style imagery in `assets/` is AI-generated for this project.
