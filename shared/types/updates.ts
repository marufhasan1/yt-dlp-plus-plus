/** Components with their own version and update status. FFmpeg covers FFmpeg and FFprobe together. */
export type UpdateComponentId = 'app' | 'yt-dlp' | 'ffmpeg' | 'deno'

export type YtDlpChannel = 'stable' | 'nightly'

export type UpdateState =
  /** Not checked yet in this installation. */
  | 'unknown'
  | 'checking'
  | 'up-to-date'
  | 'available'
  /** Requested, waiting for downloads and conversions using the engine to finish. */
  | 'waiting'
  | 'downloading'
  | 'installing'
  /** App only: downloaded and verified, applied on restart. */
  | 'ready'
  /** Updated in this session. */
  | 'updated'
  | 'failed'
  /** Nothing can be updated here (e.g. not installed, no trusted build, portable app, unconfigured release feed). */
  | 'unavailable'

export interface ComponentUpdate {
  id: UpdateComponentId
  installedVersion: string | null
  latestVersion: string | null
  /** When the latest version was published (ISO 8601), if the source says. */
  releasedAt: string | null
  checkedAt: string | null
  state: UpdateState
  /** Why the last check or update failed, or why updating is unavailable. */
  message: string | null
  /** Web page with the release notes. */
  notesUrl: string | null
  /** App only: release notes as plain text. */
  releaseNotes: string | null
  /** App only, while downloading: 0–100. */
  progress: number | null
  /** yt-dlp: the channel the latest version comes from. */
  channel: YtDlpChannel | null
  /** yt-dlp: installing the latest version means switching channels (possibly to an older version). */
  channelSwitch: boolean
  /** The installed copy belongs to the system (PATH), so YT-DLP++ installs its own copy instead of replacing it. */
  systemCopy: boolean
  /** A previous version kept for rolling back, if any. */
  rollbackVersion: string | null
}

export interface UpdatesSnapshot {
  components: Record<UpdateComponentId, ComponentUpdate>
  checkingAll: boolean
  /** Last completed "check all", manual or scheduled. */
  lastCheckedAll: string | null
  /** When the next automatic check is due, or null when automatic checks are off. */
  nextScheduledCheck: string | null
}

export type UpdateOutcome = 'success' | 'failed' | 'rolled_back'

export interface UpdateHistoryEntry {
  id: number
  component: 'app' | 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'deno'
  previousVersion: string | null
  newVersion: string | null
  status: UpdateOutcome
  createdAt: string
  errorMessage: string | null
}
