import { createPinia } from 'pinia'
import { createApp } from 'vue'
import App from './App.vue'
import { errorMessage } from './api/client'
import './assets/main.css'
import { router } from './router'
import { useAppStore } from './stores/app.store'
import { useConverterStore } from './stores/converter.store'
import { useDownloadsStore } from './stores/downloads.store'
import { useEnginesStore } from './stores/engines.store'
import { useSettingsStore } from './stores/settings.store'
import { useToastStore } from './stores/toast.store'
import { useUpdatesStore } from './stores/updates.store'

async function start(): Promise<void> {
  const app = createApp(App)
  app.use(createPinia())
  app.use(router)

  const toasts = useToastStore()
  app.config.errorHandler = (error, _instance, info) => {
    console.error(`Unhandled error (${info})`, error)
    toasts.error('Something went wrong', errorMessage(error))
  }

  // Settings are loaded before mounting so the first paint uses the saved theme.
  const [settingsResult, infoResult, enginesResult, downloadsResult, updatesResult, converterResult] = await Promise.allSettled([
    useSettingsStore().load(),
    useAppStore().load(),
    useEnginesStore().load(),
    useDownloadsStore().load(),
    useUpdatesStore().load(),
    useConverterStore().load()
  ])

  app.mount('#app')

  if (settingsResult.status === 'rejected') {
    toasts.error('Settings could not be loaded', `Using defaults. ${errorMessage(settingsResult.reason)}`)
  }
  if (infoResult.status === 'rejected') {
    toasts.error('Application information unavailable', errorMessage(infoResult.reason))
  }
  if (downloadsResult.status === 'rejected') {
    toasts.error('Downloads could not be loaded', errorMessage(downloadsResult.reason))
  }
  if (converterResult.status === 'rejected') {
    toasts.error('Conversions could not be loaded', errorMessage(converterResult.reason))
  }
  if (updatesResult.status === 'rejected') {
    toasts.error('Update status unavailable', errorMessage(updatesResult.reason))
  }
  if (enginesResult.status === 'rejected') {
    toasts.error('Media engine status unavailable', errorMessage(enginesResult.reason))
  }
}

void start()
