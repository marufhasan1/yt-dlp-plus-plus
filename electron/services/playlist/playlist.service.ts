import { z } from 'zod'
import type { DownloadJob } from '@shared/types/downloads'
import type {
  PlaylistDetails,
  PlaylistDownloadRequest,
  PlaylistDownloadResult,
  PlaylistSummary
} from '@shared/types/playlists'
import type { AppSettings } from '@shared/types/settings'
import { MAX_PLAYLIST_ENTRIES, channelVideosUrl, parseMediaUrl } from '@shared/validation/media'
import { AppError } from '../../utils/errors'
import { childPath, sanitizeFolderName } from '../../utils/filename'
import type { Logger } from '../../utils/logger'
import type { ProcessRunner } from '../../utils/process'
import type { DownloadManager } from '../download/download-manager'
import { buildProfilePlan } from '../media/format-selection'
import { selectThumbnailUrl, type ThumbnailService } from '../media/thumbnail.service'
import { YTDLP_ENV, playlistArgs, type EngineRuntime } from '../media/ytdlp-command'
import { classifyYtDlpError } from '../media/ytdlp-errors'
import type { PlaylistEntryInput, PlaylistInput, PlaylistRepository } from '../storage/playlist.repository'

const thumbnailSchema = z.object({ url: z.string(), width: z.number().nullish(), height: z.number().nullish() }).loose()

/** One entry of yt-dlp's flat playlist output. Only these fields are read. */
const flatEntrySchema = z
  .object({
    _type: z.string().nullish(),
    id: z.string().min(1).max(200),
    url: z.string().nullish(),
    title: z.string().nullish(),
    duration: z.number().nullish(),
    channel: z.string().nullish(),
    uploader: z.string().nullish(),
    availability: z.string().nullish(),
    live_status: z.string().nullish(),
    ie_key: z.string().nullish(),
    thumbnails: z.array(thumbnailSchema).nullish()
  })
  .loose()

const flatPlaylistSchema = z
  .object({
    _type: z.string().nullish(),
    id: z.string(),
    title: z.string().nullish(),
    uploader: z.string().nullish(),
    channel: z.string().nullish(),
    webpage_url: z.string().nullish(),
    extractor_key: z.string().nullish(),
    playlist_count: z.number().nullish(),
    thumbnails: z.array(thumbnailSchema).nullish(),
    entries: z.array(z.unknown()).nullish()
  })
  .loose()

const UNAVAILABLE_TITLES: Record<string, string> = {
  '[private video]': 'Private video',
  '[deleted video]': 'Deleted video',
  '[unavailable video]': 'Unavailable video'
}
const UNAVAILABLE_AVAILABILITY: Record<string, string> = {
  private: 'Private video',
  needs_auth: 'Requires signing in',
  subscriber_only: 'Members only',
  premium_only: 'Premium only'
}

/** Why an entry cannot be downloaded, or null if it can. */
export function unavailableReason(entry: z.infer<typeof flatEntrySchema>): string | null {
  const byTitle = UNAVAILABLE_TITLES[(entry.title ?? '').trim().toLowerCase()]
  if (byTitle) return byTitle
  const byAvailability = entry.availability ? UNAVAILABLE_AVAILABILITY[entry.availability] : undefined
  if (byAvailability) return byAvailability
  if (entry.live_status === 'is_live') return 'Live now'
  if (entry.live_status === 'is_upcoming') return 'Not released yet'
  return null
}

/** List-row thumbnails are small; the Downloads list uses the usual 480 px. */
const ENTRY_THUMBNAIL_WIDTH = 240
const PLAYLIST_THUMBNAIL_WIDTH = 480
const PLAYLIST_TIMEOUT_MS = 5 * 60_000
const MAX_JSON_BYTES = 128 * 1024 * 1024
const THUMBNAIL_CONCURRENCY = 4

/**
 * Converts flat playlist JSON into what MediaFlow stores. Entries that are
 * themselves playlists (a channel's tab list) or that have no usable link are
 * dropped; private, deleted and live entries are kept but marked unavailable.
 */
export function parseFlatPlaylist(json: unknown, requestedUrl: string, maxEntries = MAX_PLAYLIST_ENTRIES): PlaylistInput {
  const parsed = flatPlaylistSchema.safeParse(json)
  if (!parsed.success) {
    throw new AppError('OPERATION_FAILED', 'yt-dlp returned playlist data MediaFlow could not read.', { cause: parsed.error })
  }
  const info = parsed.data
  const extractor = (info.extractor_key ?? 'generic').toLowerCase()
  const entries: PlaylistEntryInput[] = []
  let nested = 0
  for (const raw of info.entries ?? []) {
    const entry = flatEntrySchema.safeParse(raw)
    if (!entry.success) continue
    const e = entry.data
    if (e._type === 'playlist' || (e._type === 'url' && /\/(playlist|videos|shorts|streams)(\?|$)/.test(e.url ?? '') && !/[?&]v=/.test(e.url ?? ''))) {
      nested++
      continue
    }
    const url = e.url && parseMediaUrl(e.url) ? e.url : null
    if (!url) continue
    entries.push({
      position: entries.length + 1,
      videoId: e.id,
      url,
      title: truncate(e.title?.trim() || e.id, 300),
      durationSeconds: e.duration && e.duration > 0 ? Math.round(e.duration) : null,
      uploader: truncateNullable(e.channel ?? e.uploader ?? null, 200),
      thumbnailUrl: selectThumbnailUrl(e.thumbnails ?? null, null, ENTRY_THUMBNAIL_WIDTH),
      unavailableReason: unavailableReason(e)
    })
    if (entries.length >= maxEntries) break
  }
  if (entries.length === 0) {
    throw new AppError(
      'UNSUPPORTED',
      nested > 0
        ? 'This page lists other playlists rather than videos. Open one of them instead.'
        : 'This playlist has no videos that can be listed.'
    )
  }
  const count = info.playlist_count ?? null
  return {
    sourceId: `${extractor}:${info.id}`,
    url: info.webpage_url && parseMediaUrl(info.webpage_url) ? info.webpage_url : requestedUrl,
    title: truncate(info.title?.trim() || info.id, 300),
    uploader: truncateNullable(info.uploader ?? info.channel ?? null, 200),
    thumbnail: null,
    // Channels report no count, so reaching the cap is the only signal.
    truncated: count !== null ? count > entries.length : entries.length >= maxEntries,
    entries
  }
}

export interface PlaylistServiceDeps {
  runtime: () => EngineRuntime | Promise<EngineRuntime>
  acquire: (engines: ('yt-dlp' | 'deno')[]) => () => void
  run: ProcessRunner
  thumbnails: ThumbnailService
  repository: PlaylistRepository
  downloads: Pick<DownloadManager, 'enqueue' | 'find' | 'setThumbnail' | 'baseDestination' | 'onChanged' | 'downloadedSources'>
  settings: () => AppSettings
  logger: Logger
}

/** An entry whose job is in one of these states already has a download in progress (or paused). */
const ACTIVE: ReadonlySet<DownloadJob['status']> = new Set(['queued', 'analyzing', 'downloading', 'processing', 'paused'])

/**
 * Lists playlists (and channel Video tabs), keeps them in the database, and
 * turns a selection of entries into one download job per video.
 */
export class PlaylistService {
  private current: AbortController | null = null
  private readonly lastStatus = new Map<string, DownloadJob['status']>()

  constructor(private readonly deps: PlaylistServiceDeps) {
    // Keep each entry's stored status in step with its download job.
    deps.downloads.onChanged((job) => {
      if (!job.playlistId || this.lastStatus.get(job.id) === job.status) return
      this.lastStatus.set(job.id, job.status)
      deps.repository.setStatusForDownload(job.id, job.status)
    })
  }

  async analyze(rawUrl: string): Promise<PlaylistDetails> {
    const url = channelVideosUrl(rawUrl)
    const runtime = await this.deps.runtime()
    this.current?.abort()
    const controller = new AbortController()
    this.current = controller
    const release = this.deps.acquire(['yt-dlp', 'deno'])
    const started = Date.now()
    try {
      let result
      try {
        result = await this.deps.run(runtime.ytdlp, playlistArgs(runtime, url, MAX_PLAYLIST_ENTRIES), {
          timeoutMs: PLAYLIST_TIMEOUT_MS,
          maxOutputBytes: MAX_JSON_BYTES,
          env: YTDLP_ENV,
          killTree: true,
          signal: controller.signal
        })
      } catch (error) {
        if (controller.signal.aborted) throw new AppError('CANCELLED', 'Analysis was cancelled.', { cause: error })
        throw new AppError('OPERATION_FAILED', 'yt-dlp could not be started. Check Software Updates.', { cause: error })
      }
      if (result.timedOut) throw new AppError('NETWORK', 'Listing the playlist took too long. Try again.')
      if (result.exitCode !== 0) {
        const classified = classifyYtDlpError(result.stderr)
        this.deps.logger.warn(`Playlist analysis failed (${classified.code})`)
        const code = classified.code === 'NETWORK' || classified.code === 'RATE_LIMITED' ? 'NETWORK' : classified.code === 'PLAYLIST_UNAVAILABLE' ? 'NOT_FOUND' : 'OPERATION_FAILED'
        throw new AppError(code, classified.message)
      }

      let json: unknown
      try {
        json = JSON.parse(result.stdout)
      } catch (error) {
        throw new AppError('OPERATION_FAILED', 'yt-dlp returned playlist data MediaFlow could not read.', { cause: error })
      }
      const input = parseFlatPlaylist(json, url)
      const parsedThumbs = flatPlaylistSchema.safeParse(json)
      const thumbnailUrl =
        selectThumbnailUrl(parsedThumbs.success ? (parsedThumbs.data.thumbnails ?? null) : null, null, PLAYLIST_THUMBNAIL_WIDTH) ??
        input.entries.find((e) => e.thumbnailUrl)?.thumbnailUrl ??
        null
      input.thumbnail = await this.deps.thumbnails.cached(thumbnailUrl, PLAYLIST_THUMBNAIL_WIDTH, controller.signal)

      const id = this.deps.repository.save(input)
      this.deps.logger.info(
        `Listed playlist ${input.sourceId}: ${input.entries.length} entries${input.truncated ? ' (truncated)' : ''} in ${Date.now() - started} ms`
      )
      return this.get(id)
    } finally {
      release()
      if (this.current === controller) this.current = null
    }
  }

  cancel(): void {
    this.current?.abort()
  }

  list(): PlaylistSummary[] {
    return this.deps.repository.list()
  }

  get(id: string): PlaylistDetails {
    const playlist = this.deps.repository.get(id)
    if (!playlist) throw new AppError('NOT_FOUND', 'This playlist no longer exists.')
    return playlist
  }

  /** Lists the playlist again, keeping each video's download state. */
  refresh(id: string): Promise<PlaylistDetails> {
    return this.analyze(this.get(id).url)
  }

  /** Forgets the playlist. Download jobs and downloaded files are kept. */
  remove(id: string): void {
    this.get(id)
    this.deps.repository.remove(id)
  }

  /** The entry's thumbnail, fetched by the main process from the URL stored at analysis time. */
  async thumbnail(id: string, position: number): Promise<string | null> {
    const entry = this.deps.repository.entry(id, position)
    return entry ? this.deps.thumbnails.cached(entry.thumbnailUrl, ENTRY_THUMBNAIL_WIDTH) : null
  }

  async download(request: PlaylistDownloadRequest): Promise<PlaylistDownloadResult> {
    const playlist = this.get(request.playlistId)
    const wanted = request.positions === 'all' ? null : new Set(request.positions)
    const candidates = playlist.entries.filter((e) => wanted === null || wanted.has(e.position))
    const startable = candidates.filter((e) => {
      if (!e.available) return false
      const job = e.downloadId ? this.deps.downloads.find(e.downloadId) : null
      return !job || !ACTIVE.has(job.status)
    })

    const plan = buildProfilePlan(request.selection, request.options)
    const extractor = playlist.sourceId.split(':')[0] ?? 'generic'
    const sourceIdOf = (videoId: string) => `${extractor === 'youtubetab' ? 'youtube' : extractor}:${videoId}`
    const downloaded = request.skipDownloaded
      ? await this.deps.downloads.downloadedSources(startable.map((e) => sourceIdOf(e.videoId)), plan.outputFormat)
      : new Set<string>()
    const entries = startable.filter((e) => !downloaded.has(sourceIdOf(e.videoId)))
    if (entries.length === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        downloaded.size > 0
          ? `The selected videos are already downloaded as ${plan.outputFormat.toUpperCase()}.`
          : 'None of the selected videos can be downloaded right now.'
      )
    }

    const base = this.deps.downloads.baseDestination()
    const destination = this.deps.settings().playlistSubfolders ? childPath(base, sanitizeFolderName(playlist.title)) : base
    const width = Math.max(3, String(playlist.totalItems).length)

    const jobs = await this.deps.downloads.enqueue(
      entries.map((entry) => ({
        url: entry.url,
        title: entry.title,
        thumbnail: null,
        sourceId: sourceIdOf(entry.videoId),
        plan,
        destination,
        ...(request.numberFiles ? { filenamePrefix: `${String(entry.position).padStart(width, '0')} - ` } : {}),
        playlist: { id: playlist.id, position: entry.position, title: playlist.title }
      }))
    )
    jobs.forEach((job, index) => {
      const entry = entries[index]
      if (entry) this.deps.repository.linkDownload(playlist.id, entry.position, job.id, job.status)
    })
    void this.fillThumbnails(playlist.id, jobs)
    this.deps.logger.info(`Queued ${jobs.length} of ${candidates.length} selected entries from playlist ${playlist.id}`)
    return { queued: jobs.length, skipped: candidates.length - jobs.length, alreadyDownloaded: downloaded.size }
  }

  /** Download-list thumbnails for batch jobs, fetched a few at a time after queueing. */
  private async fillThumbnails(playlistId: string, jobs: DownloadJob[]): Promise<void> {
    const queue = [...jobs]
    const worker = async (): Promise<void> => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        if (job.playlistPosition === null) continue
        const entry = this.deps.repository.entry(playlistId, job.playlistPosition)
        const thumbnail = await this.deps.thumbnails.cached(entry?.thumbnailUrl ?? null, PLAYLIST_THUMBNAIL_WIDTH)
        if (thumbnail) this.deps.downloads.setThumbnail(job.id, thumbnail)
      }
    }
    await Promise.all(Array.from({ length: THUMBNAIL_CONCURRENCY }, worker)).catch((error: unknown) =>
      this.deps.logger.warn('Playlist thumbnails could not be loaded', error)
    )
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function truncateNullable(text: string | null, max: number): string | null {
  return text === null ? null : truncate(text, max)
}
