<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { FolderOpen, Monitor, Moon, Sun } from '@lucide/vue'
import type { ThemePreference } from '@shared/types/settings'
import { errorMessage } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import SegmentedControl, { type SegmentOption } from '@/components/common/SegmentedControl.vue'
import SkeletonBlock from '@/components/common/SkeletonBlock.vue'
import AdvancedSettings from '@/components/settings/AdvancedSettings.vue'
import DownloadSettings from '@/components/settings/DownloadSettings.vue'
import UpdateSettings from '@/components/settings/UpdateSettings.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import SettingsSection from '@/components/settings/SettingsSection.vue'
import { useTheme } from '@/composables/useTheme'
import { useAppStore } from '@/stores/app.store'
import { useToastStore } from '@/stores/toast.store'

const appStore = useAppStore()
const toasts = useToastStore()
const route = useRoute()

// Links such as "Update settings" on the Software Updates page open a specific section.
onMounted(() => {
  const id = route.hash.replace(/^#/, '')
  if (/^[a-z-]+$/.test(id)) void nextTick(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }))
})
const { preference, setPreference } = useTheme()

const themeOptions: readonly SegmentOption<ThemePreference>[] = [
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Monitor }
]

const savingTheme = ref(false)
const theme = computed<ThemePreference>({
  get: () => preference.value,
  set: (value) => {
    savingTheme.value = true
    setPreference(value)
      .catch((error: unknown) => toasts.error('Theme could not be saved', errorMessage(error)))
      .finally(() => {
        savingTheme.value = false
      })
  }
})

const openingLogs = ref(false)
async function openLogs(): Promise<void> {
  openingLogs.value = true
  try {
    await appStore.openLogsFolder()
  } catch (error) {
    toasts.error('Logs folder unavailable', errorMessage(error))
  } finally {
    openingLogs.value = false
  }
}

const PLATFORM_NAMES: Record<string, string> = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' }

const aboutRows = computed(() => {
  const info = appStore.info
  if (!info) return []
  return [
    { label: 'Version', value: `${info.version}${info.isPackaged ? '' : ' (development)'}` },
    { label: 'Platform', value: `${PLATFORM_NAMES[info.platform] ?? info.platform} · ${info.arch}` },
    { label: 'Electron', value: info.versions.electron },
    { label: 'Chromium', value: info.versions.chrome },
    { label: 'Node.js', value: info.versions.node },
    { label: 'Data folder', value: info.paths.userData },
    { label: 'Logs folder', value: info.paths.logs }
  ]
})
</script>

<template>
  <div class="space-y-6">
    <SettingsSection title="Appearance" description="Choose how the application looks on this device.">
      <SettingsRow label="Theme" description="System follows your operating system's light or dark mode.">
        <SegmentedControl
          v-model="theme"
          :options="themeOptions"
          :disabled="savingTheme"
          label="Theme"
          data-testid="theme-setting"
        />
      </SettingsRow>
    </SettingsSection>

    <DownloadSettings />

    <UpdateSettings />

    <AdvancedSettings />

    <SettingsSection title="Diagnostics" description="Log files help troubleshoot problems. They stay on this device.">
      <SettingsRow label="Application logs" description="Open the folder containing the application's log files.">
        <AppButton :icon="FolderOpen" :loading="openingLogs" data-testid="open-logs" @click="openLogs">
          Open logs folder
        </AppButton>
      </SettingsRow>
    </SettingsSection>

    <SettingsSection title="About">
      <dl v-if="aboutRows.length > 0" class="divide-y divide-border" data-testid="about">
        <div v-for="row in aboutRows" :key="row.label" class="grid grid-cols-[160px_1fr] gap-4 px-5 py-3">
          <dt class="text-[13px] text-fg-muted">{{ row.label }}</dt>
          <dd class="selectable truncate font-mono text-[12.5px]" :title="row.value">{{ row.value }}</dd>
        </div>
      </dl>
      <div v-else class="space-y-3 px-5 py-4">
        <SkeletonBlock v-for="n in 5" :key="n" class="h-4" :style="{ width: `${40 + n * 9}%` }" />
      </div>
    </SettingsSection>
  </div>
</template>
