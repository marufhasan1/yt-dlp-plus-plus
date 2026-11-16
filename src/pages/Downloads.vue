<script setup lang="ts">
import { computed, ref } from 'vue'
import { Download, History, Pause, Play, RotateCcw } from '@lucide/vue'
import type { DownloadStatus } from '@shared/types/downloads'
import { errorMessage } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import DownloadItem from '@/components/downloads/DownloadItem.vue'
import { useDownloadsStore } from '@/stores/downloads.store'
import { useToastStore } from '@/stores/toast.store'
import { formatSpeed } from '@/utils/format'

type Filter = 'all' | 'downloading' | 'queued' | 'paused' | 'completed' | 'failed' | 'cancelled'

const store = useDownloadsStore()
const toasts = useToastStore()
const filter = ref<Filter>('all')
const bulkBusy = ref(false)
/** "Not now" on the recovery notice, for this session. */
const recoveryDismissed = ref(false)
const showRecovery = computed(() => store.interrupted.length > 0 && !recoveryDismissed.value)

const MATCHES: Record<Filter, (status: DownloadStatus) => boolean> = {
  all: () => true,
  downloading: (s) => s === 'downloading' || s === 'processing',
  queued: (s) => s === 'queued',
  paused: (s) => s === 'paused',
  completed: (s) => s === 'completed',
  failed: (s) => s === 'failed',
  cancelled: (s) => s === 'cancelled'
}

const filters = computed(() => {
  const c = store.counts
  return [
    { id: 'all' as const, label: 'All', count: store.jobs.length },
    { id: 'downloading' as const, label: 'Downloading', count: c.downloading + c.processing },
    { id: 'queued' as const, label: 'Queued', count: c.queued },
    { id: 'paused' as const, label: 'Paused', count: c.paused },
    { id: 'completed' as const, label: 'Completed', count: c.completed },
    { id: 'failed' as const, label: 'Failed', count: c.failed },
    { id: 'cancelled' as const, label: 'Cancelled', count: c.cancelled }
  ]
})
const visible = computed(() => store.jobs.filter((job) => MATCHES[filter.value](job.status)))
const summary = computed(() => {
  const c = store.counts
  const parts = [`${c.downloading + c.processing} active`, `${c.queued} queued`]
  if (c.paused > 0) parts.push(`${c.paused} paused`)
  parts.push(`${c.completed} completed`)
  if (c.failed > 0) parts.push(`${c.failed} failed`)
  return parts.join(' · ')
})

async function bulk(action: () => Promise<number>, done: (count: number) => string, failure: string): Promise<void> {
  bulkBusy.value = true
  try {
    const count = await action()
    if (count > 0) toasts.info(done(count))
  } catch (error) {
    toasts.error(failure, errorMessage(error))
  } finally {
    bulkBusy.value = false
  }
}
const plural = (n: number) => `${n} download${n === 1 ? '' : 's'}`
const pauseAll = () => bulk(() => store.pauseAll(), (n) => `${plural(n)} paused`, 'Could not pause downloads')
const resumeAll = () => bulk(() => store.resumeAll(), (n) => `${plural(n)} resumed`, 'Could not resume downloads')
</script>

<template>
  <div class="space-y-4">
    <section
      v-if="showRecovery"
      class="flex items-center gap-4 rounded-xl border border-warning/40 bg-warning-soft px-5 py-3.5"
      role="status"
      data-testid="recovery-banner"
    >
      <RotateCcw :size="18" class="shrink-0 text-warning" aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <p class="text-[13.5px] font-medium">
          {{ plural(store.interrupted.length) }} {{ store.interrupted.length === 1 ? 'was' : 'were' }} interrupted when MediaFlow closed
        </p>
        <p class="text-[12.5px] text-fg-muted">The partial downloads were kept. Resume them to continue where they stopped.</p>
      </div>
      <AppButton variant="ghost" data-testid="recovery-later" @click="recoveryDismissed = true">Not now</AppButton>
      <AppButton variant="primary" :icon="Play" :loading="bulkBusy" data-testid="recovery-resume" @click="resumeAll">Resume all</AppButton>
    </section>

    <div class="flex items-center justify-between gap-4" data-testid="downloads-summary">
      <p class="text-[13px] text-fg-muted">
        {{ summary }}<span v-if="store.totalSpeed > 0" class="ml-2 font-mono">· {{ formatSpeed(store.totalSpeed) }}</span>
      </p>
      <div class="flex items-center gap-2">
        <AppButton v-if="store.paused.length > 0 && !showRecovery" :icon="Play" :disabled="bulkBusy" data-testid="resume-all" @click="resumeAll">Resume all</AppButton>
        <AppButton v-if="store.pausable.length > 0" :icon="Pause" :disabled="bulkBusy" data-testid="pause-all" @click="pauseAll">Pause all</AppButton>
        <AppButton variant="ghost" :icon="History" data-testid="open-history" @click="$router.push({ name: 'history' })">History</AppButton>
      </div>
    </div>

    <div class="flex flex-wrap gap-1.5" role="tablist" aria-label="Filter downloads">
      <button
        v-for="item in filters"
        :key="item.id"
        type="button"
        role="tab"
        :aria-selected="filter === item.id"
        class="rounded-full border px-3 py-1 text-[12.5px] font-medium transition-colors"
        :class="filter === item.id ? 'border-accent bg-accent-soft text-accent' : 'border-border text-fg-muted hover:bg-surface-2 hover:text-fg'"
        :data-testid="`filter-${item.id}`"
        @click="filter = item.id"
      >
        {{ item.label }} <span class="ml-0.5 opacity-70">{{ item.count }}</span>
      </button>
    </div>

    <ul v-if="visible.length > 0" class="divide-y divide-border rounded-xl border border-border bg-surface shadow-card" data-testid="download-list">
      <DownloadItem v-for="job in visible" :key="job.id" :job="job" />
    </ul>
    <EmptyState
      v-else
      :icon="Download"
      :title="filter === 'all' ? 'No downloads yet' : 'Nothing here'"
      :description="filter === 'all' ? 'Analyse a link on the Home page and choose Download. Your downloads and their progress appear here.' : 'No downloads match this filter.'"
    />
  </div>
</template>
