// Frame scoring: use ffmpeg's `blurdetect` to estimate per-frame blur so we can
// keep sharp, side-on car shots and discard motion-blurred frames.
//
// blurdetect emits "blur mean: <value>" where LOWER = sharper. A flat/blank
// image yields "blur mean: -nan" (no edges). We invert to a 0..1 keep-score.
import ffmpegPath from 'ffmpeg-static'
import { execFile } from 'node:child_process'

// Return { score, blurMean, blurred } where score in 0..1 (1 = sharpest).
export async function scoreSharpness(imagePath) {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-i', imagePath, '-vf', 'blurdetect', '-f', 'null', '-'],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (err) return reject(new Error(`blurdetect: ${err.message}\n${stderr.slice(-800)}`))
        const m = stderr.match(/blur mean:\s*(-nan|[\d.]+)/)
        if (!m) return resolve({ score: 0.5, blurMean: null, blurred: false })
        if (m[1] === '-nan') return resolve({ score: 0, blurMean: null, blurred: true })
        const blurMean = Number(m[1])
        // Sharp frames typically report small blur means (~2-5); blurry frames
        // climb higher (8+). Map ~0..12 onto 1..0.
        const score = Math.min(1, Math.max(0, 1 - blurMean / 12))
        resolve({ score, blurMean, blurred: blurMean > 10 })
      },
    )
  })
}