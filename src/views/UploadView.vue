<script setup>
import { ref } from 'vue'
import { api } from '../lib/api.js'

const dragging = ref(false)
const selected = ref(null)
const uploading = ref(false)
const result = ref(null)
const error = ref(null)

const settings = ref({
  location: '',
  note: '',
})

function onDrop(e) {
  dragging.value = false
  const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0]
  if (file) handleFile(file)
}

function onChoose(e) {
  const file = e.target.files?.[0]
  if (file) handleFile(file)
}

function isImage(file) {
  const t = file.type || ''
  return t.startsWith('image/')
}

async function handleFile(file) {
  selected.value = file
  error.value = null
  result.value = null
  uploading.value = true
  try {
    if (isImage(file)) {
      result.value = await api.uploadImage(file, {
        location: settings.value.location,
        note: settings.value.note,
      })
    } else {
      result.value = await api.uploadVideo(file, {
        location: settings.value.location,
        note: settings.value.note,
      })
    }
  } catch (e) {
    error.value = e.message
  } finally {
    uploading.value = false
  }
}

function fmtBytes(n) {
  if (!n) return ''
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

function fmtDur(s) {
  if (s == null) return ''
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}
</script>

<template>
  <div>
    <h1>Upload</h1>
    <p class="muted">
      Drop a train <strong>video</strong> (archived for scrubbing) or a <strong>still photo</strong>
      (saved as a sighting) here.
    </p>

    <div
      class="drop"
      :class="{ dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="onDrop"
      @click="$refs.file.click()"
    >
      <p v-if="!uploading">Drop a video or image here, or click to browse</p>
      <p v-else>Uploading…</p>
      <input
        ref="file"
        type="file"
        accept="video/*,image/*,.mov,.mp4,.mts,.avi,.jpg,.jpeg,.png,.heic"
        hidden
        @change="onChoose"
      />
    </div>

    <p v-if="selected" class="file-info">
      <strong>{{ selected.name }}</strong> ({{ fmtBytes(selected.size) }})
    </p>

    <section class="settings">
      <h2>Details</h2>
      <div class="grid">
        <label>
          Location
          <input v-model="settings.location" type="text" placeholder="e.g. Coquitlam" />
        </label>
        <label>
          Note
          <input v-model="settings.note" type="text" placeholder="optional" />
        </label>
      </div>
    </section>

    <section v-if="result" class="result">
      <h3>Uploaded</h3>
      <div v-if="result.meta && result.meta.width" class="meta-banner">
        <span>{{ result.meta.width }}×{{ result.meta.height }}</span>
        <span v-if="result.meta.fps">{{ result.meta.fps }} fps</span>
        <span v-if="result.meta.duration">{{ fmtDur(result.meta.duration) }} long</span>
        <span v-if="result.meta.width < 1280 && result.meta.fps" class="warning">SD video — detail will be limited</span>
      </div>
      <p v-if="result.sightingId">Saved as sighting #{{ result.sightingId }} (photo).</p>
      <p v-else>Video archived — go to Scrub to pick frames.</p>
    </section>

    <p v-if="error" class="error">{{ error }}</p>
  </div>
</template>

<style scoped>
.muted {
  color: #888;
  font-size: 12px;
}
.drop {
  border: 2px dashed #aaa;
  border-radius: 8px;
  padding: 40px;
  text-align: center;
  cursor: pointer;
  background: #fafafa;
  transition: all 0.1s;
}
.drop.dragging {
  border-color: #3a7d3a;
  background: #eef7ee;
}
.file-info {
  margin: 8px 0;
}
.settings {
  margin-top: 20px;
}
.grid {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.grid label {
  display: flex;
  flex-direction: column;
  font-size: 13px;
  color: #444;
}
.grid input {
  margin-top: 4px;
  padding: 6px 8px;
  border: 1px solid #ccc;
  border-radius: 4px;
  width: 180px;
}
.result {
  margin-top: 20px;
}
.meta-banner {
  display: flex;
  gap: 12px;
  align-items: center;
  background: #eef3ff;
  padding: 8px 12px;
  border-radius: 6px;
  margin: 8px 0;
}
.warning {
  color: #b8860b;
  font-size: 12px;
}
.error {
  color: #b00;
}
.jobs ul {
  list-style: none;
  padding: 0;
}
.jobs li {
  padding: 4px 0;
  font-size: 13px;
}
.badge {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  margin-right: 6px;
  text-transform: uppercase;
}
.badge.done {
  background: #e2f4e2;
  color: #2a6e2a;
}
.badge.running {
  background: #fff3d6;
  color: #8a6d1a;
}
.badge.queued {
  background: #eee;
  color: #555;
}
.badge.failed {
  background: #fbe3e3;
  color: #a33;
}
</style>