import { z } from 'zod'
import { proxySchema } from './network'

export const themePreferenceSchema = z.enum(['dark', 'light', 'system'])

/** File name patterns offered to the user. Free-form yt-dlp templates are not accepted. */
export const FILENAME_TEMPLATES = {
  'title-id': '%(title).150B [%(id)s].%(ext)s',
  title: '%(title).180B.%(ext)s',
  'uploader-title': '%(uploader).60B - %(title).150B.%(ext)s',
  'date-title': '%(upload_date>%Y-%m-%d)s - %(title).150B.%(ext)s'
} as const

export type FilenameTemplateId = keyof typeof FILENAME_TEMPLATES

/**
 * Every persisted setting. Each key is stored as its own row in the `settings`
 * table and validated individually, so one corrupt value cannot reset the rest.
 *
 * Defaults are kept separate from the field schemas on purpose: Zod applies
 * `.default()` even inside `.partial()`, which would turn an update of one key
 * into a reset of every other key.
 */
export const settingsFields = {
  theme: themePreferenceSchema,
  /** Absolute folder chosen through the native folder dialog; null means the OS Downloads folder. */
  downloadDirectory: z.string().min(1).max(4096).nullable(),
  defaultVideoFormat: z.enum(['mp4', 'webm', 'mkv']),
  defaultVideoQuality: z.enum(['best', '2160', '1440', '1080', '720', '480', '360']),
  defaultAudioFormat: z.enum(['mp3', 'm4a', 'wav', 'flac', 'opus']),
  defaultAudioQuality: z.enum(['best', '128', '192', '256', '320']),
  maxConcurrentDownloads: z.number().int().min(1).max(5),
  filenameTemplate: z.enum(Object.keys(FILENAME_TEMPLATES) as [FilenameTemplateId, ...FilenameTemplateId[]]),
  /** Leave a file alone (and finish immediately) when it has already been downloaded. */
  skipExisting: z.boolean(),
  embedMetadata: z.boolean(),
  embedThumbnail: z.boolean(),
  /** Put each playlist's downloads in a folder named after the playlist. */
  playlistSubfolders: z.boolean(),
  /** How many times a download that failed because of the network is resumed automatically. */
  maxRetries: z.number().int().min(0).max(10),
  /** Seconds yt-dlp waits for a network response before giving up on it. */
  networkTimeoutSeconds: z.number().int().min(5).max(300),
  /** Proxy for yt-dlp and MediaFlow's own requests; null for a direct connection. */
  proxy: proxySchema,
  /** Download speed limit per download in KiB/s; null for no limit. */
  speedLimitKib: z.number().int().min(64).max(1_048_576).nullable(),
  /** Detail written to the log file. */
  logLevel: z.enum(['info', 'debug']),
  /** Check for application and engine updates in the background. */
  autoCheckUpdates: z.boolean(),
  /** Hours between automatic checks. */
  updateCheckIntervalHours: z.union([z.literal(6), z.literal(12), z.literal(24), z.literal(72), z.literal(168)]),
  /** yt-dlp release channel: stable releases, or nightly builds with the latest site fixes. */
  ytdlpChannel: z.enum(['stable', 'nightly']),
  /** Install new yt-dlp versions automatically (only a copy MediaFlow manages, and only when idle). Opt-in. */
  autoUpdateYtdlp: z.boolean(),
  /** Include FFmpeg/FFprobe and Deno in automatic checks. */
  checkEngineUpdates: z.boolean(),
  /** Show a notice when a new MediaFlow version is found by an automatic check. */
  appUpdateNotifications: z.boolean()
}

export type SettingKey = keyof typeof settingsFields

export const appSettingsSchema = z.object(settingsFields).strict()

/**
 * Settings the renderer may change directly. The download folder is excluded:
 * it can only be set through the native folder picker in the main process, so
 * the renderer can never point downloads at an arbitrary path.
 */
/** A partial update coming from the renderer. Unknown and main-process-only keys are rejected. */
export const settingsPatchSchema = z
  .object(settingsFields)
  .omit({ downloadDirectory: true })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Settings update is empty' })

export const DEFAULT_SETTINGS: Readonly<z.infer<typeof appSettingsSchema>> = Object.freeze({
  theme: 'dark',
  downloadDirectory: null,
  defaultVideoFormat: 'mp4',
  defaultVideoQuality: 'best',
  defaultAudioFormat: 'mp3',
  defaultAudioQuality: '192',
  maxConcurrentDownloads: 2,
  filenameTemplate: 'title-id',
  skipExisting: true,
  embedMetadata: true,
  embedThumbnail: true,
  playlistSubfolders: true,
  maxRetries: 3,
  networkTimeoutSeconds: 30,
  proxy: null,
  speedLimitKib: null,
  logLevel: 'info',
  autoCheckUpdates: true,
  updateCheckIntervalHours: 24,
  ytdlpChannel: 'stable',
  autoUpdateYtdlp: false,
  checkEngineUpdates: true,
  appUpdateNotifications: true
})
