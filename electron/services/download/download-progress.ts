import type { PlannedStream } from '../media/format-selection'

/*
 * yt-dlp is run with machine-readable progress templates (see ytdlp-command.ts):
 *   stdout  [MF-PROGRESS] status|downloaded|total|total_estimate|speed|eta|format_id
 *   stderr  [MF-PP] status|postprocessor
 *   stdout  [MF-FILE] "<final path, JSON-encoded>"
 * Fields yt-dlp does not know are empty.
 */

export const PROGRESS_PREFIX = '[MF-PROGRESS] '
export const POSTPROCESS_PREFIX = '[MF-PP] '
export const FILE_PREFIX = '[MF-FILE] '

export const DOWNLOAD_PROGRESS_TEMPLATE =
  'download:[MF-PROGRESS] %(progress.status|)s|%(progress.downloaded_bytes|)s|%(progress.total_bytes|)s|' +
  '%(progress.total_bytes_estimate|)s|%(progress.speed|)s|%(progress.eta|)s|%(info.format_id|)s'
export const POSTPROCESS_PROGRESS_TEMPLATE = 'postprocess:[MF-PP] %(progress.status|)s|%(progress.postprocessor|)s'
export const FINAL_PATH_TEMPLATE = 'after_move:[MF-FILE] %(filepath)j'

export type ProgressEvent =
  | {
      type: 'progress'
      status: string
      downloadedBytes: number | null
      totalBytes: number | null
      totalBytesEstimate: number | null
      speed: number | null
      eta: number | null
      formatId: string | null
    }
  | { type: 'postprocess'; status: string; name: string }
  | { type: 'file'; path: string }

function num(value: string | undefined): number | null {
  if (value === undefined || value === '' || value === 'NA' || value === 'None') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Parses one output line. Returns null for anything that is not one of our template lines. */
export function parseProgressLine(line: string): ProgressEvent | null {
  const text = line.replace(/\r$/, '')
  if (text.startsWith(PROGRESS_PREFIX)) {
    const [status = '', downloaded, total, estimate, speed, eta, formatId] = text.slice(PROGRESS_PREFIX.length).split('|')
    return {
      type: 'progress',
      status,
      downloadedBytes: num(downloaded),
      totalBytes: num(total),
      totalBytesEstimate: num(estimate),
      speed: num(speed),
      eta: num(eta),
      formatId: formatId ? formatId : null
    }
  }
  if (text.startsWith(POSTPROCESS_PREFIX)) {
    const [status = '', name = ''] = text.slice(POSTPROCESS_PREFIX.length).split('|')
    return { type: 'postprocess', status, name }
  }
  if (text.startsWith(FILE_PREFIX)) {
    try {
      const path: unknown = JSON.parse(text.slice(FILE_PREFIX.length))
      return typeof path === 'string' && path.length > 0 ? { type: 'file', path } : null
    } catch {
      return null
    }
  }
  return null
}

const POSTPROCESSOR_LABELS: Record<string, string> = {
  Merger: 'Merging video and audio',
  ExtractAudio: 'Converting audio',
  VideoRemuxer: 'Changing container',
  VideoConvertor: 'Converting video',
  EmbedThumbnail: 'Embedding thumbnail',
  Metadata: 'Writing metadata',
  FFmpegMetadata: 'Writing metadata',
  SubtitlesConvertor: 'Converting subtitles',
  EmbedSubtitle: 'Embedding subtitles',
  ThumbnailsConvertor: 'Converting thumbnail',
  MoveFiles: 'Finishing'
}

export function postprocessorLabel(name: string): string {
  if (POSTPROCESSOR_LABELS[name]) return POSTPROCESSOR_LABELS[name]
  if (name.startsWith('Fixup')) return 'Fixing up the file'
  return 'Processing'
}

export interface AggregateProgress {
  phase: 'downloading' | 'processing'
  /** 0–100 across all planned streams. */
  progress: number
  downloadedBytes: number
  totalBytes: number | null
  speed: number
  eta: number
  stage: string
}

interface StreamState {
  formatId: string
  kind: PlannedStream['kind'] | 'unknown'
  expected: number | null
  downloaded: number
  total: number | null
  done: boolean
}

/**
 * Combines per-stream progress (video, then audio) into one figure, weighting
 * each stream by its size. Streams yt-dlp chose that were not in the plan
 * (fallback selection) are added as they appear.
 */
export class ProgressAggregator {
  private readonly streams: StreamState[]
  private phase: AggregateProgress['phase'] = 'downloading'
  private stage = 'Starting'
  private speed = 0
  private eta = 0

  constructor(planned: readonly PlannedStream[]) {
    this.streams = planned.map((s) => ({
      formatId: s.formatId,
      kind: s.kind,
      expected: s.bytes,
      downloaded: 0,
      total: s.bytes,
      done: false
    }))
  }

  apply(event: ProgressEvent): AggregateProgress {
    if (event.type === 'progress') this.onProgress(event)
    if (event.type === 'postprocess' && event.status !== 'finished') {
      this.phase = 'processing'
      this.stage = postprocessorLabel(event.name)
      this.speed = 0
      this.eta = 0
    }
    return this.snapshot()
  }

  snapshot(): AggregateProgress {
    const downloaded = this.streams.reduce((sum, s) => sum + s.downloaded, 0)
    const totals = this.streams.map((s) => s.total ?? s.expected)
    const totalKnown = totals.length > 0 && totals.every((t) => t !== null)
    const total = totalKnown ? totals.reduce<number>((sum, t) => sum + (t ?? 0), 0) : null
    let progress: number
    if (total && total > 0) progress = (downloaded / total) * 100
    else {
      // Without sizes, each stream counts equally.
      const parts = this.streams.map((s) => (s.done ? 1 : s.total ? s.downloaded / s.total : 0))
      progress = parts.length > 0 ? (parts.reduce((a, b) => a + b, 0) / parts.length) * 100 : 0
    }
    if (this.phase === 'processing') progress = 100
    return {
      phase: this.phase,
      progress: Math.max(0, Math.min(100, Math.round(progress * 10) / 10)),
      downloadedBytes: downloaded,
      totalBytes: total,
      speed: this.speed,
      eta: this.eta,
      stage: this.stage
    }
  }

  private onProgress(event: Extract<ProgressEvent, { type: 'progress' }>): void {
    let stream = this.streams.find((s) => s.formatId === event.formatId)
    if (!stream) {
      stream = { formatId: event.formatId ?? '?', kind: 'unknown', expected: null, downloaded: 0, total: null, done: false }
      this.streams.push(stream)
    }
    stream.total = event.totalBytes ?? event.totalBytesEstimate ?? stream.total
    stream.downloaded = event.downloadedBytes ?? stream.downloaded
    if (event.status === 'finished') {
      stream.done = true
      stream.downloaded = stream.total ?? stream.downloaded
    }
    this.phase = 'downloading'
    this.speed = event.speed ?? 0
    const index = this.streams.indexOf(stream)
    const what = stream.kind === 'video' ? 'video' : stream.kind === 'audio' ? 'audio' : ''
    this.stage =
      this.streams.length > 1
        ? `Downloading ${what || 'stream'} (${index + 1} of ${this.streams.length})`
        : what === 'audio'
          ? 'Downloading audio'
          : 'Downloading'
    const snapshot = this.snapshotTotals()
    this.eta =
      snapshot.total !== null && this.speed > 0
        ? Math.max(0, Math.round((snapshot.total - snapshot.downloaded) / this.speed))
        : (event.eta ?? 0)
  }

  private snapshotTotals(): { downloaded: number; total: number | null } {
    const downloaded = this.streams.reduce((sum, s) => sum + s.downloaded, 0)
    const totals = this.streams.map((s) => s.total ?? s.expected)
    return {
      downloaded,
      total: totals.every((t) => t !== null) ? totals.reduce<number>((sum, t) => sum + (t ?? 0), 0) : null
    }
  }
}
