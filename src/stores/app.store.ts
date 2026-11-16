import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppInfo } from '@shared/types/app'
import { bridge, unwrap } from '@/api/client'

export const useAppStore = defineStore('app', () => {
  const info = ref<AppInfo | null>(null)

  async function load(): Promise<void> {
    info.value = await unwrap(bridge.app.getInfo())
  }

  async function openLogsFolder(): Promise<void> {
    await unwrap(bridge.app.openLogsFolder())
  }

  return { info, load, openLogsFolder }
})
