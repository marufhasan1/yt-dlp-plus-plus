import { defineStore } from 'pinia'
import { ref } from 'vue'
import { DEFAULT_SETTINGS } from '@shared/validation/settings'
import type { Unsubscribe } from '@shared/types/ipc'
import type { AppSettings, SettingsPatch } from '@shared/types/settings'
import { bridge, unwrap } from '@/api/client'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const loaded = ref(false)
  let unsubscribe: Unsubscribe | null = null

  async function load(): Promise<void> {
    // Subscribe first so a change made between the read and the subscription is not lost.
    unsubscribe ??= bridge.settings.onChanged((next) => {
      settings.value = next
    })
    settings.value = await unwrap(bridge.settings.get())
    loaded.value = true
  }

  /** Persists a change. The main process is the source of truth for the stored value. */
  async function update(patch: SettingsPatch): Promise<void> {
    settings.value = await unwrap(bridge.settings.update(patch))
  }

  return { settings, loaded, load, update }
})
