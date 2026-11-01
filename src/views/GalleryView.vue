<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../lib/api.js'
import Slideshow from '../components/Slideshow.vue'
import PerspectiveEditor from '../components/PerspectiveEditor.vue'

const sightings = ref([])
const error = ref(null)
const showSlideshow = ref(false)

// Selection (for bulk editing)
const selectedIds = ref(new Set())
const busy = ref(false)
const version = ref(1) // cache-bust counter for image URLs after destructive edits

// Editor state
const showPerspective = ref(false)

// Filters
const search = ref('') // matches name / location / note / road number
const location = ref('')
const minWidth = ref(0)
const capturedDate = ref('')

onMounted(async () => {
  try {
    sightings.value = await api.sightings()
  } catch (e) {
    error.value = e.message
  }
})

function mediaUrl(p) {
  if (!p) return ''
  const i = p.indexOf('/storage/')
  return i >= 0 ? `/media${p.slice(i + '/storage'.length)}` : p
}

const locations = computed(() => {
  const s = new Set()
  for (const x of sightings.value) if (x.capture_location) s.add(x.capture_location)
  return [...s].sort()
})

function effectiveWidth(s) {
  return s.capture_width || 0
}

function dateOnly(s) {
  return s.captured_at ? String(s.captured_at).slice(0, 10) : ''
}

// ── Selection ───────────────────────────────────────────────────────────────
function toggleSelect(id) {
  const s = new Set(selectedIds.value)
  s.has(id) ? s.delete(id) : s.add(id)
  selectedIds.value = s
}

function selectAll() {
  const all = filtered.value.map((s) => s.id)
  selectedIds.value = new Set(all)
}

function clearSelection() {
  selectedIds.value = new Set()
}

const selectedCount = computed(() => selectedIds.value.size)

// ── Actions ─────────────────────────────────────────────────────────────────
// The image being edited (set from selection via the toolbar, or dbl-click).
const editorImage = ref(null)

function openPerspective() {
  if (!editorImage.value) {
    const id = [...selectedIds.value][0]
    editorImage.value = sightings.value.find((s) => s.id === id) || null
  }
  if (editorImage.value) showPerspective.value = true
}

// Double-click a card -> edit that image directly.
function dblclickToEdit(s) {
  editorImage.value = s
  showPerspective.value = true
}

function onPerspectiveApplied() {
  showPerspective.value = false
  editorImage.value = null
  clearSelection()
  reload()
}

async function deleteSelected() {
  if (!selectedCount.value) return
  if (!confirm(`Delete ${selectedCount.value} selected image${selectedCount.value > 1 ? 's' : ''}?`)) return
  busy.value = true
  try {
    await api.deleteSightings([...selectedIds.value])
    clearSelection()
    await reload()
  } catch (e) {
    error.value = e.message
  } finally {
    busy.value = false
  }
}

async function reload() {
  try {
    sightings.value = await api.sightings()
  } catch (e) {
    error.value = e.message
  }
  version.value++
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return sightings.value.filter((s) => {
    if (q) {
      const hay = [s.capture_name, s.capture_location, s.capture_note, s.road_number, s.note]
        .filter(Boolean).join(' ').toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (location.value && s.capture_location !== location.value) return false
    if (minWidth.value && effectiveWidth(s) < minWidth.value) return false
    if (capturedDate.value && dateOnly(s) !== capturedDate.value) return false
    return true
  })
})

// Slideshow uses the current filter set.
const slideshowImages = computed(() =>
  filtered.value.map((s) => ({
    id: s.id,
    image_path: s.image_path,
    capture_id: s.capture_id,
    road_number: s.road_number,
    capture_name: s.capture_name,
    capture_location: s.capture_location,
    captured_at: s.captured_at,
  })),
)

function startSlideshow() {
  if (!slideshowImages.value.length) return
  showSlideshow.value = true
}
</script>

<template>
  <div class="gallery">
    <div class="sticky-head">
      <div class="head">
        <h1>Gallery</h1>
        <button
          class="play-btn"
          :disabled="!slideshowImages.length"
          @click="startSlideshow"
        >
          ▶ Play slideshow
        </button>
      </div>
      <p class="muted">{{ filtered.length }} of {{ sightings.length }} captured images.</p>
      <p v-if="error" class="error">{{ error }}</p>

      <div class="filters">
        <input v-model="search" type="text" placeholder="search name / location / note / road no." />
        <select v-model="location">
          <option value="">all locations</option>
          <option v-for="l in locations" :key="l" :value="l">{{ l }}</option>
        </select>
        <select v-model="minWidth">
          <option :value="0">any resolution</option>
          <option :value="640">≥ 640px</option>
          <option :value="1280">≥ 1280px</option>
          <option :value="1920">≥ 1920px</option>
        </select>
        <input v-model="capturedDate" type="date" title="captured on" />
      </div>

      <!-- Selection / edit toolbar -->
      <div v-if="selectedCount" class="toolbar">
        <span class="tb-count">{{ selectedCount }} selected</span>
        <button class="tb-link" @click="selectAll">select all</button>
        <button class="tb-link" @click="clearSelection">clear</button>

        <span class="tb-divider"></span>

        <button class="tb-action" @click="openPerspective">Edit…</button>

        <span class="tb-divider"></span>

        <button class="tb-action danger" :disabled="busy" @click="deleteSelected">Delete</button>
      </div>
    </div>

    <div v-if="filtered.length" class="grid">
      <figure
        v-for="s in filtered"
        :key="s.id"
        class="card"
        :class="{ selected: selectedIds.has(s.id) }"
        @click="toggleSelect(s.id)"
        @dblclick="dblclickToEdit(s)"
      >
        <img :src="mediaUrl(s.image_path) + '?_=' + version" :alt="s.road_number || 'sighting'" loading="lazy" />
        <figcaption>
          <div class="line1">
            <strong>{{ s.road_number || 'unidentified' }}</strong>
            <span class="dims" v-if="s.capture_width">{{ s.capture_width }}×{{ s.capture_height }}</span>
          </div>
          <div class="meta">
            <span v-if="s.capture_name">{{ s.capture_name }}</span>
            <span v-if="s.capture_location">{{ s.capture_location }}</span>
            <span v-if="s.captured_at">{{ s.captured_at }}</span>
          </div>
          <div class="note" v-if="s.capture_note">{{ s.capture_note }}</div>
        </figcaption>
      </figure>
    </div>

    <p v-else class="muted">No images captured yet. Use the Scrub view to pick frames, or upload a photo.</p>

    <Slideshow
      v-if="showSlideshow"
      :images="slideshowImages"
      :start-index="0"
      @close="showSlideshow = false"
    />

    <PerspectiveEditor
      v-if="showPerspective && editorImage"
      :image="editorImage"
      @close="showPerspective = false"
      @applied="onPerspectiveApplied"
    />
  </div>
</template>

<style scoped>
.muted { color: #888; font-size: 12px; }
.error { color: #b00; }
.sticky-head {
  position: sticky;
  top: 0;
  z-index: 20;
  background: #f4f4f4; /* match page bg so content scrolling under doesn't show through */
  padding: 4px 0 8px;
  margin: -4px 0 0;
}
.head {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 8px;
}
.head h1 { margin: 0; }
.play-btn {
  padding: 8px 16px;
  background: #3a7d3a;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
.play-btn:hover { background: #46a046; }
.play-btn:disabled { background: #bcd7bc; cursor: default; }
.filters {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.filters input, .filters select {
  padding: 6px 8px;
  border: 1px solid #ccc;
  border-radius: 5px;
  font-size: 13px;
}
.filters input[type="text"] { flex: 1; min-width: 220px; }

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  margin-bottom: 12px;
  background: #eef7ee;
  border: 1px solid #cde3cd;
  border-radius: 8px;
  font-size: 13px;
}
.tb-count { font-weight: 600; color: #2a6e2a; }
.tb-link {
  background: none; border: none;
  color: #3a7d3a; cursor: pointer; font-size: 12px; padding: 0;
}
.tb-link:hover { text-decoration: underline; }
.tb-divider { width: 1px; height: 20px; background: #cde3cd; }
.tb-action {
  padding: 5px 12px;
  border: none; border-radius: 5px;
  background: #3a7d3a; color: #fff; cursor: pointer; font-size: 12px;
}
.tb-action:hover { background: #46a046; }
.tb-action:disabled { background: #9fc99f; cursor: default; }
.tb-action.danger { background: #c0392b; }
.tb-action.danger:hover { background: #d64434; }
.tb-action.danger:disabled { background: #e0a99f; cursor: default; }

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}
.card {
  position: relative;
  margin: 0;
  border: 2px solid #ddd;
  border-radius: 8px;
  overflow: hidden;
  background: #fff;
  cursor: pointer;
}
.card.selected {
  border-color: #3a7d3a;
}
.card.selected::after {
  content: '✓';
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: #3a7d3a;
  color: #fff;
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card img {
  width: 100%;
  height: 180px;
  object-fit: cover;
  display: block;
  background: #111;
}
figcaption {
  padding: 8px 10px;
  font-size: 12px;
}
.line1 {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.dims { color: #888; }
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  color: #666;
  margin-top: 3px;
}
.note {
  color: #555;
  margin-top: 4px;
  font-style: italic;
}
</style>