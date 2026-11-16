import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type { PreviousDownload } from '@shared/types/downloads'
import type { MediaAnalysis } from '@shared/types/media'
import { classifyMediaUrl, mediaUrlSchema } from '@shared/validation/media'
import { BridgeError, bridge, errorMessage, unwrap } from '@/api/client'
import { router } from '@/router'
import { usePlaylistsStore } from './playlists.store'

export type AnalysisStatus = 'idle' | 'analyzing' | 'ready' | 'error'

/** The Home page's link analysis. Kept in a store so it survives navigating away and back. */
export const useMediaStore = defineStore('media', () => {
  const url = ref('')
  const status = ref<AnalysisStatus>('idle')
  const analysis = ref<MediaAnalysis | null>(null)
  /** Earlier downloads of the analysed video, newest first. */
  const previousDownloads = ref<PreviousDownload[]>([])
  const error = ref<string | null>(null)

  // Editing the link dismisses the previous error; it described a different link.
  watch(url, () => {
    if (status.value === 'error') {
      status.value = 'idle'
      error.value = null
    }
  })

  async function analyze(): Promise<void> {
    const parsed = mediaUrlSchema.safeParse(url.value)
    if (!parsed.success) {
      status.value = 'error'
      error.value = parsed.error.issues[0]?.message ?? 'Enter a valid link'
      return
    }
    url.value = parsed.data
    status.value = 'analyzing'
    error.value = null
    analysis.value = null
    previousDownloads.value = []
    try {
      const result = await unwrap(bridge.media.analyze(parsed.data))
      if (result.kind === 'playlist') {
        // Playlists and channels are handled on their own page.
        status.value = 'idle'
        usePlaylistsStore().show(result.playlist)
        await router.push({ name: 'playlists', query: { id: result.playlist.id } })
        return
      }
      analysis.value = result.media
      previousDownloads.value = result.previousDownloads
      status.value = 'ready'
    } catch (caught) {
      if (caught instanceof BridgeError && caught.code === 'CANCELLED') {
        // A newer analysis replaced this one, or the user cancelled.
        if (status.value === 'analyzing') status.value = 'idle'
        return
      }
      status.value = 'error'
      error.value = errorMessage(caught)
    }
  }

  /** For a video opened from a playlist link: list the whole playlist instead. */
  async function openPlaylistOfCurrent(): Promise<void> {
    const playlistId = classifyMediaUrl(url.value).playlistId
    if (!playlistId) return
    url.value = `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`
    await analyze()
  }

  async function cancel(): Promise<void> {
    status.value = 'idle'
    await unwrap(bridge.media.cancelAnalyze())
  }

  function clear(): void {
    if (status.value === 'analyzing') void bridge.media.cancelAnalyze()
    url.value = ''
    status.value = 'idle'
    analysis.value = null
    previousDownloads.value = []
    error.value = null
  }

  return { url, status, analysis, previousDownloads, error, analyze, openPlaylistOfCurrent, cancel, clear }
})
