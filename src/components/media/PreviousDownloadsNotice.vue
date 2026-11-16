<script setup lang="ts">
import { computed } from 'vue'
import { FolderOpen, History } from '@lucide/vue'
import type { DownloadStatus, PreviousDownload } from '@shared/types/downloads'
import { errorMessage } from '@/api/client'
import { useDownloadsStore } from '@/stores/downloads.store'
import { useHistoryStore } from '@/stores/history.store'
import { useToastStore } from '@/stores/toast.store'
import { formatDateTime } from '@/utils/format'

const props = defineProps<{ sourceId: string; previous: PreviousDownload[] }>()
const downloads = useDownloadsStore()
const history = useHistoryStore()
const toasts = useToastStore()

const STATE: Partial<Record<DownloadStatus, string>> = {
  queued: 'in your downloads (queued)',
  downloading: 'downloading now',
  processing: 'downloading now',
  paused: 'paused in your downloads',
  failed: 'failed',
  cancelled: 'cancelled'
}

/** Earlier downloads, updated live from the Downloads list (e.g. one started a moment ago). */
const entries = computed(() => {
  const live = downloads.jobs.filter((j) => j.sourceId === props.sourceId)
  const byId = new Map<string, PreviousDownload>(props.previous.map((p) => [p.id, p]))
  for (const job of live) {
    const known = byId.get(job.id)
    byId.set(job.id, {
      id: job.id,
      outputFormat: job.outputFormat,
      quality: job.quality,
      status: job.status,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      fileExists: job.status === 'completed' ? (known?.fileExists ?? true) : null
    })
  }
  return [...byId.values()]
    .filter((p) => p.status !== 'cancelled' && p.status !== 'failed')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 3)
})

function describe(entry: PreviousDownload): string {
  const what = [entry.outputFormat.toUpperCase(), entry.quality].filter(Boolean).join(' · ')
  if (entry.status === 'completed') {
    const when = formatDateTime(entry.completedAt ?? entry.createdAt)
    return `${what}, downloaded ${when}${entry.fileExists === false ? ' — the file is no longer there' : ''}`
  }
  return `${what}, ${STATE[entry.status] ?? entry.status}`
}

async function reveal(id: string): Promise<void> {
  try {
    await history.showInFolder(id)
  } catch (error) {
    toasts.error('Could not open the folder', errorMessage(error))
  }
}
</script>

<template>
  <section
    v-if="entries.length > 0"
    class="flex items-start gap-3 rounded-xl border border-accent/30 bg-accent-soft px-4 py-3 text-[13px]"
    data-testid="previous-downloads"
  >
    <History :size="16" class="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <p class="font-medium">You have downloaded this video before</p>
      <ul class="mt-1 space-y-1">
        <li v-for="entry in entries" :key="entry.id" class="flex items-center gap-2 text-fg-muted" :data-status="entry.status">
          <span class="min-w-0 truncate">{{ describe(entry) }}</span>
          <button
            v-if="entry.status === 'completed' && entry.fileExists"
            type="button"
            class="inline-flex shrink-0 items-center gap-1 text-accent hover:underline"
            data-testid="previous-show"
            @click="reveal(entry.id)"
          >
            <FolderOpen :size="13" aria-hidden="true" /> Show
          </button>
        </li>
      </ul>
      <p class="mt-1 text-[12px] text-fg-subtle">You can still download it again, for example in another format.</p>
    </div>
  </section>
</template>
