// Capture pipeline: video file -> frames -> sharpness scoring -> reporting-mark
// OCR -> sightings. Media files (video + frames) live on disk; metadata, OCR
// results, and sightings live in SQLite.
//
// Storage layout (under <root>/storage):
//   storage/videos/<captureId>-<orig>.mp4     (raw video, keep)
//   storage/frames/<captureId>/frame-000001.jpg
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDb } from '../db.js'
import { extractFrames, probeMeta } from './media.js'
import { scoreSharpness } from './scoring.js'
// OCR is opt-in (--ocr). Off by default because graffiti text confuses it.
import { readReportingMarks, bestMark, terminateWorker } from './ocr.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')
const STORAGE = path.join(ROOT, 'storage')

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
  return p
}

function storageDirs() {
  return {
    videos: ensureDir(path.join(STORAGE, 'videos')),
    frames: ensureDir(path.join(STORAGE, 'frames')),
  }
}

export async function processVideo(videoPath, opts = {}) {
  const {
    intervalSec = 1.0,
    location = null,
    note = null,
    minScore = 0.3,
    ocr = false,
    dedupSec = 2.0,
    archive = false,
    captureId = null, // if provided, reuse an existing captures row instead of inserting
  } = opts
  const db = openDb()
  const dirs = storageDirs()

  if (!fs.existsSync(videoPath)) throw new Error(`video not found: ${videoPath}`)

  const meta = await probeMeta(videoPath)
  console.log(`video: ${videoPath} (${meta.duration?.toFixed(1)}s, ${meta.width}x${meta.height})`)

  // Optionally copy the raw video into storage/videos (archive).
  let storedPath = videoPath
  if (archive) {
    const dest = path.join(dirs.videos, `${Date.now()}-${path.basename(videoPath)}`)
    fs.copyFileSync(videoPath, dest)
    storedPath = dest
    console.log(`archived raw video -> ${dest}`)
  }

  // 1. Register (or reuse) the capture row.
  if (captureId == null) {
    const capInfo = db
      .prepare(
        `INSERT INTO captures (file_path, recorded_at, location, note, status, width, height, fps, duration)
         VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?)`,
      )
      .run(
        storedPath,
        meta.duration ? new Date(Date.now() - meta.duration * 1000).toISOString() : null,
        location ?? null,
        note ?? null,
        meta.width ?? null,
        meta.height ?? null,
        meta.fps ?? null,
        meta.duration ?? null,
      )
    captureId = capInfo.lastInsertRowid
  } else {
    db.prepare(
      `UPDATE captures SET status='processing', width=?, height=?, fps=?, duration=? WHERE id=?`,
    ).run(meta.width ?? null, meta.height ?? null, meta.fps ?? null, meta.duration ?? null, captureId)
  }

  // 2. Extract frames.
  const frameDir = ensureDir(path.join(dirs.frames, String(captureId)))
  const frames = await extractFrames(videoPath, frameDir, intervalSec)
  console.log(`extracted ${frames.length} frames`)

  const insFrame = db.prepare(
    'INSERT INTO frames (capture_id, file_path, ts, score, blurred) VALUES (?, ?, ?, ?, ?)',
  )
  const insSighting = db.prepare(
    `INSERT INTO sightings (trip_id, capture_id, frame_id, ts, image_path, car_type, road_number, mark_conf, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  let kept = 0
  let sight = 0

  // Dedup without OCR: keep at most one sharp frame per `dedupSec` window so a
  // single car doesn't produce dozens of near-identical stills. Within a window
  // we keep the sharpest frame.
  let windowBest = null // { frameId, path, ts, score }
  let windowStart = null

  function flushWindow() {
    if (!windowBest) return
    insSighting.run(
      null,
      captureId,
      windowBest.frameId,
      new Date().toISOString(),
      windowBest.path,
      'covered hopper',
      null,
      null,
      null,
    )
    sight++
    windowBest = null
    windowStart = null
  }

  // 3. Score each frame; OCR only if requested.
  for (const frame of frames) {
    let score = 0
    let blurred = 0
    try {
      const s = await scoreSharpness(frame.path)
      score = s.score
      blurred = s.blurred ? 1 : 0
    } catch (e) {
      console.warn(`  score failed for ${frame.path}: ${e.message}`)
    }

    const frameId = insFrame.run(captureId, frame.path, frame.ts, score, blurred).lastInsertRowid

    if (score < minScore || blurred) continue
    kept++

    // Optional OCR (off by default).
    let road = null
    let conf = null
    if (ocr) {
      try {
        const res = await readReportingMarks(frame.path)
        const best = bestMark(res)
        if (best) {
          road = best.full
          conf = best.confidence
        }
      } catch (e) {
        console.warn(`  OCR failed for ${frame.path}: ${e.message}`)
      }
    }

    // Time-window dedup: start a new window when we cross `dedupSec`.
    if (windowStart == null) windowStart = frame.ts
    if (frame.ts - windowStart >= dedupSec) flushWindow()

    if (road) {
      // With OCR, tag the road number on the frame's sighting.
      insSighting.run(
        null,
        captureId,
        frameId,
        new Date().toISOString(),
        frame.path,
        'covered hopper',
        road,
        conf,
        null,
      )
      sight++
      windowBest = null // OCR path emits directly; reset window state
    } else if (!windowBest || score > windowBest.score) {
      windowBest = { frameId, path: frame.path, ts: frame.ts, score }
    }
  }
  flushWindow()

  db.prepare("UPDATE captures SET status = 'processed' WHERE id = ?").run(captureId)
  if (ocr) await terminateWorker()

  const counts = {
    captureId,
    framesExtracted: frames.length,
    framesKept: kept,
    sightings: db
      .prepare('SELECT COUNT(*) n FROM sightings WHERE capture_id = ?')
      .get(captureId).n,
  }
  console.log(
    `\nDone: ${counts.framesExtracted} frames, ${counts.framesKept} sharp, ${counts.sightings} sightings`,
  )
  return counts
}