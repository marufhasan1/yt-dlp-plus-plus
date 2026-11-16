import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { InstallTarget } from '@shared/types/engines'
import type { Unsubscribe, UpdateNoticeEvent } from '@shared/types/ipc'
import type { UpdateComponentId, UpdateHistoryEntry, UpdatesSnapshot } from '@shared/types/updates'
import { bridge, unwrap } from '@/api/client'
import { router } from '@/router'
import { useToastStore } from './toast.store'

export const UPDATE_LABELS: Record<UpdateComponentId, string> = { app: 'YT-DLP++', 'yt-dlp': 'yt-dlp', ffmpeg: 'FFmpeg', deno: 'Deno' }

export const useUpdatesStore = defineStore('updates', () => {
  const snapshot = ref<UpdatesSnapshot | null>(null)
  const history = ref<UpdateHistoryEntry[]>([])
  let unsubscribers: Unsubscribe[] = []

  function onNotice(notice: UpdateNoticeEvent): void {
    const toasts = useToastStore()
    const name = UPDATE_LABELS[notice.component]
    if (notice.kind === 'available') {
      toasts.info(`${name} ${notice.version} is available`, 'Open Software Updates to download it.')
    } else if (notice.kind === 'updated') {
      toasts.success(`${name} updated`, notice.version ? `Now using ${notice.version}.` : undefined)
    } else {
      toasts.error(`${name} could not be updated`, notice.message ?? undefined)
    }
    void loadHistory()
  }

  async function load(): Promise<void> {
    if (unsubscribers.length === 0) {
      unsubscribers = [
        bridge.updates.onChanged((next) => {
          snapshot.value = next
        }),
        bridge.updates.onNotice(onNotice)
      ]
    }
    snapshot.value = await unwrap(bridge.updates.getStatus())
  }

  async function loadHistory(): Promise<void> {
    history.value = await unwrap(bridge.updates.history())
  }

  async function check(component: UpdateComponentId | 'all'): Promise<void> {
    snapshot.value = await unwrap(bridge.updates.check(component))
  }

  /** Returns whether the update waits for running work to finish. */
  async function updateEngine(target: InstallTarget): Promise<boolean> {
    try {
      const { deferred } = await unwrap(bridge.updates.updateEngine(target))
      return deferred
    } finally {
      void loadHistory()
    }
  }

  async function rollback(target: InstallTarget): Promise<void> {
    try {
      snapshot.value = await unwrap(bridge.updates.rollback(target))
    } finally {
      void loadHistory()
    }
  }

  /** Components with an update ready to apply, for the sidebar marker. */
  const available = computed(() => {
    const components = snapshot.value?.components
    if (!components) return []
    return Object.values(components).filter((c) => c.state === 'available' || c.state === 'ready')
  })

  return {
    snapshot,
    history,
    available,
    load,
    loadHistory,
    check,
    updateEngine,
    rollback,
    cancelWaiting: (target: InstallTarget) => unwrap(bridge.updates.cancelWaiting(target)),
    downloadApp: () => unwrap(bridge.updates.downloadApp()).finally(() => void loadHistory()),
    cancelAppDownload: () => unwrap(bridge.updates.cancelAppDownload()),
    installApp: () => unwrap(bridge.updates.installApp()),
    openReleaseNotes: (component: UpdateComponentId) => unwrap(bridge.updates.openReleaseNotes(component)),
    openPage: () => router.push({ name: 'updates' })
  }
})
