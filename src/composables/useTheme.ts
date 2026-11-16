import { computed, ref, watchEffect } from 'vue'
import type { ThemePreference } from '@shared/types/settings'
import { useSettingsStore } from '@/stores/settings.store'

export type ResolvedTheme = 'dark' | 'light'

/*
 * The main process sets nativeTheme.themeSource from the same preference, so
 * when the preference is 'system' this media query reflects the OS setting.
 */
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
const systemPrefersDark = ref(darkQuery.matches)
darkQuery.addEventListener('change', (event) => {
  systemPrefersDark.value = event.matches
})

export function useTheme() {
  const settingsStore = useSettingsStore()

  const preference = computed<ThemePreference>(() => settingsStore.settings.theme)
  const resolved = computed<ResolvedTheme>(() => {
    if (preference.value === 'system') return systemPrefersDark.value ? 'dark' : 'light'
    return preference.value
  })

  function setPreference(theme: ThemePreference): Promise<void> {
    return settingsStore.update({ theme })
  }

  /** Switches to the opposite of what is currently shown. */
  function toggle(): Promise<void> {
    return setPreference(resolved.value === 'dark' ? 'light' : 'dark')
  }

  return { preference, resolved, setPreference, toggle }
}

/** Keeps the `dark` class on <html> in sync with the resolved theme. Call once from App.vue. */
export function useThemeClass(): void {
  const { resolved } = useTheme()
  watchEffect(() => {
    document.documentElement.classList.toggle('dark', resolved.value === 'dark')
  })
}
