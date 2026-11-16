<script setup lang="ts">
import { computed, ref } from 'vue'
import { CircleAlert, FolderOpen, Music, Trash2, X } from '@lucide/vue'
import type { ConversionJob, ConversionStatus } from '@shared/types/converter'
import { errorMessage } from '@/api/client'
import ProgressBar from '@/components/common/ProgressBar.vue'
import { isConversionActive, useConverterStore } from '@/stores/converter.store'
import { useToastStore } from '@/stores/toast.store'
import { formatRealtime } from '@/utils/audio'
import { formatBytes, formatDuration, formatEta } from '@/utils/format'

const props = defineProps<{ job: ConversionJob }>()
const store = useConverterStore()
const toasts = useToastStore()
const busy = ref(false)

const STATUS: Record<ConversionStatus, { label: string; classes: string }> = {
  queued: { label: 'Queued', classes: 'bg-surface-3 text-fg-muted' },
  converting: { label: 'Converting', classes: 'bg-accent-soft text-accent' },
  completed: { label: 'Completed', classes: 'bg-success-soft text-success' },
  failed: { label: 'Failed', classes: 'bg-danger-soft text-danger' },
  cancelled: { label: 'Cancelled', classes: 'bg-surface-3 text-fg-muted' }
}

const active = computed(() => isConversionActive(props.job))
const meta = computed(() => {
  const parts: string[] = []
  if (props.job.qualityLabel) parts.push(props.job.qualityLabel)
  if (props.job.durationSeconds !== null) parts.push(formatDuration(props.job.durationSeconds))
  if (props.job.outputSizeBytes !== null) parts.push(formatBytes(props.job.outputSizeBytes))
  return parts.join(' · ')
})

async function act(action: () => Promise<unknown>, failure: string): Promise<void> {
  busy.value = true
  try {
    await action()
  } catch (error) {
    toasts.error(failure, errorMessage(error))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <li class="flex gap-3 px-5 py-3.5" :data-testid="`conversion-${job.id}`" :data-status="job.status" :data-format="job.format">
    <div class="flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-fg-muted">
      <Music :size="17" aria-hidden="true" />
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex items-start justify-between gap-3">
        <p class="selectable truncate text-[13.5px] font-medium" :title="job.inputName">{{ job.inputName }}</p>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" :class="STATUS[job.status].classes" data-testid="status">
          {{ STATUS[job.status].label }}
        </span>
      </div>
      <p class="mt-0.5 text-[12px] text-fg-muted">
        <span class="font-medium">→ {{ job.format.toUpperCase() }}</span>
        <span v-if="meta"> · {{ meta }}</span>
      </p>

      <div v-if="job.status === 'converting'" class="mt-2.5">
        <ProgressBar :value="job.durationSeconds ? job.progress / 100 : null" :label="`Progress of ${job.inputName}`" />
        <p class="mt-1.5 text-right font-mono text-[12px] text-fg-muted" data-testid="conversion-progress">
          <template v-if="job.durationSeconds">{{ Math.floor(job.progress) }}% · </template>{{ formatRealtime(job.speed) }}
          <template v-if="job.eta !== null"> · {{ formatEta(job.eta) }} left</template>
        </p>
      </div>
      <p v-else-if="job.status === 'queued'" class="mt-2 text-[12px] text-fg-subtle">Waiting for the current conversion to finish</p>
      <p v-else-if="job.status === 'failed' && job.error" class="selectable mt-2 flex items-start gap-1.5 text-[12.5px] text-danger" data-testid="conversion-error">
        <CircleAlert :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />{{ job.error }}
      </p>
      <p v-else-if="job.status === 'completed' && job.outputPath" class="selectable mt-1.5 truncate font-mono text-[11.5px] text-fg-subtle" :title="job.outputPath" data-testid="output-path">
        {{ job.outputPath }}
      </p>
    </div>

    <div class="flex shrink-0 items-start gap-1">
      <button
        v-if="active"
        type="button"
        class="icon-button"
        title="Cancel"
        aria-label="Cancel conversion"
        :disabled="busy"
        data-testid="cancel"
        @click="act(() => store.cancel(job.id), 'Could not cancel')"
      >
        <X :size="16" aria-hidden="true" />
      </button>
      <button
        v-if="job.status === 'completed'"
        type="button"
        class="icon-button"
        title="Show in folder"
        aria-label="Show in folder"
        data-testid="show-in-folder"
        @click="act(() => store.showInFolder(job.id), 'Could not open the folder')"
      >
        <FolderOpen :size="16" aria-hidden="true" />
      </button>
      <button
        v-if="!active"
        type="button"
        class="icon-button"
        title="Remove from list (keeps the file)"
        aria-label="Remove from list"
        :disabled="busy"
        data-testid="remove"
        @click="act(() => store.remove(job.id), 'Could not remove')"
      >
        <Trash2 :size="16" aria-hidden="true" />
      </button>
    </div>
  </li>
</template>

<style scoped>
@reference '../../assets/main.css';

.icon-button {
  @apply flex size-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:opacity-50;
}
</style>
