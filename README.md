# train-tracker

A personal project to capture, collect, and curate images of graffiti on passing freight and
grain rail cars through the Fraser Valley (near Vancouver, BC).

The app also ingests reference rail data from the Government of Canada:

- **Weekly grain transportation (open data)** — `server/grain-ingest.js` pulls Transport Canada
  tables from StatCan's Web Data Service (products `23100275` and `23100276`), into
  `grain_carloadings`.
- **NRWN (National Railway Network)** — station/subdivision geography from Natural Resources
  Canada, used as the reference frame for where grain cars are and where sightings happen.
- **Grain Supply Chain Dashboard (GSCD)** — the "real-time" daily per-car metrics (corridor
  flows, last-known-station, dwelling) live behind a Shiny app (`dv-vd.shinyapps.io`); see
  `server/gscd-scrape.js`.

## Stack

Vite + Vue 3 + Vue Router (hash), with a small Express backend (`server/proxy.js`) backed by
SQLite (`better-sqlite3`). This mirrors the structure of the `cdnreport` project.

## Project Setup

```sh
npm install
```

### Run (dev server + backend together)

```sh
npm run dev:all
```

Or separately:

```sh
npm run dev      # Vite frontend on :5173
npm run proxy    # Express + SQLite backend on :3001
```

### Ingest weekly grain data (open data)

```sh
node server/grain-ingest.js            # 23100275 + 23100276
node server/grain-ingest.js 23100275   # a specific product id
```

Downloads the StatCan CSV zip and upserts into `grain_carloadings`.

### Ingest daily grain movement (GSCD "real-time")

```sh
node server/gscd-scrape.js
```

Drives a headless browser (Playwright) to open the Grain Supply Chain Dashboard,
click its "Download Data" button, and load the resulting zip into the three GSCD
tables (`grain_corridor_flow`, `grain_daily_station`, `grain_dwelling`). The
download is cached under `server/data/`; set `SKIP_DOWNLOAD=1` to reuse it.

### Ingest reference geography

```sh
node server/collector.js
```
If the download is blocked, fetch the BC file manually from
https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_nrwn_rfn/ and drop it in
`server/data/`, then re-run.

### Capture a train video

```sh
npm run capture -- /path/to/video.mp4 --interval 1.0 --location "Coquitlam"
```

Splits the video into frames (`ffmpeg-static`), scores them for sharpness, OCRs the
reporting marks (`tesseract.js`), dedups by mark, and writes `sightings`. Raw video
is kept under `storage/videos/`, frames under `storage/frames/<captureId>/`, and all
metadata/OCR results go to SQLite. Flags: `--interval` (seconds between frames),
`--min-score` (0..1 sharpness threshold), `--location`, `--note`.

### Compile and Minify for Production

```sh
npm run build
```

## Database schema

Defined in `server/schema.js`:

| Table | Purpose |
| --- | --- |
| `subdivisions` | Railway subdivisions (NRWN reference geography) |
| `stations` | Railway stations with lat/lon + subdivision + TC id |
| `grain_corridor_flow` | Per-corridor daily cars entering / en route / released / dwelling |
| `grain_daily_station` | Daily cars at their "last known station" (name + lat/lon) |
| `grain_dwelling` | Daily count of cars dwelling >= 48h per station |
| `grain_carloadings` | Weekly Transport Canada grain data (geography/company/statistic/commodity) |
| `captures` | A raw video capture session (file path + status on disk) |
| `frames` | An extracted frame with sharpness score + blur flag |
| `trips` | Our own recording sessions |
| `sightings` | Individual car captures (photo, road number, OCR confidence) |
| `collections` | Generic JSON store (mirrors cdnreport) |

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/stations` | All stations (optionally `?province=BC`) |
| `GET /api/subdivisions` | All subdivisions |
| `GET /api/grain/corridor-flow` | Grain corridor flow (optionally `?from=&to=`) |
| `GET /api/grain/by-station` | Cars by last-known station (optionally `?day=`) |
| `GET /api/grain/dwelling` | Dwelling cars by station (optionally `?day=`) |
| `GET /api/grain/carloadings` | Weekly carloadings (filter by `?geography=&company=&statistic=&from=&to=&limit=`) |
| `GET /api/grain/carloadings/overview` | Distinct geography/company/statistic summaries (optionally `?geography=`) |
| `GET/POST /api/sightings` | List / record a car sighting |
| `GET /api/captures` | List capture sessions |
| `GET /api/captures/:id` | A capture with its frames + sightings |
| `GET /api/trips` | List trips |
| `GET /api/trips` (POST) | Record a trip |