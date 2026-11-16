<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Download, FolderOpen, Music, Video } from '@lucide/vue'
import { estimateAudioBytes } from '@shared/media/estimate'
import type {
  AudioFormat,
  AudioQuality,
  CodecPreference,
  MediaAnalysis,
  SubtitleFormat,
  VideoCodec,
  VideoContainer
} from '@shared/types/media'
import { errorMessage } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import SegmentedControl, { type SegmentOption } from '@/components/common/SegmentedControl.vue'
import SelectField, { type SelectOption } from '@/components/common/SelectField.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { useAppStore } from '@/stores/app.store'
import { useDownloadsStore } from '@/stores/downloads.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useToastStore } from '@/stores/toast.store'
import { formatBytes } from '@/utils/format'

const props = defineProps<{ analysis: MediaAnalysis }>()

const settingsStore = useSettingsStore()
const appStore = useAppStore()
const downloads = useDownloadsStore()
const toasts = useToastStore()
const router = useRouter()
const defaults = settingsStore.settings

const CODEC_LABELS: Record<VideoCodec, string> = { h264: 'H.264', hevc: 'H.265 / HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8' }
const AUDIO_FORMATS: readonly SegmentOption<AudioFormat>[] = [
  { value: 'mp3', label: 'MP3' },
  { value: 'm4a', label: 'M4A' },
  { value: 'opus', label: 'OPUS' },
  { value: 'flac', label: 'FLAC' },
  { value: 'wav', label: 'WAV' }
]
const AUDIO_QUALITIES: readonly SelectOption<AudioQuality>[] = [
  { value: 'best', label: 'Best available' },
  { value: '320', label: '320 kbps' },
  { value: '256', label: '256 kbps' },
  { value: '192', label: '192 kbps' },
  { value: '128', label: '128 kbps' }
]

const hasVideo = computed(() => props.analysis.video.length > 0)
const mode = ref<'video' | 'audio'>(hasVideo.value ? 'video' : 'audio')
const modeOptions = computed<readonly SegmentOption<'video' | 'audio'>[]>(() => [
  ...(hasVideo.value ? [{ value: 'video' as const, label: 'Video', icon: Video }] : []),
  ...(props.analysis.audio.available ? [{ value: 'audio' as const, label: 'Audio only', icon: Music }] : [])
])

// ─── Video ───────────────────────────────────────────────────────────────────
const containerChoices = computed<readonly SelectOption<VideoContainer>[]>(() =>
  props.analysis.video.map((c) => ({
    value: c.container,
    label: { mp4: 'MP4 — plays almost everywhere', webm: 'WebM — open formats (VP9/AV1 + Opus)', mkv: 'MKV — any codec, best quality' }[c.container]
  }))
)
const container = ref<VideoContainer>(
  props.analysis.video.some((c) => c.container === defaults.defaultVideoFormat)
    ? defaults.defaultVideoFormat
    : (props.analysis.video[0]?.container ?? 'mp4')
)
const resolutions = computed(() => props.analysis.video.find((c) => c.container === container.value)?.resolutions ?? [])

function initialHeight(): number | 'best' {
  const wanted = defaults.defaultVideoQuality === 'best' ? null : Number(defaults.defaultVideoQuality)
  if (wanted === null) return 'best'
  // The default is a ceiling: take the closest resolution at or below it.
  return resolutions.value.find((r) => r.height <= wanted)?.height ?? 'best'
}
const height = ref<number | 'best'>(initialHeight())
watch(container, () => {
  if (height.value !== 'best' && !resolutions.value.some((r) => r.height === height.value)) height.value = 'best'
})

const resolutionChoices = computed<readonly SelectOption<number | 'best'>[]>(() => {
  const best = resolutions.value[0]
  return [
    { value: 'best', label: best ? `Best available (${best.label})` : 'Best available' },
    ...resolutions.value.map((r) => ({
      value: r.height,
      label: `${r.label}${r.hdr ? ' HDR' : ''}${r.codecs.length > 0 ? ` — ${r.codecs.map((c) => CODEC_LABELS[c]).join(', ')}` : ''}${r.estimatedBytes ? ` · ≈ ${formatBytes(r.estimatedBytes)}` : ''}`
    }))
  ]
})
const selectedResolution = computed(() =>
  height.value === 'best' ? resolutions.value[0] : resolutions.value.find((r) => r.height === height.value)
)
const codec = ref<CodecPreference>('auto')
const codecChoices = computed<readonly SelectOption<CodecPreference>[]>(() => [
  { value: 'auto', label: 'Automatic (best for this format)' },
  ...(selectedResolution.value?.codecs ?? []).map((c) => ({ value: c, label: CODEC_LABELS[c] }))
])
watch(selectedResolution, (r) => {
  if (codec.value !== 'auto' && !r?.codecs.includes(codec.value)) codec.value = 'auto'
})

// ─── Audio ───────────────────────────────────────────────────────────────────
const audioFormat = ref<AudioFormat>(defaults.defaultAudioFormat)
const audioQuality = ref<AudioQuality>(defaults.defaultAudioQuality)
const lossless = computed(() => audioFormat.value === 'wav' || audioFormat.value === 'flac')
const audioNote = computed(() => {
  if (lossless.value) {
    return `${audioFormat.value.toUpperCase()} stores the audio without further loss, but cannot restore quality the source does not have. Bitrate does not apply.`
  }
  if (audioFormat.value === 'm4a' && props.analysis.audio.codecs.includes('AAC')) {
    return 'The source already uses AAC, so it is saved without re-encoding.'
  }
  if (audioFormat.value === 'opus' && props.analysis.audio.codecs.includes('Opus')) {
    return 'The source already uses Opus, so it is saved without re-encoding.'
  }
  return 'Converted with FFmpeg. A higher bitrate than the source does not add quality.'
})

// ─── Extras ──────────────────────────────────────────────────────────────────
const embedMetadata = ref(defaults.embedMetadata)
const embedThumbnail = ref(defaults.embedThumbnail)
const outputFormat = computed(() => (mode.value === 'video' ? container.value : audioFormat.value))
const thumbnailSupported = computed(() => !['webm', 'wav'].includes(outputFormat.value))

const subtitleTracks = computed(() => props.analysis.subtitles)
const wantSubtitles = ref(false)
const subtitleLang = ref(subtitleTracks.value[0]?.lang ?? '')
const subtitleFormat = ref<SubtitleFormat>('srt')
const subtitlesOnly = ref(false)
const subtitleChoices = computed<readonly SelectOption<string>[]>(() =>
  subtitleTracks.value.map((t) => ({ value: t.lang, label: `${t.name}${t.automatic ? ' (auto-generated)' : ''}` }))
)
const subtitleFormats: readonly SegmentOption<SubtitleFormat>[] = [
  { value: 'srt', label: 'SRT' },
  { value: 'vtt', label: 'VTT' }
]

// ─── Summary ─────────────────────────────────────────────────────────────────
const estimate = computed(() => {
  if (wantSubtitles.value && subtitlesOnly.value) return null
  if (mode.value === 'video') return selectedResolution.value?.estimatedBytes ?? null
  const copied =
    (audioFormat.value === 'm4a' && props.analysis.audio.codecs.includes('AAC')) ||
    (audioFormat.value === 'opus' && props.analysis.audio.codecs.includes('Opus'))
  return estimateAudioBytes(audioFormat.value, audioQuality.value, props.analysis.durationSeconds, props.analysis.audio.bestBitrateKbps, copied)
})
const destination = computed(() => settingsStore.settings.downloadDirectory ?? appStore.info?.paths.downloads ?? '')

const starting = ref(false)
async function startDownload(): Promise<void> {
  starting.value = true
  try {
    await downloads.start({
      analysisId: props.analysis.analysisId,
      selection:
        mode.value === 'video'
          ? { kind: 'video', container: container.value, height: height.value, codec: codec.value }
          : { kind: 'audio', format: audioFormat.value, quality: audioQuality.value },
      options: {
        embedMetadata: embedMetadata.value,
        embedThumbnail: embedThumbnail.value && thumbnailSupported.value,
        subtitles:
          wantSubtitles.value && subtitleLang.value
            ? { languages: [subtitleLang.value], format: subtitleFormat.value, only: subtitlesOnly.value }
            : null
      }
    })
    toasts.success('Download started', props.analysis.title)
    void router.push({ name: 'downloads' })
  } catch (error) {
    toasts.error('The download could not be started', errorMessage(error))
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <section class="rounded-xl border border-border bg-surface shadow-card" data-testid="download-options">
    <header class="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
      <h3 class="text-sm font-semibold tracking-tight">Download options</h3>
      <SegmentedControl v-if="modeOptions.length > 1" v-model="mode" :options="modeOptions" label="What to download" data-testid="mode" />
    </header>

    <div class="space-y-4 px-5 py-4">
      <template v-if="mode === 'video'">
        <div class="grid grid-cols-2 gap-4">
          <label class="block">
            <span class="mb-1.5 block text-[12.5px] font-medium text-fg-muted">Format</span>
            <SelectField v-model="container" :options="containerChoices" label="Video format" data-testid="container" />
          </label>
          <label class="block">
            <span class="mb-1.5 block text-[12.5px] font-medium text-fg-muted">Resolution</span>
            <SelectField v-model="height" :options="resolutionChoices" label="Resolution" data-testid="resolution" />
          </label>
        </div>
        <details class="group">
          <summary class="cursor-pointer text-[12.5px] font-medium text-fg-muted select-none hover:text-fg">Advanced: video codec</summary>
          <div class="mt-2.5 max-w-sm">
            <SelectField v-model="codec" :options="codecChoices" label="Video codec" data-testid="codec" />
            <p class="mt-1.5 text-[12px] text-fg-subtle">Only codecs this video offers at the chosen resolution are listed.</p>
          </div>
        </details>
      </template>

      <template v-else>
        <div>
          <span class="mb-1.5 block text-[12.5px] font-medium text-fg-muted">Audio format</span>
          <SegmentedControl v-model="audioFormat" :options="AUDIO_FORMATS" label="Audio format" data-testid="audio-format" />
        </div>
        <label class="block max-w-xs">
          <span class="mb-1.5 block text-[12.5px] font-medium text-fg-muted">Quality</span>
          <SelectField v-model="audioQuality" :options="AUDIO_QUALITIES" :disabled="lossless" label="Audio quality" data-testid="audio-quality" />
        </label>
        <p class="text-[12.5px] text-fg-subtle" data-testid="audio-note">{{ audioNote }}</p>
      </template>

      <div class="space-y-3 border-t border-border pt-4">
        <div class="flex items-center justify-between gap-4">
          <span class="text-[13px]">Embed title, artist and date</span>
          <ToggleSwitch v-model="embedMetadata" label="Embed metadata" />
        </div>
        <div class="flex items-center justify-between gap-4">
          <span class="text-[13px]">
            Embed thumbnail as cover art
            <span v-if="!thumbnailSupported" class="text-fg-subtle"> — not supported by {{ outputFormat.toUpperCase() }}</span>
          </span>
          <ToggleSwitch v-model="embedThumbnail" :disabled="!thumbnailSupported" label="Embed thumbnail" />
        </div>
        <template v-if="subtitleTracks.length > 0">
          <div class="flex items-center justify-between gap-4">
            <span class="text-[13px]">Download subtitles</span>
            <ToggleSwitch v-model="wantSubtitles" label="Download subtitles" data-testid="subtitles-toggle" />
          </div>
          <div v-if="wantSubtitles" class="grid grid-cols-[1fr_auto] items-end gap-3 rounded-lg bg-surface-2 p-3">
            <label class="block">
              <span class="mb-1.5 block text-[12px] text-fg-muted">Language</span>
              <SelectField v-model="subtitleLang" :options="subtitleChoices" label="Subtitle language" />
            </label>
            <SegmentedControl v-model="subtitleFormat" :options="subtitleFormats" label="Subtitle format" />
            <label class="col-span-2 flex items-center gap-2 text-[12.5px]">
              <input v-model="subtitlesOnly" type="checkbox" class="accent-[var(--accent)]" />
              Subtitles only — skip the {{ mode === 'video' ? 'video' : 'audio' }}
            </label>
          </div>
        </template>
      </div>
    </div>

    <footer class="flex items-center justify-between gap-4 border-t border-border px-5 py-3.5">
      <div class="min-w-0 text-[12.5px] text-fg-muted">
        <p class="flex items-center gap-1.5 truncate" :title="destination">
          <FolderOpen :size="13" class="shrink-0" aria-hidden="true" />
          <span class="truncate">{{ destination }}</span>
          <RouterLink :to="{ name: 'settings' }" class="shrink-0 text-accent hover:underline">Change</RouterLink>
        </p>
        <p v-if="estimate" class="mt-0.5" data-testid="estimate">Estimated size ≈ {{ formatBytes(estimate) }}</p>
      </div>
      <AppButton variant="primary" :icon="Download" :loading="starting" data-testid="start-download" @click="startDownload">
        Download
      </AppButton>
    </footer>
  </section>
</template>
