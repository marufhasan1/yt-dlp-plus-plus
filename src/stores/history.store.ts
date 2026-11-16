import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { HistoryEntry, HistoryQuery, HistoryStatusFilter } from '@shared/types/downloads'
import { HISTORY_PAGE_SIZE } from '@shared/validation/downloads'
import { bridge, unwrap } from '@/api/client'

export type DateRange = 'any' | 'today' | 'week' | 'month' | 'custom'

export interface HistoryFilters {
  search: string
  format: string
  status: HistoryStatusFilter | 'any'
  range: DateRange
  /** YYYY-MM-DD, local time, for the custom range. */
  customFrom: string
  customTo: string
}

const EMPTY_FILTERS: HistoryFilters = { search: '', format: 'any', status: 'any', range: 'any', customFrom: '', customTo: '' }

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

/** Local-date filters become exact instants, so "today" means today where the user is. */
export function dateBounds(filters: HistoryFilters, now = new Date()): { from?: string; to?: string } {
  const today = startOfDay(now)
  const daysAgo = (n: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - n).toISOString()
  switch (filters.range) {
    case 'today':
      return { from: today.toISOString() }
    case 'week':
      return { from: daysAgo(6) }
    case 'month':
      return { from: daysAgo(29) }
    case 'custom': {
      const parse = (value: string) => {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
        return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : null
      }
      const from = parse(filters.customFrom)
      const to = parse(filters.customTo)
      return {
        ...(from ? { from: from.toISOString() } : {}),
        // The end date is inclusive: up to the start of the next day.
        ...(to ? { to: new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1).toISOString() } : {})
      }
    }
    default:
      return {}
  }
}

export const useHistoryStore = defineStore('history', () => {
  const filters = ref<HistoryFilters>({ ...EMPTY_FILTERS })
  const items = ref<HistoryEntry[]>([])
  const total = ref(0)
  const formats = ref<string[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  let generation = 0

  function query(offset: number): HistoryQuery {
    const f = filters.value
    const search = f.search.trim()
    return {
      ...(search ? { search } : {}),
      ...(f.format !== 'any' ? { format: f.format } : {}),
      ...(f.status !== 'any' ? { status: f.status } : {}),
      ...dateBounds(f),
      offset,
      limit: HISTORY_PAGE_SIZE
    }
  }

  /** Loads the first page for the current filters (or reloads the pages already shown). */
  async function load(keepLength = false): Promise<void> {
    const current = ++generation
    loading.value = true
    try {
      const limit = keepLength ? Math.min(200, Math.max(HISTORY_PAGE_SIZE, items.value.length)) : HISTORY_PAGE_SIZE
      const page = await unwrap(bridge.history.list({ ...query(0), limit }))
      if (current !== generation) return // a newer request superseded this one
      items.value = page.items
      total.value = page.total
      formats.value = page.formats
      loaded.value = true
    } finally {
      if (current === generation) loading.value = false
    }
  }

  async function loadMore(): Promise<void> {
    if (loading.value || items.value.length >= total.value) return
    const current = ++generation
    loading.value = true
    try {
      const page = await unwrap(bridge.history.list(query(items.value.length)))
      if (current !== generation) return
      const known = new Set(items.value.map((i) => i.id))
      items.value = [...items.value, ...page.items.filter((i) => !known.has(i.id))]
      total.value = page.total
    } finally {
      if (current === generation) loading.value = false
    }
  }

  function resetFilters(): void {
    filters.value = { ...EMPTY_FILTERS }
  }

  const filtered = computed(() => {
    const f = filters.value
    return f.search.trim() !== '' || f.format !== 'any' || f.status !== 'any' || f.range !== 'any'
  })

  async function remove(id: string, deleteFile: boolean): Promise<boolean> {
    const { fileDeleted } = await unwrap(bridge.history.delete(id, deleteFile))
    items.value = items.value.filter((i) => i.id !== id)
    total.value = Math.max(0, total.value - 1)
    return fileDeleted
  }

  return {
    filters,
    items,
    total,
    formats,
    loading,
    loaded,
    filtered,
    load,
    loadMore,
    resetFilters,
    remove,
    retry: (id: string) => unwrap(bridge.history.retry(id)),
    showInFolder: (id: string) => unwrap(bridge.history.showInFolder(id))
  }
})
