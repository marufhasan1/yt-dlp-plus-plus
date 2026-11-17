<script setup lang="ts">
import { computed, ref } from 'vue'
import { AudioLines, FilePlus2, FolderOpen, ListX } from '@lucide/vue'
import type { ConverterDestination } from '@shared/types/converter'
import type { AudioFormat, AudioQuality } from '@shared/types/media'
import { MAX_CONVERSION_INPUTS } from '@shared/validation/converter'
import { errorMessage } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SegmentedControl, { type SegmentOption } from '@/components/common/SegmentedControl.vue'
import SelectField, { type SelectOption } from '@/components/common/SelectField.vue'
import ConversionItem from '@/components/converter/ConversionItem.vue'
import ConverterInputRow from '@/components/converter/ConverterInputRow.vue'
import { useAppStore } from '@/stores/app.store'
import { useConverterStore } from '@/stores/converter.store'
import { useSettingsStore } from '@/stores/settings.store'
import { useToastStore } from '@/stores/toast.store'
import { SAME_CODEC, codecName, isLosslessFormat } from '@/utils/audio'

type DestinationKind = ConverterDestination['kind']

const store = useConverterStore()
const settingsStore = useSettingsStore()
const appStore = useAppStore()
const toasts = useToastStore()

const FORMATS: readonly SegmentOption<AudioFormat>[] = [
  { value: 'mp3', label: 'MP3' },
  { value: 'm4a', label: 'M4A' },
  { value: 'opus', label: 'OPUS' },
  { value: 'flac', label: 'FLAC' },
  { value: 'wav', label: 'WAV' }
]
const DESTINATIONS: readonly SegmentOption<DestinationKind>[] = [
  { value: 'downloads', label: 'Download folder' },
  { value: 'source', label: 'Next to originals' },
  { value: 'custom', label: 'Other folder…' }
]

const format = ref<AudioFormat>(settingsStore.settings.defaultAudioFormat)
const quality = ref<AudioQuality>(settingsStore.settings.defaultAudioQuality)
const starting = ref(false)

const lossless = computed(() => isLosslessFormat(format.value))
const qualities = computed<readonly SelectOption<AudioQuality>[]>(() => [
  { value: 'best', label: format.value === 'mp3' ? 'Best (VBR, ~245 kbps)' : 'Best (256 kbps)' },
  { value: '320', label: '320 kbps' },
  { value: '256', label: '256 kbps' },
  { value: '192', label: '192 kbps' },
  { value: '128', label: '128 kbps' }
])

const notes = computed(() => {
  const sources = store.convertible.map((i) => i.source!)
  const notes: string[] = []
  if (lossless.value) {
    notes.push(`${format.value.toUpperCase()} keeps the audio without further loss. Quality settings do not apply.`)
    if (sources.some((s) => !s.lossless)) notes.push('Lossy sources (MP3, AAC…) become larger files but do not sound better.')
  } else {
    const same = SAME_CODEC[format.value]
    const matching = sources.filter((s) => s.codec === same).length
    if (same && matching > 0 && quality.value === 'best') {
      notes.push(`${matching === sources.length ? 'These files are' : `${matching} of these files are`} already ${codecName(same)}, so their audio is kept as it is, without re-encoding.`)
    } else if (sources.some((s) => !s.lossless)) {
      notes.push('Re-encoding a lossy source loses a little quality. Choose a bitrate at least as high as the original.')
    }
  }
  if (format.value === 'opus' || format.value === 'wav') {
    if (sources.some((s) => s.hasCover)) notes.push(`Cover art is not kept in ${format.value.toUpperCase()} files.`)
  }
  return notes
})

// ─── Destination ─────────────────────────────────────────────────────────────
const destinationKind = ref<DestinationKind>(store.folder ? 'custom' : 'downloads')
const downloadFolder = computed(() => settingsStore.settings.downloadDirectory ?? appStore.info?.paths.downloads ?? '')
const destinationText = computed(() => {
  if (destinationKind.value === 'source') return 'Each file is saved in the same folder as its original.'
  if (destinationKind.value === 'custom') return store.folder?.path ?? 'No folder chosen'
  return downloadFolder.value
})

async function chooseFolder(): Promise<void> {
  try {
    await store.chooseFolder()
  } catch (error) {
    toasts.error('Could not choose a folder', errorMessage(error))
  }
  if (!store.folder) destinationKind.value = 'downloads'
}

async function onDestination(kind: DestinationKind): Promise<void> {
  destinationKind.value = kind
  if (kind === 'custom' && !store.folder) await chooseFolder()
}

// ─── Actions ─────────────────────────────────────────────────────────────────
async function addFiles(): Promise<void> {
  try {
    const { overLimit } = await store.pickFiles()
    // Files already in the list are skipped silently: they are visibly there.
    if (overLimit > 0) {
      toasts.info(`${overLimit} file${overLimit === 1 ? ' was' : 's were'} not added`, `Up to ${MAX_CONVERSION_INPUTS} files can be listed at once. Convert these first, then add the rest.`)
    }
  } catch (error) {
    toasts.error('Could not add files', errorMessage(error))
  }
}

const startLabel = computed(() => {
  const count = store.convertible.length
  if (count === 0) return 'Convert'
  return count === 1 ? 'Convert 1 file' : `Convert ${count} files`
})

async function start(): Promise<void> {
  const destination: ConverterDestination | null =
    destinationKind.value === 'custom'
      ? store.folder
        ? { kind: 'custom', token: store.folder.token }
        : null
      : { kind: destinationKind.value }
  if (!destination) {
    toasts.error('Choose a folder', 'Pick the folder for the converted files first.')
    return
  }
  starting.value = true
  try {
    const jobs = await store.start({ format: format.value, quality: quality.value, destination })
    toasts.success(jobs.length === 1 ? 'Conversion started' : `${jobs.length} conversions queued`, 'Files are converted one at a time.')
  } catch (error) {
    toasts.error('Could not start the conversion', errorMessage(error))
  } finally {
    starting.value = false
  }
}

async function clearFinished(): Promise<void> {
  try {
    await store.clearFinished()
  } catch (error) {
    toasts.error('Could not clear the list', errorMessage(error))
  }
}

const summary = computed(() => {
  const converting = store.jobs.filter((j) => j.status === 'converting').length
  const queued = store.jobs.filter((j) => j.status === 'queued').length
  const completed = store.jobs.filter((j) => j.status === 'completed').length
  return `${converting} converting · ${queued} queued · ${completed} completed`
})
</script>

<template>
  <div class="space-y-5">
    <section class="rounded-xl border border-border bg-surface shadow-card" data-testid="converter-inputs">
      <header class="flex items-center justify-between gap-4 border-b border-border px-5 py-3.5">
        <div>
          <h2 class="text-sm font-semibold tracking-tight">Files to convert</h2>
          <p class="mt-0.5 text-[12.5px] text-fg-muted">Audio files, or video files to extract the audio from.</p>
        </div>
        <div class="flex items-center gap-2">
          <AppButton v-if="store.inputs.length > 0" variant="ghost" :icon="ListX" data-testid="clear-inputs" @click="store.clearInputs()">Clear</AppButton>
          <AppButton :icon="FilePlus2" :loading="store.picking" data-testid="add-files" @click="addFiles">Add files</AppButton>
        </div>
      </header>

      <ul v-if="store.inputs.length > 0" class="max-h-88 divide-y divide-border overflow-y-auto" data-testid="input-list">
        <ConverterInputRow v-for="input in store.inputs" :key="input.token" :input="input" :disabled="starting" @remove="store.removeInput(input.token)" />
      </ul>
      <div v-else class="flex flex-col items-center px-8 py-10 text-center" data-testid="no-inputs">
        <div class="flex size-11 items-center justify-center rounded-xl bg-surface-2 text-fg-muted">
          <AudioLines :size="20" aria-hidden="true" />
        </div>
        <p class="mt-3 text-[13.5px] font-medium">No files selected</p>
        <p class="mt-1 max-w-sm text-[12.5px] text-fg-muted">Choose Add files to pick audio or video files on this computer. Their format and length are checked with FFprobe.</p>
      </div>
    </section>

    <section class="rounded-xl border border-border bg-surface shadow-card" data-testid="converter-options">
      <header class="border-b border-border px-5 py-3.5">
        <h2 class="text-sm font-semibold tracking-tight">Output</h2>
      </header>
      <div class="space-y-4 px-5 py-4">
        <div class="flex flex-wrap items-end gap-x-6 gap-y-4">
          <div>
            <span class="mb-1.5 block text-[12.5px] font-medium text-fg-muted">Format</span>
            <SegmentedControl v-model="format" :options="FORMATS" label="Output format" data-testid="convert-format" />
          </div>
          <label class="block w-56">
            <span class="mb-1.5 block text-[12.5px] font-medium text-fg-muted">Quality</span>
            <SelectField v-model="quality" :options="qualities" :disabled="lossless" label="Output quality" data-testid="convert-quality" />
          </label>
        </div>
        <ul v-if="notes.length > 0" class="space-y-1 text-[12.5px] text-fg-subtle" data-testid="convert-notes">
          <li v-for="note in notes" :key="note">{{ note }}</li>
        </ul>

        <div class="border-t border-border pt-4">
          <span class="mb-1.5 block text-[12.5px] font-medium text-fg-muted">Save to</span>
          <SegmentedControl
            :model-value="destinationKind"
            :options="DESTINATIONS"
            label="Where to save converted files"
            data-testid="convert-destination"
            @update:model-value="onDestination"
          />
          <p class="mt-2 flex items-center gap-1.5 text-[12.5px] text-fg-muted" data-testid="destination-path">
            <FolderOpen :size="13" class="shrink-0" aria-hidden="true" />
            <span class="selectable truncate" :title="destinationText">{{ destinationText }}</span>
            <button v-if="destinationKind === 'custom'" type="button" class="shrink-0 text-accent hover:underline" data-testid="change-folder" @click="chooseFolder">
              Change
            </button>
          </p>
        </div>
      </div>
      <footer class="flex items-center justify-between gap-4 border-t border-border px-5 py-3.5">
        <p class="text-[12.5px] text-fg-muted">
          <template v-if="store.inputs.length > store.convertible.length">
            {{ store.inputs.length - store.convertible.length }} unreadable file{{ store.inputs.length - store.convertible.length === 1 ? '' : 's' }} will be skipped.
          </template>
          <template v-else>Existing files are never overwritten.</template>
        </p>
        <AppButton
          variant="primary"
          :icon="AudioLines"
          :loading="starting"
          :disabled="store.convertible.length === 0"
          data-testid="start-conversion"
          @click="start"
        >
          {{ startLabel }}
        </AppButton>
      </footer>
    </section>

    <section v-if="store.jobs.length > 0" class="space-y-3" data-testid="conversions">
      <div class="flex items-center justify-between gap-4">
        <div>
          <h2 class="text-sm font-semibold tracking-tight">Conversions</h2>
          <p class="mt-0.5 text-[12.5px] text-fg-muted" data-testid="conversion-summary">{{ summary }}</p>
        </div>
        <AppButton v-if="store.finished.length > 0" variant="ghost" :icon="ListX" data-testid="clear-finished" @click="clearFinished">Clear finished</AppButton>
      </div>
      <ul class="divide-y divide-border rounded-xl border border-border bg-surface shadow-card" data-testid="conversion-list">
        <ConversionItem v-for="job in store.jobs" :key="job.id" :job="job" />
      </ul>
    </section>
    <EmptyState
      v-else
      :icon="AudioLines"
      title="No conversions yet"
      description="Converted files appear here with their progress. The list is kept until YT-DLP++ closes; the files stay on disk."
    />
  </div>
</template>
