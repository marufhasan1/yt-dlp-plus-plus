import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  REQUIRED_ENGINES,
  type EngineId,
  type EnginesSnapshot,
  type EngineStatus,
  type InstallStage,
  type InstallTarget
} from '@shared/types/engines'
import type { Unsubscribe } from '@shared/types/ipc'
import { bridge, unwrap } from '@/api/client'

const ACTIVE_STAGES: readonly InstallStage[] = ['resolving', 'downloading', 'verifying', 'extracting', 'installing']

export const ENGINE_LABELS: Record<EngineId, string> = {
  'yt-dlp': 'yt-dlp',
  ffmpeg: 'FFmpeg',
  ffprobe: 'FFprobe',
  deno: 'Deno'
}

export function needsAttention(status: EngineStatus): boolean {
  return status.health === 'missing' || status.health === 'broken'
}

export const useEnginesStore = defineStore('engines', () => {
  const snapshot = ref<EnginesSnapshot | null>(null)
  let unsubscribe: Unsubscribe | null = null

  const installing = computed(() => {
    const install = snapshot.value?.install
    return install && ACTIVE_STAGES.includes(install.stage) ? install : null
  })

  /** Required engines that are missing or broken, once the first detection has finished. */
  const unavailable = computed<EngineStatus[]>(() => {
    const current = snapshot.value
    if (!current?.initialized) return []
    return REQUIRED_ENGINES.map((id) => current.engines[id]).filter(needsAttention)
  })

  /** True when yt-dlp has no JavaScript runtime and may miss some YouTube formats. */
  const jsRuntimeMissing = computed(() => {
    const deno = snapshot.value?.engines.deno
    return Boolean(snapshot.value?.initialized && deno && needsAttention(deno))
  })

  async function load(): Promise<void> {
    unsubscribe ??= bridge.engines.onChanged((next) => {
      snapshot.value = next
    })
    snapshot.value = await unwrap(bridge.engines.getStatus())
  }

  async function refresh(deep: boolean): Promise<void> {
    snapshot.value = await unwrap(bridge.engines.refresh(deep))
  }

  async function install(target: InstallTarget): Promise<void> {
    snapshot.value = await unwrap(bridge.engines.install(target))
  }

  async function cancelInstall(): Promise<void> {
    await unwrap(bridge.engines.cancelInstall())
  }

  async function openFolder(): Promise<void> {
    await unwrap(bridge.engines.openFolder())
  }

  return { snapshot, installing, unavailable, jsRuntimeMissing, load, refresh, install, cancelInstall, openFolder }
})
