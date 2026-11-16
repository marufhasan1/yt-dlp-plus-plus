import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PlaylistDetails, PlaylistDownloadRequest, PlaylistDownloadResult, PlaylistSummary } from '@shared/types/playlists'
import { bridge, unwrap } from '@/api/client'

export const usePlaylistsStore = defineStore('playlists', () => {
  const summaries = ref<PlaylistSummary[]>([])
  const current = ref<PlaylistDetails | null>(null)
  const loading = ref(false)
  /** Entry thumbnails by "<playlist id>:<position>"; a pending request is shared by every row asking for it. */
  const thumbnails = ref<Record<string, string | null>>({})
  const pending = new Map<string, Promise<void>>()

  async function load(): Promise<void> {
    summaries.value = await unwrap(bridge.playlists.list())
  }

  function show(details: PlaylistDetails): void {
    current.value = details
    const summary: PlaylistSummary = {
      id: details.id,
      sourceId: details.sourceId,
      url: details.url,
      title: details.title,
      uploader: details.uploader,
      thumbnail: details.thumbnail,
      totalItems: details.totalItems,
      unavailableItems: details.unavailableItems,
      truncated: details.truncated,
      createdAt: details.createdAt,
      updatedAt: details.updatedAt
    }
    const index = summaries.value.findIndex((s) => s.id === details.id)
    if (index === -1) summaries.value = [summary, ...summaries.value]
    else summaries.value.splice(index, 1, summary)
  }

  async function open(id: string): Promise<void> {
    loading.value = true
    try {
      show(await unwrap(bridge.playlists.get(id)))
    } finally {
      loading.value = false
    }
  }

  async function refresh(id: string): Promise<void> {
    loading.value = true
    try {
      show(await unwrap(bridge.playlists.refresh(id)))
    } finally {
      loading.value = false
    }
  }

  async function remove(id: string): Promise<void> {
    await unwrap(bridge.playlists.remove(id))
    summaries.value = summaries.value.filter((s) => s.id !== id)
    if (current.value?.id === id) current.value = null
  }

  async function download(request: PlaylistDownloadRequest): Promise<PlaylistDownloadResult> {
    const result = await unwrap(bridge.playlists.download(request))
    // Entries now point at their new jobs.
    if (current.value?.id === request.playlistId) show(await unwrap(bridge.playlists.get(request.playlistId)))
    return result
  }

  function thumbnail(id: string, position: number): void {
    const key = `${id}:${position}`
    if (key in thumbnails.value || pending.has(key)) return
    const request = unwrap(bridge.playlists.thumbnail(id, position))
      .then((data) => {
        thumbnails.value[key] = data
      })
      .catch(() => {
        thumbnails.value[key] = null
      })
      .finally(() => pending.delete(key))
    pending.set(key, request)
  }

  return { summaries, current, loading, thumbnails, load, show, open, refresh, remove, download, thumbnail }
})
