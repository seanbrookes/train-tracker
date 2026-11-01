<script setup>
import NavBar from './components/NavBar.vue'
</script>

<template>
  <div id="app-shell">
    <NavBar />
    <main id="app-main">
      <RouterView />
    </main>
  </div>
</template>