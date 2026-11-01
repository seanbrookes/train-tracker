// Ingest StatCan open-data rail/grain tables into SQLite.
//
// These are the *published* Transport Canada weekly tables (the cleanest,
// stable access vector — verified live). The daily "real-time" per-car data in
// the Grain Supply Chain Dashboard is NOT here (that lives behind a Shiny app;
// see server/gscd-scrape.js).
//
// Relevant product ids (verified):
//   23100275  Weekly performance indicators of grain transportation by rail
//   23100274  Weekly rail terminal performance indicator
//   23100276  Weekly rail system performance indicators, by commodities
//   23100277  Weekly rail system performance indicator, by type of rail car
//
// Run:  node server/grain-ingest.js [pid ...]
//
// Flow:
//   POST  /t1/wds/rest/getFullTableDownloadCSV/<pid>/en
//      -> { "object": "https://.../n1/tbl/csv/<pid>-eng.zip" }
//   GET the zip, extract the CSV, parse, upsert into grain_carloadings.

import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'fs'
import AdmZip from 'adm-zip'
import { openDb } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DATA_DIR = path.join(ROOT, 'server', 'data')

const WDS_BASE = 'https://www150.statcan.gc.ca/t1/wds/rest'
// Default tables. 23100274 (terminal dwell-time, hourly values) and 23100277
// (by rail-car type) have different shapes and can be requested explicitly.
const DEFAULT_PIDS = ['23100275', '23100276']

const UA = 'train-tracker/0.1 (personal project)'

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
}

async function resolveZipUrl(pid) {
  const res = await fetch(`${WDS_BASE}/getFullTableDownloadCSV/${pid}/en`, {
    headers: { 'User-Agent': UA },
  })
  if (!res.ok) throw new Error(`resolve ${pid}: HTTP ${res.status}`)
  const body = await res.json()
  const url = body?.object
  if (!url) throw new Error(`resolve ${pid}: no object URL in ${JSON.stringify(body).slice(0, 200)}`)
  return url
}

async function download(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

async function ingestPid(pid, db) {
  console.log(`\n== ${pid} ==`)
  const zipUrl = await resolveZipUrl(pid)
  console.log(`  zip: ${zipUrl}`)

  const cacheFile = path.join(DATA_DIR, `${pid}-eng.zip`)
  let buf
  if (fs.existsSync(cacheFile) && fs.statSync(cacheFile).size > 0) {
    console.log(`  using cached ${cacheFile}`)
    buf = fs.readFileSync(cacheFile)
  } else {
    buf = await download(zipUrl)
    fs.writeFileSync(cacheFile, buf)
    console.log(`  downloaded ${(buf.length / 1024).toFixed(1)} KB -> ${cacheFile}`)
  }

  const zip = new AdmZip(buf)
  const entry = zip.getEntries().find((e) => e.entryName.endsWith('.csv') && !/_MetaData/i.test(e.entryName))
  if (!entry) throw new Error(`no data CSV in ${pid} zip`)

  const csvText = entry.getData().toString('utf8')
  const rawRows = parseCsv(csvText)
  console.log(`  parsed ${rawRows.length} rows`)

  const rows = rawRows
    .map((r) => ({
      ref_date: r['REF_DATE'] ?? null,
      geography: r['GEO'] ?? null,
      company: r['Companies'] ?? null,
      statistic: r['Statistics'] ?? r['Indicator'] ?? null,
      commodity: r['Commodities'] ?? null,
      value: toValue(r['VALUE']),
      status: r['STATUS'] || null,
      source_pid: pid,
    }))
    .filter((r) => r.ref_date)

  const insert = db.prepare(`
    INSERT INTO grain_carloadings (ref_date, geography, company, statistic, commodity, value, status, source_pid)
    VALUES (@ref_date, @geography, @company, @statistic, @commodity, @value, @status, @source_pid)
    ON CONFLICT(ref_date, geography, company, statistic, commodity, source_pid) DO UPDATE SET
      value = excluded.value,
      status = excluded.status
  `)

  const tx = db.transaction((items) => {
    let n = 0
    for (const it of items) {
      insert.run(it)
      n++
    }
    return n
  })

  const n = tx(rows.filter((r) => r.value != null))
  console.log(`  upserted ${n} rows into grain_carloadings`)
  return n
}

// Minimal RFC-4180 CSV parser (handles quoted fields + commas).
function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.length === 0) return []
  const header = csvSplit(lines[0])
  const out = []
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const cells = csvSplit(line)
    const rec = {}
    for (let j = 0; j < header.length; j++) rec[header[j]] = cells[j] ?? ''
    out.push(rec)
  }
  return out
}

function csvSplit(line) {
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
    } else if (c === '"') {
      inQ = true
    } else if (c === ',') {
      out.push(cur)
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur)
  return out
}

function toValue(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (s === '..' || s === '...' || s === '' || s === null) return null
  const n = Number(s.replace(/,/g, ''))
  return Number.isNaN(n) ? null : n
}

async function main() {
  ensureDataDir()
  const db = openDb()
  const pids = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_PIDS

  let total = 0
  for (const pid of pids) {
    try {
      const rows = await ingestPid(pid, db)
      total += rows
    } catch (e) {
      console.error(`  FAILED ${pid}: ${e.message}`)
    }
  }

  const count = db.prepare('SELECT COUNT(*) AS n FROM grain_carloadings').get().n
  const latest = db
    .prepare('SELECT MAX(ref_date) AS d, MIN(ref_date) AS lo FROM grain_carloadings')
    .get()
  console.log(`\nDone. grain_carloadings now has ${count} rows (${latest.lo} .. ${latest.d}).`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})