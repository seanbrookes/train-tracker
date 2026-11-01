import { createRouter, createWebHashHistory } from 'vue-router'
import GalleryView from '../views/GalleryView.vue'
import ScrubView from '../views/ScrubView.vue'
import UploadView from '../views/UploadView.vue'
import GrainView from '../views/GrainView.vue'

export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: GalleryView },
    { path: '/scrub', component: ScrubView },
    { path: '/upload', component: UploadView },
    { path: '/grain', component: GrainView },
  ],
})