const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${UNITS[unit]}`
}

export function formatSpeed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : '—'
}

/** 75 → "1:15", 3725 → "1:02:05" */
export function formatDuration(totalSeconds: number | null): string {
  if (totalSeconds === null || !Number.isFinite(totalSeconds) || totalSeconds < 0) return '—'
  const seconds = Math.round(totalSeconds)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** Remaining time in words: "45 s", "3 min", "1 h 5 min". */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  if (seconds < 60) return `${Math.round(seconds)} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  const h = Math.floor(seconds / 3600)
  return `${h} h ${Math.round((seconds % 3600) / 60)} min`
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString()
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const date = new Date(`${iso}T00:00:00`)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString()
}

export function formatCount(value: number | null): string {
  return value === null ? '—' : new Intl.NumberFormat(undefined, { notation: 'compact' }).format(value)
}

/** "just now", "5 min ago", "3 h ago", "yesterday", then the date. Future times: "in 3 h". */
export function formatRelative(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000)
  const future = seconds < 0
  const s = Math.abs(seconds)
  const span = (text: string) => (future ? `in ${text}` : `${text} ago`)
  if (s < 60) return future ? 'in a moment' : 'just now'
  if (s < 3600) return span(`${Math.round(s / 60)} min`)
  if (s < 86_400) return span(`${Math.round(s / 3600)} h`)
  if (!future && s < 2 * 86_400) return 'yesterday'
  return date.toLocaleDateString()
}
