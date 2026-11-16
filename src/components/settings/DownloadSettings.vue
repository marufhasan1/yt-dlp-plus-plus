<script setup lang="ts">
import { computed } from 'vue'
import { FolderOpen, RotateCcw } from '@lucide/vue'
import type { AppSettings } from '@shared/types/settings'
import { bridge, errorMessage, unwrap } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import SelectField, { type SelectOption } from '@/components/common/SelectField.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useToastStore } from '@/stores/toast.store'
import SettingsRow from './SettingsRow.vue'
import SettingsSection from './SettingsSection.vue'

const settingsStore = useSettingsStore()
const appStore = useAppStore()
const toasts = useToastStore()

/** A two-way binding for one setting that saves on change and reports failures. */
function setting<K extends Exclude<keyof AppSettings, 'downloadDirectory'>>(key: K) {
  return computed<AppSettings[K]>({
    get: () => settingsStore.settings[key],
    set: (value) => {
      settingsStore.update({ [key]: value }).catch((error: unknown) => toasts.error('Setting not saved', errorMessage(error)))
    }
  })
}

const videoFormat = setting('defaultVideoFormat')
const videoQuality = setting('defaultVideoQuality')
const audioFormat = setting('defaultAudioFormat')
const audioQuality = setting('defaultAudioQuality')
const concurrency = setting('maxConcurrentDownloads')
const template = setting('filenameTemplate')
const skipExisting = setting('skipExisting')
const embedMetadata = setting('embedMetadata')
const embedThumbnail = setting('embedThumbnail')
const playlistSubfolders = setting('playlistSubfolders')

const folder = computed(() => settingsStore.settings.downloadDirectory ?? appStore.info?.paths.downloads ?? '')
const isDefaultFolder = computed(() => settingsStore.settings.downloadDirectory === null)

async function changeFolder(reset: boolean): Promise<void> {
  try {
    settingsStore.settings = await unwrap(
      reset ? bridge.settings.resetDownloadDirectory() : bridge.settings.chooseDownloadDirectory()
    )
  } catch (error) {
    toasts.error('Download folder not changed', errorMessage(error))
  }
}

const VIDEO_FORMATS: readonly SelectOption<AppSettings['defaultVideoFormat']>[] = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'mkv', label: 'MKV' }
]
const VIDEO_QUALITIES: readonly SelectOption<AppSettings['defaultVideoQuality']>[] = [
  { value: 'best', label: 'Best available' },
  { value: '2160', label: 'Up to 2160p (4K)' },
  { value: '1440', label: 'Up to 1440p' },
  { value: '1080', label: 'Up to 1080p' },
  { value: '720', label: 'Up to 720p' },
  { value: '480', label: 'Up to 480p' },
  { value: '360', label: 'Up to 360p' }
]
const AUDIO_FORMATS: readonly SelectOption<AppSettings['defaultAudioFormat']>[] = [
  { value: 'mp3', label: 'MP3' },
  { value: 'm4a', label: 'M4A' },
  { value: 'opus', label: 'OPUS' },
  { value: 'flac', label: 'FLAC' },
  { value: 'wav', label: 'WAV' }
]
const AUDIO_QUALITIES: readonly SelectOption<AppSettings['defaultAudioQuality']>[] = [
  { value: 'best', label: 'Best available' },
  { value: '320', label: '320 kbps' },
  { value: '256', label: '256 kbps' },
  { value: '192', label: '192 kbps' },
  { value: '128', label: '128 kbps' }
]
const CONCURRENCY: readonly SelectOption<number>[] = [1, 2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))
const TEMPLATES: readonly SelectOption<AppSettings['filenameTemplate']>[] = [
  { value: 'title-id', label: 'Title [id]' },
  { value: 'title', label: 'Title' },
  { value: 'uploader-title', label: 'Uploader - Title' },
  { value: 'date-title', label: 'Upload date - Title' }
]
</script>

<template>
  <SettingsSection title="Downloads" description="Where files go and what is pre-selected when you analyse a link.">
    <SettingsRow label="Download folder" :description="folder">
      <div class="flex gap-2">
        <AppButton :icon="FolderOpen" data-testid="choose-folder" @click="changeFolder(false)">Change…</AppButton>
        <AppButton v-if="!isDefaultFolder" variant="ghost" :icon="RotateCcw" title="Use the system Downloads folder" @click="changeFolder(true)">
          Reset
        </AppButton>
      </div>
    </SettingsRow>
    <SettingsRow label="Default video format">
      <div class="w-56"><SelectField v-model="videoFormat" :options="VIDEO_FORMATS" label="Default video format" /></div>
    </SettingsRow>
    <SettingsRow label="Default video quality" description="The highest resolution at or below this is pre-selected.">
      <div class="w-56"><SelectField v-model="videoQuality" :options="VIDEO_QUALITIES" label="Default video quality" /></div>
    </SettingsRow>
    <SettingsRow label="Default audio format">
      <div class="w-56"><SelectField v-model="audioFormat" :options="AUDIO_FORMATS" label="Default audio format" /></div>
    </SettingsRow>
    <SettingsRow label="Default audio quality" description="Not used for FLAC and WAV, which are lossless.">
      <div class="w-56"><SelectField v-model="audioQuality" :options="AUDIO_QUALITIES" label="Default audio quality" /></div>
    </SettingsRow>
    <SettingsRow label="Simultaneous downloads" description="Further downloads wait in the queue.">
      <div class="w-24"><SelectField v-model="concurrency" :options="CONCURRENCY" label="Simultaneous downloads" data-testid="concurrency" /></div>
    </SettingsRow>
    <SettingsRow label="File names">
      <div class="w-56"><SelectField v-model="template" :options="TEMPLATES" label="File name pattern" /></div>
    </SettingsRow>
    <SettingsRow label="Create subfolders for playlists" description="Save each playlist into a folder named after it.">
      <ToggleSwitch v-model="playlistSubfolders" label="Create subfolders for playlists" data-testid="playlist-subfolders" />
    </SettingsRow>
    <SettingsRow label="Skip existing files" description="If the file was already downloaded, keep it instead of downloading again.">
      <ToggleSwitch v-model="skipExisting" label="Skip existing files" />
    </SettingsRow>
    <SettingsRow label="Embed metadata" description="Default for new downloads.">
      <ToggleSwitch v-model="embedMetadata" label="Embed metadata" />
    </SettingsRow>
    <SettingsRow label="Embed thumbnail" description="Default for new downloads, where the format supports cover art.">
      <ToggleSwitch v-model="embedThumbnail" label="Embed thumbnail" />
    </SettingsRow>
  </SettingsSection>
</template>
