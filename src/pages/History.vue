<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { History, Search, X } from '@lucide/vue'
import type { HistoryEntry } from '@shared/types/downloads'
import { errorMessage } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SelectField, { type SelectOption } from '@/components/common/SelectField.vue'
import HistoryRow from '@/components/history/HistoryRow.vue'
import { useAppStore } from '@/stores/app.store'
import { useDownloadsStore } from '@/stores/downloads.store'
import { useHistoryStore, type DateRange, type HistoryFilters } from '@/stores/history.store'
import { useToastStore } from '@/stores/toast.store'

const store = useHistoryStore()
const downloads = useDownloadsStore()
const appStore = useAppStore()
const toasts = useToastStore()

const trashName = computed(() => (appStore.info?.platform === 'win32' ? 'Recycle Bin' : 'Trash'))

const formatOptions = computed<readonly SelectOption<string>[]>(() => [
  { value: 'any', label: 'All formats' },
  ...store.formats.map((f) => ({ value: f, label: f.toUpperCase() }))
])
const STATUS_OPTIONS: readonly SelectOption<HistoryFilters['status']>[] = [
  { value: 'any', label: 'Any result' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'cancelled', label: 'Cancelled' }
]
const RANGE_OPTIONS: readonly SelectOption<DateRange>[] = [
  { value: 'any', label: 'Any time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
  { value: 'custom', label: 'Custom dates…' }
]

async function load(keepLength = false): Promise<void> {
  try {
    await store.load(keepLength)
  } catch (error) {
    toasts.error('History could not be loaded', errorMessage(error))
  }
}

// Search waits for a pause in typing; the other filters apply at once.
let searchTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => store.filters.search,
  () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void load(), 300)
  }
)
watch(
  () => [store.filters.format, store.filters.status, store.filters.range, store.filters.customFrom, store.filters.customTo],
  () => void load()
)

// Downloads finishing (or being removed) elsewhere refresh the list.
let refreshTimer: ReturnType<typeof setTimeout> | undefined
const signature = computed(() => downloads.jobs.map((j) => `${j.id}:${j.status}`).join(','))
watch(signature, () => {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => void load(true), 500)
})

onMounted(() => void load())
onBeforeUnmount(() => {
  clearTimeout(searchTimer)
  clearTimeout(refreshTimer)
})

const customInvalid = computed(() => {
  const f = store.filters
  return f.range === 'custom' && f.customFrom !== '' && f.customTo !== '' && f.customFrom > f.customTo
})

// ─── Deleting ────────────────────────────────────────────────────────────────
const pending = ref<HistoryEntry | null>(null)
const confirmOpen = ref(false)
const alsoDeleteFile = ref(false)

function askDelete(entry: HistoryEntry): void {
  pending.value = entry
  alsoDeleteFile.value = false
  confirmOpen.value = true
}

async function confirmDelete(): Promise<void> {
  const entry = pending.value
  if (!entry) return
  try {
    const fileDeleted = await store.remove(entry.id, alsoDeleteFile.value)
    toasts.success('Removed from history', fileDeleted ? `The file was moved to the ${trashName.value}.` : 'The downloaded file was not touched.')
  } catch (error) {
    toasts.error('Could not delete the entry', errorMessage(error))
  } finally {
    pending.value = null
  }
}

const countText = computed(() => {
  if (!store.loaded) return ''
  const n = store.total
  return `${n} download${n === 1 ? '' : 's'}${store.filtered ? ' match' + (n === 1 ? 'es' : '') : ''}`
})
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-end gap-3" data-testid="history-filters">
      <label class="relative min-w-56 flex-1">
        <span class="sr-only">Search history</span>
        <Search :size="15" class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
        <input
          v-model="store.filters.search"
          type="search"
          maxlength="200"
          placeholder="Search titles and links"
          class="h-9 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-[13.5px] shadow-card placeholder:text-fg-subtle"
          data-testid="history-search"
        />
      </label>
      <div class="w-36"><SelectField v-model="store.filters.format" :options="formatOptions" label="Format" data-testid="history-format" /></div>
      <div class="w-36"><SelectField v-model="store.filters.status" :options="STATUS_OPTIONS" label="Result" data-testid="history-status" /></div>
      <div class="w-40"><SelectField v-model="store.filters.range" :options="RANGE_OPTIONS" label="Date" data-testid="history-range" /></div>
    </div>

    <div v-if="store.filters.range === 'custom'" class="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-muted" data-testid="history-custom-range">
      <label class="flex items-center gap-2">
        From
        <input v-model="store.filters.customFrom" type="date" class="h-8 rounded-lg border border-border bg-surface px-2 text-fg" data-testid="history-from" />
      </label>
      <label class="flex items-center gap-2">
        to
        <input v-model="store.filters.customTo" type="date" class="h-8 rounded-lg border border-border bg-surface px-2 text-fg" data-testid="history-to" />
      </label>
      <span v-if="customInvalid" class="text-danger">The start date is after the end date.</span>
    </div>

    <div class="flex items-center justify-between gap-4">
      <p class="text-[13px] text-fg-muted" data-testid="history-count">{{ countText }}</p>
      <AppButton v-if="store.filtered" variant="ghost" :icon="X" data-testid="history-clear" @click="store.resetFilters()">Clear filters</AppButton>
    </div>

    <ul v-if="store.items.length > 0" class="divide-y divide-border rounded-xl border border-border bg-surface shadow-card" data-testid="history-list">
      <HistoryRow v-for="entry in store.items" :key="entry.id" :entry="entry" @delete="askDelete" @retried="load(true)" />
    </ul>
    <EmptyState
      v-else-if="store.loaded"
      :icon="History"
      :title="store.filtered ? 'No matches' : 'No download history yet'"
      :description="
        store.filtered
          ? 'No finished downloads match these filters.'
          : 'Completed, failed and cancelled downloads are listed here, including ones removed from the Downloads page.'
      "
    />

    <div v-if="store.items.length < store.total" class="flex justify-center">
      <AppButton :loading="store.loading" data-testid="history-more" @click="store.loadMore()">
        Show more ({{ store.total - store.items.length }} left)
      </AppButton>
    </div>

    <ConfirmDialog v-model:open="confirmOpen" title="Delete from history?" confirm-label="Delete" tone="danger" @confirm="confirmDelete">
      <p>
        <span class="font-medium text-fg">{{ pending?.title }}</span> will be removed from History and from the Downloads list.
      </p>
      <label
        v-if="pending?.status === 'completed' && pending.fileExists"
        class="mt-3 flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-[13px] text-fg"
        data-testid="delete-file-option"
      >
        <input v-model="alsoDeleteFile" type="checkbox" class="mt-0.5 accent-[var(--danger)]" data-testid="delete-file" />
        <span>
          Also move the downloaded file to the {{ trashName }}
          <span class="block text-[12px] text-fg-muted">Otherwise the file stays where it is.</span>
        </span>
      </label>
    </ConfirmDialog>
  </div>
</template>
