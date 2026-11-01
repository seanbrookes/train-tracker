import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import express from 'express'
import cors from 'cors'
import multer from 'multer'
import { openDb } from './db.js'
import { probeMeta, extractFrameAt, extractFilmstrip, rotateImage, cropImage } from './capture/media.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.env.PROXY_PORT ?? 3001)

const db = openDb()

const app = express()
app.use(cors({ origin: 'http://localhost:5173' }))
app.use(express.json({ limit: '50mb' }))

// Serve captured frame images from storage (so the frontend can show them).
app.use('/media', express.static(path.join(ROOT, 'storage')))

// ── Uploads (streaming to disk via multer) ──────────────────────────────────
const UPLOAD_DIR = path.join(ROOT, 'storage', 'inbox')
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 4 * 1024 * 1024 * 1024 } })

// ── Upload + process ────────────────────────────────────────────────────────
// POST /api/upload  (multipart, field "video") -> saves, analyzes, processes.
// Returns { captureId, jobId } immediately; processing runs in the background.
app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no video file in field "video"' })

  const src = req.file.path
  // Give the file a meaningful extension from the original name.
  const ext = path.extname(req.file.originalname || '') || '.mov'
  const stored = src + ext
  fs.renameSync(src, stored)

  const location = req.body?.location || null
  const note = req.body?.note || null
  const name = req.body?.name || null
  const captured_at = req.body?.captured_at || null

  // Archive the full video into storage/videos, keeping it intact (no sampling).
  const videosDir = path.join(ROOT, 'storage', 'videos')
  fs.mkdirSync(videosDir, { recursive: true })
  const archived = path.join(videosDir, `${Date.now()}-${req.file.originalname || path.basename(stored)}`)
  fs.renameSync(stored, archived)

  // Analyze (resolution / fps / duration) so the scrub view knows the video.
  let meta = null
  try {
    meta = await probeMeta(archived)
  } catch (e) {
    meta = { error: e.message }
  }

  // Register the capture as ready-to-scrub (no auto frame extraction).
  const cap = db
    .prepare(
      `INSERT INTO captures (file_path, name, captured_at, location, note, status, width, height, fps, duration)
       VALUES (?, ?, ?, ?, ?, 'processed', ?, ?, ?, ?)`,
    )
    .run(archived, name, captured_at, location, note, meta?.width ?? null, meta?.height ?? null, meta?.fps ?? null, meta?.duration ?? null)
  const captureId = cap.lastInsertRowid

  res.json({ captureId, meta })
})

// ── Static image upload ──────────────────────────────────────────────────────
// POST /api/upload/image (multipart, field "image") -> a single still photo.
// A still photo is already "sighting-ready": store it, record capture metadata,
// and create a sighting immediately (no frame extraction / scoring).
const IMAGE_DIR = path.join(ROOT, 'storage', 'images')
fs.mkdirSync(IMAGE_DIR, { recursive: true })
const imageUpload = multer({ dest: IMAGE_DIR, limits: { fileSize: 64 * 1024 * 1024 } })

app.post('/api/upload/image', imageUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no image file in field "image"' })

  const src = req.file.path
  const ext = path.extname(req.file.originalname || '') || '.jpg'
  const stored = src + ext
  fs.renameSync(src, stored)

  const location = req.body?.location || null
  const note = req.body?.note || null
  const carType = req.body?.carType || 'covered hopper'
  const roadNumber = req.body?.roadNumber || null

  // Probe dimensions (probeMeta reads width/height from stills too).
  let meta = null
  try {
    meta = await probeMeta(stored)
  } catch {
    meta = {}
  }

  const cap = db
    .prepare(
      `INSERT INTO captures (file_path, location, note, status, width, height)
       VALUES (?, ?, ?, 'processed', ?, ?)`,
    )
    .run(stored, location, note, meta?.width ?? null, meta?.height ?? null)
  const captureId = cap.lastInsertRowid

  const sight = db
    .prepare(
      `INSERT INTO sightings (trip_id, capture_id, frame_id, ts, image_path, car_type, road_number, mark_conf, station_id, note)
       VALUES (null, ?, null, ?, ?, ?, ?, null, null, ?)`,
    )
    .run(captureId, new Date().toISOString(), stored, carType, roadNumber, note)
  const sightingId = sight.lastInsertRowid

  res.json({ captureId, sightingId, meta })
})

// GET /api/analyze?path=<abs video path> -> probe resolution/fps/duration only.
app.get('/api/analyze', async (req, res) => {
  const { path: p } = req.query
  if (!p || !fs.existsSync(p)) return res.status(400).json({ error: 'missing or nonexistent path' })
  try {
    res.json(await probeMeta(p))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/jobs -> recent jobs; GET /api/jobs/:id -> one job.
app.get('/api/jobs', (req, res) => {
  res.json(db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT 50').all())
})

app.get('/api/jobs/:id', (req, res) => {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id)
  if (!job) return res.status(404).json({ error: 'job not found' })
  res.json(job)
})

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/db/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() })
})

// ── Stations & subdivisions (NRWN reference geography) ─────────────────────
app.get('/api/stations', (req, res) => {
  const { province } = req.query
  const rows = province
    ? db.prepare('SELECT * FROM stations WHERE province = ? ORDER BY name').all(province)
    : db.prepare('SELECT * FROM stations ORDER BY name').all()
  res.json(rows)
})

app.get('/api/subdivisions', (req, res) => {
  res.json(db.prepare('SELECT * FROM subdivisions ORDER BY name').all())
})

// ── Grain movement (GSCD-shaped) ───────────────────────────────────────────
app.get('/api/grain/corridor-flow', (req, res) => {
  const { from, to } = req.query
  let rows
  if (from || to) {
    rows = db
      .prepare(
        `SELECT * FROM grain_corridor_flow
         WHERE day >= COALESCE(?, day) AND day <= COALESCE(?, day)
         ORDER BY day, corridor`,
      )
      .all(from ?? null, to ?? null)
  } else {
    rows = db.prepare('SELECT * FROM grain_corridor_flow ORDER BY day DESC, corridor').all()
  }
  res.json(rows)
})

app.get('/api/grain/by-station', (req, res) => {
  const { day } = req.query
  const rows = day
    ? db
        .prepare(
          `SELECT g.day, g.station, g.province, g.lat, g.lon, g.cars
           FROM grain_daily_station g
           WHERE g.day = ? ORDER BY g.cars DESC`,
        )
        .all(day)
    : db
        .prepare(
          `SELECT g.day, g.station, g.province, g.lat, g.lon, g.cars
           FROM grain_daily_station g
           ORDER BY g.day DESC, g.cars DESC
           LIMIT 1000`,
        )
        .all()
  res.json(rows)
})

// ── StatCan weekly carloadings (open data tables) ─────────────────────────
app.get('/api/grain/carloadings', (req, res) => {
  const { geography, company, statistic, from, to, limit } = req.query
  const conds = []
  const args = []
  if (geography) {
    conds.push('geography = ?')
    args.push(geography)
  }
  if (company) {
    conds.push('company = ?')
    args.push(company)
  }
  if (statistic) {
    conds.push('statistic = ?')
    args.push(statistic)
  }
  if (from) {
    conds.push('ref_date >= ?')
    args.push(from)
  }
  if (to) {
    conds.push('ref_date <= ?')
    args.push(to)
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const lim = Math.min(Number(limit) || 2000, 10000)
  const rows = db
    .prepare(
      `SELECT * FROM grain_carloadings ${where} ORDER BY ref_date DESC, geography, company, statistic LIMIT ?`,
    )
    .all(...args, lim)
  res.json(rows)
})

app.get('/api/grain/carloadings/overview', (req, res) => {
  const { geography } = req.query
  const rows = db
    .prepare(
      `SELECT geography, company, statistic, MIN(ref_date) AS min_date, MAX(ref_date) AS max_date,
              COUNT(*) AS n
       FROM grain_carloadings
       WHERE (? IS NULL OR geography = ?)
       GROUP BY geography, company, statistic
       ORDER BY geography, company, statistic`,
    )
    .all(geography ?? null, geography ?? null)
  res.json(rows)
})

app.get('/api/grain/dwelling', (req, res) => {
  const { day } = req.query
  const rows = day
    ? db
        .prepare(
          `SELECT g.day, g.station, g.province, g.lat, g.lon, g.cars
           FROM grain_dwelling g
           WHERE g.day = ? ORDER BY g.cars DESC`,
        )
        .all(day)
    : db
        .prepare(
          `SELECT g.day, g.station, g.province, g.lat, g.lon, g.cars
           FROM grain_dwelling g
           ORDER BY g.day DESC, g.cars DESC
           LIMIT 1000`,
        )
        .all()
  res.json(rows)
})

// ── Sightings & trips (our own captures) ───────────────────────────────────
app.get('/api/sightings', (req, res) => {
  const { limit } = req.query
  const lim = Math.min(Number(limit) || 500, 5000)
  // Join capture metadata so each picked frame inherits its source video's
  // name/captured_at/location/note/resolution/fps/duration.
  const rows = db
    .prepare(
      `SELECT s.*,
              c.name AS capture_name,
              c.captured_at AS captured_at,
              c.location AS capture_location,
              c.note AS capture_note,
              c.width AS capture_width,
              c.height AS capture_height,
              c.fps AS capture_fps,
              c.duration AS capture_duration
       FROM sightings s
       LEFT JOIN captures c ON c.id = s.capture_id
       ORDER BY s.ts DESC LIMIT ?`,
    )
    .all(lim)
  res.json(rows)
})

app.post('/api/sightings', (req, res) => {
  const { trip_id, capture_id, frame_id, ts, image_path, car_type, road_number, mark_conf, station_id, note } =
    req.body ?? {}
  if (!ts) return res.status(400).json({ error: 'ts required' })
  const info = db
    .prepare(
      `INSERT INTO sightings (trip_id, capture_id, frame_id, ts, image_path, car_type, road_number, mark_conf, station_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      trip_id ?? null,
      capture_id ?? null,
      frame_id ?? null,
      ts,
      image_path ?? null,
      car_type ?? null,
      road_number ?? null,
      mark_conf ?? null,
      station_id ?? null,
      note ?? null,
    )
  res.json({ ok: true, id: info.lastInsertRowid })
})

// DELETE /api/sightings/:id -> remove a sighting + its frame row + image file.
app.delete('/api/sightings/:id', (req, res) => {
  const s = db.prepare('SELECT * FROM sightings WHERE id = ?').get(req.params.id)
  if (!s) return res.status(404).json({ error: 'sighting not found' })

  // Gather the frame (if any) before deleting the sighting, because the
  // sighting row has a FK to frames.id.
  const frame = s.frame_id ? db.prepare('SELECT * FROM frames WHERE id = ?').get(s.frame_id) : null

  // Delete the sighting first (its frame_id FK must be released), then the frame.
  db.prepare('DELETE FROM sightings WHERE id = ?').run(req.params.id)

  if (frame?.file_path && fs.existsSync(frame.file_path)) {
    try { fs.rmSync(frame.file_path, { force: true }) } catch {}
  }
  if (s.frame_id) db.prepare('DELETE FROM frames WHERE id = ?').run(s.frame_id)

  // Still-photo sighting (no frame row): remove the underlying file.
  if (!s.frame_id && s.image_path && s.image_path.includes('/storage/images/') && fs.existsSync(s.image_path)) {
    try { fs.rmSync(s.image_path, { force: true }) } catch {}
  }

  res.json({ ok: true })
})

// DELETE /api/sightings (body { ids: [...] }) -> bulk delete picked frames.
app.delete('/api/sightings', (req, res) => {
  const ids = req.body?.ids
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'ids array required' })

  const get = db.prepare('SELECT * FROM sightings WHERE id = ?')
  const delS = db.prepare('DELETE FROM sightings WHERE id = ?')
  const delF = db.prepare('DELETE FROM frames WHERE id = ?')

  const tx = db.transaction(() => {
    let n = 0
    for (const id of ids) {
      const s = get.get(id)
      if (!s) continue
      const frame = s.frame_id ? db.prepare('SELECT * FROM frames WHERE id = ?').get(s.frame_id) : null
      delS.run(id)
      if (frame?.file_path && fs.existsSync(frame.file_path)) {
        try { fs.rmSync(frame.file_path, { force: true }) } catch {}
      }
      if (s.frame_id) delF.run(s.frame_id)
      else if (s.image_path && s.image_path.includes('/storage/images/') && fs.existsSync(s.image_path)) {
        try { fs.rmSync(s.image_path, { force: true }) } catch {}
      }
      n++
    }
    return n
  })
  const deleted = tx()
  res.json({ ok: true, deleted })
})

// ── Image editing (destructive rotate, clone-and-copy crop) ─────────────────

// POST /api/sightings/:id/rotate -> rotate a sighting's image in place.
// Body: { degrees }. Optional `applyToSource` rotates every sighting from the
// same capture by the same angle.
app.post('/api/sightings/:id/rotate', async (req, res) => {
  const s = db.prepare('SELECT * FROM sightings WHERE id = ?').get(req.params.id)
  if (!s) return res.status(404).json({ error: 'sighting not found' })
  const degrees = Number(req.body?.degrees)
  if (Number.isNaN(degrees)) return res.status(400).json({ error: 'degrees required' })

  const targets = []
  if (req.body?.applyToSource && s.capture_id) {
    targets.push(...db.prepare('SELECT * FROM sightings WHERE capture_id = ?').all(s.capture_id))
  } else {
    targets.push(s)
  }

  let rotated = 0
  for (const t of targets) {
    const src = t.image_path
    if (!src || !fs.existsSync(src)) continue
    // Use a .jpg-suffixed temp so ffmpeg can infer the output format.
    const tmp = src + '.rot.jpg'
    try {
      await rotateImage(src, tmp, degrees)
      fs.renameSync(tmp, src)
      rotated++
    } catch (e) {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true })
    }
  }

  res.json({ ok: true, rotated })
})

// POST /api/sightings/:id/crop -> clone + crop the image into a new sighting.
// Body: { x, y, width, height }. Original image is left intact.
app.post('/api/sightings/:id/crop', async (req, res) => {
  const s = db.prepare('SELECT * FROM sightings WHERE id = ?').get(req.params.id)
  if (!s) return res.status(404).json({ error: 'sighting not found' })
  const { x, y, width, height } = req.body ?? {}
  if ([x, y, width, height].some((v) => v == null || Number.isNaN(Number(v)))) {
    return res.status(400).json({ error: 'x, y, width, height required' })
  }

  const src = s.image_path
  if (!src || !fs.existsSync(src)) return res.status(404).json({ error: 'image file missing' })

  const dir = path.dirname(src)
  const outFile = path.join(dir, `crop-${Date.now()}.jpg`)
  await cropImage(src, outFile, Number(x), Number(y), Number(width), Number(height))

  // New capture-independent sighting (still inherits the source capture via capture_id).
  const frameId = db
    .prepare('INSERT INTO frames (capture_id, file_path, ts, score, blurred) VALUES (?, ?, ?, 1, 0)')
    .run(s.capture_id ?? null, outFile, 0).lastInsertRowid
  const sightId = db
    .prepare(
      `INSERT INTO sightings (trip_id, capture_id, frame_id, ts, image_path, car_type, road_number, mark_conf, note)
       VALUES (null, ?, ?, ?, ?, ?, ?, null, ?)`,
    )
    .run(s.capture_id ?? null, frameId, new Date().toISOString(), outFile, s.car_type ?? 'covered hopper', s.road_number ?? null, s.note ?? null)
    .lastInsertRowid

  const mediaUrl = '/media' + outFile.slice(outFile.indexOf('/storage') + '/storage'.length)
  res.json({ sightingId: sightId, image_path: outFile, mediaUrl })
})

// ── Perspective (keystone) correction ───────────────────────────────────────
const PERSPECTIVE_PY = path.join(__dirname, 'capture', 'perspective.py')

function runPerspective(args) {
  return new Promise((resolve, reject) => {
    execFile('python3', [PERSPECTIVE_PY, ...args], { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`perspective.py failed: ${stderr || err.message}`))
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error(`perspective.py bad output: ${stdout.slice(0, 200)}`)) }
    })
  })
}

// POST /api/sightings/:id/perspective/detect -> best-effort auto keystone detect.
app.post('/api/sightings/:id/perspective/detect', async (req, res) => {
  const s = db.prepare('SELECT * FROM sightings WHERE id = ?').get(req.params.id)
  if (!s) return res.status(404).json({ error: 'sighting not found' })
  const src = s.image_path
  if (!src || !fs.existsSync(src)) return res.status(404).json({ error: 'image file missing' })

  try {
    const result = await runPerspective(['detect', src])
    res.json(result)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/sightings/:id/perspective/apply -> warp using 4 corners, save CLONE.
// Body: { src: [x0,y0,x1,y1,x2,y2,x3,y3] } TL,TR,BR,BL.
app.post('/api/sightings/:id/perspective/apply', async (req, res) => {
  const s = db.prepare('SELECT * FROM sightings WHERE id = ?').get(req.params.id)
  if (!s) return res.status(404).json({ error: 'sighting not found' })
  const pts = req.body?.src
  if (!Array.isArray(pts) || pts.length !== 8) return res.status(400).json({ error: 'src must be 8 numbers (4 corners)' })

  const src = s.image_path
  if (!src || !fs.existsSync(src)) return res.status(404).json({ error: 'image file missing' })

  const dir = path.dirname(src)
  const outFile = path.join(dir, `persp-${Date.now()}.jpg`)

  try {
    await runPerspective(['apply', src, outFile, JSON.stringify({ src: pts })])
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }

  // Clone as a new sighting (never overwrite the original).
  const frameId = db
    .prepare('INSERT INTO frames (capture_id, file_path, ts, score, blurred) VALUES (?, ?, ?, 1, 0)')
    .run(s.capture_id ?? null, outFile, 0).lastInsertRowid
  const sightId = db
    .prepare(
      `INSERT INTO sightings (trip_id, capture_id, frame_id, ts, image_path, car_type, road_number, mark_conf, note)
       VALUES (null, ?, ?, ?, ?, ?, ?, null, ?)`,
    )
    .run(s.capture_id ?? null, frameId, new Date().toISOString(), outFile, s.car_type ?? 'covered hopper', s.road_number ?? null, s.note ?? null)
    .lastInsertRowid

  const media = '/media' + outFile.slice(outFile.indexOf('/storage') + '/storage'.length)
  res.json({ sightingId: sightId, image_path: outFile, mediaUrl: media })
})

// ── Captures & frames (video capture pipeline) ─────────────────────────────
app.get('/api/captures', (req, res) => {
  res.json(db.prepare('SELECT * FROM captures ORDER BY created_at DESC').all())
})

// DELETE /api/captures/:id -> remove a video artifact + its frames/sightings/files.
app.delete('/api/captures/:id', (req, res) => {
  const cap = db.prepare('SELECT * FROM captures WHERE id = ?').get(req.params.id)
  if (!cap) return res.status(404).json({ error: 'capture not found' })

  // Remove all sighting/frame files for this capture.
  const sightings = db.prepare('SELECT * FROM sightings WHERE capture_id = ?').all(cap.id)
  for (const s of sightings) {
    if (s.image_path && fs.existsSync(s.image_path)) {
      try { fs.rmSync(s.image_path, { force: true }) } catch {}
    }
  }
  db.prepare('DELETE FROM sightings WHERE capture_id = ?').run(cap.id)

  const frames = db.prepare('SELECT * FROM frames WHERE capture_id = ?').all(cap.id)
  for (const f of frames) {
    if (f.file_path && fs.existsSync(f.file_path)) {
      try { fs.rmSync(f.file_path, { force: true }) } catch {}
    }
  }
  db.prepare('DELETE FROM frames WHERE capture_id = ?').run(cap.id)

  // Remove the source video file (inbox or archive) and thumbnails.
  const video = resolveVideo(cap)
  if (video && fs.existsSync(video)) {
    try { fs.rmSync(video, { force: true }) } catch {}
  }
  const thumbs = path.join(ROOT, 'storage', 'thumbs', String(cap.id))
  if (fs.existsSync(thumbs)) fs.rmSync(thumbs, { recursive: true, force: true })

  db.prepare('DELETE FROM jobs WHERE capture_id = ?').run(cap.id)
  db.prepare('DELETE FROM captures WHERE id = ?').run(cap.id)
  res.json({ ok: true })
})

app.get('/api/captures/:id', (req, res) => {
  const cap = db.prepare('SELECT * FROM captures WHERE id = ?').get(req.params.id)
  if (!cap) return res.status(404).json({ error: 'capture not found' })
  const frames = db
    .prepare('SELECT * FROM frames WHERE capture_id = ? ORDER BY ts')
    .all(req.params.id)
  const sightings = db
    .prepare('SELECT * FROM sightings WHERE capture_id = ? ORDER BY ts')
    .all(req.params.id)
  res.json({ ...cap, frames, sightings })
})

// PATCH /api/captures/:id -> update editable metadata (name, captured_at, location, note).
app.patch('/api/captures/:id', (req, res) => {
  const cap = db.prepare('SELECT * FROM captures WHERE id = ?').get(req.params.id)
  if (!cap) return res.status(404).json({ error: 'capture not found' })

  const { name, captured_at, location, note, rotation } = req.body ?? {}
  db.prepare(
    `UPDATE captures SET
       name = COALESCE(?, name),
       captured_at = COALESCE(?, captured_at),
       location = COALESCE(?, location),
       note = COALESCE(?, note),
       rotation = COALESCE(?, rotation)
     WHERE id = ?`,
  ).run(name ?? null, captured_at ?? null, location ?? null, note ?? null, rotation ?? null, cap.id)

  res.json(db.prepare('SELECT * FROM captures WHERE id = ?').get(cap.id))
})

// ── Video scrub (on-demand frame extraction for manual picking) ─────────────

// Resolve the canonical video file for a capture (inbox or archive).
function resolveVideo(cap) {
  if (!cap) return null
  // file_path may point at storage/inbox (uploaded) or storage/videos (archive).
  if (fs.existsSync(cap.file_path)) return cap.file_path
  // Fallback: a stale inbox path renamed into videos.
  const base = path.basename(cap.file_path)
  const candidates = [
    path.join(ROOT, 'storage', 'videos', base),
    path.join(ROOT, 'storage', 'inbox', base),
  ]
  return candidates.find((p) => fs.existsSync(p)) ?? null
}

// GET /api/video/:id/meta -> { duration, width, height, fps }
app.get('/api/video/:id/meta', (req, res) => {
  const cap = db.prepare('SELECT * FROM captures WHERE id = ?').get(req.params.id)
  if (!cap) return res.status(404).json({ error: 'capture not found' })
  res.json({ duration: cap.duration, width: cap.width, height: cap.height, fps: cap.fps })
})

// GET /api/video/:id/filmstrip -> [{ ts, url }] thumbnails for scrub bar.
app.get('/api/video/:id/filmstrip', async (req, res) => {
  const cap = db.prepare('SELECT * FROM captures WHERE id = ?').get(req.params.id)
  if (!cap) return res.status(404).json({ error: 'capture not found' })
  const video = resolveVideo(cap)
  if (!video) return res.status(404).json({ error: 'video file missing on disk' })

  const outDir = path.join(ROOT, 'storage', 'thumbs', String(cap.id))
  // Reuse cached thumbs if present, else generate.
  const cached = fs.existsSync(outDir) && fs.readdirSync(outDir).some((f) => f.endsWith('.jpg'))
  const thumbs = cached
    ? fs.readdirSync(outDir).filter((f) => /^thumb-\d+\.jpg$/.test(f)).sort().map((f, i) => ({ path: path.join(outDir, f), ts: i * 0.5 }))
    : await extractFilmstrip(video, outDir, 0.5, 320)

  const media = (p) => { const i = p.indexOf('/storage/'); return i >= 0 ? `/media${p.slice(i + '/storage'.length)}` : p }
  res.json(thumbs.map((t) => ({ ts: +t.ts.toFixed(2), url: media(t.path) })))
})

// GET /api/video/:id/frame?t=12.34 -> a single frame JPEG at time t.
app.get('/api/video/:id/frame', async (req, res) => {
  const cap = db.prepare('SELECT * FROM captures WHERE id = ?').get(req.params.id)
  if (!cap) return res.status(404).json({ error: 'capture not found' })
  const video = resolveVideo(cap)
  if (!video) return res.status(404).json({ error: 'video file missing on disk' })

  const t = Number(req.query.t)
  if (Number.isNaN(t) || t < 0) return res.status(400).json({ error: 'invalid t' })

  const tmp = path.join(ROOT, 'storage', 'tmp', `${cap.id}-${Date.now()}.jpg`)
  fs.mkdirSync(path.dirname(tmp), { recursive: true })
  await extractFrameAt(video, t, tmp, 0) // full original resolution
  res.sendFile(tmp, { root: '/' }, () => { /* noop */ })
})

// POST /api/video/:id/capture { t } -> persist the frame at t as a sighting.
app.post('/api/video/:id/capture', async (req, res) => {
  const cap = db.prepare('SELECT * FROM captures WHERE id = ?').get(req.params.id)
  if (!cap) return res.status(404).json({ error: 'capture not found' })
  const video = resolveVideo(cap)
  if (!video) return res.status(404).json({ error: 'video file missing on disk' })

  const t = Number(req.body?.t)
  if (Number.isNaN(t) || t < 0) return res.status(400).json({ error: 'invalid t' })

  const frameDir = path.join(ROOT, 'storage', 'frames', String(cap.id))
  fs.mkdirSync(frameDir, { recursive: true })
  const fname = `pick-${Date.now()}.jpg`
  const outFile = path.join(frameDir, fname)
  await extractFrameAt(video, t, outFile, 0)

  // Bake in the source video's tilt correction (if set) so picked frames are
  // already straightened at capture time.
  if (cap.rotation) {
    const tmp = outFile + '.rot.jpg'
    await rotateImage(outFile, tmp, cap.rotation)
    fs.renameSync(tmp, outFile)
  }

  // Record the frame + sighting.
  const frameId = db
    .prepare('INSERT INTO frames (capture_id, file_path, ts, score, blurred) VALUES (?, ?, ?, 1, 0)')
    .run(cap.id, outFile, t).lastInsertRowid
  const sightId = db
    .prepare(
      `INSERT INTO sightings (trip_id, capture_id, frame_id, ts, image_path, car_type, road_number, mark_conf, note)
       VALUES (null, ?, ?, ?, ?, 'covered hopper', null, null, ?)`,
    )
    .run(cap.id, frameId, new Date().toISOString(), outFile, req.body?.note ?? null).lastInsertRowid

  const mediaUrl = '/media' + outFile.slice(outFile.indexOf('/storage') + '/storage'.length)
  res.json({ sightingId: sightId, frameId, ts: t, image_path: outFile, mediaUrl })
})

app.get('/api/trips', (req, res) => {
  res.json(db.prepare('SELECT * FROM trips ORDER BY start_ts DESC').all())
})

app.post('/api/trips', (req, res) => {
  const { start_ts, end_ts, location, note } = req.body ?? {}
  if (!start_ts) return res.status(400).json({ error: 'start_ts required' })
  const info = db
    .prepare('INSERT INTO trips (start_ts, end_ts, location, note) VALUES (?, ?, ?, ?)')
    .run(start_ts, end_ts ?? null, location ?? null, note ?? null)
  res.json({ ok: true, id: info.lastInsertRowid })
})

// ── Generic JSON collection (mirrors cdnreport's collections table) ────────
app.get('/db/:collection', (req, res) => {
  const row = db.prepare('SELECT data FROM collections WHERE name = ?').get(req.params.collection)
  res.json(row ? JSON.parse(row.data) : [])
})

app.post('/db/:collection', (req, res) => {
  const data = JSON.stringify(req.body)
  db.prepare('INSERT OR REPLACE INTO collections (name, data) VALUES (?, ?)').run(
    req.params.collection,
    data,
  )
  res.json({ ok: true, count: Array.isArray(req.body) ? req.body.length : 0 })
})

app.listen(PORT, () => console.log(`train-tracker proxy running on http://localhost:${PORT}`))