// CLI: process a captured train video into frames + sightings.
//
// Usage:
//   node server/capture.js <video-file> [--interval 1.0] [--min-score 0.3]
//                              [--dedup 2.0] [--ocr] [--location "..."] [--note "..."]
//
// Raw video is kept under storage/videos; frames under storage/frames/<id>/.
// OCR is opt-in via --ocr (off by default).
import { processVideo } from './capture/pipeline.js'

function parseArgs(argv) {
  const args = {
    intervalSec: 1.0,
    minScore: 0.3,
    dedupSec: 2.0,
    ocr: false,
    location: null,
    note: null,
    video: null,
  }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--interval') args.intervalSec = Number(argv[++i])
    else if (a === '--min-score') args.minScore = Number(argv[++i])
    else if (a === '--dedup') args.dedupSec = Number(argv[++i])
    else if (a === '--ocr') args.ocr = true
    else if (a === '--location') args.location = argv[++i]
    else if (a === '--note') args.note = argv[++i]
    else rest.push(a)
  }
  args.video = rest[0]
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.video) {
  console.error('Usage: node server/capture.js <video-file> [--interval 1.0] [--location ...]')
  process.exit(1)
}

processVideo(args.video, args)
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FATAL', e.message)
    process.exit(1)
  })