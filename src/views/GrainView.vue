<script setup>
import { ref, computed, onMounted } from 'vue'
import { api } from '../lib/api.js'

const carloadings = ref([])
const geography = ref('British Columbia')
const error = ref(null)

const provinces = [
  'Canada',
  'British Columbia',
  'Alberta',
  'Saskatchewan',
  'Manitoba',
  'Ontario',
  'Quebec',
]

const latestWeek = computed(() => {
  if (!carloadings.value.length) return null
  return carloadings.value[0].ref_date
})

async function load() {
  carloadings.value = []
  error.value = null
  try {
    carloadings.value = await api.carloadings({
      geography: geography.value,
      statistic: 'Cars loaded and billed, all systems',
      limit: 500,
    })
  } catch (e) {
    error.value = e.message
  }
}

onMounted(load)
</script>

<template>
  <div>
    <h1>Grain Movement</h1>
    <p class="muted">
      Weekly grain transportation by rail (Transport Canada open data), through {{ latestWeek }}.
    </p>

    <p v-if="error" class="error">
      Backend not reachable: {{ error }} (run `npm run dev:all` and `node server/grain-ingest.js`)
    </p>

    <label>
      Province:
      <select v-model="geography" @change="load">
        <option v-for="p in provinces" :key="p" :value="p">{{ p }}</option>
      </select>
    </label>

    <section v-if="carloadings.length">
      <h2>Cars loaded &amp; billed, all systems — {{ geography }}</h2>
      <table>
        <thead>
          <tr><th>Week</th><th>Company</th><th>Cars</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in carloadings" :key="r.id">
            <td>{{ r.ref_date }}</td>
            <td>{{ r.company }}</td>
            <td>{{ r.value }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p v-if="!carloadings.length && !error">No carloadings data for this filter.</p>
  </div>
</template>

<style scoped>
table {
  border-collapse: collapse;
  width: 100%;
  margin-bottom: 2rem;
}
th,
td {
  border: 1px solid #ddd;
  padding: 6px 10px;
  text-align: left;
}
th {
  background: #eee;
}
.error {
  color: #b00;
}
.muted {
  color: #888;
}
</style>