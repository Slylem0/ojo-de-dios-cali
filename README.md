# 👁️ Ojo de Dios · Cali

**A "god's-eye view" surveillance console for the sky over Cali, Valle del Cauca (Colombia). It shows live aircraft from public ADS-B transponders on top of Amazon Location Service imagery and 3D terrain, and replays the day's traffic from an archive the app records to S3.**

🔴 **Live map:** https://d1im1mt9hnfpi0.cloudfront.net · 🎬 **Demo video:** https://youtu.be/j7bAz1Dp_no

> *Ojo de Dios* ("God's Eye") is the surveillance system in *Fast & Furious 7*. Most of what a "spy satellite" console shows is public: every airliner broadcasts its position over ADS-B. This project points that idea at my city. It has a tactical HUD, FLIR, NVG and CRT sensor modes, detection boxes, and click-to-track. Every number on screen comes from real, open data.

Built for the AWS Builder Center **Weekend Challenge: Map it**. The visual language is inspired by Bilawal Sidhu's open-source [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) (MIT). This is a new, much smaller codebase written from scratch for this challenge.

---

## What you can explore

| | |
|---|---|
| ✈️ **Live aircraft** | Every ADS-B contact within 150 NM (≈280 km) of Cali, refreshed every 5 s and dead-reckoned in between so contacts glide. Colored by altitude. Military flags show in red. |
| 🎯 **Click-to-track** | The camera locks on and a trail is drawn. You get callsign, registration, type, altitude in ft and m, speed in kt and km/h, vertical rate, squawk, and distance to Cali and to SKCL airport. |
| 📍 **"Overflying…"** | While you track a plane, **Amazon Location reverse geocoding** tells you which comuna, municipality or department is below it right now, for example *"Comuna 3, Cali, Valle del Cauca"* or *"El Litoral del San Juan, Chocó"*. |
| ⏪ **Replay 3H** | An EventBridge rule archives a snapshot of the sky to S3 every minute. Replay scrubs through the last 3 hours of traffic, with interpolated motion and trails, so you can watch the SKCL approaches and the Pacific-coast corridor fill up. |
| 🌋 **Earthquakes** | One year of USGS seismic events within 300 km of Cali, sized by magnitude and colored by depth. The Pacific subduction zone shows up clearly. |
| 🛰️ **Sensors** | EO, NVG, FLIR (thermal false-color) and CRT. These are SVG filters on the WebGL canvas, so the HUD stays crisp. Shortcut keys: `1`–`4`. |
| 🗺️ **Basemaps** | Amazon Location **Satellite**, **Hybrid** and **Monochrome (dark)**, draped over 3D terrain. The Farallones de Cali rise from AWS Open Data elevation tiles. |
| 🔎 **Search & identify** | Amazon Location **geocoding**, biased to Cali, for any address, barrio or landmark. Clicking anywhere identifies the address under the cursor. |
| 📌 **Cali landmarks** | One-click flights to Cristo Rey, the Cerro de las Tres Cruces, the Farallones, SKCL, Estadio Pascual Guerrero and the Río Cauca. |

## Datasets

| Dataset | What's in it | How it's used |
|---|---|---|
| **ADS-B Exchange-compatible feed from [adsb.lol](https://adsb.lol)** (ODbL, no key) | ICAO24 hex, callsign, registration, type, lat/lon, baro altitude, ground speed, track, vertical rate, squawk, emergency and military flags | Live layer, plus a per-minute archive in S3 |
| **[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)**, Registry of Open Data on AWS | Global elevation in Terrarium PNG encoding | 3D terrain under the map (Andes, Farallones, Cauca valley) |
| **[USGS FDSN Event API](https://earthquake.usgs.gov/fdsnws/event/1/)** | Earthquake epicenter, magnitude, depth, time | Seismic layer |
| **Amazon Location Service**, Maps & Places v2 | Satellite and vector basemaps, geocoding, reverse geocoding | Basemap, search, "overflying" readout |

No personal data is used. ADS-B positions are broadcast publicly by aircraft and aggregated by a community network.

## Architecture

```
                         ┌───────────────────────────────┐
  EventBridge  ──1/min──▶│  Lambda  ojo-de-dios-aircraft │──fetch──▶ adsb.lol  (150 NM around Cali)
  (recorder)             │  Node 22, no dependencies     │
                         │                               │──PutObject──▶ S3  data/snapshots/YYYY-MM-DD/HHMM.json
  Browser ──GET ?live───▶│  Function URL (CORS)          │
          ──GET ?replay─▶│                               │◀─List/Get──── S3  (last N minutes → frames[])
                         └───────────────────────────────┘
     │
     ├── MapLibre GL ──▶ Amazon Location Maps v2   (Satellite / Hybrid / Monochrome, API key)
     ├── fetch ────────▶ Amazon Location Places v2 (geocode, reverse-geocode, API key)
     ├── raster-dem ───▶ s3://elevation-tiles-prod (Registry of Open Data on AWS)
     └── fetch ────────▶ USGS FDSN (earthquakes)

  Static site: S3 (private, /site) ──OAC──▶ CloudFront ──▶ https://d1im1mt9hnfpi0.cloudfront.net
```

**Why these pieces:**
- **Amazon Location Service** gives satellite imagery, a dark tactical basemap, geocoding and reverse geocoding behind one API key. The key is restricted to `geo-maps:*` and `geo-places:*` and to this site's referers, so it is safe to ship in a static page. There are no map SDK lock-ins: plain MapLibre GL plus REST calls.
- **Lambda Function URL** is the smallest possible backend. The upstream ADS-B API does not send CORS headers, so the Lambda proxies it. The same function is the **recorder** (EventBridge) and the **replay API** (S3 list and get), so it is one deployable unit. If the community feed hiccups, it retries once and then serves the latest S3 snapshot, so the map never goes dark.
- **S3** is the flight archive. One JSON per minute (~2 KB) is about 3 MB per day: cheap, append-only, and readable by Athena if you want to query a month of traffic later.
- **CloudFront + OAC** serves the static site from a private bucket over HTTPS.

## Reuse the pattern

The whole stack is about 1,200 lines of code with no build step and no npm dependencies at runtime. To point it at **your** city:

1. In `backend/index.mjs`, change `CENTER` (and `RADIUS_NM`).
2. In `web/app.js`, change `CALI`, `SKCL` and `POIS`.
3. Deploy:

```bash
# requires AWS CLI v2 with credentials; region defaults to us-east-1
./infra/deploy.sh all        # bucket, Lambda + URL, recorder, Location key, CloudFront, site
./infra/deploy.sh site       # re-upload the front end after edits
```

`deploy.sh` is idempotent plain AWS CLI, so you can read it top to bottom and see every resource it creates. For local development, run `python3 -m http.server 5173 --directory web` after a deploy. The Location key also allows `localhost`.

## Files

```
backend/index.mjs   Lambda: live proxy, S3 recorder, replay API
web/index.html      HUD layout + SVG sensor filters
web/style.css       Tactical styling, sensor modes, detection boxes
web/app.js          Map, layers, tracking, dead reckoning, replay, Amazon Location calls
web/config.js       Generated by deploy.sh (region, public Location key, API URL)
infra/deploy.sh     Plain AWS CLI deployment
```

## Credits

- Visual concept inspired by [God's Eye View](https://github.com/bilawalsidhu/gods-eye-view) by Bilawal Sidhu (MIT). No code was copied.
- Aircraft data © adsb.lol contributors (ODbL). Earthquakes: USGS. Terrain: Mapzen / AWS Open Data Terrain Tiles. Basemaps and places: Amazon Location Service (HERE, Esri and other providers per the map attribution).

MIT License.
