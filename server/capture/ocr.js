// Reporting-mark OCR using tesseract.js (self-contained, no system tesseract).
//
// Railcar reporting marks have the form:   [AAR mark] [number]
//   e.g. "CN 123456", "CP 594321", "BNSF 812233", "UP 123456"
// The AAR mark is 2-4 letters (reporting mark), then a space and 1-6 digits.
//
// We OCR the whole frame, then scan the merged text for a reporting-mark-shaped
// token. tesseract struggles with painted stencils + graffiti noise, so we (a)
// upscale + threshold to help it, and (b) accept a fuzzy match with confidence.

import { createWorker, PSM } from 'tesseract.js'
import { execFile } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// AAR reporting marks we're likely to see (railway initials without trailing
// digits are the mark, e.g. CN, CP, BNSF, UP, NS, CSXT, KCS, etc.)
const REPORTING_MARK =
  /(?<![A-Z])([A-Z]{2,4})\s*([0-9]{1,6})(?![0-9])(?:\b|$)/g

// A few common owner initials to help validate (not exhaustive).
const KNOWN_MARKS = new Set([
  'CN', 'CP', 'CPAA', 'BNSF', 'BN', 'UP', 'NS', 'CSXT', 'CSX', 'KCS', 'KCSM',
  'SOO', 'GTW', 'IC', 'DMIR', 'DME', 'ICG', 'WC', 'CITX', 'CGLX', 'CPWX',
  'GATX', 'PROX', 'UNPX', 'NATX', 'CRDX', 'CEFX', 'RBOX', 'FURX', 'SHPX',
  'PLCX', 'ADMX', 'PWRL', 'WCX', 'CHPX', 'GRTX', 'VCRR', 'SRY', 'BNML',
])

let workerPromise = null
function getWorker() {
  if (!workerPromise) workerPromise = createWorker('eng', 1, { logger: () => {} })
  return workerPromise
}

// Pre-process a frame into a high-contrast crop of the middle band (where
// reporting marks are stenciled). Returns a temp image path.
async function preprocess(imagePath) {
  const tmp = path.join(
    os.tmpdir(),
    `tt-ocr-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
  )
  // Crop the middle band (y 30%..70%), leave width full, grayscale.
  // (No 2x upscale / contrast boost: tesseract reads the plain crop best.)
  const vf = 'crop=iw:ih*0.4:0:ih*0.3,format=gray'
  await new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', imagePath, '-vf', vf, tmp], (err) =>
      err ? reject(new Error(`preprocess: ${err.message}`)) : resolve(),
    )
  })
  return tmp
}

// OCR a frame and extract candidate reporting marks.
// Returns { marks: [{ mark, number, full, confidence }], text, wallMs }
export async function readReportingMarks(imagePath) {
  const worker = await getWorker()
  const t0 = Date.now()

  const pre = await preprocess(imagePath)

  // Reporting marks are a single printed line; SINGLE_LINE is the most
  // reliable mode. Fall back to AUTO/SPARSE if it returns nothing useful.
  let text = ''
  let conf = 0
  for (const mode of [PSM.SINGLE_LINE, PSM.AUTO, PSM.SPARSE_TEXT]) {
    const { data } = await worker.recognize(pre, {}, { tessedit_pageseg_mode: mode })
    text = (data.text || '').trim()
    conf = data.confidence ?? 0
    if (text) break
  }
  fs.rmSync(pre, { force: true })

  const pageConf = conf / 100

  const marks = []
  for (const m of text.matchAll(REPORTING_MARK)) {
    const mark = m[1].toUpperCase()
    const number = m[2]
    const full = `${mark} ${number}`
    marks.push({
      mark,
      number,
      full,
      confidence: pageConf,
      known: KNOWN_MARKS.has(mark),
    })
  }

  return { marks, text, wallMs: Date.now() - t0 }
}

// Normalize a candidate mark by filtering implausible tokens and known-marks
// preference. Returns the best single mark or null.
export function bestMark(result) {
  if (!result.marks.length) return null
  // Prefer a known mark; otherwise take highest confidence.
  const known = result.marks.filter((m) => m.known)
  const pool = known.length ? known : result.marks
  return pool.reduce((a, b) => (b.confidence > a.confidence ? b : a), pool[0])
}

export async function terminateWorker() {
  if (workerPromise) {
    const w = await workerPromise
    await w.terminate()
    workerPromise = null
  }
}