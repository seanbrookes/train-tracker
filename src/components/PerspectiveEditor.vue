<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { api } from '../lib/api.js'

const props = defineProps({
  image: { type: Object, default: null }, // { id, image_path }
})
const emit = defineEmits(['close', 'applied'])

const busy = ref(false)
const error = ref(null)
const stage = ref(null)
const win = ref({ w: 1280, h: 860 })
const stageW = ref(800)
const stageH = ref(600)
const stageSize = ref({ w: 800, h: 600 }) // reactive, drives fitScale + redraw

// Corners in IMAGE pixel space. `originCorners` is the perspective-only quad
// (keystone unaffected by rotation); `corners` is originCorners rotated by
// `rotation` degrees around its center.
const originCorners = ref([
  { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 },
])
const rotation = ref(0)

const imgW = ref(0)
const imgH = ref(0)
const zoom = ref(1)
const pan = ref({ x: 0, y: 0 })
const shiftHeld = ref(false)

// Custom draggable guides (up to 4: h-top, h-bottom, v-left, v-right).
// Each: { id, label, axis, visible, pos (0..1) }.
const guides = ref([
  { id: 'top', label: 'Top', axis: 'h', visible: false, pos: 0.5 },
  { id: 'bottom', label: 'Bottom', axis: 'h', visible: false, pos: 0.5 },
  { id: 'left', label: 'Left', axis: 'v', visible: false, pos: 0.5 },
  { id: 'right', label: 'Right', axis: 'v', visible: false, pos: 0.5 },
])
const showGuidesPanel = ref(false)
let draggingGuideId = null

// Derive the effective corners (rotated view) used for display + warp.
const corners = computed(() => {
  if (!rotation.value) return originCorners.value
  const cx = originCorners.value.reduce((s, c) => s + c.x, 0) / 4
  const cy = originCorners.value.reduce((s, c) => s + c.y, 0) / 4
  const r = (rotation.value * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  return originCorners.value.map((c) => {
    const dx = c.x - cx
    const dy = c.y - cy
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
  })
})

let resize = null
let dragCorner = null
let rotating = false
let rotateStart = null // { center, startAngle } in image px
let panning = null

function mediaUrl(p) {
  if (!p) return ''
  const i = p.indexOf('/storage/')
  return i >= 0 ? `/media${p.slice(i + '/storage'.length)}` : p
}

// Load the image's intrinsic size so corners start at its bounds.
function initFromImage() {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      imgW.value = img.naturalWidth
      imgH.value = img.naturalHeight
      afterSrc.value = img
      originCorners.value = [
        { x: 0, y: 0 },
        { x: img.naturalWidth, y: 0 },
        { x: img.naturalWidth, y: img.naturalHeight },
        { x: 0, y: img.naturalHeight },
      ]
      resolve()
      drawAfterPreview()
    }
    img.onerror = () => {
      imgW.value = props.image?.capture_width || 640
      imgH.value = props.image?.capture_height || 480
      originCorners.value = [
        { x: 0, y: 0 },
        { x: imgW.value, y: 0 },
        { x: imgW.value, y: imgH.value },
        { x: 0, y: imgH.value },
      ]
      resolve()
    }
    img.src = mediaUrl(props.image.image_path)
  })
}

// Stage-to-image coord mapping: the image is drawn at a scale so it fits the
// stage (contain), centered, then zoom/pan is applied.
function fitScale() {
  if (!imgW.value) return 1
  return Math.min(stageSize.value.w / imgW.value, stageSize.value.h / imgH.value)
}

function imageToStage(imgX, imgY) {
  const s = fitScale() * zoom.value
  const dw = imgW.value * s
  const dh = imgH.value * s
  const ox = (stageSize.value.w - dw) / 2 + pan.value.x
  const oy = (stageSize.value.h - dh) / 2 + pan.value.y
  return { x: ox + imgX * s, y: oy + imgY * s }
}

function stageToImage(stX, stY) {
  const s = fitScale() * zoom.value
  const dw = imgW.value * s
  const dh = imgH.value * s
  const ox = (stageSize.value.w - dw) / 2 + pan.value.x
  const oy = (stageSize.value.h - dh) / 2 + pan.value.y
  return { x: (stX - ox) / s, y: (stY - oy) / s }
}

// Corner handle pixel positions.
function handlePos(i) {
  const p = imageToStage(corners.value[i].x, corners.value[i].y)
  return { left: p.x + 'px', top: p.y + 'px' }
}

// Source image is drawn fit+pan/zoom (no warp), so the handles sit directly on
// the actual photo corners — dragging feels 1:1 (no inverse confusion).
const sourceStyle = computed(() => {
  const s = fitScale() * zoom.value
  return {
    width: imgW.value * s + 'px',
    height: imgH.value * s + 'px',
    left: '50%',
    top: '50%',
    transformOrigin: 'center center',
    transform: `translate(calc(-50% + ${pan.value.x}px), calc(-50% + ${pan.value.y}px))`,
  }
})

// Quad center (image px).
function quadCenter() {
  let cx = 0
  let cy = 0
  for (const c of corners.value) {
    cx += c.x
    cy += c.y
  }
  return { x: cx / 4, y: cy / 4 }
}

// Quad outline + mesh in stage coords.
const quadPts = computed(() => corners.value.map((c) => imageToStage(c.x, c.y)))
const quadPolygon = computed(() => quadPts.value.map((p) => `${p.x},${p.y}`).join(' '))

// Guides are always fully visible (independent of preview opacity).
// Grid is most useful when the preview (target) is visible, so it follows the
// blend slider: faint near "source", prominent near "preview".
const gridOpacity = computed(() => 0.2 + previewOpacity.value * 0.8)

// Guide mesh: 5x5 grid inside the quad (4 vertical + 4 horizontal lines).
const gridLines = computed(() => {
  const [tl, tr, br, bl] = quadPts.value
  const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
  const lines = []
  for (const t of [0.2, 0.4, 0.6, 0.8]) {
    // vertical-ish: connect top edge (tl->tr) to bottom edge (bl->br)
    lines.push([lerp(tl, tr, t), lerp(bl, br, t)])
    // horizontal-ish: connect left edge (tl->bl) to right edge (tr->br)
    lines.push([lerp(tl, bl, t), lerp(tr, br, t)])
  }
  return lines
})

// Live-warp "after" preview, rendered at the SAME size/position as the source
// image so it overlays the grid for direct comparison. Opacity-adjustable.
const afterCanvas = ref(null)
const afterSrc = ref(null)
const previewOpacity = ref(0.5)

// Canvas geometry matches the source image (fit + zoom + pan).
const previewStyle = computed(() => {
  const s = fitScale() * zoom.value
  return {
    width: imgW.value * s + 'px',
    height: imgH.value * s + 'px',
    left: '50%',
    top: '50%',
    opacity: previewOpacity.value,
    transformOrigin: 'center center',
    transform: `translate(calc(-50% + ${pan.value.x}px), calc(-50% + ${pan.value.y}px))`,
  }
})

function drawAfterPreview() {
  const cv = afterCanvas.value
  const img = afterSrc.value
  if (!cv || !img || !imgW.value) return
  const s = fitScale() * zoom.value
  const W = Math.round(imgW.value * s)
  const H = Math.round(imgH.value * s)
  if (W <= 0 || H <= 0) return
  cv.width = W
  cv.height = H
  const ctx = cv.getContext('2d')
  const iw = img.naturalWidth
  const ih = img.naturalHeight

  // Normalize corners to [0,1] space.
  const N = corners.value.map((c) => ({ x: c.x / iw, y: c.y / ih }))
  // Homography: source rectangle (full image) -> dragged quad (normalized), so
  // the warped image content follows the corner drag.
  const rect = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  const P = homography(rect, N)
  const inv = invertHomography(P)

  drawSourceCache(img)
  const out = ctx.createImageData(W, H)
  const data = out.data
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // normalized canvas coordinate
      const nx = (x + 0.5) / W
      const ny = (y + 0.5) / H
      const sx = inv[0] * nx + inv[1] * ny + inv[2]
      const sy = inv[3] * nx + inv[4] * ny + inv[5]
      const sw = inv[6] * nx + inv[7] * ny + inv[8]
      const ux = sx / sw
      const uy = sy / sw
      const px = Math.round(ux * iw)
      const py = Math.round(uy * ih)
      const o = (y * W + x) * 4
      if (px >= 0 && px < iw && py >= 0 && py < ih) {
        const so = (py * iw + px) * 4
        data[o] = sourceCache.data[so]
        data[o + 1] = sourceCache.data[so + 1]
        data[o + 2] = sourceCache.data[so + 2]
        data[o + 3] = 255
      } else {
        data[o + 3] = 0
      }
    }
  }
  ctx.putImageData(out, 0, 0)
}

let sourceCache = null
function drawSourceCache(img) {
  if (sourceCache && sourceCache.w === img.naturalWidth) return
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  c.getContext('2d').drawImage(img, 0, 0)
  sourceCache = { canvas: c, data: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, w: c.width }
}

// 3x3 homography mapping src quad -> dst quad (both {x,y}).
function homography(src, dst) {
  const A = []
  const b = []
  for (let i = 0; i < 4; i++) {
    const { x: X, y: Y } = src[i]
    const { x: u, y: v } = dst[i]
    A.push([X, Y, 1, 0, 0, 0, -u * X, -u * Y])
    A.push([0, 0, 0, X, Y, 1, -v * X, -v * Y])
    b.push(u, v)
  }
  const h = solve(A, b)
  // return [m00,m01,m02, m10,m11,m12, m20,m21,m22] (row-major, w=h33=1)
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
}

function invertHomography(m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = c * h - b * i
  const C = b * f - c * e
  const det = a * A + d * B + g * C
  if (Math.abs(det) < 1e-9) return m
  return [
    A / det, B / det, C / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ]
}

function solve(A, b) {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    ;[M[col], M[piv]] = [M[piv], M[col]]
    const d = M[col][col] || 1
    for (let c = col; c <= n; c++) M[col][c] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col]
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row) => row[n])
}

// Drag corner. Shift+drag rotates the whole quad around its center; otherwise
// the single corner moves freely (perspective).
function startCorner(i, e) {
  e.preventDefault()
  e.stopPropagation()
  if (shiftHeld.value) {
    rotating = true
    const rect = stage.value.getBoundingClientRect()
    const p0 = stageToImage(e.clientX - rect.left, e.clientY - rect.top)
    const { x: cx, y: cy } = quadCenter()
    rotateStart = { cx, cy, angle: Math.atan2(p0.y - cy, p0.x - cx), rot0: rotation.value }
  } else {
    dragCorner = i
  }
  window.addEventListener('mousemove', onCornerMove)
  window.addEventListener('mouseup', onCornerUp)
}
function onCornerMove(e) {
  const rect = stage.value.getBoundingClientRect()
  const p = stageToImage(e.clientX - rect.left, e.clientY - rect.top)
  if (rotating && rotateStart) {
    const a = Math.atan2(p.y - rotateStart.cy, p.x - rotateStart.cx)
    rotation.value = rotateStart.rot0 + ((a - rotateStart.angle) * 180) / Math.PI
  } else if (dragCorner != null) {
    // Independent corner move (un-rotated to origin space).
    const unrot = originCorners.value.map((c) => ({ ...c }))
    const r = (-rotation.value * Math.PI) / 180
    const cos = Math.cos(r)
    const sin = Math.sin(r)
    const cx = originCorners.value.reduce((s, c) => s + c.x, 0) / 4
    const cy = originCorners.value.reduce((s, c) => s + c.y, 0) / 4
    const dx = p.x - cx
    const dy = p.y - cy
    unrot[dragCorner] = { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
    originCorners.value = unrot
  }
}

function onCornerUp() {
  dragCorner = null
  rotating = false
  rotateStart = null
  window.removeEventListener('mousemove', onCornerMove)
  window.removeEventListener('mouseup', onCornerUp)
}

// Pan (drag empty stage) and zoom (scroll wheel).
function startPan(e) {
  if (e.target !== e.currentTarget) return
  panning = { x: e.clientX, y: e.clientY, ox: pan.value.x, oy: pan.value.y }
  window.addEventListener('mousemove', onPanMove)
  window.addEventListener('mouseup', onPanUp)
}
function onPanMove(e) {
  if (!panning) return
  pan.value.x = panning.ox + (e.clientX - panning.x)
  pan.value.y = panning.oy + (e.clientY - panning.y)
}
function onPanUp() {
  panning = null
  window.removeEventListener('mousemove', onPanMove)
  window.removeEventListener('mouseup', onPanUp)
}
function onWheel(e) {
  e.preventDefault()
  // Inverted: scroll up (deltaY < 0) zooms OUT, scroll down zooms IN.
  const factor = e.deltaY < 0 ? 0.9 : 1.1
  zoom.value = Math.min(6, Math.max(0.2, zoom.value * factor))
}

// ── Custom guides ────────────────────────────────────────────────────────────
function toggleGuide(id) {
  const g = guides.value.find((x) => x.id === id)
  if (g) g.visible = !g.visible
}

function startGuideDrag(id, e) {
  e.preventDefault()
  e.stopPropagation()
  const g = guides.value.find((x) => x.id === id)
  if (!g) return
  if (!g.visible) g.visible = true // grabbing implies wanting it on
  draggingGuideId = id
  updateGuideFromEvent(e)
  window.addEventListener('mousemove', onGuideMove)
  window.addEventListener('mouseup', onGuideUp)
}
function onGuideMove(e) {
  updateGuideFromEvent(e)
}
function onGuideUp() {
  draggingGuideId = null
  window.removeEventListener('mousemove', onGuideMove)
  window.removeEventListener('mouseup', onGuideUp)
}
function updateGuideFromEvent(e) {
  if (!draggingGuideId) return
  const rect = stage.value.getBoundingClientRect()
  const fx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
  const fy = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
  const g = guides.value.find((x) => x.id === draggingGuideId)
  if (!g) return
  g.pos = g.axis === 'h' ? fy : fx
}

async function autoDetect() {
  if (!props.image) return
  busy.value = true
  error.value = null
  try {
    const res = await api.perspectiveDetect(props.image.id)
    if (res && Array.isArray(res.src) && res.src.length === 8) {
      const [x0, y0, x1, y1, x2, y2, x3, y3] = res.src
      originCorners.value = [
        { x: x0, y: y0 }, { x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 },
      ]
      rotation.value = 0
    } else {
      error.value = 'Auto-detect found no reliable correction; adjust corners manually.'
    }
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

function resetCorners() {
  originCorners.value = [
    { x: 0, y: 0 }, { x: imgW.value, y: 0 }, { x: imgW.value, y: imgH.value }, { x: 0, y: imgH.value },
  ]
  rotation.value = 0
  zoom.value = 1
  pan.value = { x: 0, y: 0 }
}

async function apply() {
  if (!props.image) return
  // Send the effective (already-rotated) corners; perspective warps to a
  // rectangle, which is equivalent to rotate-then-keystone-correct.
  const src = corners.value.flatMap((c) => [c.x, c.y])
  busy.value = true
  error.value = null
  try {
    await api.perspectiveApply(props.image.id, src)
    emit('applied')
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

// Window resize.
function startWinResize(e) {
  e.preventDefault()
  resize = { x: e.clientX, y: e.clientY, w: win.value.w, h: win.value.h }
  window.addEventListener('mousemove', onWinResize)
  window.addEventListener('mouseup', onWinResizeEnd)
}
function onWinResize(e) {
  if (!resize) return
  win.value.w = Math.max(480, resize.w + (e.clientX - resize.x))
  win.value.h = Math.max(360, resize.h + (e.clientY - resize.y))
}
function onWinResizeEnd() {
  resize = null
  window.removeEventListener('mousemove', onWinResize)
  window.removeEventListener('mouseup', onWinResizeEnd)
}

// Redraw the live "after" preview whenever the quad or view changes.
watch([corners, rotation, zoom, pan, stageSize], () => drawAfterPreview())

onMounted(async () => {
  await initFromImage()
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKeyUp)
  const el = stage.value
  if (el) {
    stageW.value = el.clientWidth
    stageH.value = el.clientHeight
    stageSize.value = { w: el.clientWidth, h: el.clientHeight }
    const ro = new ResizeObserver(() => {
      stageW.value = el.clientWidth
      stageH.value = el.clientHeight
      stageSize.value = { w: el.clientWidth, h: el.clientHeight }
      drawAfterPreview()
    })
    ro.observe(el)
  }
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('mousemove', onCornerMove)
  window.removeEventListener('mouseup', onCornerUp)
  window.removeEventListener('mousemove', onPanMove)
  window.removeEventListener('mouseup', onPanUp)
  window.removeEventListener('mousemove', onWinResize)
  window.removeEventListener('mouseup', onWinResizeEnd)
  window.removeEventListener('mousemove', onGuideMove)
  window.removeEventListener('mouseup', onGuideUp)
})
function onKey(e) {
  if (e.key === 'Escape') emit('close')
  else if (e.key === 'Shift') shiftHeld.value = true
}
function onKeyUp(e) {
  if (e.key === 'Shift') shiftHeld.value = false
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="editor" :style="{ width: win.w + 'px', height: win.h + 'px' }">
      <div class="titlebar">
        <span class="title">Edit — perspective + rotation</span>
        <span class="hint">scroll zoom · drag bg to pan · drag dots to keystone · <b>Shift+drag</b> to rotate</span>
        <button class="tb" @click="emit('close')">✕</button>
      </div>

      <div class="stage-wrap">
        <div ref="stage" class="stage" :class="{ 'mode-rotate': shiftHeld }" @mousedown="startPan" @wheel="onWheel">
          <!-- source image (undistorted), fitted + pan/zoom -->
          <img :src="mediaUrl(image.image_path) + '?_=' + Date.now()" class="source" :style="sourceStyle" />

          <!-- warped "after" preview, aligned to the source (opacity-adjustable) -->
          <canvas ref="afterCanvas" class="preview" :style="previewStyle"></canvas>

          <!-- mesh overlay: source quad + rule-of-thirds grid (with dark halo for legibility) -->
          <svg class="mesh" :viewBox="`0 0 ${stageW} ${stageH}`" preserveAspectRatio="none" :style="{ opacity: gridOpacity }">
            <polygon :points="quadPolygon" fill="rgba(0,220,255,0.08)" stroke="#000" stroke-width="4.5" stroke-opacity="0.8" />
            <polygon :points="quadPolygon" fill="none" stroke="#00f0ff" stroke-width="2.5" />
            <line
              v-for="(l, i) in gridLines"
              :key="'h' + i"
              :x1="l[0].x" :y1="l[0].y" :x2="l[1].x" :y2="l[1].y"
              stroke="#000" stroke-width="3.5" stroke-opacity="0.8"
            />
            <line
              v-for="(l, i) in gridLines"
              :key="'f' + i"
              :x1="l[0].x" :y1="l[0].y" :x2="l[1].x" :y2="l[1].y"
              stroke="#00f0ff" stroke-width="1.5"
            />
          </svg>

          <!-- corner handles -->
          <div
            v-for="(c, i) in corners"
            :key="i"
            class="handle"
            :style="handlePos(i)"
            @mousedown="startCorner(i, $event)"
          ></div>

          <!-- custom guides (red, draggable by grabbing the line) -->
          <template v-for="g in guides" :key="g.id">
            <div
              v-if="g.visible"
              class="guide-line"
              :class="g.axis"
              :style="g.axis === 'h' ? { top: (g.pos * 100) + '%' } : { left: (g.pos * 100) + '%' }"
              @mousedown="startGuideDrag(g.id, $event)"
            ></div>
          </template>
        </div>
      </div>

      <div class="controls">
        <button class="btn" :disabled="busy" @click="autoDetect">{{ busy ? 'Detecting…' : 'Auto-detect' }}</button>
        <button class="btn ghost" @click="resetCorners">Reset</button>
        <button class="btn ghost" :class="{ on: showGuidesPanel }" @click="showGuidesPanel = !showGuidesPanel">Guides</button>

        <span class="sep"></span>

        <span class="rlbl">Rotate</span>
        <button class="nudge" @click="rotation = Math.round((rotation - 0.1) * 10) / 10">−</button>
        <input v-model.number="rotation" type="number" step="0.1" class="angle-in" />
        <span class="deg">°</span>
        <button class="nudge" @click="rotation = Math.round((rotation + 0.1) * 10) / 10">+</button>
        <input v-model.number="rotation" type="range" min="-10" max="10" step="0.05" class="angle-slider" />

        <span class="sep"></span>

        <span class="rlbl">Blend</span>
        <div class="blend">
          <span class="blend-end">source</span>
          <input v-model.number="previewOpacity" type="range" min="0" max="1" step="0.05" class="angle-slider op-slider" />
          <span class="blend-end">preview</span>
          <span class="blend-val">{{ Math.round(previewOpacity * 100) }}%</span>
        </div>
      </div>

      <p v-if="error" class="error">{{ error }}</p>

      <!-- Guide panel (slide-out from bottom) -->
      <div v-if="showGuidesPanel" class="guide-panel">
        <div v-for="g in guides" :key="g.id" class="guide-row">
          <label class="guide-check">
            <input type="checkbox" :checked="g.visible" @change="toggleGuide(g.id)" />
            <span>{{ g.label }}</span>
          </label>
        </div>
        <span class="guide-hint">tip: drag the red line on the image to move it</span>
      </div>

      <div class="footer">
        <button class="cancel" @click="emit('close')">Cancel</button>
        <button class="apply" :disabled="busy" @click="apply">{{ busy ? 'Working…' : 'Apply (save as copy)' }}</button>
      </div>

      <div class="resize" @mousedown="startWinResize" title="drag to resize"></div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: fixed; inset: 0; z-index: 1100; background: rgba(0,0,0,0.65); display: flex; align-items: center; justify-content: center; }
.editor { position: relative; max-width: 96vw; max-height: 94vh; background: #1c1c1c; border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 16px 70px rgba(0,0,0,0.7); }
.titlebar { display: flex; align-items: center; gap: 12px; padding: 8px 12px; background: #111; color: #eee; flex: 0 0 auto; }
.title { font-size: 13px; font-weight: 600; }
.titlebar .hint { color: #888; font-size: 11px; }
.tb { margin-left: auto; width: 26px; height: 26px; border: none; border-radius: 4px; background: rgba(255,255,255,0.1); color: #eee; cursor: pointer; }
.tb:hover { background: rgba(255,255,255,0.25); }

.stage-wrap { flex: 1; min-height: 0; display: flex; }
.stage { position: relative; flex: 1; background: #000; overflow: hidden; cursor: grab; user-select: none; }
.stage:active { cursor: grabbing; }

/* Rotate mode (Shift held): distinct cursor on stage + handles */
.stage.mode-rotate { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="none" stroke="%2300f0ff" stroke-width="2" d="M19 12a7 7 0 1 1-2-5.3"/><polyline fill="none" stroke="%2300f0ff" stroke-width="2" points="17 2 17 7 12 7"/></svg>') 12 12, crosshair; }
.stage.mode-rotate .handle { cursor: url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="none" stroke="%2300f0ff" stroke-width="2" d="M19 12a7 7 0 1 1-2-5.3"/><polyline fill="none" stroke="%2300f0ff" stroke-width="2" points="17 2 17 7 12 7"/></svg>') 12 12, crosshair; }

.source { position: absolute; pointer-events: none; }

.preview {
  position: absolute;
  pointer-events: none;
  z-index: 2;
}

.mesh { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 3; }

.handle { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; background: #00dcff; border: 2px solid #fff; border-radius: 50%; cursor: grab; z-index: 5; }
.handle:active { cursor: grabbing; }

.guide-line { position: absolute; z-index: 7; background: rgba(255, 80, 80, 0.95); }
.guide-line.h { left: 0; right: 0; height: 1px; cursor: ns-resize; opacity: 0.85; }
.guide-line.v { top: 0; bottom: 0; width: 1px; cursor: ew-resize; opacity: 0.85; }
.guide-line:hover { background: #ff3333; opacity: 1; }

.guide-panel {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 8px 16px;
  background: #1a1a1a;
  border-top: 1px solid #333;
  align-items: center;
}
.guide-row { display: flex; align-items: center; gap: 8px; }
.guide-check { display: flex; align-items: center; gap: 5px; color: #ccc; font-size: 12px; cursor: pointer; }
.guide-hint { color: #777; font-size: 11px; }
.btn.ghost.on { border-color: #00f0ff; color: #00f0ff; }

.controls { display: flex; align-items: center; gap: 10px; padding: 10px 16px; background: #1c1c1c; border-top: 1px solid #333; flex: 0 0 auto; }
.btn { padding: 6px 14px; border: none; border-radius: 6px; background: #3a7d3a; color: #fff; cursor: pointer; font-size: 13px; }
.btn:disabled { background: #5a7d5a; cursor: default; }
.btn.ghost { background: transparent; border: 1px solid #555; color: #ccc; }
.hint { color: #777; font-size: 12px; }

.sep { width: 1px; height: 20px; background: #333; }
.rlbl { color: #ccc; font-size: 12px; }
.nudge { width: 26px; height: 26px; border: 1px solid #444; border-radius: 4px; background: #222; color: #eee; cursor: pointer; font-size: 15px; }
.angle-in { width: 54px; padding: 3px 5px; background: #222; color: #eee; border: 1px solid #444; border-radius: 4px; font-size: 12px; }
.deg { color: #aaa; font-size: 12px; }
.angle-slider { width: 120px; accent-color: #3a9c3a; }
.op-slider { width: 100px; accent-color: #00a8cc; }
.blend { display: flex; align-items: center; gap: 6px; }
.blend-end { color: #aaa; font-size: 11px; }
.blend-val { color: #fff; font-size: 11px; font-variant-numeric: tabular-nums; min-width: 34px; }

.error { color: #ff7a7a; padding: 0 16px; margin: 0; font-size: 12px; }

.footer { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 16px; background: #111; border-top: 1px solid #333; flex: 0 0 auto; }
.cancel { padding: 7px 14px; border: 1px solid #555; border-radius: 6px; background: transparent; color: #ccc; cursor: pointer; font-size: 13px; }
.apply { padding: 7px 14px; border: none; border-radius: 6px; background: #3a7d3a; color: #fff; cursor: pointer; font-size: 13px; }
.apply:disabled { background: #5a7d5a; cursor: default; }

.resize { position: absolute; right: 0; bottom: 0; width: 20px; height: 20px; cursor: nwse-resize; z-index: 10; }
.resize::after { content: ''; position: absolute; right: 5px; bottom: 5px; border-right: 2px solid #999; border-bottom: 2px solid #999; width: 10px; height: 10px; }
</style>