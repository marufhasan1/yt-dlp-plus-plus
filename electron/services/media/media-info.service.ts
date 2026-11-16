import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DownloadErrorCode } from '@shared/types/downloads'
import type { IpcErrorCode } from '@shared/types/ipc'
import type { DownloadRequest, MediaAnalysis, MediaNotice, SubtitleTrack } from '@shared/types/media'
import { classifyMediaUrl } from '@shared/validation/media'
import { AppError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import type { ProcessRunner } from '../../utils/process'
import {
  PlanError,
  audioSummary,
  buildDownloadPlan,
  containerOptions,
  normalizeFormats,
  type DownloadPlan,
  type NormalizedFormat
} from './format-selection'
import { selectThumbnailUrl, type ThumbnailService } from './thumbnail.service'
import { YTDLP_ENV, analyzeArgs, type EngineRuntime } from './ytdlp-command'
import { classifyYtDlpError } from './ytdlp-errors'

/** The subset of yt-dlp's info JSON MediaFlow reads. Everything else is ignored. */
const rawInfoSchema = z
  .object({
    _type: z.string().nullish(),
    id: z.string(),
    title: z.string().nullish(),
    uploader: z.string().nullish(),
    channel: z.string().nullish(),
    duration: z.number().nullish(),
    upload_date: z.string().nullish(),
    view_count: z.number().nullish(),
    webpage_url: z.string().nullish(),
    extractor_key: z.string().nullish(),
    extractor: z.string().nullish(),
    is_live: z.boolean().nullish(),
    live_status: z.string().nullish(),
    language: z.string().nullish(),
    thumbnail: z.string().nullish(),
    thumbnails: z
      .array(z.object({ url: z.string(), width: z.number().nullish(), height: z.number().nullish() }).loose())
      .nullish(),
    formats: z.array(z.object({ format_id: z.string() }).loose()).nullish(),
    subtitles: z.record(z.string(), z.array(z.object({ name: z.string().nullish() }).loose())).nullish(),
    automatic_captions: z.record(z.string(), z.array(z.object({ name: z.string().nullish() }).loose())).nullish()
  })
  .loose()

type RawInfo = z.infer<typeof rawInfoSchema>

/** The link is a playlist or channel; it must be listed by PlaylistService instead. */
export class PlaylistDetected extends AppError {
  constructor() {
    super('UNSUPPORTED', 'This link is a playlist. Open it from the Playlists page.')
    this.name = 'PlaylistDetected'
  }
}

export interface CachedAnalysis {
  analysis: MediaAnalysis
  formats: NormalizedFormat[]
  createdAt: number
}

export interface MediaInfoDeps {
  /** Resolves engine paths; throws ENGINE_MISSING when yt-dlp is unusable. */
  runtime: () => EngineRuntime | Promise<EngineRuntime>
  /** Marks engines in use so they are not replaced mid-run. Returns the release function. */
  acquire: (engines: ('yt-dlp' | 'deno')[]) => () => void
  run: ProcessRunner
  thumbnails: ThumbnailService
  logger: Logger
  now?: () => number
}

const CACHE_TTL_MS = 3 * 60 * 60 * 1000
const CACHE_MAX = 50
const ANALYZE_TIMEOUT_MS = 120_000
/** Info JSON with many caption tracks can run to several megabytes. */
const MAX_JSON_BYTES = 64 * 1024 * 1024

const ERROR_TO_IPC: Partial<Record<DownloadErrorCode, IpcErrorCode>> = {
  UNSUPPORTED_URL: 'UNSUPPORTED',
  LIVE_STREAM: 'UNSUPPORTED',
  NETWORK: 'NETWORK',
  RATE_LIMITED: 'NETWORK',
  VIDEO_UNAVAILABLE: 'NOT_FOUND',
  PRIVATE_VIDEO: 'NOT_FOUND'
}

export class MediaInfoService {
  private readonly cache = new Map<string, CachedAnalysis>()
  private current: AbortController | null = null
  private readonly now: () => number

  constructor(private readonly deps: MediaInfoDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Analyses a single media URL. Starting a new analysis cancels the previous one. */
  async analyze(url: string): Promise<MediaAnalysis> {
    const kind = classifyMediaUrl(url).kind
    if (kind === 'youtube-playlist' || kind === 'youtube-channel') throw new PlaylistDetected()

    const runtime = await this.deps.runtime()
    this.current?.abort()
    const controller = new AbortController()
    this.current = controller
    const release = this.deps.acquire(['yt-dlp', 'deno'])
    const started = this.now()

    try {
      let result
      try {
        result = await this.deps.run(runtime.ytdlp, analyzeArgs(runtime, url), {
          timeoutMs: ANALYZE_TIMEOUT_MS,
          maxOutputBytes: MAX_JSON_BYTES,
          env: YTDLP_ENV,
          killTree: true,
          signal: controller.signal
        })
      } catch (error) {
        if (controller.signal.aborted) throw new AppError('CANCELLED', 'Analysis was cancelled.', { cause: error })
        throw new AppError('OPERATION_FAILED', 'yt-dlp could not be started. Check Software Updates.', { cause: error })
      }
      if (result.timedOut) throw new AppError('NETWORK', 'Analysing the link took too long. Try again.')
      if (result.exitCode !== 0) {
        const classified = classifyYtDlpError(result.stderr)
        this.deps.logger.warn(`Analysis failed (${classified.code}) after ${this.now() - started} ms`)
        throw new AppError(ERROR_TO_IPC[classified.code] ?? 'OPERATION_FAILED', classified.message)
      }

      const info = parseInfo(result.stdout)
      const { analysis, formats } = await this.toAnalysis(info, url, runtime, controller.signal)
      this.remember({ analysis, formats, createdAt: this.now() })
      this.deps.logger.info(
        `Analysed ${analysis.sourceId} in ${this.now() - started} ms: ${formats.length} usable formats` +
          (runtime.deno ? '' : ' (no JavaScript runtime)')
      )
      return analysis
    } finally {
      release()
      if (this.current === controller) this.current = null
    }
  }

  cancel(): void {
    this.current?.abort()
  }

  get(analysisId: string): CachedAnalysis | null {
    const entry = this.cache.get(analysisId)
    if (!entry) return null
    if (this.now() - entry.createdAt > CACHE_TTL_MS) {
      this.cache.delete(analysisId)
      return null
    }
    return entry
  }

  /** Builds the download plan for a request against a cached analysis. */
  plan(request: DownloadRequest): { cached: CachedAnalysis; plan: DownloadPlan } {
    const cached = this.get(request.analysisId)
    if (!cached) throw new AppError('NOT_FOUND', 'This analysis has expired. Analyse the link again.')
    try {
      const plan = buildDownloadPlan(cached.formats, cached.analysis.durationSeconds, request.selection, request.options)
      return { cached, plan }
    } catch (error) {
      if (error instanceof PlanError) throw new AppError('VALIDATION_FAILED', error.message)
      throw error
    }
  }

  private remember(entry: CachedAnalysis): void {
    this.cache.set(entry.analysis.analysisId, entry)
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private async toAnalysis(
    info: RawInfo,
    url: string,
    runtime: EngineRuntime,
    signal: AbortSignal
  ): Promise<{ analysis: MediaAnalysis; formats: NormalizedFormat[] }> {
    if (info._type && info._type !== 'video') throw new PlaylistDetected()
    if (info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
      throw new AppError('UNSUPPORTED', 'Live streams cannot be downloaded while they are live. Try again after the broadcast ends.')
    }

    const extractor = info.extractor_key ?? info.extractor ?? 'generic'
    const durationSeconds = info.duration && info.duration > 0 ? Math.round(info.duration) : null
    const formats = normalizeFormats((info.formats ?? []) as Parameters<typeof normalizeFormats>[0], durationSeconds)
    const video = containerOptions(formats)
    const audio = audioSummary(formats)

    const notices: MediaNotice[] = []
    if (!runtime.deno && /youtube/i.test(extractor)) {
      notices.push({
        code: 'JS_RUNTIME_MISSING',
        message: 'Some YouTube formats may be missing. Install the JavaScript runtime from Software Updates to see them all.'
      })
    }
    if (classifyMediaUrl(url).playlistId) {
      notices.push({ code: 'PART_OF_PLAYLIST', message: 'This video is part of a playlist. Only this video will be downloaded.' })
    }
    if (video.length === 0) notices.push({ code: 'NO_VIDEO', message: 'No downloadable video stream was found; audio only.' })
    if (!audio.available) notices.push({ code: 'NO_AUDIO', message: 'This media has no audio track.' })
    if (video.length === 0 && !audio.available) {
      throw new AppError('UNSUPPORTED', 'No downloadable video or audio was found at this link.')
    }

    const thumbnail = await this.deps.thumbnails.load(
      selectThumbnailUrl(info.thumbnails ?? null, info.thumbnail ?? null),
      signal
    )

    const analysis: MediaAnalysis = {
      analysisId: randomUUID(),
      url: info.webpage_url && /^https?:\/\//.test(info.webpage_url) ? info.webpage_url : url,
      sourceId: `${extractor.toLowerCase()}:${info.id}`,
      extractor,
      title: truncate(info.title?.trim() || info.id, 500),
      uploader: truncateNullable(info.uploader ?? info.channel ?? null, 200),
      durationSeconds,
      uploadDate: isoDate(info.upload_date ?? null),
      viewCount: info.view_count ?? null,
      thumbnail,
      video,
      audio,
      subtitles: subtitleTracks(info),
      notices
    }
    return { analysis, formats }
  }
}

function parseInfo(stdout: string): RawInfo {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch (error) {
    throw new AppError('OPERATION_FAILED', 'yt-dlp returned data MediaFlow could not read.', { cause: error })
  }
  const parsed = rawInfoSchema.safeParse(json)
  if (!parsed.success) {
    throw new AppError('OPERATION_FAILED', 'yt-dlp returned data MediaFlow could not read.', { cause: parsed.error })
  }
  return parsed.data
}

/**
 * Publisher subtitles in every language, plus machine captions in the
 * original language only (YouTube offers ~150 machine-translated ones).
 */
function subtitleTracks(info: RawInfo): SubtitleTrack[] {
  const valid = (lang: string) => /^[A-Za-z0-9-]{1,32}$/.test(lang) && lang !== 'live_chat'
  const manual = Object.entries(info.subtitles ?? {})
    .filter(([lang]) => valid(lang))
    .map(([lang, tracks]) => ({ lang, name: truncate(tracks[0]?.name ?? lang, 80), automatic: false }))
  const automatic = Object.entries(info.automatic_captions ?? {}).filter(
    ([lang]) => valid(lang) && (lang.endsWith('-orig') || (!!info.language && lang === info.language))
  )
  const seen = new Set(manual.map((t) => t.lang))
  return [
    ...manual,
    ...automatic
      .filter(([lang]) => !seen.has(lang))
      .map(([lang, tracks]) => ({ lang, name: truncate(tracks[0]?.name ?? lang, 80), automatic: true }))
  ].slice(0, 100)
}

function isoDate(value: string | null): string | null {
  const match = value ? /^(\d{4})(\d{2})(\d{2})$/.exec(value) : null
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function truncateNullable(text: string | null, max: number): string | null {
  return text === null ? null : truncate(text, max)
}
