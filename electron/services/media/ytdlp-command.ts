import { FILENAME_TEMPLATES, type FilenameTemplateId } from '@shared/validation/settings'
import {
  DOWNLOAD_PROGRESS_TEMPLATE,
  FINAL_PATH_TEMPLATE,
  POSTPROCESS_PROGRESS_TEMPLATE
} from '../download/download-progress'
import { compareVersions } from '../updates/versions'
import type { DownloadPlan } from './format-selection'

/** Resolved engine locations for one yt-dlp invocation. */
export interface EngineRuntime {
  ytdlp: string
  /** Folder containing ffmpeg and ffprobe (always a matched pair), or null when unavailable. */
  ffmpegLocation: string | null
  /** Deno executable for YouTube's JavaScript challenges, or null. */
  deno: string | null
  /** Connection settings from Settings → Advanced; defaults apply when omitted. */
  network?: NetworkOptions
  /** Version of the yt-dlp at `ytdlp`, when known (decides which options it understands). */
  ytdlpVersion?: string | null
}

/** First yt-dlp release with --no-plugin-dirs (Changelog 2024.10.22, #11277). */
const NO_PLUGIN_DIRS_SINCE = '2024.10.22'

export interface NetworkOptions {
  /** Seconds to wait for a response. */
  timeoutSeconds: number
  /** Normalised proxy address (validated by proxySchema), or null for a direct connection. */
  proxy: string | null
  /** Per-download limit in KiB/s, or null. */
  speedLimitKib: number | null
}

export const DEFAULT_NETWORK: NetworkOptions = { timeoutSeconds: 30, proxy: null, speedLimitKib: null }

/** Make Python print UTF-8 regardless of the Windows console code page. */
export const YTDLP_ENV: Record<string, string> = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

/**
 * Arguments every invocation shares. `--ignore-config` keeps a user's global
 * yt-dlp configuration from changing YT-DLP++'s behaviour.
 */
export function commonArgs(runtime: EngineRuntime): string[] {
  const network = runtime.network ?? DEFAULT_NETWORK
  return [
    '--ignore-config',
    // Plugins from the user's yt-dlp folders would run inside YT-DLP++'s downloads; --ignore-config does not stop them.
    ...(runtime.ytdlpVersion && compareVersions(runtime.ytdlpVersion, NO_PLUGIN_DIRS_SINCE) >= 0 ? ['--no-plugin-dirs'] : []),
    '--no-colors',
    '--encoding',
    'utf-8',
    '--no-playlist',
    '--socket-timeout',
    String(network.timeoutSeconds),
    // Without one, yt-dlp follows the system's HTTP(S)_PROXY variables, like before.
    ...(network.proxy ? ['--proxy', network.proxy] : []),
    ...(runtime.deno ? ['--js-runtimes', `deno:${runtime.deno}`] : []),
    ...(runtime.ffmpegLocation ? ['--ffmpeg-location', runtime.ffmpegLocation] : [])
  ]
}

/** Metadata only, as one JSON document. `--flat-playlist` keeps playlist pages cheap if one slips through. */
export function analyzeArgs(runtime: EngineRuntime, url: string): string[] {
  return [...commonArgs(runtime), '--dump-single-json', '--skip-download', '--flat-playlist', '--', url]
}

/**
 * Playlist listing without visiting each video ("flat"): one request per page
 * of entries instead of one per video. `--playlist-end` bounds huge playlists
 * and channels; yt-dlp stops fetching pages once it is reached.
 */
export function playlistArgs(runtime: EngineRuntime, url: string, maxEntries: number): string[] {
  return [
    ...commonArgs(runtime).filter((arg) => arg !== '--no-playlist'),
    '--yes-playlist',
    '--flat-playlist',
    '--playlist-end',
    String(maxEntries),
    '--dump-single-json',
    '--skip-download',
    '--',
    url
  ]
}

export interface DownloadCommand {
  runtime: EngineRuntime
  plan: DownloadPlan
  url: string
  /** Final folder. */
  destination: string
  /** Per-job scratch folder for partial files; finished files are moved to `destination`. */
  tempDir: string
  filenameTemplate: FilenameTemplateId
  skipExisting: boolean
  platform: NodeJS.Platform
  /** Literal text placed before the file name, e.g. "003 - " for playlist order. */
  filenamePrefix?: string
}

/** Only digits and " - " are accepted as a prefix; `%` would start a yt-dlp template field. */
const PREFIX_PATTERN = /^\d{1,5} - $/

export function outputTemplate(template: FilenameTemplateId, prefix?: string): string {
  if (prefix !== undefined && !PREFIX_PATTERN.test(prefix)) throw new Error('Invalid file name prefix')
  return `${prefix ?? ''}${FILENAME_TEMPLATES[template]}`
}

/**
 * Full argument list for a download. Only fixed strings, validated plan
 * arguments, app-controlled paths and the validated URL (after `--`) are used.
 */
export function downloadArgs(command: DownloadCommand): string[] {
  return [
    ...commonArgs(command.runtime),
    ...command.plan.args,
    '--newline',
    // --print implies --quiet; --progress keeps the progress lines coming.
    '--progress',
    '--progress-template',
    DOWNLOAD_PROGRESS_TEMPLATE,
    '--progress-template',
    POSTPROCESS_PROGRESS_TEMPLATE,
    '--print',
    FINAL_PATH_TEMPLATE,
    '--no-simulate',
    '--paths',
    command.destination,
    '--paths',
    `temp:${command.tempDir}`,
    '--output',
    outputTemplate(command.filenameTemplate, command.filenamePrefix),
    command.skipExisting ? '--no-overwrites' : '--force-overwrites',
    '--no-mtime',
    '--retries',
    '10',
    '--fragment-retries',
    '10',
    ...(command.runtime.network?.speedLimitKib ? ['--limit-rate', `${command.runtime.network.speedLimitKib}K`] : []),
    ...(command.platform === 'win32' ? ['--windows-filenames'] : []),
    '--',
    command.url
  ]
}
