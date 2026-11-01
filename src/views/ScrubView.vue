<script setup>
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { api } from '../lib/api.js'

const captures = ref([])
const selected = ref(null)
const meta = ref(null)
const filmstrip = ref([]) // [{ ts, url }]
const time = ref(0)
const frameUrl = ref('')
const picks = ref([]) // [{ sightingId, ts, url }]
const error = ref(null)
const note = ref('')
const stripRef = ref(null)
const frameEl = ref(null)
const selectedPicks = ref(new Set()) // sightingId -> true
const metaById = ref({}) // capture id -> editable metadata { name, captured_at, location, note, ... }
const expandedId = ref(null) // which video's metadata accordion is open
const saveState = ref('idle') // idle | saving | saved

let scrubTimer = null

onMounted(async () => {
  try {
    const all = await api.captures()
    // Only videos (have a real duration); stills/failed have null/tiny duration.
    captures.value = all.filter((c) => c.duration && c.duration > 1)
  } catch (e) {
    error.value = e.message
  }
  window.addEventListener('keydown', onKey)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  if (scrubTimer) clearTimeout(scrubTimer)
})

const duration = computed(() => meta.value?.duration || 0)
const stepMs = computed(() => (meta.value?.fps ? 1 / meta.value.fps : 1 / 30))
const timeLabel = computed(() => fmtTime(time.value))

// Fractional scrub position 0..1, used to float the head controls.
const headPct = computed(() => (duration.value ? (time.value / duration.value) * 100 : 0))

// Live tilt correction for the currently-loaded capture (preview only; the
// actual bake happens at frame-capture time via cap.rotation).
const liveRotation = computed(() => {
  if (selected.value == null) return 0
  return metaById.value[selected.value]?.rotation ?? 0
})
const previewStyle = computed(() => ({
  transform: `rotate(${liveRotation.value}deg) scale(0.98)`,
  transformOrigin: 'center center',
}))

function fmtTime(t) {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const ms = Math.floor((t % 1) * 100)
  return `${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(2, '0')}`
}

async function selectCapture(cap) {
  selected.value = cap.id
  meta.value = { duration: cap.duration, width: cap.width, height: cap.height, fps: cap.fps }
  filmstrip.value = []
  picks.value = []
  selectedPicks.value = new Set()
  time.value = 0
  note.value = ''
  error.value = null

  try {
    const [m, strip, capDetail] = await Promise.all([
      api.get(`/api/video/${cap.id}/meta`),
      api.get(`/api/video/${cap.id}/filmstrip`),
      api.capture(cap.id),
    ])
    meta.value = m
    filmstrip.value = strip
    picks.value = (capDetail.sightings || []).map((s) => ({
      sightingId: s.id,
      url: mediaUrl(s.image_path),
    }))
    // Cache editable metadata for this capture.
    metaById.value[cap.id] = metaFromDetail(capDetail)
    updateFrame()
    centerStrip()
  } catch (e) {
    error.value = e.message
  }
}

function metaFromDetail(d) {
  return {
    name: d.name ?? '',
    captured_at: d.captured_at ?? '',
    location: d.location ?? '',
    note: d.note ?? '',
    rotation: d.rotation ?? 0,
    created_at: d.created_at ?? null,
    width: d.width ?? null,
    height: d.height ?? null,
    fps: d.fps ?? null,
    duration: d.duration ?? null,
  }
}

// Expand/collapse a video's metadata without loading it for scrubbing.
async function toggleMeta(cap) {
  if (expandedId.value === cap.id) {
    expandedId.value = null
    return
  }
  expandedId.value = cap.id
  if (!metaById.value[cap.id]) {
    try {
      const detail = await api.capture(cap.id)
      metaById.value[cap.id] = metaFromDetail(detail)
    } catch (e) {
      error.value = e.message
    }
  }
}

function mediaUrl(p) {
  if (!p) return ''
  const i = p.indexOf('/storage/')
  return i >= 0 ? `/media${p.slice(i + '/storage'.length)}` : p
}

function scheduleFrame() {
  if (scrubTimer) clearTimeout(scrubTimer)
  scrubTimer = setTimeout(updateFrame, 60)
}

async function updateFrame() {
  if (selected.value == null) return
  const url = `/api/video/${selected.value}/frame?t=${time.value.toFixed(3)}`
  frameUrl.value = url + '&_=' + Date.now()
}

function onScrub() {
  scheduleFrame()
  centerStrip()
}

// Keep the filmstrip centered on the current time (wide-angle look ahead/behind).
function centerStrip() {
  nextTick(() => {
    const el = stripRef.value
    if (!el) return
    const thumb = el.querySelector('.thumb.current')
    if (thumb) {
      const elMid = el.clientWidth / 2
      const thumbMid = thumb.offsetLeft + thumb.clientWidth / 2
      el.scrollLeft = thumbMid - elMid
    }
  })
}

function step(n) {
  time.value = Math.max(0, Math.min(duration.value, time.value + n * stepMs.value))
  scheduleFrame()
  centerStrip()
}

async function captureCurrent() {
  if (selected.value == null) return
  try {
    const r = await api.captureFrame(selected.value, time.value, note.value)
    picks.value.unshift({ sightingId: r.sightingId, ts: time.value, url: r.mediaUrl })
  } catch (e) {
    error.value = e.message
  }
}

function togglePick(id) {
  const s = selectedPicks.value
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selectedPicks.value = new Set(s)
}

function selectAllPicks() {
  const all = picks.value.map((p) => p.sightingId)
  selectedPicks.value = selectedPicks.value.size === picks.value.length && picks.value.length
    ? new Set()
    : new Set(all)
}

async function deleteSelectedPicks() {
  const ids = [...selectedPicks.value]
  if (!ids.length) return
  try {
    await api.deleteSightings(ids)
    picks.value = picks.value.filter((p) => !selectedPicks.value.has(p.sightingId))
    selectedPicks.value = new Set()
  } catch (e) {
    error.value = e.message
  }
}

async function deletePick(id) {
  try {
    await api.deleteSighting(id)
    picks.value = picks.value.filter((p) => p.sightingId !== id)
    selectedPicks.value = new Set([...selectedPicks.value].filter((x) => x !== id))
  } catch (e) {
    error.value = e.message
  }
}

async function saveMeta(id) {
  if (id == null || !metaById.value[id]) return
  saveState.value = 'saving'
  try {
    const updated = await api.updateCapture(id, {
      name: metaById.value[id].name,
      captured_at: metaById.value[id].captured_at,
      location: metaById.value[id].location,
      note: metaById.value[id].note,
      rotation: metaById.value[id].rotation ?? 0,
    })
    // Reflect returned values back.
    metaById.value[id] = {
      ...metaById.value[id],
      name: updated.name ?? '',
      captured_at: updated.captured_at ?? '',
      location: updated.location ?? '',
      note: updated.note ?? '',
      rotation: updated.rotation ?? 0,
    }
    saveState.value = 'saved'
    setTimeout(() => { saveState.value = 'idle' }, 2000)
  } catch (e) {
    error.value = e.message
    saveState.value = 'idle'
  }
}

// Clear the currently loaded video (without deleting anything).
// Metadata (metaById) and the metadata accordion (expandedId) are independent
// and are NOT cleared here.
function clearSelection() {
  selected.value = null
  meta.value = null
  filmstrip.value = []
  picks.value = []
  frameUrl.value = ''
  time.value = 0
  note.value = ''
  selectedPicks.value = new Set()
  if (scrubTimer) {
    clearTimeout(scrubTimer)
    scrubTimer = null
  }
}

async function deleteCapture(id) {
  if (!confirm('Delete this video and all its picked frames?')) return
  try {
    await api.deleteCapture(id)
    if (selected.value === id) clearSelection()
    if (expandedId.value === id) expandedId.value = null
    delete metaById.value[id]
    const all = await api.captures()
    captures.value = all.filter((c) => c.duration && c.duration > 1)
  } catch (e) {
    error.value = e.message
  }
}

function isEditableTarget(el) {
  if (!el) return false
  const tag = el.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    el.isContentEditable
  )
}

function onKey(e) {
  if (selected.value == null) return
  // Ignore shortcuts while the user is typing in a field or textarea.
  if (isEditableTarget(e.target)) return
  if (e.key === 'ArrowRight') step(1)
  else if (e.key === 'ArrowLeft') step(-1)
  else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    captureCurrent()
  }
}
</script>

<template>
  <div class="scrub">
    <!-- Main work area (left) -->
    <div class="work">
      <p v-if="error" class="error">{{ error }}</p>

      <div v-if="selected == null" class="empty">
        <p>Select a video from the right to begin.</p>
      </div>

      <template v-else>
        <!-- Player block: preview + scrubber joined, with floating head controls -->
        <section class="player">
          <div class="preview">
            <img v-if="frameUrl" :src="frameUrl" class="frame" :style="previewStyle" :alt="`frame at ${timeLabel}`" />
            <div v-else class="frame placeholder">Loading frame…</div>

            <!-- Floating scrub-head controls, positioned at the headPct -->
            <div class="head-controls" :style="{ left: `${headPct}%` }">
              <button class="ico" title="previous frame" @click="step(-1)">‹</button>
              <button class="ico cap-btn" title="capture frame" @click="captureCurrent">●</button>
              <button class="ico" title="next frame" @click="step(1)">›</button>
            </div>
          </div>

          <!-- Scrubber joined to the preview bottom -->
          <div class="scrubber">
            <input
              type="range"
              :min="0"
              :max="duration"
              :step="stepMs"
              v-model.number="time"
              @input="onScrub"
              class="slider"
            />
          </div>

          <div class="scrub-meta">
            <span class="time">{{ timeLabel }}</span>
            <span class="time muted">/ {{ fmtTime(duration || 0) }}</span>
            <span class="hint muted">← → step · Enter capture</span>
            <label class="note">
              <input v-model="note" type="text" placeholder="note (optional)" />
            </label>
            <button class="close-btn" title="close this video" @click="clearSelection">✕</button>
          </div>

          <!-- Filmstrip: wide-angle view around the scrub head -->
          <div v-if="filmstrip.length" ref="stripRef" class="filmstrip">
            <img
              v-for="t in filmstrip"
              :key="t.ts"
              :src="t.url"
              class="thumb"
              :class="{ current: Math.abs(t.ts - time) < stepMs }"
              @click="time = t.ts; updateFrame(); centerStrip()"
            />
          </div>
        </section>

        <section v-if="picks.length" class="picks">
          <div class="picks-head">
            <h2>Picked frames ({{ picks.length }})</h2>
            <div class="picks-actions">
              <button class="link" @click="selectAllPicks">select all</button>
              <button
                class="link danger"
                :disabled="!selectedPicks.size"
                @click="deleteSelectedPicks"
              >
                delete selected{{ selectedPicks.size ? ` (${selectedPicks.size})` : '' }}
              </button>
            </div>
          </div>
          <div class="pick-grid">
            <div
              v-for="p in picks"
              :key="p.sightingId"
              class="pick"
              :class="{ selected: selectedPicks.has(p.sightingId) }"
              @click="togglePick(p.sightingId)"
            >
              <img :src="p.url" :alt="'pick'" />
              <button class="pick-x" title="delete" @click.stop="deletePick(p.sightingId)">✕</button>
            </div>
          </div>
        </section>
      </template>
    </div>

    <!-- Side panel (right): imported video artifacts -->
    <aside class="side">
      <h2>Videos</h2>
      <p v-if="!captures.length" class="muted">No videos imported yet.</p>
      <ul class="cap-list">
        <li v-for="c in captures" :key="c.id">
          <!-- Accordion header: expand/collapse metadata (does NOT load video) -->
          <div class="cap-row">
            <button
              class="cap-chip toggle"
              :class="{ active: selected === c.id, open: expandedId === c.id }"
              @click="toggleMeta(c)"
            >
              <span class="chev">{{ expandedId === c.id ? '▾' : '▸' }}</span>
              <span class="cap-name">{{ metaById[c.id]?.name || `#${c.id}` }}</span>
              <span class="cap-res">{{ c.width }}×{{ c.height }}</span>
            </button>
            <button
              class="cap-load"
              :class="{ loaded: selected === c.id }"
              :title="selected === c.id ? 'already loaded' : 'load for scrubbing'"
              @click="selectCapture(c)"
            >
              {{ selected === c.id ? 'loaded' : 'load' }}
            </button>
            <button class="cap-del" title="delete video" @click="deleteCapture(c.id)">✕</button>
          </div>

          <!-- Inline metadata accordion -->
          <section v-if="expandedId === c.id && metaById[c.id]" class="meta-panel">
            <label>Name
              <input v-model="metaById[c.id].name" type="text" placeholder="optional name" />
            </label>

            <label>Captured at
              <input v-model="metaById[c.id].captured_at" type="datetime-local" />
            </label>

            <label>Location
              <input v-model="metaById[c.id].location" type="text" placeholder="e.g. Coquitlam" />
            </label>

            <label>Notes
              <textarea v-model="metaById[c.id].note" rows="3" placeholder="anything worth remembering"></textarea>
            </label>

            <!-- Tilt correction: baked into every frame picked from this video -->
            <div class="tilt">
              <span class="tilt-label">Tilt correction</span>
              <div class="tilt-row">
                <button class="nudge" @click="metaById[c.id].rotation = Math.round((metaById[c.id].rotation - 0.1) * 10) / 10">−</button>
                <input v-model.number="metaById[c.id].rotation" type="number" step="0.1" class="angle-in" />
                <span class="deg">°</span>
                <button class="nudge" @click="metaById[c.id].rotation = Math.round((metaById[c.id].rotation + 0.1) * 10) / 10">+</button>
                <input v-model.number="metaById[c.id].rotation" type="range" min="-5" max="5" step="0.05" class="angle-slider" />
              </div>
              <span class="tilt-hint">applies to frames picked after saving</span>
            </div>

            <div class="meta-readonly">
              <span v-if="metaById[c.id].width">{{ metaById[c.id].width }}×{{ metaById[c.id].height }}</span>
              <span v-if="metaById[c.id].fps">{{ metaById[c.id].fps }} fps</span>
              <span v-if="metaById[c.id].duration">{{ fmtTime(metaById[c.id].duration) }}</span>
              <span v-if="metaById[c.id].created_at" class="muted">uploaded {{ metaById[c.id].created_at }}</span>
            </div>

            <button class="save" :disabled="saveState === 'saving'" @click="saveMeta(c.id)">
              <span v-if="saveState === 'saving'">Saving…</span>
              <span v-else-if="saveState === 'saved'" class="saved">✓ Saved</span>
              <span v-else>Save metadata</span>
            </button>
          </section>
        </li>
      </ul>
    </aside>
  </div>
</template>

<style scoped>
.scrub {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 16px;
  align-items: start;
  width: 100%;
  max-width: 100%;
}
.work {
  min-width: 0;
  overflow: hidden;
}
.muted {
  color: #888;
  font-size: 12px;
}
.error {
  color: #b00;
}
.empty {
  padding: 60px;
  text-align: center;
  color: #888;
}

/* Side panel */
.side h2 {
  margin-top: 0;
  font-size: 14px;
}
.cap-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.cap-chip {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid #ccc;
  border-radius: 6px;
  background: #fff;
  cursor: pointer;
  text-align: left;
  font-size: 13px;
}
.cap-chip:hover {
  border-color: #aaa;
}
.cap-chip.active {
  border-color: #3a7d3a;
  background: #eef7ee;
}
.chev {
  color: #999;
  font-size: 11px;
  width: 10px;
  text-align: center;
  flex: 0 0 auto;
}
.cap-name {
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cap-res {
  color: #888;
  font-size: 11px;
  margin-left: auto;
  flex: 0 0 auto;
}

.player {
  margin: 0;
  min-width: 0;
  max-width: 100%;
}

/* Preview + floating head controls */
.preview {
  position: relative;
  background: #111;
  border-radius: 8px 8px 0 0;
  overflow: hidden;
}
.frame {
  display: block;
  width: 100%;
  max-height: 520px;
  object-fit: contain;
}
.placeholder {
  padding: 120px;
  text-align: center;
  color: #888;
}
.head-controls {
  position: absolute;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  gap: 6px;
  align-items: center;
  background: rgba(0, 0, 0, 0.45);
  padding: 4px 8px;
  border-radius: 20px;
  backdrop-filter: blur(2px);
  transition: left 0.08s linear;
}
.ico {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.25);
  color: #fff;
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ico:hover {
  background: rgba(255, 255, 255, 0.4);
}
.cap-btn {
  background: #3a9c3a;
  font-size: 16px;
}
.cap-btn:hover {
  background: #46b346;
}

/* Scrubber joined to preview (no top radius gap) */
.scrubber {
  background: #1c1c1c;
  padding: 8px 12px 10px;
}
.slider {
  width: 100%;
  accent-color: #3a9c3a;
}

.scrub-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #1c1c1c;
  color: #eee;
  padding: 0 12px 10px;
  border-radius: 0 0 8px 8px;
}
.time {
  font-variant-numeric: tabular-nums;
}
.hint {
  color: #777;
}
.note {
  margin-left: auto;
  display: flex;
  align-items: center;
  font-size: 12px;
  color: #aaa;
}
.note input {
  padding: 4px 8px;
  border: 1px solid #444;
  border-radius: 4px;
  background: #222;
  color: #eee;
  width: 160px;
}
.close-btn {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: none;
  background: rgba(255, 255, 255, 0.12);
  color: #ccc;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  flex: 0 0 auto;
}
.close-btn:hover {
  background: rgba(255, 99, 99, 0.35);
  color: #fff;
}

/* Filmstrip below scrubber, wide-angle context */
.filmstrip {
  display: flex;
  gap: 2px;
  overflow-x: auto;
  padding: 8px 0;
  scroll-behavior: smooth;
  max-width: 100%;
}
.thumb {
  height: 52px;
  cursor: pointer;
  border: 2px solid transparent;
  flex: 0 0 auto;
}
.thumb.current {
  border-color: #3a9c3a;
}

.picks {
  margin-top: 24px;
}
.picks-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.picks-head h2 {
  font-size: 14px;
}
.picks-actions {
  display: flex;
  gap: 10px;
}
.link {
  background: none;
  border: none;
  color: #3a7d3a;
  cursor: pointer;
  font-size: 12px;
  padding: 0;
}
.link:hover {
  text-decoration: underline;
}
.link.danger {
  color: #b00;
}
.link:disabled {
  color: #bbb;
  cursor: default;
  text-decoration: none;
}
.pick-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.pick {
  position: relative;
  cursor: pointer;
  border: 2px solid transparent;
  border-radius: 6px;
}
.pick.selected {
  border-color: #3a9c3a;
}
.pick img {
  height: 120px;
  border-radius: 4px;
  display: block;
}
.pick-x {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  display: none;
  align-items: center;
  justify-content: center;
}
.pick:hover .pick-x {
  display: flex;
}

/* Side panel video rows */
.cap-row {
  display: flex;
  gap: 4px;
  align-items: stretch;
}
.cap-load {
  padding: 0 8px;
  border: 1px solid #3a7d3a;
  border-radius: 6px;
  background: #fff;
  color: #3a7d3a;
  cursor: pointer;
  font-size: 11px;
  white-space: nowrap;
}
.cap-load:hover {
  background: #eef7ee;
}
.cap-load.loaded {
  background: #3a7d3a;
  color: #fff;
}
.cap-del {
  width: 26px;
  border: 1px solid #ccc;
  border-radius: 6px;
  background: #fff;
  color: #999;
  cursor: pointer;
  font-size: 12px;
  flex: 0 0 auto;
}
.cap-del:hover {
  color: #b00;
  border-color: #b00;
}

/* Metadata panel (inline accordion under each video) */
.meta-panel {
  margin: 6px 0 8px 18px;
  border-left: 2px solid #3a7d3a;
  padding: 6px 8px;
  background: #fafafa;
  border-radius: 0 6px 6px 0;
}
.meta-panel label {
  display: flex;
  flex-direction: column;
  font-size: 12px;
  color: #555;
  margin-bottom: 8px;
}
.meta-panel input,
.meta-panel textarea {
  margin-top: 3px;
  padding: 5px 7px;
  border: 1px solid #ccc;
  border-radius: 4px;
  font-size: 12px;
  width: 100%;
  font-family: inherit;
}
.tilt {
  margin: 4px 0 8px;
}
.tilt-label {
  display: block;
  font-size: 12px;
  color: #555;
  margin-bottom: 4px;
}
.tilt-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
.nudge {
  width: 24px;
  height: 24px;
  border: 1px solid #bbb;
  border-radius: 4px;
  background: #fff;
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.angle-in {
  width: 52px;
  padding: 3px 5px;
  border: 1px solid #bbb;
  border-radius: 4px;
  font-size: 12px;
}
.deg {
  color: #666;
  font-size: 12px;
}
.angle-slider {
  flex: 1;
  min-width: 60px;
  accent-color: #3a7d3a;
}
.tilt-hint {
  display: block;
  font-size: 10px;
  color: #999;
  margin-top: 3px;
}

.meta-readonly {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 11px;
  color: #666;
  margin: 8px 0;
}
.meta-readonly .muted {
  color: #aaa;
}
.save {
  margin-top: 6px;
  padding: 6px 12px;
  background: #3a7d3a;
  color: #fff;
  border: none;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
}
.save:hover {
  background: #46a046;
}
.save:disabled {
  background: #9fc99f;
  cursor: default;
}
.save .saved {
  font-weight: 600;
}
</style>