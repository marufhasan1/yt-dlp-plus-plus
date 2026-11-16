export type EngineId = 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'deno'

/**
 * What can be installed. 'ffmpeg' installs FFmpeg and FFprobe together as one
 * toolchain. 'deno' is the JavaScript runtime yt-dlp uses for YouTube's
 * JavaScript challenges; it is recommended but optional.
 */
export type InstallTarget = 'yt-dlp' | 'ffmpeg' | 'deno'

/** Engines without which downloading cannot work at all. */
export const REQUIRED_ENGINES: readonly EngineId[] = ['yt-dlp', 'ffmpeg', 'ffprobe']

/**
 * Where a binary was found, in resolution order:
 * managed (downloaded by the app into its engines folder), bundled (shipped
 * inside the application package), system (found on PATH).
 */
export type EngineSource = 'managed' | 'bundled' | 'system'

export type EngineHealth = 'checking' | 'ok' | 'degraded' | 'broken' | 'missing'

export type EngineProblemCode =
  | 'NOT_FOUND'
  | 'NOT_EXECUTABLE'
  | 'INCOMPATIBLE_BINARY'
  | 'VERSION_FAILED'
  | 'INTEGRITY_MISMATCH'
  | 'MISSING_CAPABILITIES'
  | 'TOOLCHAIN_MISMATCH'

export interface EngineProblem {
  code: EngineProblemCode
  message: string
}

export interface EngineStatus {
  id: EngineId
  health: EngineHealth
  /** Display version, e.g. "2026.10.26" or "9.0". */
  version: string | null
  /** Full build string as reported by the binary, when it differs from `version`. */
  build: string | null
  source: EngineSource | null
  path: string | null
  problems: EngineProblem[]
  checkedAt: string | null
}

export type InstallStage =
  | 'resolving'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'installing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface InstallProgress {
  target: InstallTarget
  stage: InstallStage
  receivedBytes: number
  totalBytes: number | null
  /** Version being installed, once known. */
  version: string | null
  /** User-presentable failure reason when stage is 'failed'. */
  error: string | null
}

/** Where an installable engine comes from, shown to the user before they opt in. */
export interface EngineProviderInfo {
  name: string
  homepage: string
  license: string
}

export interface EnginesSnapshot {
  /** e.g. "win32-x64". */
  target: string
  platform: string
  arch: string
  initialized: boolean
  checking: boolean
  enginesDir: string
  engines: Record<EngineId, EngineStatus>
  /** Null when no trusted build exists for this platform; the user must install the engine themselves. */
  providers: Record<InstallTarget, EngineProviderInfo | null>
  /** The current or most recent installation in this session. */
  install: InstallProgress | null
  /** Version kept for rolling back each target (managed copies only), or null. */
  rollback: Record<InstallTarget, string | null>
  /** Targets whose engines are in use by downloads or conversions right now. */
  inUse: InstallTarget[]
}
