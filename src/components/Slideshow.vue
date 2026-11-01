<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'

const props = defineProps({
  images: { type: Array, default: () => [] }, // [{ id, url, road_number, capture_name, capture_location, captured_at }]
  startIndex: { type: Number, default: 0 },
})
const emit = defineEmits(['close'])

const index = ref(0)
const playing = ref(true)
const fullscreen = ref(false)
const intervalMs = ref(4000)

// Window size/position
const win = ref({ x: 80, y: 60, w: 800, h: 560 })

let timer = null
const rootEl = ref(null)

const current = computed(() => props.images[index.value] || null)

// Cross-fade: two slots. `front` is the slot index currently shown on top.
const front = ref(0) // 0 | 1
const slots = ref([null, null]) // each holds an image {url,...} or null

function mediaUrl(p) {
  if (!p) return ''
  const i = p.indexOf('/storage/')
  return i >= 0 ? `/media${p.slice(i + '/storage'.length)}` : p
}

// Set the active image, cross-fading by loading into the hidden slot.
function setIndex(i) {
  if (!props.images.length) return
  index.value = ((i % props.images.length) + props.images.length) % props.images.length
  const img = props.images[index.value]
  if (!img) return
  const src = { url: mediaUrl(img.image_path || img.url), ...img }
  if (slots.value[front.value] == null) {
    // First load: fill current slot, no fade.
    slots.value[front.value] = src
  } else {
    // Cross-fade: swap into the hidden slot, then flip.
    const back = 1 - front.value
    slots.value[back] = src
    front.value = back
  }
}

function advance() {
  setIndex(index.value + 1)
}
function goPrev() { setIndex(index.value - 1) }
function goNext() { setIndex(index.value + 1) }

function init() {
  setIndex(props.startIndex || 0)
}

function start() {
  stop()
  if (playing.value && props.images.length > 1) {
    timer = setInterval(advance, intervalMs.value)
  }
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
}

function togglePlay() { playing.value = !playing.value }

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen()
  } else {
    rootEl.value?.requestFullscreen?.()
  }
}

// Track fullscreen state via the fullscreenchange event.
function onFsChange() {
  fullscreen.value = !!document.fullscreenElement
}

// Resize drag via a corner handle; position via a title bar drag.
let drag = null
function startDrag(e) {
  drag = { startX: e.clientX, startY: e.clientY, w: win.value.w, h: win.value.h }
  window.addEventListener('mousemove', onDragMove)
  window.addEventListener('mouseup', onDragEnd)
}
function onDragMove(e) {
  if (!drag) return
  win.value.w = Math.max(320, drag.w + (e.clientX - drag.startX))
  win.value.h = Math.max(240, drag.h + (e.clientY - drag.startY))
}
function onDragEnd() { drag = null; window.removeEventListener('mousemove', onDragMove); window.removeEventListener('mouseup', onDragEnd) }

let move = null
function startMove(e) {
  move = { startX: e.clientX, startY: e.clientY, x: win.value.x, y: win.value.y }
  window.addEventListener('mousemove', onMoveMove)
  window.addEventListener('mouseup', onMoveEnd)
}
function onMoveMove(e) {
  if (!move) return
  win.value.x = move.x + (e.clientX - move.startX)
  win.value.y = move.y + (e.clientY - move.startY)
}
function onMoveEnd() { move = null; window.removeEventListener('mousemove', onMoveMove); window.removeEventListener('mouseup', onMoveEnd) }

function onKey(e) {
  if (e.key === 'Escape') emit('close')
  else if (e.key === ' ') { e.preventDefault(); togglePlay() }
  else if (e.key === 'ArrowRight') goNext()
  else if (e.key === 'ArrowLeft') goPrev()
}

watch(playing, start)
watch(intervalMs, start)

onMounted(() => {
  init()
  document.addEventListener('fullscreenchange', onFsChange)
  window.addEventListener('keydown', onKey)
  start()
})
onUnmounted(() => {
  stop()
  document.removeEventListener('fullscreenchange', onFsChange)
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('mousemove', onDragMove)
  window.removeEventListener('mouseup', onDragEnd)
  window.removeEventListener('mousemove', onMoveMove)
  window.removeEventListener('mouseup', onMoveEnd)
})
</script>

<template>
  <div
    ref="rootEl"
    class="slideshow"
    :class="{ fullscreen }"
    :style="{ left: win.x + 'px', top: win.y + 'px', width: win.w + 'px', height: win.h + 'px' }"
  >
    <!-- Title bar (drag to move) -->
    <div class="titlebar" @mousedown="startMove">
      <span class="title">Slideshow — {{ index + 1 }} / {{ images.length }}</span>
      <div class="tb-actions" @mousedown.stop>
        <button class="tb" title="fullscreen" @click="toggleFullscreen">⛶</button>
        <button class="tb" title="close" @click="emit('close')">✕</button>
      </div>
    </div>

    <!-- Cross-fade stage (two stacked slots; `front` is the visible one) -->
    <div class="stage">
      <img
        v-if="slots[0]"
        :src="slots[0].url"
        class="layer"
        :class="{ show: front === 0 }"
      />
      <img
        v-if="slots[1]"
        :src="slots[1].url"
        class="layer"
        :class="{ show: front === 1 }"
      />
      <div class="caption" v-if="current">
        <strong>{{ current.road_number || 'unidentified' }}</strong>
        <span v-if="current.capture_location">{{ current.capture_location }}</span>
        <span v-if="current.captured_at">{{ current.captured_at }}</span>
      </div>
    </div>

    <!-- Controls bar -->
    <div class="controls">
      <button class="ctl" @click="goPrev">‹</button>
      <button class="ctl play" @click="togglePlay">{{ playing ? '❚❚' : '▶' }}</button>
      <button class="ctl" @click="goNext">›</button>

      <label class="interval">interval
        <select v-model.number="intervalMs">
          <option :value="2000">2s</option>
          <option :value="4000">4s</option>
          <option :value="7000">7s</option>
          <option :value="12000">12s</option>
        </select>
      </label>
    </div>

    <!-- Resize handle -->
    <div class="resize" @mousedown="startDrag"></div>
  </div>
</template>

<style scoped>
.slideshow {
  position: fixed;
  z-index: 1000;
  background: #111;
  border: 1px solid #333;
  border-radius: 10px;
  box-shadow: 0 12px 60px rgba(0,0,0,0.6);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.slideshow.fullscreen {
  left: 0 !important;
  top: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  border-radius: 0;
  border: none;
}

.titlebar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: #1a1a1a;
  color: #ccc;
  cursor: move;
  user-select: none;
  flex: 0 0 auto;
}
.title { font-size: 12px; font-weight: 600; }
.tb-actions { display: flex; gap: 4px; }
.tb {
  width: 24px; height: 24px;
  border: none; border-radius: 4px;
  background: rgba(255,255,255,0.1);
  color: #ddd; cursor: pointer; font-size: 12px;
}
.tb:hover { background: rgba(255,255,255,0.25); }

.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #000;
  overflow: hidden;
}
.layer {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: contain;
  opacity: 0;
  transition: opacity 0.8s ease;
}
.layer.show { opacity: 1; }

.caption {
  position: absolute;
  left: 0; right: 0; bottom: 0;
  padding: 8px 12px;
  background: linear-gradient(transparent, rgba(0,0,0,0.75));
  color: #eee;
  font-size: 12px;
  display: flex;
  gap: 10px;
  align-items: baseline;
}

.controls {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #1a1a1a;
  flex: 0 0 auto;
}
.ctl {
  width: 30px; height: 30px;
  border: none; border-radius: 50%;
  background: rgba(255,255,255,0.12);
  color: #fff; cursor: pointer; font-size: 16px;
}
.ctl:hover { background: rgba(255,255,255,0.3); }
.ctl.play { font-size: 10px; }
.interval {
  margin-left: auto;
  color: #aaa;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.interval select {
  background: #222; color: #eee;
  border: 1px solid #444; border-radius: 4px;
  padding: 2px 4px;
}

.resize {
  position: absolute;
  right: 0; bottom: 0;
  width: 18px; height: 18px;
  cursor: nwse-resize;
}
.resize::after {
  content: '';
  position: absolute;
  right: 4px; bottom: 4px;
  border-right: 2px solid #666;
  border-bottom: 2px solid #666;
  width: 10px; height: 10px;
}
</style>