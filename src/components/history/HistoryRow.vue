<script setup lang="ts">
import { computed, ref } from 'vue'
import { CircleAlert, FolderOpen, ImageOff, RotateCcw, Trash2 } from '@lucide/vue'
import type { HistoryEntry } from '@shared/types/downloads'
import { errorMessage } from '@/api/client'
import { useHistoryStore } from '@/stores/history.store'
import { useToastStore } from '@/stores/toast.store'
import { formatBytes, formatDateTime } from '@/utils/format'

const props = defineProps<{ entry: HistoryEntry }>()
const emit = defineEmits<{ delete: [entry: HistoryEntry]; retried: [] }>()
const store = useHistoryStore()
const toasts = useToastStore()
const busy = ref(false)

const STATUS = {
  completed: { label: 'Completed', classes: 'bg-success-soft text-success' },
  failed: { label: 'Failed', classes: 'bg-danger-soft text-danger' },
  cancelled: { label: 'Cancelled', classes: 'bg-surface-3 text-fg-muted' }
} as const
const status = computed(() => (props.entry.status in STATUS ? STATUS[props.entry.status as keyof typeof STATUS] : null))
const size = computed(() => (props.entry.status === 'completed' && props.entry.totalBytes ? formatBytes(props.entry.totalBytes) : null))
const canRetry = computed(() => props.entry.status === 'failed' || props.entry.status === 'cancelled')

async function act(action: () => Promise<unknown>, failure: string): Promise<boolean> {
  busy.value = true
  try {
    await action()
    return true
  } catch (error) {
    toasts.error(failure, errorMessage(error))
    return false
  } finally {
    busy.value = false
  }
}

async function retry(): Promise<void> {
  if (await act(() => store.retry(props.entry.id), 'Could not retry')) {
    toasts.success('Download queued again', props.entry.title)
    emit('retried')
  }
}
</script>

<template>
  <li class="flex gap-4 px-5 py-3.5" :data-testid="`history-${entry.id}`" :data-status="entry.status">
    <div class="relative aspect-video w-24 shrink-0 overflow-hidden rounded-md bg-surface-3">
      <img v-if="entry.thumbnail" :src="entry.thumbnail" alt="" class="size-full object-cover" draggable="false" />
      <div v-else class="flex size-full items-center justify-center text-fg-subtle"><ImageOff :size="16" aria-hidden="true" /></div>
    </div>

    <div class="min-w-0 flex-1">
      <div class="flex items-start justify-between gap-3">
        <p class="selectable line-clamp-1 text-[13.5px] font-medium" :title="entry.title">{{ entry.title }}</p>
        <div class="flex shrink-0 items-center gap-1.5">
          <span
            v-if="entry.fileExists === false"
            class="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-medium text-warning"
            title="The file is no longer where it was saved"
            data-testid="file-missing"
          >
            File missing
          </span>
          <span v-if="status" class="rounded-full px-2 py-0.5 text-[11px] font-medium" :class="status.classes" data-testid="status">{{ status.label }}</span>
        </div>
      </div>
      <p class="mt-0.5 text-[12px] text-fg-muted">
        <span class="font-medium uppercase">{{ entry.outputFormat }}</span>
        <span v-if="entry.quality"> · {{ entry.quality }}</span>
        <span v-if="size"> · {{ size }}</span>
        <span> · {{ formatDateTime(entry.completedAt ?? entry.createdAt) }}</span>
      </p>
      <p v-if="entry.playlistTitle" class="mt-0.5 truncate text-[11.5px] text-fg-subtle">
        Playlist: {{ entry.playlistTitle }}<span v-if="entry.playlistPosition"> · #{{ entry.playlistPosition }}</span>
      </p>
      <p v-if="entry.status === 'failed' && entry.error" class="selectable mt-1 flex items-start gap-1.5 text-[12px] text-danger">
        <CircleAlert :size="13" class="mt-0.5 shrink-0" aria-hidden="true" />{{ entry.error }}
      </p>
      <p v-else-if="entry.status === 'completed'" class="selectable mt-1 truncate font-mono text-[11px] text-fg-subtle" :title="entry.outputPath">
        {{ entry.outputPath }}
      </p>
    </div>

    <div class="flex shrink-0 items-start gap-1">
      <button
        v-if="entry.status === 'completed' && entry.fileExists"
        type="button"
        class="icon-button"
        title="Show in folder"
        aria-label="Show in folder"
        data-testid="show-in-folder"
        @click="act(() => store.showInFolder(entry.id), 'Could not open the folder')"
      >
        <FolderOpen :size="16" aria-hidden="true" />
      </button>
      <button
        v-if="canRetry"
        type="button"
        class="icon-button"
        title="Download again"
        aria-label="Retry download"
        :disabled="busy"
        data-testid="retry"
        @click="retry"
      >
        <RotateCcw :size="16" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="icon-button"
        title="Delete from history"
        aria-label="Delete from history"
        :disabled="busy"
        data-testid="delete"
        @click="emit('delete', entry)"
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
