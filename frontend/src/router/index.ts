import { createRouter, createWebHistory } from 'vue-router'
import SegmentStudioView from '../views/SegmentStudioView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'segment-studio',
      component: SegmentStudioView,
    },
  ],
})

export default router
