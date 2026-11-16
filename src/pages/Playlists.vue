<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ImageOff, ListVideo, RefreshCw, Search, Trash2 } from '@lucide/vue'
import type { DownloadJob } from '@shared/types/downloads'
import { mediaUrlSchema } from '@shared/validation/media'
import { BridgeError, bridge, errorMessage, unwrap } from '@/api/client'
import AppButton from '@/components/common/AppButton.vue'
import ConfirmDialog from '@/components/common/ConfirmDialog.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ProgressBar from '@/components/common/ProgressBar.vue'
import SkeletonBlock from '@/components/common/SkeletonBlock.vue'
import PlaylistDownloadPanel, { type PlaylistDownloadChoice } from '@/components/playlists/PlaylistDownloadPanel.vue'
import PlaylistEntryRow from '@/components/playlists/PlaylistEntryRow.vue'
import { useDownloadsStore } from '@/stores/downloads.store'
import { useMediaStore } from '@/stores/media.store'
import { usePlaylistsStore } from '@/stores/playlists.store'
import { useToastStore } from '@/stores/toast.store'

const store = usePlaylistsStore()
const downloads = useDownloadsStore()
const media = useMediaStore()
const toasts = useToastStore()
const route = useRoute()
const router = useRouter()

// ─── Adding a playlist ───────────────────────────────────────────────────────
const link = ref('')
const analyzing = ref(false)
const linkError = ref<string | null>(null)
watch(link, () => (linkError.value = null))

async function addPlaylist(): Promise<void> {
  const parsed = mediaUrlSchema.safeParse(link.value)
  if (!parsed.success) {
    linkError.value = parsed.error.issues[0]?.message ?? 'Enter a valid link'
    return
  }
  analyzing.value = true
  try {
    const result = await unwrap(bridge.media.analyze(parsed.data))
    if (result.kind === 'playlist') {
      store.show(result.playlist)
      link.value = ''
      void router.replace({ query: { id: result.playlist.id } })
    } else {
      // A single video: hand it to the Home page instead.
      media.url = parsed.data
      void router.push({ name: 'home' }).then(() => media.analyze())
      toasts.info('That link is a single video', 'It was opened on the Home page.')
    }
  } catch (error) {
    if (!(error instanceof BridgeError && error.code === 'CANCELLED')) linkError.value = errorMessage(error)
  } finally {
    analyzing.value = false
  }
}

// ─── Library and current playlist ────────────────────────────────────────────
void store.load().catch((error: unknown) => toasts.error('Playlists could not be loaded', errorMessage(error)))

watch(
  () => route.query['id'],
  (id) => {
    if (typeof id === 'string' && id !== store.current?.id) {
      store.open(id).catch((error: unknown) => toasts.error('Playlist could not be opened', errorMessage(error)))
    }
  },
  { immediate: true }
)

function select(id: string): void {
  void router.replace({ query: { id } })
}

const playlist = computed(() => store.current)
const jobsById = computed(() => new Map(downloads.jobs.map((job) => [job.id, job])))
function jobFor(downloadId: string | null): DownloadJob | null {
  return downloadId ? (jobsById.value.get(downloadId) ?? null) : null
}

// ─── Selection ───────────────────────────────────────────────────────────────
const selected = ref(new Set<number>())
const filter = ref('')
let lastClicked: number | null = null
watch(
  () => playlist.value?.id,
  () => {
    selected.value = new Set()
    filter.value = ''
    lastClicked = null
  }
)

const visibleEntries = computed(() => {
  const entries = playlist.value?.entries ?? []
  const query = filter.value.trim().toLowerCase()
  return query ? entries.filter((e) => e.title.toLowerCase().includes(query)) : entries
})
const availableCount = computed(() => playlist.value?.entries.filter((e) => e.available).length ?? 0)

/** Click toggles one entry; Shift+click selects the range from the previous click. */
function toggle(position: number, event: MouseEvent): void {
  const next = new Set(selected.value)
  if (event.shiftKey && lastClicked !== null) {
    const positions = visibleEntries.value.filter((e) => e.available).map((e) => e.position)
    const [from, to] = [Math.min(lastClicked, position), Math.max(lastClicked, position)]
    for (const p of positions) if (p >= from && p <= to) next.add(p)
  } else if (next.has(position)) {
    next.delete(position)
  } else {
    next.add(position)
  }
  lastClicked = position
  selected.value = next
}

function selectAll(): void {
  selected.value = new Set(visibleEntries.value.filter((e) => e.available).map((e) => e.position))
}
function selectNone(): void {
  selected.value = new Set()
}

// ─── Overall progress of this playlist's downloads ───────────────────────────
const progress = computed(() => {
  const jobs = (playlist.value?.entries ?? []).map((e) => jobFor(e.downloadId)).filter((j): j is DownloadJob => j !== null)
  if (jobs.length === 0) return null
  const done = jobs.filter((j) => j.status === 'completed').length
  const failed = jobs.filter((j) => j.status === 'failed').length
  const active = jobs.filter((j) => ['queued', 'downloading', 'processing', 'paused'].includes(j.status)).length
  const value = jobs.reduce((sum, j) => sum + (j.status === 'completed' ? 100 : j.status === 'failed' || j.status === 'cancelled' ? 0 : j.progress), 0)
  return { total: jobs.length, done, failed, active, fraction: value / (jobs.length * 100) }
})

// ─── Actions ─────────────────────────────────────────────────────────────────
const busy = ref(false)
async function download(scope: 'selected' | 'all', choice: PlaylistDownloadChoice): Promise<void> {
  const current = playlist.value
  if (!current) return
  busy.value = true
  try {
    const result = await store.download({
      playlistId: current.id,
      positions: scope === 'all' ? 'all' : [...selected.value].sort((a, b) => a - b),
      ...choice
    })
    toasts.success(
      `${result.queued} download${result.queued === 1 ? '' : 's'} queued`,
      result.skipped === 0
        ? current.title
        : result.alreadyDownloaded > 0
          ? `${result.skipped} skipped, ${result.alreadyDownloaded} of them already downloaded in this format.`
          : `${result.skipped} skipped (unavailable, or already in your downloads).`
    )
    selected.value = new Set()
  } catch (error) {
    toasts.error('The playlist could not be downloaded', errorMessage(error))
  } finally {
    busy.value = false
  }
}

async function refresh(): Promise<void> {
  if (!playlist.value) return
  try {
    await store.refresh(playlist.value.id)
    toasts.success('Playlist updated')
  } catch (error) {
    toasts.error('The playlist could not be refreshed', errorMessage(error))
  }
}

const confirmRemove = ref(false)
async function remove(): Promise<void> {
  if (!playlist.value) return
  try {
    await store.remove(playlist.value.id)
    void router.replace({ query: {} })
  } catch (error) {
    toasts.error('The playlist could not be removed', errorMessage(error))
  }
}
</script>

<template>
  <div class="space-y-5">
    <section class="rounded-xl border border-border bg-surface p-4 shadow-card">
      <form class="flex gap-2" novalidate @submit.prevent="addPlaylist">
        <div class="relative min-w-0 flex-1">
          <ListVideo :size="16" class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <input
            v-model="link"
            type="url"
            spellcheck="false"
            autocomplete="off"
            placeholder="Paste a playlist or channel link"
            aria-label="Playlist link"
            class="h-9.5 w-full rounded-lg border border-border bg-bg pr-3 pl-9 text-[13.5px] placeholder:text-fg-subtle focus:border-accent focus:outline-none"
            :disabled="analyzing"
            data-testid="playlist-url"
          />
        </div>
        <AppButton type="submit" variant="primary" :icon="Search" :loading="analyzing" :disabled="!link.trim()" data-testid="playlist-analyze">
          List videos
        </AppButton>
      </form>
      <p v-if="linkError" class="selectable mt-2 text-[12.5px] text-danger" role="alert" data-testid="playlist-error">{{ linkError }}</p>
      <p v-else-if="analyzing" class="mt-2 text-[12.5px] text-fg-subtle">Listing videos… large playlists can take a little while.</p>
    </section>

    <EmptyState
      v-if="store.summaries.length === 0 && !playlist"
      :icon="ListVideo"
      title="No playlists yet"
      description="Paste a playlist or channel link to list its videos. You can then download the whole playlist or pick individual videos, and follow each one's progress."
    />

    <div v-else class="grid grid-cols-[220px_1fr] items-start gap-5">
      <nav class="space-y-1" aria-label="Saved playlists" data-testid="playlist-library">
        <button
          v-for="item in store.summaries"
          :key="item.id"
          type="button"
          class="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors"
          :class="item.id === playlist?.id ? 'bg-accent-soft' : 'hover:bg-surface-2'"
          :data-testid="`library-${item.id}`"
          @click="select(item.id)"
        >
          <div class="aspect-video w-14 shrink-0 overflow-hidden rounded bg-surface-3">
            <img v-if="item.thumbnail" :src="item.thumbnail" alt="" class="size-full object-cover" draggable="false" />
          </div>
          <span class="min-w-0">
            <span class="line-clamp-2 text-[12.5px] leading-snug font-medium" :class="item.id === playlist?.id ? 'text-accent' : ''">{{ item.title }}</span>
            <span class="text-[11.5px] text-fg-subtle">{{ item.totalItems }} videos</span>
          </span>
        </button>
      </nav>

      <div v-if="playlist" class="min-w-0 space-y-4" data-testid="playlist-details">
        <section class="flex gap-4 rounded-xl border border-border bg-surface p-4 shadow-card">
          <div class="relative aspect-video w-44 shrink-0 overflow-hidden rounded-lg bg-surface-3">
            <img v-if="playlist.thumbnail" :src="playlist.thumbnail" alt="" class="size-full object-cover" draggable="false" />
            <div v-else class="flex size-full items-center justify-center text-fg-subtle"><ImageOff :size="20" aria-hidden="true" /></div>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <h2 class="selectable line-clamp-2 text-[15px] font-semibold" data-testid="playlist-title">{{ playlist.title }}</h2>
              <div class="flex shrink-0 gap-1">
                <AppButton variant="ghost" :icon="RefreshCw" :loading="store.loading" title="List the videos again" @click="refresh">Refresh</AppButton>
                <AppButton variant="ghost" :icon="Trash2" title="Remove from this list (files are kept)" data-testid="playlist-remove" @click="confirmRemove = true" />
              </div>
            </div>
            <p class="mt-1 text-[12.5px] text-fg-muted">
              <span v-if="playlist.uploader">{{ playlist.uploader }} · </span>
              <span data-testid="playlist-count">{{ playlist.totalItems }} videos</span>
              <span v-if="playlist.unavailableItems > 0"> · {{ playlist.unavailableItems }} unavailable</span>
            </p>
            <p v-if="playlist.truncated" class="mt-1 text-[12px] text-warning">
              Only the first {{ playlist.totalItems }} videos are listed.
            </p>
            <div v-if="progress" class="mt-3" data-testid="playlist-progress">
              <ProgressBar :value="progress.fraction" :label="`Progress of ${playlist.title}`" />
              <p class="mt-1.5 text-[12px] text-fg-muted">
                {{ progress.done }} of {{ progress.total }} downloaded<span v-if="progress.active"> · {{ progress.active }} in progress</span><span v-if="progress.failed" class="text-danger"> · {{ progress.failed }} failed</span>
              </p>
            </div>
          </div>
        </section>

        <PlaylistDownloadPanel
          :playlist="playlist"
          :selected-count="selected.size"
          :available-count="availableCount"
          :busy="busy"
          @download="download"
        />

        <section class="rounded-xl border border-border bg-surface shadow-card">
          <div class="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <div class="relative w-56">
              <Search :size="14" class="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
              <input
                v-model="filter"
                type="search"
                placeholder="Filter by title"
                aria-label="Filter videos"
                class="h-8 w-full rounded-md border border-border bg-bg pr-2 pl-8 text-[12.5px] focus:border-accent focus:outline-none"
                data-testid="entry-filter"
              />
            </div>
            <AppButton variant="ghost" class="h-8 text-[12.5px]" data-testid="select-all" @click="selectAll">Select all</AppButton>
            <AppButton variant="ghost" class="h-8 text-[12.5px]" data-testid="select-none" @click="selectNone">Deselect all</AppButton>
            <span class="ml-auto text-[12px] text-fg-subtle" data-testid="selection-count">{{ selected.size }} selected</span>
          </div>
          <ul class="divide-y divide-border" data-testid="entry-list">
            <PlaylistEntryRow
              v-for="entry in visibleEntries"
              :key="entry.position"
              :playlist-id="playlist.id"
              :entry="entry"
              :job="jobFor(entry.downloadId)"
              :selected="selected.has(entry.position)"
              @toggle="toggle(entry.position, $event)"
            />
          </ul>
          <p v-if="visibleEntries.length === 0" class="px-4 py-6 text-center text-[13px] text-fg-subtle">No videos match this filter.</p>
        </section>
      </div>

      <div v-else-if="store.loading" class="space-y-4">
        <SkeletonBlock class="h-32 rounded-xl" />
        <SkeletonBlock class="h-64 rounded-xl" />
      </div>
      <p v-else class="pt-8 text-center text-[13px] text-fg-subtle">Choose a playlist on the left.</p>
    </div>

    <ConfirmDialog v-model:open="confirmRemove" title="Remove this playlist?" confirm-label="Remove" tone="danger" @confirm="remove">
      <p>The playlist is removed from this list. Downloaded files and entries on the Downloads page are kept.</p>
    </ConfirmDialog>
  </div>
</template>
