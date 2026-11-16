<script setup lang="ts">
import { computed } from 'vue'
import type { DownloadJob } from '@shared/types/downloads'
import type { PlaylistEntry } from '@shared/types/playlists'
import { formatDuration } from '@/utils/format'
import EntryThumbnail from './EntryThumbnail.vue'

const props = defineProps<{
  playlistId: string
  entry: PlaylistEntry
  /** The entry's live download job, when it is still in the Downloads list. */
  job: DownloadJob | null
  selected: boolean
}>()
const emit = defineEmits<{ toggle: [event: MouseEvent] }>()

const status = computed(() => {
  if (!props.entry.available) return { label: props.entry.unavailableReason ?? 'Unavailable', classes: 'text-fg-subtle' }
  const value = props.job?.status ?? props.entry.status
  switch (value) {
    case 'queued':
      return { label: 'Queued', classes: 'text-fg-muted' }
    case 'downloading':
      return { label: `${Math.floor(props.job?.progress ?? 0)}%`, classes: 'text-accent font-mono' }
    case 'processing':
      return { label: 'Processing', classes: 'text-accent' }
    case 'paused':
      return { label: 'Paused', classes: 'text-warning' }
    case 'completed':
      return { label: 'Downloaded', classes: 'text-success' }
    case 'failed':
      return { label: 'Failed', classes: 'text-danger' }
    case 'cancelled':
      return { label: 'Cancelled', classes: 'text-fg-subtle' }
    default:
      return { label: '', classes: '' }
  }
})
</script>

<template>
  <li
    class="entry-row flex items-center gap-3 px-4 py-2"
    :class="entry.available ? 'hover:bg-surface-2/60' : 'opacity-55'"
    :data-testid="`entry-${entry.position}`"
    :data-status="job?.status ?? entry.status"
  >
    <input
      type="checkbox"
      class="size-4 shrink-0 accent-[var(--accent)]"
      :checked="selected"
      :disabled="!entry.available"
      :aria-label="`Select ${entry.title}`"
      @click="emit('toggle', $event)"
    />
    <span class="w-8 shrink-0 text-right font-mono text-[11.5px] text-fg-subtle">{{ entry.position }}</span>
    <EntryThumbnail :playlist-id="playlistId" :position="entry.position" />
    <div class="min-w-0 flex-1">
      <p class="selectable truncate text-[13px] font-medium" :title="entry.title">{{ entry.title }}</p>
      <p class="truncate text-[12px] text-fg-subtle">
        <span v-if="entry.uploader">{{ entry.uploader }}</span>
        <span v-if="entry.uploader && entry.durationSeconds"> · </span>
        <span v-if="entry.durationSeconds">{{ formatDuration(entry.durationSeconds) }}</span>
      </p>
      <p v-if="job?.status === 'failed' && job.error" class="selectable truncate text-[12px] text-danger" :title="job.error">{{ job.error }}</p>
    </div>
    <span class="w-24 shrink-0 text-right text-[12px]" :class="status.classes" data-testid="entry-status">{{ status.label }}</span>
  </li>
</template>

<style scoped>
/* Long playlists: the browser skips layout and paint for rows that are off screen. */
.entry-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 70px;
}
</style>
