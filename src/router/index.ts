import { createRouter, createWebHashHistory } from 'vue-router'

// Hash history: the production renderer is loaded from file://, which has no server to rewrite paths.
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('@/pages/Home.vue'),
      meta: { title: 'Home', description: 'Analyze a link and choose what to download' }
    },
    {
      path: '/downloads',
      name: 'downloads',
      component: () => import('@/pages/Downloads.vue'),
      meta: { title: 'Downloads', description: 'Active and queued downloads' }
    },
    {
      path: '/playlists',
      name: 'playlists',
      component: () => import('@/pages/Playlists.vue'),
      meta: { title: 'Playlists', description: 'Browse playlists and pick individual videos' }
    },
    {
      path: '/converter',
      name: 'converter',
      component: () => import('@/pages/Converter.vue'),
      meta: { title: 'Audio Converter', description: 'Convert local media files to audio formats' }
    },
    {
      path: '/history',
      name: 'history',
      component: () => import('@/pages/History.vue'),
      meta: { title: 'History', description: 'Previously downloaded items' }
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/pages/Settings.vue'),
      meta: { title: 'Settings', description: 'Preferences and application information' }
    },
    {
      path: '/updates',
      name: 'updates',
      component: () => import('@/pages/Updates.vue'),
      meta: { title: 'Software Updates', description: 'Application and media engine versions' }
    },
    { path: '/:pathMatch(.*)*', redirect: { name: 'home' } }
  ]
})
