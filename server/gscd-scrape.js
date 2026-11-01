// Scrape the Statistics Canada Grain Supply Chain Dashboard (GSCD) for daily
// grain-movement data, and load it into SQLite.
//
// The GSCD is a Shiny app (not an open-data table) at:
//   https://dv-vd.shinyapps.io/71-607-x2023003_en/
// It exposes a single "Download Data" button that returns a zip of three CSVs.
// Because the download requires a live Shiny session, we drive a headless
// browser (Playwright) to click the button and capture the zip.
//
// Run:  node server/gscd-scrape.js
//
// The zip contains:
//   daily-corridor-data.csv                  -> grain_corridor_flow
//   daily-car-data-for-end-of-day-location.csv -> grain_daily_station
//   daily-car-data-for-48hr-dwelling-on.csv    -> grain_dwelling
//
// Downloads are cached under server/data/ so re-runs reuse the last capture.

import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'
import { chromium } from 'playwright'
import AdmZip from 'adm-zip'
import { openDb } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, 'data')
const CACHE = path.join(DATA_DIR, 'gscd-download.zip')
const APP_URL = 'https://dv-vd.shinyapps.io/71-607-x2023003_en/'

async function downloadZip() {
  if (process.env.SKIP_DOWNLOAD && fs.existsSync(CACHE)) {
    console.log(`Using cached ${CACHE} (SKIP_DOWNLOAD set)`)
    return CACHE
  }

  console.log('Launching headless browser...')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ acceptDownloads: true })
    console.log(`Navigating to ${APP_URL}`)
    await page.goto(APP_URL, { waitUntil: 'commit', timeout: 120000 })

    await page.waitForSelector('#downloadData', { timeout: 180000 })
    console.log('App loaded; waiting for it to settle...')
    await page.waitForTimeout(15000)

    const dlPromise = page.waitForEvent('download', { timeout: 120000 })
    await page.click('#downloadData')
    const dl = await dlPromise
    fs.mkdirSync(DATA_DIR, { recursive: true })
    await dl.saveAs(CACHE)
    console.log(`Downloaded -> ${CACHE} (${fs.statSync(CACHE).size} bytes)`)
    return CACHE
  } finally {
    await browser.close()
  }
}

// Minimal RFC-4180 CSV parser.
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length < 2) return []
  const header = splitLine(lines[0])
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const cells = splitLine(line)
    const rec = {}
    for (let j = 0; j < header.length; j++) rec[header[j]] = cells[j] ?? ''
    out.push(rec)
  }
  return out
}

function splitLine(line) {
  const out = []
  let cur = ''
  let inQ = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        } else inQ = false
      } else cur += c
    } else if (c === '"') inQ = true
    else if (c === ',') {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

function num(v) {
  if (v == null || v === '') return 0
  const n = Number(String(v).trim())
  return Number.isNaN(n) ? 0 : n
}

function readZipText(zip, entryName) {
  const e = zip.getEntries().find((x) => x.entryName === entryName)
  if (!e) throw new Error(`missing ${entryName} in zip`)
  return e.getData().toString('utf8')
}

async function main() {
  const zipPath = await downloadZip()
  const zip = new AdmZip(fs.readFileSync(zipPath))
  console.log('zip entries:', zip.getEntries().map((e) => e.entryName).join(', '))

  const db = openDb()

  // ── corridor flow ────────────────────────────────────────────────────────
  {
    const rows = parseCsv(readZipText(zip, 'daily-corridor-data.csv'))
    const ins = db.prepare(`
      INSERT INTO grain_corridor_flow (day, corridor, entering, en_route, released, dwelling)
      VALUES (@day, @corridor, @entering, @en_route, @released, @dwelling)
      ON CONFLICT(day, corridor) DO UPDATE SET
        entering = excluded.entering,
        en_route = excluded.en_route,
        released = excluded.released,
        dwelling = excluded.dwelling
    `)
    const tx = db.transaction((items) => {
      for (const r of items) {
        ins.run({
          day: r['Date'],
          corridor: r['Corridor'],
          entering: num(r['Cars_Entering']),
          en_route: num(r['Cars_Enroute']),
          released: num(r['Released_Loads']),
          dwelling: num(r['Cars_Dwelling']),
        })
      }
    })
    tx(rows.filter((r) => r['Date'] && r['Corridor']))
    console.log(`corridor: upserted ${rows.length} rows`)
  }

  // ── daily last-known station ─────────────────────────────────────────────
  {
    const rows = parseCsv(readZipText(zip, 'daily-car-data-for-end-of-day-location.csv'))
    const ins = db.prepare(`
      INSERT INTO grain_daily_station (day, station, province, lat, lon, cars)
      VALUES (@day, @station, @province, @lat, @lon, @cars)
      ON CONFLICT(day, station, province) DO UPDATE SET
        lat = excluded.lat,
        lon = excluded.lon,
        cars = excluded.cars
    `)
    const tx = db.transaction((items) => {
      for (const r of items) {
        ins.run({
          day: r['Date'],
          station: r['Event Station'],
          province: r['Province'] || null,
          lat: r['Station Latitude'] ? Number(r['Station Latitude']) : null,
          lon: r['Station Longitude'] ? Number(r['Station Longitude']) : null,
          cars: num(r['Cars_count']),
        })
      }
    })
    tx(rows.filter((r) => r['Date'] && r['Event Station']))
    console.log(`daily station: upserted ${rows.length} rows`)
  }

  // ── 48-hr dwelling ───────────────────────────────────────────────────────
  {
    const rows = parseCsv(readZipText(zip, 'daily-car-data-for-48hr-dwelling-on.csv'))
    const ins = db.prepare(`
      INSERT INTO grain_dwelling (day, station, province, lat, lon, cars)
      VALUES (@day, @station, @province, @lat, @lon, @cars)
      ON CONFLICT(day, station, province) DO UPDATE SET
        lat = excluded.lat,
        lon = excluded.lon,
        cars = excluded.cars
    `)
    const tx = db.transaction((items) => {
      for (const r of items) {
        ins.run({
          day: r['Date'],
          station: r['Event Station'],
          province: r['Province'] || null,
          lat: r['Station Latitude'] ? Number(r['Station Latitude']) : null,
          lon: r['Station Longitude'] ? Number(r['Station Longitude']) : null,
          cars: num(r['CarsNotMoving']),
        })
      }
    })
    tx(rows.filter((r) => r['Date'] && r['Event Station']))
    console.log(`dwelling: upserted ${rows.length} rows`)
  }

  const stats = {
    corridor: db.prepare('SELECT COUNT(*) n, MAX(day) d FROM grain_corridor_flow').get(),
    station: db.prepare('SELECT COUNT(*) n, MAX(day) d FROM grain_daily_station').get(),
    dwelling: db.prepare('SELECT COUNT(*) n, MAX(day) d FROM grain_dwelling').get(),
  }
  console.log('\nDone:')
  for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v.n} rows, latest ${v.d}`)
}

main().catch((e) => {
  console.error('FATAL', e.message)
  process.exit(1)
})