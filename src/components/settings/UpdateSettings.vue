<script setup lang="ts">
import { computed } from 'vue'
import type { AppSettings } from '@shared/types/settings'
import { errorMessage } from '@/api/client'
import SegmentedControl, { type SegmentOption } from '@/components/common/SegmentedControl.vue'
import SelectField, { type SelectOption } from '@/components/common/SelectField.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useSettingsStore } from '@/stores/settings.store'
import { useToastStore } from '@/stores/toast.store'
import SettingsRow from './SettingsRow.vue'
import SettingsSection from './SettingsSection.vue'

type UpdateKey = 'autoCheckUpdates' | 'updateCheckIntervalHours' | 'ytdlpChannel' | 'autoUpdateYtdlp' | 'checkEngineUpdates' | 'appUpdateNotifications'

const settingsStore = useSettingsStore()
const toasts = useToastStore()

function setting<K extends UpdateKey>(key: K) {
  return computed<AppSettings[K]>({
    get: () => settingsStore.settings[key],
    set: (value) => {
      settingsStore.update({ [key]: value }).catch((error: unknown) => toasts.error('Setting not saved', errorMessage(error)))
    }
  })
}

const autoCheck = setting('autoCheckUpdates')
const interval = setting('updateCheckIntervalHours')
const channel = setting('ytdlpChannel')
const autoUpdateYtdlp = setting('autoUpdateYtdlp')
const checkEngines = setting('checkEngineUpdates')
const notifications = setting('appUpdateNotifications')

const INTERVALS: readonly SelectOption<AppSettings['updateCheckIntervalHours']>[] = [
  { value: 6, label: 'Every 6 hours' },
  { value: 12, label: 'Every 12 hours' },
  { value: 24, label: 'Every day' },
  { value: 72, label: 'Every 3 days' },
  { value: 168, label: 'Every week' }
]
const CHANNELS: readonly SegmentOption<AppSettings['ytdlpChannel']>[] = [
  { value: 'stable', label: 'Stable' },
  { value: 'nightly', label: 'Nightly' }
]
</script>

<template>
  <SettingsSection id="updates" title="Updates" description="How MediaFlow looks for new versions of itself and its media engines.">
    <SettingsRow label="Check for updates automatically" description="Looks for new versions in the background. Nothing is downloaded without your choice, except yt-dlp if enabled below.">
      <ToggleSwitch v-model="autoCheck" label="Check for updates automatically" data-testid="setting-auto-check" />
    </SettingsRow>
    <SettingsRow label="Check frequency" description="How often the automatic check runs.">
      <div class="w-40"><SelectField v-model="interval" :options="INTERVALS" :disabled="!autoCheck" label="Check frequency" data-testid="setting-check-interval" /></div>
    </SettingsRow>
    <SettingsRow label="Tell me about new MediaFlow versions" description="Shows a notice when an automatic check finds a new version of the app.">
      <ToggleSwitch v-model="notifications" :disabled="!autoCheck" label="Application update notifications" data-testid="setting-app-notifications" />
    </SettingsRow>
    <SettingsRow label="yt-dlp release channel" description="Nightly builds get fixes for sites days or weeks earlier, but are less tested. Stable is recommended.">
      <SegmentedControl v-model="channel" :options="CHANNELS" label="yt-dlp release channel" data-testid="setting-ytdlp-channel" />
    </SettingsRow>
    <SettingsRow
      label="Update yt-dlp automatically"
      description="Installs new yt-dlp versions found by the automatic check, when no downloads are running. Only MediaFlow's own copy is updated; the previous version is kept for rolling back."
    >
      <ToggleSwitch v-model="autoUpdateYtdlp" :disabled="!autoCheck" label="Update yt-dlp automatically" data-testid="setting-auto-update-ytdlp" />
    </SettingsRow>
    <SettingsRow label="Include FFmpeg and Deno in automatic checks" description="When off, FFmpeg/FFprobe and Deno are checked only when you ask. They are never updated without your choice.">
      <ToggleSwitch v-model="checkEngines" :disabled="!autoCheck" label="Include FFmpeg and Deno in automatic checks" data-testid="setting-check-engines" />
    </SettingsRow>
  </SettingsSection>
</template>
