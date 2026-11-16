<script setup lang="ts">
import { computed, ref } from 'vue'
import { CircleAlert, FolderOpen, ImageOff, Pause, Play, RotateCcw, Trash2, X } from '@lucide/vue'
import type { DownloadJob, DownloadStatus } from '@shared/types/downloads'
import { errorMessage } from '@/api/client'
import ProgressBar from '@/components/common/ProgressBar.vue'
import { isActive, useDownloadsStore } from '@/stores/downloads.store'
import { useToastStore } from '@/stores/toast.store'
import { formatBytes, formatEta, formatSpeed } from '@/utils/format'

const props = defineProps<{ job: DownloadJob }>()
const store = useDownloadsStore()
const toasts = useToastStore()
const busy = ref(false)

const STATUS: Record<DownloadStatus, { label: string; classes: string }> = {
  queued: { label: 'Queued', classes: 'bg-surface-3 text-fg-muted' },
  analyzing: { label: 'Analyzing', classes: 'bg-accent-soft text-accent' },
  downloading: { label: 'Downloading', classes: 'bg-accent-soft text-accent' },
  processing: { label: 'Processing', classes: 'bg-accent-soft text-accent' },
  paused: { label: 'Paused', classes: 'bg-warning-soft text-warning' },
  completed: { label: 'Completed', classes: 'bg-success-soft text-success' },
  failed: { label: 'Failed', classes: 'bg-danger-soft text-danger' },
  cancelled: { label: 'Cancelled', classes: 'bg-surface-3 text-fg-muted' }
}

const active = computed(() => isActive(props.job))
/** Holds a place in the queue or partial files: it can be cancelled but not removed. */
const unfinished = computed(() => active.value || props.job.status === 'paused')
const sizeText = computed(() => {
  const { downloadedBytes, totalBytes, status } = props.job
  if (status === 'completed') return totalBytes ? formatBytes(totalBytes) : ''
  if (totalBytes) return `${formatBytes(downloadedBytes)} of ${formatBytes(totalBytes)}`
  return downloadedBytes > 0 ? formatBytes(downloadedBytes) : ''
})
const progressValue = computed(() => (props.job.status === 'processing' ? null : props.job.progress / 100))

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
  <li class="flex gap-4 px-5 py-4" :data-testid="`download-${job.id}`" :data-status="job.status">
    <div class="relative aspect-video w-32 shrink-0 overflow-hidden rounded-md bg-surface-3">
      <img v-if="job.thumbnail" :src="job.thumbnail" alt="" class="size-full object-cover" draggable="false" />
      <div v-else class="flex size-full items-center justify-center text-fg-subtle"><ImageOff :size="18" aria-hidden="true" /></div>
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex items-start justify-between gap-3">
        <p class="selectable line-clamp-1 text-[13.5px] font-medium" :title="job.title">{{ job.title }}</p>
        <span class="shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium" :class="STATUS[job.status].classes" data-testid="status">
          {{ STATUS[job.status].label }}
        </span>
      </div>
      <p class="mt-0.5 text-[12px] text-fg-muted">
        <span class="font-medium uppercase">{{ job.outputFormat }}</span>
        <span v-if="job.quality"> · {{ job.quality }}</span>
        <span v-if="sizeText"> · {{ sizeText }}</span>
      </p>
      <p v-if="job.playlistTitle" class="mt-0.5 truncate text-[11.5px] text-fg-subtle" data-testid="job-playlist">
        Playlist: {{ job.playlistTitle }}<span v-if="job.playlistPosition"> · #{{ job.playlistPosition }}</span>
      </p>

      <div v-if="job.status === 'downloading' || job.status === 'processing'" class="mt-2.5">
        <ProgressBar :value="progressValue" :label="`Progress of ${job.title}`" />
        <div class="mt-1.5 flex justify-between gap-3 text-[12px] text-fg-muted">
          <span>{{ job.stage }}</span>
          <span v-if="job.status === 'downloading'" class="font-mono">
            {{ Math.floor(job.progress) }}% · {{ formatSpeed(job.speed) }} · {{ formatEta(job.eta) }} left
          </span>
        </div>
      </div>
      <div v-else-if="job.status === 'paused'" class="mt-2.5" data-testid="paused-info">
        <ProgressBar :value="job.progress / 100" :label="`Progress of ${job.title}`" class="opacity-60" />
        <div class="mt-1.5 flex justify-between gap-3 text-[12px] text-fg-muted">
          <span>{{ job.interrupted ? 'Interrupted when MediaFlow closed — resume to continue' : 'Paused — partial download kept' }}</span>
          <span class="font-mono">{{ Math.floor(job.progress) }}%</span>
        </div>
      </div>
      <p v-else-if="job.status === 'queued'" class="mt-2 text-[12px] text-fg-subtle" data-testid="queued-stage">{{ job.stage ?? 'Waiting to start' }}</p>
      <p v-else-if="job.status === 'failed' && job.error" class="selectable mt-2 flex items-start gap-1.5 text-[12.5px] text-danger">
        <CircleAlert :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />{{ job.error }}
      </p>
      <p v-else-if="job.status === 'completed'" class="selectable mt-2 truncate font-mono text-[11.5px] text-fg-subtle" :title="job.outputPath">
        {{ job.outputPath }}
      </p>
    </div>

    <div class="flex shrink-0 items-start gap-1">
      <button
        v-if="job.status === 'queued' || job.status === 'downloading'"
        type="button"
        class="icon-button"
        title="Pause (keeps the partial download)"
        aria-label="Pause download"
        :disabled="busy"
        data-testid="pause"
        @click="act(() => store.pause(job.id), 'Could not pause')"
      >
        <Pause :size="16" aria-hidden="true" />
      </button>
      <button
        v-if="job.status === 'paused'"
        type="button"
        class="icon-button"
        title="Resume"
        aria-label="Resume download"
        :disabled="busy"
        data-testid="resume"
        @click="act(() => store.resume(job.id), 'Could not resume')"
      >
        <Play :size="16" aria-hidden="true" />
      </button>
      <button
        v-if="unfinished"
        type="button"
        class="icon-button"
        title="Cancel (deletes the partial download)"
        aria-label="Cancel download"
        :disabled="busy"
        data-testid="cancel"
        @click="act(() => store.cancel(job.id), 'Could not cancel')"
      >
        <X :size="16" aria-hidden="true" />
      </button>
      <button
        v-if="job.status === 'failed' || job.status === 'cancelled'"
        type="button"
        class="icon-button"
        title="Retry"
        aria-label="Retry download"
        :disabled="busy"
        data-testid="retry"
        @click="act(() => store.retry(job.id), 'Could not retry')"
      >
        <RotateCcw :size="16" aria-hidden="true" />
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
        v-if="!unfinished"
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
