import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { DownloadJob, DownloadStatus } from '@shared/types/downloads'
import type { Unsubscribe } from '@shared/types/ipc'
import type { DownloadRequest } from '@shared/types/media'
import { bridge, unwrap } from '@/api/client'

const ACTIVE: readonly DownloadStatus[] = ['queued', 'analyzing', 'downloading', 'processing']

export function isActive(job: DownloadJob): boolean {
  return ACTIVE.includes(job.status)
}

export const useDownloadsStore = defineStore('downloads', () => {
  const jobs = ref<DownloadJob[]>([])
  let unsubscribers: Unsubscribe[] = []

  function upsert(job: DownloadJob): void {
    const index = jobs.value.findIndex((j) => j.id === job.id)
    if (index === -1) jobs.value = [job, ...jobs.value]
    else jobs.value.splice(index, 1, job)
  }

  async function load(): Promise<void> {
    if (unsubscribers.length === 0) {
      unsubscribers = [
        bridge.downloads.onChanged(upsert),
        bridge.downloads.onRemoved((id) => {
          jobs.value = jobs.value.filter((j) => j.id !== id)
        })
      ]
    }
    jobs.value = await unwrap(bridge.downloads.list())
  }

  async function start(request: DownloadRequest): Promise<DownloadJob> {
    const job = await unwrap(bridge.downloads.start(request))
    upsert(job)
    return job
  }

  const active = computed(() => jobs.value.filter(isActive))
  /** Paused because the app closed while they were queued or running. */
  const interrupted = computed(() => jobs.value.filter((j) => j.status === 'paused' && j.interrupted))
  const pausable = computed(() => jobs.value.filter((j) => j.status === 'queued' || j.status === 'downloading'))
  const paused = computed(() => jobs.value.filter((j) => j.status === 'paused'))
  const counts = computed(() => {
    const result: Record<DownloadStatus, number> = {
      queued: 0,
      analyzing: 0,
      downloading: 0,
      processing: 0,
      paused: 0,
      completed: 0,
      failed: 0,
      cancelled: 0
    }
    for (const job of jobs.value) result[job.status] += 1
    return result
  })
  const totalSpeed = computed(() =>
    jobs.value.filter((j) => j.status === 'downloading').reduce((sum, j) => sum + j.speed, 0)
  )

  return {
    jobs,
    active,
    interrupted,
    pausable,
    paused,
    counts,
    totalSpeed,
    load,
    start,
    cancel: (id: string) => unwrap(bridge.downloads.cancel(id)),
    retry: async (id: string) => upsert(await unwrap(bridge.downloads.retry(id))),
    remove: (id: string) => unwrap(bridge.downloads.remove(id)),
    showInFolder: (id: string) => unwrap(bridge.downloads.showInFolder(id)),
    pause: (id: string) => unwrap(bridge.downloads.pause(id)),
    resume: async (id: string) => upsert(await unwrap(bridge.downloads.resume(id))),
    pauseAll: () => unwrap(bridge.downloads.pauseAll()),
    resumeAll: () => unwrap(bridge.downloads.resumeAll())
  }
})
