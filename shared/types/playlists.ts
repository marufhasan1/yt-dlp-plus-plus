import type { DownloadStatus } from './downloads'
import type { DownloadOptions, DownloadSelection } from './media'

/** Per-entry state shown next to each video. */
export type PlaylistEntryStatus = 'pending' | 'unavailable' | DownloadStatus

export interface PlaylistEntry {
  /** 1-based position in the playlist. */
  position: number
  videoId: string
  url: string
  title: string
  durationSeconds: number | null
  uploader: string | null
  /** False for private, deleted, members-only or live entries, which cannot be downloaded. */
  available: boolean
  unavailableReason: string | null
  status: PlaylistEntryStatus
  /** The most recent download job for this entry, if any. */
  downloadId: string | null
}

export interface PlaylistSummary {
  id: string
  /** "<extractor>:<playlist id>" */
  sourceId: string
  url: string
  title: string
  uploader: string | null
  /** Small JPEG data URL, or null. */
  thumbnail: string | null
  /** Entries listed (may be capped; see `truncated`). */
  totalItems: number
  unavailableItems: number
  /** True when the playlist has more entries than YT-DLP++ lists. */
  truncated: boolean
  createdAt: string
  updatedAt: string
}

export interface PlaylistDetails extends PlaylistSummary {
  entries: PlaylistEntry[]
}

export interface PlaylistDownloadRequest {
  playlistId: string
  /** Positions to download; 'all' means every available entry. */
  positions: number[] | 'all'
  selection: DownloadSelection
  options: Omit<DownloadOptions, 'subtitles'>
  /** Prefix file names with the playlist position ("003 - Title"), keeping playlist order. */
  numberFiles: boolean
  /** Leave out videos already downloaded in the same format whose file still exists. */
  skipDownloaded: boolean
}

export interface PlaylistDownloadResult {
  queued: number
  /** Entries skipped because they are unavailable, already downloading or paused, or already downloaded. */
  skipped: number
  /** Of `skipped`: entries left out because they were already downloaded in this format. */
  alreadyDownloaded: number
}
