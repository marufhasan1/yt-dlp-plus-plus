<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download, Music, Video } from '@lucide/vue'
import type { AudioFormat, AudioQuality, CodecPreference, DownloadSelection, VideoContainer } from '@shared/types/media'
import type { PlaylistDetails } from '@shared/types/playlists'
import AppButton from '@/components/common/AppButton.vue'
import SegmentedControl, { type SegmentOption } from '@/components/common/SegmentedControl.vue'
import SelectField, { type SelectOption } from '@/components/common/SelectField.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useAppStore } from '@/stores/app.store'
import { useSettingsStore } from '@/stores/settings.store'

const props = defineProps<{
  playlist: PlaylistDetails
  selectedCount: number
  availableCount: number
  busy: boolean
}>()

export interface PlaylistDownloadChoice {
  selection: DownloadSelection
  options: { embedMetadata: boolean; embedThumbnail: boolean }
  numberFiles: boolean
  skipDownloaded: boolean
}
const emit = defineEmits<{ download: [scope: 'selected' | 'all', choice: PlaylistDownloadChoice] }>()

const settingsStore = useSettingsStore()
const appStore = useAppStore()
const defaults = settingsStore.settings

const mode = ref<'video' | 'audio'>('video')
const modeOptions: readonly SegmentOption<'video' | 'audio'>[] = [
  { value: 'video', label: 'Video', icon: Video },
  { value: 'audio', label: 'Audio only', icon: Music }
]
const container = ref<VideoContainer>(defaults.defaultVideoFormat)
const height = ref<number | 'best'>(defaults.defaultVideoQuality === 'best' ? 'best' : Number(defaults.defaultVideoQuality))
const codec = ref<CodecPreference>('auto')
const audioFormat = ref<AudioFormat>(defaults.defaultAudioFormat)
const audioQuality = ref<AudioQuality>(defaults.defaultAudioQuality)
const embedMetadata = ref(defaults.embedMetadata)
const embedThumbnail = ref(defaults.embedThumbnail)
const numberFiles = ref(true)
const skipDownloaded = ref(true)

const CONTAINERS: readonly SelectOption<VideoContainer>[] = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
  { value: 'mkv', label: 'MKV' }
]
const HEIGHTS: readonly SelectOption<number | 'best'>[] = [
  { value: 'best', label: 'Best available' },
  ...[2160, 1440, 1080, 720, 480, 360].map((h) => ({ value: h, label: `Up to ${h}p${h === 2160 ? ' (4K)' : ''}` }))
]
const CODECS: readonly SelectOption<CodecPreference>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'h264', label: 'Prefer H.264' },
  { value: 'hevc', label: 'Prefer H.265' },
  { value: 'vp9', label: 'Prefer VP9' },
  { value: 'av1', label: 'Prefer AV1' }
]
const AUDIO_FORMATS: readonly SegmentOption<AudioFormat>[] = (['mp3', 'm4a', 'opus', 'flac', 'wav'] as const).map((f) => ({
  value: f,
  label: f.toUpperCase()
}))
const AUDIO_QUALITIES: readonly SelectOption<AudioQuality>[] = [
  { value: 'best', label: 'Best available' },
  ...(['320', '256', '192', '128'] as const).map((q) => ({ value: q, label: `${q} kbps` }))
]
const lossless = computed(() => audioFormat.value === 'wav' || audioFormat.value === 'flac')
const outputFormat = computed(() => (mode.value === 'video' ? container.value : audioFormat.value))
const thumbnailSupported = computed(() => !['webm', 'wav'].includes(outputFormat.value))

const destination = computed(() => {
  const base = settingsStore.settings.downloadDirectory ?? appStore.info?.paths.downloads ?? ''
  return settingsStore.settings.playlistSubfolders ? `${base}${base.includes('\\') ? '\\' : '/'}${props.playlist.title}` : base
})

function choice(): PlaylistDownloadChoice {
  return {
    selection:
      mode.value === 'video'
        ? { kind: 'video', container: container.value, height: height.value, codec: codec.value }
        : { kind: 'audio', format: audioFormat.value, quality: audioQuality.value },
    options: { embedMetadata: embedMetadata.value, embedThumbnail: embedThumbnail.value && thumbnailSupported.value },
    numberFiles: numberFiles.value,
    skipDownloaded: skipDownloaded.value
  }
}
</script>

<template>
  <section class="rounded-xl border border-border bg-surface shadow-card" data-testid="playlist-download-panel">
    <header class="flex items-center justify-between gap-4 border-b border-border px-5 py-3">
      <h3 class="text-sm font-semibold tracking-tight">Download options</h3>
      <SegmentedControl v-model="mode" :options="modeOptions" label="What to download" data-testid="playlist-mode" />
    </header>
    <div class="space-y-3.5 px-5 py-4">
      <div v-if="mode === 'video'" class="grid grid-cols-3 gap-3">
        <label class="block">
          <span class="mb-1.5 block text-[12px] font-medium text-fg-muted">Format</span>
          <SelectField v-model="container" :options="CONTAINERS" label="Video format" data-testid="playlist-container" />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-[12px] font-medium text-fg-muted">Quality</span>
          <SelectField v-model="height" :options="HEIGHTS" label="Maximum resolution" data-testid="playlist-height" />
        </label>
        <label class="block">
          <span class="mb-1.5 block text-[12px] font-medium text-fg-muted">Codec</span>
          <SelectField v-model="codec" :options="CODECS" label="Codec preference" />
        </label>
      </div>
      <div v-else class="flex flex-wrap items-end gap-4">
        <div>
          <span class="mb-1.5 block text-[12px] font-medium text-fg-muted">Audio format</span>
          <SegmentedControl v-model="audioFormat" :options="AUDIO_FORMATS" label="Audio format" data-testid="playlist-audio-format" />
        </div>
        <label class="block w-44">
          <span class="mb-1.5 block text-[12px] font-medium text-fg-muted">Quality</span>
          <SelectField v-model="audioQuality" :options="AUDIO_QUALITIES" :disabled="lossless" label="Audio quality" />
        </label>
      </div>
      <p class="text-[12px] text-fg-subtle">
        {{
          mode === 'video'
            ? 'Each video gets the closest match: if a video does not offer the chosen resolution or codec, its best lower option is used.'
            : lossless
              ? 'Lossless formats keep the source quality but cannot improve on it; bitrate does not apply.'
              : 'Sources already in this codec are kept as-is; others are converted with FFmpeg.'
        }}
      </p>
      <div class="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-3.5 text-[12.5px]">
        <label class="flex items-center justify-between gap-2">
          Number files in playlist order
          <ToggleSwitch v-model="numberFiles" label="Number files" data-testid="number-files" />
        </label>
        <label class="flex items-center justify-between gap-2" title="Videos whose file in this format is still on disk are left out">
          Skip videos already downloaded
          <ToggleSwitch v-model="skipDownloaded" label="Skip videos already downloaded" data-testid="skip-downloaded" />
        </label>
        <label class="flex items-center justify-between gap-2">
          Embed metadata
          <ToggleSwitch v-model="embedMetadata" label="Embed metadata" />
        </label>
        <label class="flex items-center justify-between gap-2" :class="thumbnailSupported ? '' : 'opacity-60'">
          Embed thumbnail
          <ToggleSwitch v-model="embedThumbnail" :disabled="!thumbnailSupported" label="Embed thumbnail" />
        </label>
      </div>
    </div>
    <footer class="flex items-center justify-between gap-4 border-t border-border px-5 py-3">
      <p class="min-w-0 truncate text-[12px] text-fg-muted" :title="destination">
        Saves to <span class="font-mono">{{ destination }}</span>
      </p>
      <div class="flex shrink-0 gap-2">
        <AppButton
          :icon="Download"
          :disabled="busy || availableCount === 0"
          data-testid="download-all"
          @click="emit('download', 'all', choice())"
        >
          Download all ({{ availableCount }})
        </AppButton>
        <AppButton
          variant="primary"
          :icon="Download"
          :disabled="busy || selectedCount === 0"
          :loading="busy"
          data-testid="download-selected"
          @click="emit('download', 'selected', choice())"
        >
          Download selected ({{ selectedCount }})
        </AppButton>
      </div>
    </footer>
  </section>
</template>
