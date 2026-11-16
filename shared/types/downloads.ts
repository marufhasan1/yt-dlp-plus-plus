export type DownloadStatus =
  | 'queued'
  | 'analyzing'
  | 'downloading'
  | 'processing'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type DownloadErrorCode =
  | 'UNSUPPORTED_URL'
  | 'VIDEO_UNAVAILABLE'
  | 'PLAYLIST_UNAVAILABLE'
  | 'PRIVATE_VIDEO'
  | 'AGE_RESTRICTED'
  | 'GEO_BLOCKED'
  | 'LOGIN_REQUIRED'
  | 'BOT_CHECK'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'FORMAT_UNAVAILABLE'
  | 'FFMPEG_MISSING'
  | 'ENGINE_MISSING'
  | 'DISK_FULL'
  | 'PERMISSION_DENIED'
  | 'LIVE_STREAM'
  | 'INTERRUPTED'
  | 'UNKNOWN'

/** The normalised job model shared by the main process, the database and the UI. */
export interface DownloadJob {
  id: string
  url: string
  title: string
  /** Small JPEG data URL. */
  thumbnail: string | null
  mediaType: 'video' | 'audio' | 'playlist'
  /** mp4, webm, mkv, mp3, m4a, wav, flac, opus, or "srt"/"vtt" for subtitle-only jobs. */
  outputFormat: string
  /** e.g. "1080p60 · H.264" or "192 kbps" */
  quality: string | null
  /** The output folder until the job completes, then the final file. */
  outputPath: string
  status: DownloadStatus
  /** 0–100, download portion only. Post-processing is reported through `stage`. */
  progress: number
  /** Bytes per second. */
  speed: number
  /** Seconds remaining. */
  eta: number
  downloadedBytes: number
  totalBytes: number | null
  /** Human-readable step, e.g. "Downloading video (1 of 2)" or "Merging video and audio". */
  stage: string | null
  error: string | null
  errorCode: DownloadErrorCode | null
  createdAt: string
  completedAt: string | null
  /** Set when the job was started from a playlist. */
  playlistId: string | null
  /** 1-based position of the video in that playlist. */
  playlistPosition: number | null
  playlistTitle: string | null
  /** "<extractor>:<id>" of the media, used for duplicate detection. */
  sourceId: string | null
  /** Paused because the app closed (or crashed) while it was queued or running; partial files were kept. */
  interrupted: boolean
}

/** An earlier download of the same media, shown before downloading it again. */
export interface PreviousDownload {
  id: string
  outputFormat: string
  quality: string | null
  status: DownloadStatus
  completedAt: string | null
  createdAt: string
  /** For completed downloads: whether the file is still where it was saved. */
  fileExists: boolean | null
}

export type HistoryStatusFilter = 'completed' | 'failed' | 'cancelled'

export interface HistoryQuery {
  /** Matched against the title and the link. */
  search?: string
  /** An output format such as "mp4"; omitted for all formats. */
  format?: string
  status?: HistoryStatusFilter
  /** Inclusive lower bound on the creation time (ISO 8601). */
  from?: string
  /** Exclusive upper bound on the creation time (ISO 8601). */
  to?: string
  offset: number
  limit: number
}

export interface HistoryEntry extends DownloadJob {
  /** For completed downloads: whether the file is still where it was saved; null otherwise. */
  fileExists: boolean | null
  /** Still listed on the Downloads page. */
  listed: boolean
}

export interface HistoryPage {
  items: HistoryEntry[]
  /** Matches for the query, across all pages. */
  total: number
  /** Every output format present in the history, for the filter. */
  formats: string[]
}
