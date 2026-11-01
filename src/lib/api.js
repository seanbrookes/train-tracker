// Thin fetch client for the train-tracker backend (server/proxy.js).
// All endpoints are backed by the SQLite database.

async function getJson(path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

// Generic helpers exposed on `api` for the scrub view.
async function rawGet(path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

async function del(path, body) {
  const res = await fetch(path, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

// Upload a video file (multipart) and return the JSON response.
async function upload(path, file, fields = {}) {
  const fd = new FormData()
  fd.append('video', file)
  for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') fd.append(k, v)
  const res = await fetch(path, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`)
  return res.json()
}

export const api = {
  stations: () => getJson('/api/stations'),
  subdivisions: () => getJson('/api/subdivisions'),
  corridorFlow: () => getJson('/api/grain/corridor-flow'),
  grainByStation: (day) =>
    getJson(`/api/grain/by-station${day ? `?day=${encodeURIComponent(day)}` : ''}`),
  grainDwelling: (day) =>
    getJson(`/api/grain/dwelling${day ? `?day=${encodeURIComponent(day)}` : ''}`),
  carloadings: (params = {}) => {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, v)
    const qs = q.toString()
    return getJson(`/api/grain/carloadings${qs ? `?${qs}` : ''}`)
  },
  carloadingsOverview: (geography) =>
    getJson(`/api/grain/carloadings/overview${geography ? `?geography=${encodeURIComponent(geography)}` : ''}`),
  sightings: () => getJson('/api/sightings'),
  addSighting: (s) => postJson('/api/sightings', s),
  deleteSighting: (id) => del(`/api/sightings/${id}`),
  deleteSightings: (ids) => del('/api/sightings', { ids }),
  rotateSighting: (id, degrees, applyToSource = false) =>
    postJson(`/api/sightings/${id}/rotate`, { degrees, applyToSource }),
  cropSighting: (id, rect) => postJson(`/api/sightings/${id}/crop`, rect),
  perspectiveDetect: (id) => postJson(`/api/sightings/${id}/perspective/detect`, {}),
  perspectiveApply: (id, src) => postJson(`/api/sightings/${id}/perspective/apply`, { src }),
  deleteCapture: (id) => del(`/api/captures/${id}`),
  captures: () => getJson('/api/captures'),
  capture: (id) => getJson(`/api/captures/${id}`),
  updateCapture: (id, fields) =>
    fetch(`/api/captures/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`update failed: ${r.status}`)))),
  trips: () => getJson('/api/trips'),
  addTrip: (t) => postJson('/api/trips', t),
  uploadVideo: (file, fields) => upload('/api/upload', file, fields),
  uploadImage: async (file, fields = {}) => {
    const fd = new FormData()
    fd.append('image', file)
    for (const [k, v] of Object.entries(fields)) if (v != null && v !== '') fd.append(k, v)
    const res = await fetch('/api/upload/image', { method: 'POST', body: fd })
    if (!res.ok) throw new Error(`image upload failed: ${res.status}`)
    return res.json()
  },
  jobs: () => getJson('/api/jobs'),
  job: (id) => getJson(`/api/jobs/${id}`),
  // Generic (used by scrub view) + video scrub endpoints.
  get: rawGet,
  postJSON: postJson,
  videoMeta: (id) => rawGet(`/api/video/${id}/meta`),
  filmstrip: (id) => rawGet(`/api/video/${id}/filmstrip`),
  frameUrl: (id, t) => `/api/video/${id}/frame?t=${t.toFixed(3)}`,
  captureFrame: (id, t, note) => postJson(`/api/video/${id}/capture`, { t, note }),
}