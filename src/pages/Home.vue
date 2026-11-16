<script setup lang="ts">
import { Link2, TriangleAlert } from '@lucide/vue'
import AppButton from '@/components/common/AppButton.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import SkeletonBlock from '@/components/common/SkeletonBlock.vue'
import DownloadOptions from '@/components/media/DownloadOptions.vue'
import MediaPreview from '@/components/media/MediaPreview.vue'
import PreviousDownloadsNotice from '@/components/media/PreviousDownloadsNotice.vue'
import UrlInput from '@/components/media/UrlInput.vue'
import { useEnginesStore } from '@/stores/engines.store'
import { useMediaStore } from '@/stores/media.store'

const media = useMediaStore()
const engines = useEnginesStore()
</script>

<template>
  <div class="space-y-5">
    <UrlInput />

    <div
      v-if="engines.unavailable.some((e) => e.id === 'yt-dlp')"
      class="flex items-center gap-3 rounded-xl border border-warning/40 bg-warning-soft px-4 py-3 text-[13px]"
    >
      <TriangleAlert :size="16" class="shrink-0 text-warning" aria-hidden="true" />
      <span class="flex-1">yt-dlp is needed to analyse and download links.</span>
      <AppButton class="h-8" @click="$router.push({ name: 'updates' })">Set up engines</AppButton>
    </div>

    <template v-if="media.status === 'analyzing'">
      <section class="flex gap-5 rounded-xl border border-border bg-surface p-5 shadow-card" aria-busy="true" data-testid="analyzing">
        <SkeletonBlock class="aspect-video w-60 shrink-0 rounded-lg" />
        <div class="flex-1 space-y-3 pt-1">
          <SkeletonBlock class="h-4 w-4/5" />
          <SkeletonBlock class="h-3 w-2/5" />
          <SkeletonBlock class="mt-5 h-3 w-3/5" />
          <SkeletonBlock class="h-3 w-1/2" />
          <p class="pt-2 text-[12.5px] text-fg-subtle">Reading media information…</p>
        </div>
      </section>
    </template>

    <template v-else-if="media.status === 'ready' && media.analysis">
      <MediaPreview :analysis="media.analysis" />
      <PreviousDownloadsNotice :source-id="media.analysis.sourceId" :previous="media.previousDownloads" />
      <DownloadOptions :key="media.analysis.analysisId" :analysis="media.analysis" />
    </template>

    <EmptyState
      v-else-if="media.status !== 'error'"
      :icon="Link2"
      title="Download from a link"
      description="Paste a video link above and choose Analyze to see its formats, resolutions and audio options before downloading. Only download content you own or are allowed to download."
    />
  </div>
</template>
