import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { ConversionJob, ConversionRequest, ConversionStatus, ConverterInput, PickedFolder } from '@shared/types/converter'
import type { Unsubscribe } from '@shared/types/ipc'
import { MAX_CONVERSION_INPUTS } from '@shared/validation/converter'
import { bridge, unwrap } from '@/api/client'

const ACTIVE: readonly ConversionStatus[] = ['queued', 'converting']

export function isConversionActive(job: ConversionJob): boolean {
  return ACTIVE.includes(job.status)
}

export const useConverterStore = defineStore('converter', () => {
  /** Files picked for the next conversion, in the order they were added. */
  const inputs = ref<ConverterInput[]>([])
  const jobs = ref<ConversionJob[]>([])
  const folder = ref<PickedFolder | null>(null)
  const picking = ref(false)
  let unsubscribers: Unsubscribe[] = []

  function upsert(job: ConversionJob): void {
    const index = jobs.value.findIndex((j) => j.id === job.id)
    if (index !== -1) {
      jobs.value.splice(index, 1, job)
      return
    }
    // Newest batch first; jobs of one batch share createdAt and keep the order they were picked in.
    const before = jobs.value.findIndex((j) => j.createdAt < job.createdAt)
    if (before === -1) jobs.value = [...jobs.value, job]
    else jobs.value.splice(before, 0, job)
  }

  async function load(): Promise<void> {
    if (unsubscribers.length === 0) {
      unsubscribers = [
        bridge.converter.onChanged(upsert),
        bridge.converter.onRemoved((id) => {
          jobs.value = jobs.value.filter((j) => j.id !== id)
        })
      ]
    }
    jobs.value = await unwrap(bridge.converter.list())
  }

  /** Opens the native file dialog and adds new files; reports those already listed or over the limit. */
  async function pickFiles(): Promise<{ added: number; duplicates: number; overLimit: number }> {
    picking.value = true
    try {
      const picked = await unwrap(bridge.converter.pickFiles())
      const known = new Set(inputs.value.map((i) => i.path))
      const unique = picked.filter((i) => !known.has(i.path))
      const fresh = unique.slice(0, Math.max(0, MAX_CONVERSION_INPUTS - inputs.value.length))
      inputs.value = [...inputs.value, ...fresh]
      return { added: fresh.length, duplicates: picked.length - unique.length, overLimit: unique.length - fresh.length }
    } finally {
      picking.value = false
    }
  }

  async function chooseFolder(): Promise<PickedFolder | null> {
    const picked = await unwrap(bridge.converter.chooseFolder())
    if (picked) folder.value = picked
    return picked
  }

  function removeInput(token: string): void {
    inputs.value = inputs.value.filter((i) => i.token !== token)
  }

  function clearInputs(): void {
    inputs.value = []
  }

  const convertible = computed(() => inputs.value.filter((i) => i.source !== null))

  /** Queues every readable input; they leave the selection once queued. */
  async function start(options: Omit<ConversionRequest, 'inputs'>): Promise<ConversionJob[]> {
    const tokens = convertible.value.map((i) => i.token)
    const started = await unwrap(bridge.converter.start({ ...options, inputs: tokens }))
    for (const job of started) upsert(job)
    inputs.value = inputs.value.filter((i) => !tokens.includes(i.token))
    return started
  }

  const active = computed(() => jobs.value.filter(isConversionActive))
  const finished = computed(() => jobs.value.filter((j) => !isConversionActive(j)))

  async function clearFinished(): Promise<void> {
    await Promise.all(finished.value.map((j) => unwrap(bridge.converter.remove(j.id))))
  }

  return {
    inputs,
    jobs,
    folder,
    picking,
    convertible,
    active,
    finished,
    load,
    pickFiles,
    chooseFolder,
    removeInput,
    clearInputs,
    start,
    clearFinished,
    cancel: (id: string) => unwrap(bridge.converter.cancel(id)),
    remove: (id: string) => unwrap(bridge.converter.remove(id)),
    showInFolder: (id: string) => unwrap(bridge.converter.showInFolder(id))
  }
})
