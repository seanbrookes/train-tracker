// Ingest the reference rail geography (stations + subdivisions) into SQLite.
//
// Source: Natural Resources Canada "National Railway Network (NRWN)" open data.
// Provincial pre-packaged files (Shapefile / KML / GML) are served from
//   https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_nrwn_rfn/
// The station feature class ("Railway Station") carries name, Transport Canada
// identifier, station type/user, and subdivision name.
//
// Run:  node server/collector.js
//
// This script prefers the KML export (single XML file, no sidecar files). It
// will look for the BC KML under the NRWN download directory. If the file is
// not already cached locally under server/data/, it attempts to fetch it.

import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import { openDb } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'server', 'data')

const NRWN_BASE = 'https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_nrwn_rfn'

// NRWN directories are laid out per province. BC's directory and station file
// names vary by release; the collector looks for cached files first, then tries
// a small set of known URL shapes.
const CANDIDATES = [
  `${NRWN_BASE}/bc/nrwn_rfn_bc_station.kml`,
  `${NRWN_BASE}/bc/nrwn_rfn_bc_station.gml`,
  `${NRWN_BASE}/nrwn_rfn_bc_station.kml`,
]

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

async function loadXml(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

// Parse KML/GML <Placemark> entries for stations. Handles a loose subset of
// GeoBase KML (name + point coordinates + ExtendedData attributes).
function parseStations(xml) {
  const stations = []
  const placemarkRe = /<Placemark[\s\S]*?<\/Placemark>/g
  let m
  while ((m = placemarkRe.exec(xml)) !== null) {
    const block = m[0]
    const name = (block.match(/<name>([\s\S]*?)<\/name>/) || [])[1]?.trim()
    const coord = (block.match(/<Point[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/) || [])[1]
    if (!name || !coord) continue
    const [lon, lat] = coord.trim().split(',').map(Number)
    if (lon == null || lat == null) continue

    // Pull a few known attributes out of ExtendedData/Data or SchemaData tags.
    const pick = (key) => {
      const re = new RegExp(`<Data name=["']${key}["']>\\s*<value>([\\s\\S]*?)</value>`, 'i')
      return (block.match(re) || [])[1]?.trim() || null
    }
    stations.push({
      name,
      lon,
      lat,
      tc_id: pick('TCID') ?? pick('tc_id'),
      station_type: pick('STNTYPE') ?? pick('station_type'),
      subdivision: pick('SUBDIVISION') ?? pick('subdivision_name'),
      province: 'BC',
    })
  }
  return stations
}

async function main() {
  ensureDataDir()
  const db = openDb()

  let xml = null
  let source = null

  // Prefer a locally cached download.
  const cached = fs.readdirSync(DATA_DIR).find((f) => /station/i.test(f))
  if (cached) {
    xml = fs.readFileSync(path.join(DATA_DIR, cached), 'utf8')
    source = cached
    console.log(`Using cached station file: ${cached}`)
  } else {
    for (const url of CANDIDATES) {
      try {
        console.log(`Fetching ${url}`)
        xml = await loadXml(url)
        const file = path.basename(url)
        fs.writeFileSync(path.join(DATA_DIR, file), xml, 'utf8')
        source = file
        break
      } catch (e) {
        console.warn(`  failed: ${e.message}`)
      }
    }
  }

  if (!xml) {
    console.error(
      'No NRWN station file available.\n' +
        'Download the BC bitkml/gml manually from\n' +
        '  https://ftp.maps.canada.ca/pub/nrcan_rncan/vector/geobase_nrwn_rfn/\n' +
        'and place it in server/data/, then re-run.',
    )
    process.exit(1)
  }

  const stations = parseStations(xml)
  console.log(`Parsed ${stations.length} station placemarks from ${source}`)

  const subDivLookup = {}
  const getSub = (name) => {
    if (!name) return null
    if (subDivLookup[name] !== undefined) return subDivLookup[name]
    let row = db.prepare('SELECT id FROM subdivisions WHERE name = ?').get(name)
    if (!row) {
      const info = db
        .prepare('INSERT INTO subdivisions (name, province) VALUES (?, ?)')
        .run(name, 'BC')
      row = { id: info.lastInsertRowid }
    }
    subDivLookup[name] = row.id
    return row.id
  }

  const insertStmt = db.prepare(`
    INSERT INTO stations (name, tc_id, station_type, subdivision_id, lat, lon, province, source)
    VALUES (@name, @tc_id, @station_type, @subdivision_id, @lat, @lon, @province, 'NRWN')
    ON CONFLICT(name, subdivision_id) DO UPDATE SET
      tc_id = excluded.tc_id,
      station_type = excluded.station_type,
      lat = excluded.lat,
      lon = excluded.lon,
      province = excluded.province
  `)

  const tx = db.transaction((rows) => {
    let inserted = 0
    for (const s of rows) {
      const subdivision_id = getSub(s.subdivision)
      insertStmt.run({ ...s, subdivision_id })
      inserted++
    }
    return inserted
  })

  const inserted = tx(stations)
  const stationCount = db.prepare('SELECT COUNT(*) AS n FROM stations').get().n
  const subCount = db.prepare('SELECT COUNT(*) AS n FROM subdivisions').get().n
  console.log(`Upserted ${inserted} stations.`)
  console.log(`DB now has ${stationCount} stations, ${subCount} subdivisions.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})