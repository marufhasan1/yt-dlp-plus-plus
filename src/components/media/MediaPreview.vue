<script setup lang="ts">
import { computed } from 'vue'
import { CalendarDays, Clock, Eye, ImageOff, Info, ListVideo, User } from '@lucide/vue'
import type { MediaAnalysis } from '@shared/types/media'
import { useMediaStore } from '@/stores/media.store'
import { formatCount, formatDate, formatDuration } from '@/utils/format'

const props = defineProps<{ analysis: MediaAnalysis }>()
const media = useMediaStore()

const containers = computed(() => props.analysis.video.map((c) => c.container.toUpperCase()))
const resolutions = computed(() => {
  const all = new Set<number>()
  for (const container of props.analysis.video) for (const r of container.resolutions) all.add(r.height)
  return [...all].sort((a, b) => b - a)
})
const audioLine = computed(() => {
  const audio = props.analysis.audio
  if (!audio.available) return 'No audio'
  const parts = [audio.codecs.join(', ')]
  if (audio.bestBitrateKbps) parts.push(`up to ${audio.bestBitrateKbps} kbps`)
  if (audio.channels && audio.channels > 2) parts.push(`${audio.channels}-channel available`)
  return parts.join(' · ')
})
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface shadow-card" data-testid="media-preview">
    <div class="flex gap-5 p-5">
      <div class="relative aspect-video w-60 shrink-0 overflow-hidden rounded-lg bg-surface-3">
        <img
          v-if="analysis.thumbnail"
          :src="analysis.thumbnail"
          alt=""
          class="size-full object-cover"
          draggable="false"
        />
        <div v-else class="flex size-full items-center justify-center text-fg-subtle">
          <ImageOff :size="22" aria-hidden="true" />
        </div>
        <span
          v-if="analysis.durationSeconds"
          class="absolute right-1.5 bottom-1.5 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] text-white"
        >
          {{ formatDuration(analysis.durationSeconds) }}
        </span>
      </div>

      <div class="min-w-0 flex-1">
        <h2 class="selectable line-clamp-2 text-[15px] leading-snug font-semibold" data-testid="media-title">
          {{ analysis.title }}
        </h2>
        <dl class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-fg-muted">
          <div v-if="analysis.uploader" class="flex items-center gap-1.5">
            <User :size="13" aria-hidden="true" /><dt class="sr-only">Uploader</dt><dd class="selectable">{{ analysis.uploader }}</dd>
          </div>
          <div v-if="analysis.durationSeconds" class="flex items-center gap-1.5">
            <Clock :size="13" aria-hidden="true" /><dt class="sr-only">Duration</dt><dd>{{ formatDuration(analysis.durationSeconds) }}</dd>
          </div>
          <div v-if="analysis.uploadDate" class="flex items-center gap-1.5">
            <CalendarDays :size="13" aria-hidden="true" /><dt class="sr-only">Published</dt><dd>{{ formatDate(analysis.uploadDate) }}</dd>
          </div>
          <div v-if="analysis.viewCount !== null" class="flex items-center gap-1.5">
            <Eye :size="13" aria-hidden="true" /><dt class="sr-only">Views</dt><dd>{{ formatCount(analysis.viewCount) }} views</dd>
          </div>
        </dl>

        <dl class="mt-3.5 grid grid-cols-[88px_1fr] gap-x-3 gap-y-1.5 text-[12.5px]">
          <dt class="text-fg-subtle">Formats</dt>
          <dd data-testid="media-formats">{{ containers.length > 0 ? containers.join(' · ') : 'Audio only' }}</dd>
          <template v-if="resolutions.length > 0">
            <dt class="text-fg-subtle">Resolutions</dt>
            <dd class="flex flex-wrap gap-1" data-testid="media-resolutions">
              <span v-for="height in resolutions" :key="height" class="rounded bg-surface-2 px-1.5 py-px font-mono text-[11.5px]">
                {{ height }}p
              </span>
            </dd>
          </template>
          <dt class="text-fg-subtle">Audio</dt>
          <dd>{{ audioLine }}</dd>
          <template v-if="analysis.subtitles.length > 0">
            <dt class="text-fg-subtle">Subtitles</dt>
            <dd>{{ analysis.subtitles.length }} language{{ analysis.subtitles.length === 1 ? '' : 's' }}</dd>
          </template>
        </dl>
      </div>
    </div>

    <ul v-if="analysis.notices.length > 0" class="space-y-1.5 border-t border-border bg-surface-2/50 px-5 py-3">
      <li v-for="notice in analysis.notices" :key="notice.code" class="flex items-start gap-2 text-[12.5px] text-fg-muted">
        <Info :size="14" class="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
        <span :data-testid="`notice-${notice.code}`">{{ notice.message }}</span>
        <button
          v-if="notice.code === 'PART_OF_PLAYLIST'"
          type="button"
          class="ml-auto flex shrink-0 items-center gap-1 font-medium text-accent hover:underline"
          data-testid="open-playlist"
          @click="media.openPlaylistOfCurrent()"
        >
          <ListVideo :size="13" aria-hidden="true" />Open the whole playlist
        </button>
      </li>
    </ul>
  </section>
</template>
