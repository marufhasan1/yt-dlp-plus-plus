import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { DownloadJob, HistoryEntry, HistoryPage, HistoryQuery, PreviousDownload } from '@shared/types/downloads'
import type { EngineId } from '@shared/types/engines'
import type { Unsubscribe } from '@shared/types/ipc'
import type { DownloadRequest } from '@shared/types/media'
import type { AppSettings } from '@shared/types/settings'
import { AppError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import type { DownloadPlan } from '../media/format-selection'
import type { MediaInfoService } from '../media/media-info.service'
import { downloadArgs, type EngineRuntime } from '../media/ytdlp-command'
import type { DownloadRepository, StoredPlan } from '../storage/download.repository'
import type { AggregateProgress } from './download-progress'
import { DownloadCancelled, DownloadFailure, type DownloadWorker } from './download-worker'
import { clearOwner, stopOrphan, writeOwner, type GroupKiller, type ProcessInspector } from './orphan-guard'

export interface DownloadManagerDeps {
  repository: DownloadRepository
  media: Pick<MediaInfoService, 'plan'>
  engines: {
    /** Throws ENGINE_MISSING when yt-dlp is unusable. */
    runtime(): EngineRuntime | Promise<EngineRuntime>
    acquire(engines: readonly EngineId[]): () => void
  }
  settings: () => AppSettings
  /** Used when the user has not chosen a download folder. */
  defaultDownloadDir: string
  /** Parent of the per-job scratch folders. */
  tempRoot: string
  createWorker: () => DownloadWorker
  logger: Logger
  /** Moves a file to the Recycle Bin / Trash (Electron's shell.trashItem in production). */
  trash?: (path: string) => Promise<void>
  platform?: NodeJS.Platform
  now?: () => Date
  /** First automatic-retry delay; later ones grow ×3. */
  retryBaseDelayMs?: number
  /** Finds and stops yt-dlp processes left running by a crashed session (see orphan-guard.ts). */
  orphans?: { inspect: ProcessInspector; kill: GroupKiller }
}

/** A download ready to queue: what to fetch, how, and where to put it. */
export interface PreparedDownload {
  url: string
  title: string
  thumbnail: string | null
  /** "<extractor>:<id>" when known. */
  sourceId: string | null
  plan: DownloadPlan
  destination: string
  /** Validated "NNN - " prefix for playlist order. */
  filenamePrefix?: string
  playlist?: { id: string; position: number; title: string }
}

/** Statuses of jobs that hold a place in the queue or a running process. */
const ACTIVE = new Set<DownloadJob['status']>(['queued', 'analyzing', 'downloading', 'processing'])
const UPDATE_INTERVAL_MS = 250
const ENGINES_FOR_DOWNLOAD: readonly EngineId[] = ['yt-dlp', 'ffmpeg', 'ffprobe', 'deno']
const RETRY_MAX_DELAY_MS = 2 * 60_000
const INTERRUPTED_MESSAGE = 'The download was interrupted when the app closed and cannot be resumed.'

type StopReason = 'cancel' | 'pause'

/**
 * Owns all download jobs: a FIFO queue limited to the configured number of
 * simultaneous downloads, persistence of every state change, pause/resume,
 * automatic retries, restart recovery, history, and the engine leases that
 * keep yt-dlp/FFmpeg from being replaced mid-download.
 *
 * yt-dlp cannot be suspended safely, so pausing stops its process tree and
 * keeps the job's scratch folder; resuming runs the same command again and
 * yt-dlp continues the partial files (verified with the real binary).
 */
export class DownloadManager {
  private readonly jobs = new Map<string, DownloadJob>()
  private readonly plans = new Map<string, StoredPlan>()
  private readonly queue: string[] = []
  private readonly running = new Map<string, DownloadWorker>()
  private readonly stopReasons = new Map<string, StopReason>()
  private readonly retryTimers = new Map<string, NodeJS.Timeout>()
  private readonly attempts = new Map<string, number>()
  private readonly lastEmit = new Map<string, number>()
  private readonly events = new EventEmitter()
  private readonly now: () => Date
  private shuttingDown = false

  constructor(private readonly deps: DownloadManagerDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Startup: jobs that were queued or running when the app last closed (or
   * crashed) become paused and flagged as interrupted, so the user can resume them.
   */
  initialize(): number {
    const interrupted = this.deps.repository.recoverInterrupted(INTERRUPTED_MESSAGE, this.now())
    if (interrupted > 0) this.deps.logger.warn(`${interrupted} download(s) were interrupted by the last shutdown; kept paused`)
    for (const job of this.deps.repository.list()) this.jobs.set(job.id, job)
    return interrupted
  }

  /**
   * Startup, before anything can resume: stops yt-dlp processes a crashed
   * session left running, then removes scratch folders that no paused or
   * failed job can resume from.
   */
  async cleanTemp(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.deps.tempRoot)
    } catch {
      return
    }
    const orphans = this.deps.orphans
    await Promise.all(
      entries.map(async (name) => {
        const dir = join(this.deps.tempRoot, name)
        if (orphans) {
          await stopOrphan(dir, { ...orphans, logger: this.deps.logger, platform: this.deps.platform }).catch((error: unknown) =>
            this.deps.logger.warn(`Could not check ${name} for a leftover process`, error)
          )
        }
        const status = this.jobs.get(name)?.status
        if (status === 'paused' || status === 'failed') return
        await rm(dir, { recursive: true, force: true }).catch((error: unknown) =>
          this.deps.logger.warn(`Could not remove ${name} from the download scratch folder`, error)
        )
      })
    )
  }

  list(): DownloadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  onChanged(listener: (job: DownloadJob) => void): Unsubscribe {
    this.events.on('changed', listener)
    return () => this.events.off('changed', listener)
  }

  onRemoved(listener: (id: string) => void): Unsubscribe {
    this.events.on('removed', listener)
    return () => this.events.off('removed', listener)
  }

  /** The configured download folder, or the OS Downloads folder. */
  baseDestination(): string {
    return this.deps.settings().downloadDirectory ?? this.deps.defaultDownloadDir
  }

  /** Downloads one analysed video. */
  async start(request: DownloadRequest): Promise<DownloadJob> {
    const { cached, plan } = this.deps.media.plan(request)
    const { analysis } = cached
    const duplicate = [...this.jobs.values()].find(
      (job) =>
        job.sourceId === analysis.sourceId &&
        job.outputFormat === plan.outputFormat &&
        (ACTIVE.has(job.status) || job.status === 'paused')
    )
    if (duplicate) {
      const state = duplicate.status === 'paused' ? 'paused in your downloads' : 'already being downloaded'
      throw new AppError('DUPLICATE', `This video is ${state} as ${plan.outputFormat.toUpperCase()}. See the Downloads page.`)
    }
    const [job] = await this.enqueue([
      {
        url: analysis.url,
        title: analysis.title,
        thumbnail: analysis.thumbnail,
        sourceId: analysis.sourceId,
        plan,
        destination: this.baseDestination()
      }
    ])
    if (!job) throw new AppError('INTERNAL', 'The download could not be queued.')
    return job
  }

  /**
   * Queues prepared downloads (one per video), e.g. every selected entry of a
   * playlist. Engines and folders are checked once up front, so a batch is
   * either queued completely or not at all.
   */
  async enqueue(items: readonly PreparedDownload[]): Promise<DownloadJob[]> {
    const runtime = await this.deps.engines.runtime()
    if (items.some((item) => item.plan.kind !== 'subtitles') && !runtime.ffmpegLocation) {
      throw new AppError('ENGINE_MISSING', 'FFmpeg is needed to merge and convert downloads. Install it from Software Updates.')
    }
    for (const destination of new Set(items.map((item) => item.destination))) {
      try {
        await mkdir(destination, { recursive: true })
      } catch (error) {
        throw new AppError('OPERATION_FAILED', 'The download folder cannot be created. Choose another folder in Settings.', {
          cause: error
        })
      }
    }

    const settings = this.deps.settings()
    const queued: DownloadJob[] = []
    for (const item of items) {
      const stored: StoredPlan = {
        plan: item.plan,
        destination: item.destination,
        filenameTemplate: settings.filenameTemplate,
        skipExisting: settings.skipExisting,
        ...(item.filenamePrefix ? { filenamePrefix: item.filenamePrefix } : {})
      }
      const job: DownloadJob = {
        id: randomUUID(),
        url: item.url,
        title: item.title,
        thumbnail: item.thumbnail,
        mediaType: item.plan.kind === 'audio' ? 'audio' : 'video',
        outputFormat: item.plan.outputFormat,
        quality: item.plan.qualityLabel,
        outputPath: item.destination,
        status: 'queued',
        progress: 0,
        speed: 0,
        eta: 0,
        downloadedBytes: 0,
        totalBytes: item.plan.estimatedBytes,
        stage: 'Waiting to start',
        error: null,
        errorCode: null,
        createdAt: this.now().toISOString(),
        completedAt: null,
        playlistId: item.playlist?.id ?? null,
        playlistPosition: item.playlist?.position ?? null,
        playlistTitle: item.playlist?.title ?? null,
        sourceId: item.sourceId,
        interrupted: false
      }
      this.deps.repository.insert(job, stored, item.sourceId)
      this.jobs.set(job.id, job)
      this.plans.set(job.id, stored)
      this.emit(job, true)
      queued.push({ ...job })
      this.queue.push(job.id)
    }
    this.deps.logger.info(
      items.length === 1
        ? `Queued ${queued[0]?.id}: ${items[0]?.sourceId ?? items[0]?.url} as ${items[0]?.plan.outputFormat} (${items[0]?.plan.qualityLabel ?? '—'})`
        : `Queued ${items.length} downloads${items[0]?.playlist ? ` from playlist ${items[0].playlist.id}` : ''}`
    )
    this.pump()
    return queued
  }

  /** Thumbnails of batch-queued videos are fetched after queueing and filled in here. */
  setThumbnail(id: string, thumbnail: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.deps.repository.setThumbnail(id, thumbnail)
    this.update(job, { thumbnail }, true)
  }

  /** The job, or null if it no longer exists in the list. */
  find(id: string): DownloadJob | null {
    const job = this.jobs.get(id)
    return job ? { ...job } : null
  }

  get(id: string): DownloadJob {
    return { ...this.require(id) }
  }

  // ─── Job control ─────────────────────────────────────────────────────────────

  /**
   * Pauses a queued or downloading job. A running download is stopped and its
   * partial files are kept for resuming. Post-processing (merging, converting)
   * cannot be interrupted safely and is left to finish.
   */
  async pause(id: string): Promise<void> {
    const job = this.require(id)
    if (job.status === 'paused') return
    if (job.status === 'queued') {
      this.leaveQueue(id)
      this.finish(job, { status: 'paused', stage: null, interrupted: false })
      return
    }
    if (job.status === 'processing') {
      throw new AppError('BUSY', 'The download is being finished and cannot be paused now.')
    }
    const worker = this.running.get(id)
    if (job.status !== 'downloading' || !worker) {
      throw new AppError('VALIDATION_FAILED', 'Only queued or downloading jobs can be paused.')
    }
    this.stopReasons.set(id, 'pause')
    this.update(job, { stage: 'Pausing…' }, true)
    await worker.cancel()
  }

  /** Puts a paused job back in the queue; yt-dlp continues its partial files. */
  resume(id: string): DownloadJob {
    const job = this.require(id)
    if (job.status !== 'paused') throw new AppError('VALIDATION_FAILED', 'Only paused downloads can be resumed.')
    this.requirePlan(id)
    this.attempts.delete(id)
    this.update(job, { status: 'queued', stage: 'Waiting to start', interrupted: false, error: null, errorCode: null }, true)
    this.deps.repository.update(job, this.now())
    // Copied before pump(): the queue may start it right away.
    const queued = { ...job }
    this.queue.push(id)
    this.pump()
    return queued
  }

  /** Pauses every queued and downloading job; returns how many were paused. */
  async pauseAll(): Promise<number> {
    const targets = [...this.jobs.values()].filter((job) => job.status === 'queued' || job.status === 'downloading')
    // Queued jobs first, so a slot freed by a paused download is not filled by the next in line.
    targets.sort((a, b) => Number(a.status === 'downloading') - Number(b.status === 'downloading'))
    let paused = 0
    for (const job of targets) {
      try {
        await this.pause(job.id)
        paused++
      } catch (error) {
        this.deps.logger.debug(`Could not pause ${job.id}`, error)
      }
    }
    return paused
  }

  /** Resumes every paused job, oldest first; returns how many. */
  resumeAll(): number {
    const paused = [...this.jobs.values()].filter((job) => job.status === 'paused')
    paused.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    for (const job of paused) this.resume(job.id)
    return paused.length
  }

  async cancel(id: string): Promise<void> {
    const job = this.require(id)
    if (job.status === 'paused' || this.leaveQueue(id)) {
      this.finish(job, { status: 'cancelled', stage: null, interrupted: false })
      await this.removeTemp(id)
      return
    }
    const worker = this.running.get(id)
    if (worker) {
      this.stopReasons.set(id, 'cancel')
      this.update(job, { stage: 'Cancelling…' }, true)
      await worker.cancel()
    }
  }

  /**
   * Re-queues a failed or cancelled job, including one only shown in History.
   * Partial files of a failed attempt are kept and continued.
   */
  retry(id: string): DownloadJob {
    let job = this.jobs.get(id)
    if (!job) {
      const stored = this.deps.repository.get(id)
      if (!stored) throw new AppError('NOT_FOUND', 'This download no longer exists.')
      job = stored.job
    }
    if (job.status !== 'failed' && job.status !== 'cancelled') {
      throw new AppError('VALIDATION_FAILED', 'Only failed or cancelled downloads can be retried.')
    }
    const stored = this.requirePlan(id)
    if (!this.jobs.has(id)) {
      this.deps.repository.undismiss(id)
      this.jobs.set(id, job)
    }
    this.attempts.delete(id)
    this.update(
      job,
      {
        status: 'queued',
        progress: 0,
        speed: 0,
        eta: 0,
        downloadedBytes: 0,
        stage: 'Waiting to start',
        error: null,
        errorCode: null,
        completedAt: null,
        interrupted: false,
        outputPath: stored.destination
      },
      true
    )
    this.deps.repository.update(job, this.now())
    const queued = { ...job }
    this.queue.push(id)
    this.pump()
    return queued
  }

  /** Removes a finished job from the Downloads list (kept in History). Files on disk are not touched. */
  async remove(id: string): Promise<void> {
    const job = this.require(id)
    if (ACTIVE.has(job.status) || job.status === 'paused') throw new AppError('BUSY', 'Cancel the download before removing it.')
    this.deps.repository.dismiss(id, this.now())
    this.forget(id)
    await this.removeTemp(id)
  }

  hasActiveJobs(): boolean {
    return [...this.jobs.values()].some((job) => ACTIVE.has(job.status))
  }

  /** Called when settings change: a higher download limit starts waiting jobs. */
  settingsChanged(): void {
    this.pump()
  }

  /**
   * Stops all work before the app quits. Queued and running jobs are saved as
   * paused + interrupted with their partial files, and offered for resuming on
   * the next start.
   */
  async shutdown(): Promise<void> {
    const affected = [...this.jobs.values()].filter((job) => ACTIVE.has(job.status))
    for (const job of affected) {
      Object.assign(job, { status: 'paused', interrupted: true, stage: null, speed: 0, eta: 0 })
    }
    this.deps.repository.updateMany(affected, this.now())
    this.shuttingDown = true
    this.queue.length = 0
    for (const timer of this.retryTimers.values()) clearTimeout(timer)
    this.retryTimers.clear()
    await Promise.all([...this.running.values()].map((worker) => worker.cancel()))
    this.events.removeAllListeners()
  }

  // ─── History and duplicates ──────────────────────────────────────────────────

  /** Finished downloads (including ones removed from the Downloads list), newest first. */
  async history(query: HistoryQuery): Promise<HistoryPage> {
    const { items, total } = this.deps.repository.history(query)
    const entries: HistoryEntry[] = await Promise.all(
      items.map(async ({ job, dismissed }) => ({
        ...(this.jobs.get(job.id) ?? job),
        fileExists: job.status === 'completed' ? await isFile(job.outputPath) : null,
        listed: !dismissed
      }))
    )
    return { items: entries, total, formats: this.deps.repository.formats() }
  }

  /**
   * Deletes a download from history (and from the Downloads list). The file is
   * only touched when the user explicitly asks, and is moved to the Recycle Bin
   * / Trash rather than deleted.
   */
  async deleteRecord(id: string, deleteFile: boolean): Promise<{ fileDeleted: boolean }> {
    const job = this.jobs.get(id) ?? this.deps.repository.get(id)?.job
    if (!job) throw new AppError('NOT_FOUND', 'This download no longer exists.')
    if (ACTIVE.has(job.status) || job.status === 'paused') {
      throw new AppError('BUSY', 'Cancel the download before deleting it from history.')
    }
    let fileDeleted = false
    if (deleteFile) {
      if (job.status !== 'completed' || !(await isFile(job.outputPath))) {
        throw new AppError('NOT_FOUND', 'There is no downloaded file to delete. It may have been moved or deleted already.')
      }
      if (!this.deps.trash) throw new AppError('UNSUPPORTED', 'Files cannot be moved to the Recycle Bin here.')
      try {
        await this.deps.trash(job.outputPath)
      } catch (error) {
        throw new AppError('OPERATION_FAILED', 'The file could not be moved to the Recycle Bin / Trash.', { cause: error })
      }
      fileDeleted = true
      this.deps.logger.info(`Moved ${job.outputPath} to the trash (history entry ${id})`)
    }
    this.deps.repository.delete(id)
    this.forget(id)
    await this.removeTemp(id)
    return { fileDeleted }
  }

  /** Where "Show in folder" should point, for listed and history-only jobs. */
  location(id: string): string {
    const job = this.jobs.get(id) ?? this.deps.repository.get(id)?.job
    if (!job) throw new AppError('NOT_FOUND', 'This download no longer exists.')
    return job.outputPath
  }

  /** Earlier downloads of the same media, newest first. */
  async previous(sourceId: string): Promise<PreviousDownload[]> {
    return Promise.all(
      this.deps.repository.previous(sourceId).map(async (job) => ({
        id: job.id,
        outputFormat: job.outputFormat,
        quality: job.quality,
        status: this.jobs.get(job.id)?.status ?? job.status,
        completedAt: job.completedAt,
        createdAt: job.createdAt,
        fileExists: job.status === 'completed' ? await isFile(job.outputPath) : null
      }))
    )
  }

  /** Of these media, the ones already downloaded in this format whose file still exists. */
  async downloadedSources(sourceIds: readonly string[], outputFormat: string): Promise<Set<string>> {
    const found = new Set<string>()
    for (const [sourceId, paths] of this.deps.repository.completedFiles(sourceIds, outputFormat)) {
      for (const path of paths) {
        if (await isFile(path)) {
          found.add(sourceId)
          break
        }
      }
    }
    return found
  }

  // ─── Running ─────────────────────────────────────────────────────────────────

  private pump(): void {
    if (this.shuttingDown) return
    const limit = this.deps.settings().maxConcurrentDownloads
    while (this.running.size < limit && this.queue.length > 0) {
      const id = this.queue.shift()
      if (id) void this.run(id)
    }
  }

  private async run(id: string): Promise<void> {
    const job = this.jobs.get(id)
    const stored = this.plans.get(id)
    if (!job || !stored || job.status !== 'queued') return

    const worker = this.deps.createWorker()
    this.running.set(id, worker)
    const tempDir = join(this.deps.tempRoot, id)
    let release: (() => void) | null = null
    let keepTemp = false
    this.update(job, { status: 'downloading', stage: job.downloadedBytes > 0 ? 'Resuming' : 'Starting' }, true)
    this.deps.repository.update(job, this.now())

    try {
      const runtime = await this.deps.engines.runtime()
      release = this.deps.engines.acquire(ENGINES_FOR_DOWNLOAD)
      await mkdir(tempDir, { recursive: true })
      const args = downloadArgs({
        runtime,
        plan: stored.plan,
        url: job.url,
        destination: stored.destination,
        tempDir,
        filenameTemplate: stored.filenameTemplate,
        skipExisting: stored.skipExisting,
        filenamePrefix: stored.filenamePrefix,
        platform: this.deps.platform ?? process.platform
      })
      this.deps.logger.info(`Starting download ${id}${job.downloadedBytes > 0 ? ' (resuming)' : ''}`)
      const result = await worker.run(
        runtime.ytdlp,
        args,
        stored.plan.streams,
        (progress) => this.onProgress(job, progress),
        (pid) => {
          try {
            writeOwner(tempDir, { pid, executable: runtime.ytdlp, startedAt: new Date().toISOString() })
          } catch (error) {
            this.deps.logger.warn(`Could not record the process of download ${id}`, error)
          }
        }
      )
      // The reported file must be inside the destination folder; anything else is ignored, so
      // "Show in folder" and "Move to Recycle Bin" can only ever act on files this job wrote.
      const reported = result.outputPath && (await isInside(result.outputPath, stored.destination)) ? result.outputPath : null
      if (result.outputPath && !reported) this.deps.logger.warn(`Download ${id} reported a file outside its folder; ignored: ${result.outputPath}`)
      const outputPath = reported ?? stored.destination
      const size = reported ? await fileSize(reported) : null
      this.attempts.delete(id)
      this.finish(job, {
        status: 'completed',
        progress: 100,
        outputPath,
        totalBytes: size ?? job.totalBytes,
        downloadedBytes: size ?? job.downloadedBytes,
        stage: null
      })
      this.deps.logger.info(`Completed download ${id}`)
    } catch (error) {
      // At shutdown the job was already saved as paused; its partial files stay.
      if (this.shuttingDown) {
        keepTemp = true
        return
      }
      const reason = this.stopReasons.get(id)
      if (error instanceof DownloadCancelled && reason === 'pause') {
        keepTemp = true
        this.finish(job, { status: 'paused', stage: null, interrupted: false })
        this.deps.logger.info(`Paused download ${id}`)
      } else if (error instanceof DownloadCancelled) {
        this.finish(job, { status: 'cancelled', stage: null })
        this.deps.logger.info(`Cancelled download ${id}`)
      } else if (error instanceof DownloadFailure) {
        keepTemp = true // a manual retry continues from the partial files
        if (error.code === 'NETWORK' && this.scheduleRetry(job)) return
        this.finish(job, { status: 'failed', stage: null, error: error.message, errorCode: error.code })
      } else if (error instanceof AppError && error.code === 'ENGINE_MISSING') {
        keepTemp = true
        this.finish(job, { status: 'failed', stage: null, error: error.message, errorCode: 'ENGINE_MISSING' })
      } else {
        this.deps.logger.error(`Download ${id} failed unexpectedly`, error)
        this.finish(job, {
          status: 'failed',
          stage: null,
          error: 'The download failed unexpectedly. Details were written to the log file.',
          errorCode: 'UNKNOWN'
        })
      }
    } finally {
      release?.()
      this.running.delete(id)
      this.stopReasons.delete(id)
      if (!keepTemp) await this.removeTemp(id)
      else await clearOwner(tempDir).catch(() => {})
      this.pump()
    }
  }

  /**
   * After a network failure, waits and queues the job again (its partial files
   * are continued). Returns false when the retries are used up.
   */
  private scheduleRetry(job: DownloadJob): boolean {
    const max = this.deps.settings().maxRetries
    const attempt = (this.attempts.get(job.id) ?? 0) + 1
    if (attempt > max) return false
    this.attempts.set(job.id, attempt)
    const delay = Math.min(RETRY_MAX_DELAY_MS, (this.deps.retryBaseDelayMs ?? 5000) * 3 ** (attempt - 1))
    this.update(
      job,
      {
        status: 'queued',
        speed: 0,
        eta: 0,
        stage: `Connection problem — retrying in ${Math.round(delay / 1000)} s (attempt ${attempt} of ${max})`
      },
      true
    )
    this.deps.repository.update(job, this.now())
    this.deps.logger.warn(`Download ${job.id} hit a network error; retry ${attempt} of ${max} in ${delay} ms`)
    const timer = setTimeout(() => {
      this.retryTimers.delete(job.id)
      if (job.status !== 'queued' || this.shuttingDown) return
      this.update(job, { stage: 'Retrying' }, true)
      this.queue.push(job.id)
      this.pump()
    }, delay)
    timer.unref?.()
    this.retryTimers.set(job.id, timer)
    return true
  }

  /** Takes a job out of the queue or its retry wait. Returns whether it was waiting. */
  private leaveQueue(id: string): boolean {
    const timer = this.retryTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(id)
    }
    const index = this.queue.indexOf(id)
    if (index !== -1) this.queue.splice(index, 1)
    return Boolean(timer) || index !== -1
  }

  private requirePlan(id: string): StoredPlan {
    const stored = this.plans.get(id) ?? this.deps.repository.get(id)?.stored ?? null
    if (!stored) throw new AppError('NOT_FOUND', 'This download cannot be restarted. Analyse the link again.')
    this.plans.set(id, stored)
    return stored
  }

  private forget(id: string): void {
    this.jobs.delete(id)
    this.plans.delete(id)
    this.attempts.delete(id)
    this.lastEmit.delete(id)
    this.events.emit('removed', id)
  }

  private async removeTemp(id: string): Promise<void> {
    const dir = join(this.deps.tempRoot, id)
    await rm(dir, { recursive: true, force: true }).catch((error: unknown) => this.deps.logger.warn(`Could not remove ${dir}`, error))
  }

  private onProgress(job: DownloadJob, progress: AggregateProgress): void {
    if (job.status !== 'downloading' && job.status !== 'processing') return
    if (this.stopReasons.has(job.id)) return // keep "Pausing…" / "Cancelling…" visible
    // Byte counters are throttled; a change of phase or step is always delivered.
    const transition = progress.phase !== job.status || progress.stage !== job.stage
    this.update(
      job,
      {
        status: progress.phase,
        progress: progress.progress,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes ?? job.totalBytes,
        speed: progress.speed,
        eta: progress.eta,
        stage: progress.stage
      },
      transition
    )
  }

  private finish(job: DownloadJob, changes: Partial<DownloadJob>): void {
    if (this.shuttingDown) return
    this.update(
      job,
      { speed: 0, eta: 0, ...changes, completedAt: changes.status === 'completed' ? this.now().toISOString() : null },
      true
    )
    this.deps.repository.update(job, this.now())
  }

  private update(job: DownloadJob, changes: Partial<DownloadJob>, force = false): void {
    Object.assign(job, changes)
    this.emit(job, force)
  }

  private emit(job: DownloadJob, force: boolean): void {
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(job.id) ?? 0) < UPDATE_INTERVAL_MS) return
    this.lastEmit.set(job.id, now)
    this.events.emit('changed', { ...job })
  }

  private require(id: string): DownloadJob {
    const job = this.jobs.get(id)
    if (!job) throw new AppError('NOT_FOUND', 'This download no longer exists.')
    return job
  }
}

async function fileSize(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size
  } catch {
    return null
  }
}

/** Whether `path` (after resolving links) is a file inside `folder`. */
async function isInside(path: string, folder: string): Promise<boolean> {
  try {
    const [file, base] = await Promise.all([realpath(path), realpath(folder)])
    const inside = relative(base, file)
    return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
