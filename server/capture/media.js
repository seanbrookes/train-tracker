// Media helpers built on ffmpeg-static (self-contained, no system ffmpeg).
import ffmpegPath from 'ffmpeg-static'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

let busy = Promise.resolve()

// Serialize ffmpeg invocations (a single static binary, simple + safe).
function run(args, log = false) {
  const next = busy.then(
    () =>
      new Promise((resolve, reject) => {
        execFile(ffmpegPath, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`ffmpeg: ${err.message}\n${stderr.slice(-2000)}`))
          resolve(stderr)
        })
      }),
  )
  busy = next.catch(() => {})
  return next
}

export async function probeMeta(videoPath) {
  const stderr = await run([
    '-hide_banner',
    '-i',
    videoPath,
    '-f',
    'null',
    '-',
  ])
  // Duration: 00:00:12.34 and resolution
  const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/)
  const resMatch = stderr.match(/(\d{2,5})x(\d{2,5})[ ,]/)
  const fpsMatch = stderr.match(/(\d+(?:\.\d+)?)\s*fps/i)
  const duration = durMatch
    ? Number(durMatch[1]) * 3600 + Number(durMatch[2]) * 60 + Number(durMatch[3])
    : null
  return {
    duration,
    width: resMatch ? Number(resMatch[1]) : null,
    height: resMatch ? Number(resMatch[2]) : null,
    fps: fpsMatch ? Number(fpsMatch[1]) : null,
  }
}

// Extract frames at a fixed interval (seconds) into outDir.
// Returns an array of { path, ts } in video-time order.
//
// maxWidth caps output width; frames are downscaled only if the source is
// wider than maxWidth (never upscaled, to avoid wasting space on small sources).
export async function extractFrames(videoPath, outDir, intervalSec = 1.0, maxWidth = 1920) {
  fs.mkdirSync(outDir, { recursive: true })
  const pattern = path.join(outDir, 'frame-%06d.jpg')
  // Use fps=1/interval to sample evenly; cap width at maxWidth (keeps aspect).
  const fps = (1 / intervalSec).toFixed(6)
  const scale = `scale=min(iw\\,${maxWidth}):-2`
  await run([
    '-hide_banner',
    '-i',
    videoPath,
    '-vf',
    `fps=${fps},${scale}`,
    '-q:v',
    '3',
    pattern,
  ])

  return fs
    .readdirSync(outDir)
    .filter((f) => /^frame-\d+\.jpg$/.test(f))
    .sort()
    .map((f, i) => ({ path: path.join(outDir, f), ts: i * intervalSec }))
}

// Extract a single frame at `timeSec` (fast seek before -i), writing to outFile
// as a JPG. `maxWidth` caps output width (default keeps original size).
export async function extractFrameAt(videoPath, timeSec, outFile, maxWidth = 0) {
  const seek = Math.max(0, timeSec).toFixed(3)
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', seek, '-i', videoPath]
  if (maxWidth > 0) args.push('-vf', `scale=min(iw\\,${maxWidth}):-2`)
  args.push('-frames:v', '1', '-q:v', '2', outFile)
  await run(args)
  return outFile
}

// Rotate an image (in place) by `degrees`, filling corners with black.
export async function rotateImage(inPath, outPath, degrees) {
  const radians = (degrees * Math.PI) / 180
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inPath,
    '-vf', `rotate=${radians}:fillcolor=black`,
    '-q:v', '3',
    outPath,
  ])
  return outPath
}

// Crop an image to width×height at x,y (creates a new image; original intact).
export async function cropImage(inPath, outPath, x, y, width, height) {
  await run([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', inPath,
    '-vf', `crop=${width}:${height}:${x}:${y}`,
    '-q:v', '2',
    outPath,
  ])
  return outPath
}

// Generate a filmstrip of thumbnails: `count` small frames evenly spaced across
// the video, written to outDir. Returns { fps-adjusted paths, timestamps }.
export async function extractFilmstrip(videoPath, outDir, intervalSec = 0.5, thumbWidth = 320) {
  fs.mkdirSync(outDir, { recursive: true })
  const pattern = path.join(outDir, 'thumb-%04d.jpg')
  const fps = (1 / intervalSec).toFixed(6)
  const scale = `scale=min(iw\\,${thumbWidth}):-2`
  await run([
    '-hide_banner',
    '-loglevel', 'error',
    '-i',
    videoPath,
    '-vf',
    `fps=${fps},${scale}`,
    '-q:v',
    '5',
    pattern,
  ])
  const files = fs
    .readdirSync(outDir)
    .filter((f) => /^thumb-\d+\.jpg$/.test(f))
    .sort()
  return files.map((f, i) => ({ path: path.join(outDir, f), ts: i * intervalSec }))
}