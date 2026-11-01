// SQL schema for the train-tracker SQLite database.
//
// The data model mirrors the Statistics Canada "Grain Supply Chain Dashboard"
// (GSCD), which reports three metrics derived from daily per-car "last known
// station" events supplied by the Ag Transport Coalition / Railinc:
//   1. cars entering / en route / exiting per destination corridor
//   2. cars' daily last known station (per station, per day)
//   3. cars dwelling >= 48h at a station
//
// Reference geography (stations, subdivisions) comes from Natural Resources
// Canada's National Railway Network (NRWN) geodata. Our own field captures
// (sightings + trips) link back to that geography.

export const SCHEMA = `
-- ── Generic JSON store (mirrors cdnreport's collections table) ─────────────
CREATE TABLE IF NOT EXISTS collections (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL
);

-- ── Reference geography (from NRWN) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS subdivisions (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  operator    TEXT,
  owner       TEXT,
  province    TEXT,
  source      TEXT DEFAULT 'NRWN'
);

CREATE TABLE IF NOT EXISTS stations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  tc_id       TEXT,          -- Transport Canada identifier
  station_type TEXT,         -- NRWN station type
  subdivision_id INTEGER REFERENCES subdivisions(id),
  lat         REAL,
  lon         REAL,
  province    TEXT,
  source      TEXT DEFAULT 'NRWN',
  UNIQUE(name, subdivision_id)
);

-- ── Grain movement (GSCD-shaped, from dv-vd.shinyapps.io download) ─────────
-- These come from the GSCD "Download Data" zip. Stations are identified by
-- name + lat/lon (the GSCD does not expose NRWN ids), so we store them inline.

CREATE TABLE IF NOT EXISTS grain_daily_station (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,           -- ISO date (YYYY-MM-DD)
  station     TEXT NOT NULL,           -- station name (GSCD "Event Station")
  province    TEXT,
  lat         REAL,
  lon         REAL,
  cars        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(day, station, province)
);

CREATE TABLE IF NOT EXISTS grain_corridor_flow (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,
  corridor    TEXT NOT NULL,
  entering    INTEGER NOT NULL DEFAULT 0,
  en_route    INTEGER NOT NULL DEFAULT 0,
  released    INTEGER NOT NULL DEFAULT 0,
  dwelling    INTEGER NOT NULL DEFAULT 0,
  UNIQUE(day, corridor)
);

CREATE TABLE IF NOT EXISTS grain_dwelling (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,
  station     TEXT NOT NULL,
  province    TEXT,
  lat         REAL,
  lon         REAL,
  cars        INTEGER NOT NULL DEFAULT 0,
  UNIQUE(day, station, province)
);

-- ── StatCan weekly open-data tables (Transport Canada grain performance) ───
-- Shape matches StatCan cubes: REF_DATE, GEO, Companies, Statistics/Indicator,
-- and optionally Commodities. VALUE is the numeric measure.
CREATE TABLE IF NOT EXISTS grain_carloadings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_date    TEXT NOT NULL,          -- ISO week start date (YYYY-MM-DD)
  geography   TEXT NOT NULL,          -- province / Canada
  company     TEXT,                   -- Canadian National / Canadian Pacific / BNSF / CSXT
  statistic   TEXT,                   -- e.g. "Cars loaded and billed, all systems"
  commodity   TEXT,                   -- e.g. "Coal" (present in 23100276)
  value       REAL,
  status      TEXT,                   -- StatCan data-quality symbol
  source_pid  TEXT,                   -- StatCan product id e.g. 23100275
  UNIQUE(ref_date, geography, company, statistic, commodity, source_pid)
);

-- ── Our own field captures ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trips (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  start_ts    TEXT NOT NULL,
  end_ts      TEXT,
  location    TEXT,
  note        TEXT
);

-- A raw video capture session (file on disk, metadata here).
CREATE TABLE IF NOT EXISTS captures (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id     INTEGER REFERENCES trips(id),
  file_path   TEXT NOT NULL,           -- source video file
  name        TEXT,                    -- short name/title (optional)
  captured_at TEXT,                    -- when the footage was actually shot (date/time)
  location    TEXT,
  note        TEXT,                    -- general notes
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending / processing / processed / failed
  width       INTEGER,                 -- source pixel width
  height      INTEGER,                 -- source pixel height
  fps         REAL,                    -- source frame rate
  duration    REAL,                    -- source duration (seconds)
  rotation    REAL,                    -- degrees of tilt correction applied at capture time
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))  -- upload date/time
);

-- A background processing job (upload -> analyze -> capture pipeline).
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id  INTEGER REFERENCES captures(id),
  kind        TEXT NOT NULL,           -- 'upload' | 'process' | 'analyze'
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued / running / done / failed
  detail      TEXT,                    -- JSON blob (progress, error, meta)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A single frame extracted from a capture (thumb kept on disk, data here).
CREATE TABLE IF NOT EXISTS frames (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  capture_id  INTEGER REFERENCES captures(id),
  file_path   TEXT NOT NULL,           -- frame image on disk
  ts          REAL,                    -- time offset in seconds within the video
  score       REAL,                    -- keep/quality score (higher = better car shot)
  blurred     INTEGER DEFAULT 0,       -- motion-blur flag
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sightings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id     INTEGER REFERENCES trips(id),
  capture_id  INTEGER REFERENCES captures(id),
  frame_id    INTEGER REFERENCES frames(id),
  ts          TEXT NOT NULL,
  image_path  TEXT,
  car_type    TEXT,             -- e.g. covered hopper (grain car), boxcar, tank car
  road_number TEXT,             -- reporting mark + car number, e.g. CN 123456
  mark_conf   REAL,             -- OCR confidence 0..1
  station_id  INTEGER REFERENCES stations(id),
  note        TEXT
);

CREATE INDEX IF NOT EXISTS idx_grain_station_day   ON grain_daily_station(day);
CREATE INDEX IF NOT EXISTS idx_grain_station_st    ON grain_daily_station(station);
CREATE INDEX IF NOT EXISTS idx_grain_flow_day      ON grain_corridor_flow(day);
CREATE INDEX IF NOT EXISTS idx_grain_dwelling_day  ON grain_dwelling(day);
CREATE INDEX IF NOT EXISTS idx_carloadings_date     ON grain_carloadings(ref_date);
CREATE INDEX IF NOT EXISTS idx_carloadings_geo      ON grain_carloadings(geography);
CREATE INDEX IF NOT EXISTS idx_sightings_ts        ON sightings(ts);
CREATE INDEX IF NOT EXISTS idx_sightings_road      ON sightings(road_number);
CREATE INDEX IF NOT EXISTS idx_frames_capture      ON frames(capture_id);
CREATE INDEX IF NOT EXISTS idx_stations_subdiv     ON stations(subdivision_id);
`