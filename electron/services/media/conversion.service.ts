import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { access, mkdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { ConversionJob, ConversionRequest, ConverterInput, PickedFolder } from '@shared/types/converter'
import type { Unsubscribe } from '@shared/types/ipc'
import type { AppSettings } from '@shared/types/settings'
import { MAX_CONVERSION_INPUTS } from '@shared/validation/converter'
import { AppError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import type { ProcessRunner } from '../../utils/process'
import { killProcessTree } from '../../utils/process-tree'
import {
  FfmpegProgressParser,
  buildConversionArgs,
  classifyFfmpegError,
  outputBaseName,
  parseProbe,
  probeArgs,
  uniqueOutputPath,
  verifyOutput,
  type ProbeInfo
} from './conversion-plan'

export type SpawnFn = (file: string, args: readonly string[]) => ChildProcess
export type KillFn = (child: ChildProcess) => Promise<void>

export interface ConversionServiceDeps {
  /** Paired FFmpeg/FFprobe paths; throws ENGINE_MISSING when unavailable. */
  toolchain: () => Promise<{ ffmpeg: string; ffprobe: string }>
  acquire: (engines: ('ffmpeg' | 'ffprobe')[]) => () => void
  run: ProcessRunner
  /** Native dialogs; return absolute paths chosen by the user. */
  dialogs: { pickFiles(): Promise<string[]>; pickFolder(): Promise<string | null> }
  settings: () => AppSettings
  defaultDownloadDir: string
  logger: Logger
  spawn?: SpawnFn
  kill?: KillFn
  now?: () => Date
}

interface PickedFile {
  input: ConverterInput
  path: string
  probe: ProbeInfo | null
}

interface JobState {
  job: ConversionJob
  input: PickedFile
  format: ConversionRequest['format']
  quality: ConversionRequest['quality']
  outputDir: string
  child: ChildProcess | null
  cancelled: boolean
}

const ACTIVE = new Set<ConversionJob['status']>(['queued', 'converting'])
const PROBE_CONCURRENCY = 3
const STDERR_TAIL = 60
const EMIT_INTERVAL_MS = 250
const MAX_PICKED = 1000

const defaultSpawn: SpawnFn = (file, args) =>
  spawn(file, [...args], {
    shell: false,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  })

/**
 * Converts local audio and video files to MP3, M4A, WAV, FLAC or OPUS with
 * FFmpeg, one file at a time. Files and folders come only from native dialogs
 * and are referred to by tokens, so the renderer never supplies a path.
 */
export class ConversionService {
  private readonly picked = new Map<string, PickedFile>()
  private readonly folders = new Map<string, string>()
  private readonly jobs = new Map<string, JobState>()
  private readonly queue: string[] = []
  private running: string | null = null
  private readonly events = new EventEmitter()
  private readonly lastEmit = new Map<string, number>()
  private readonly spawn: SpawnFn
  private readonly kill: KillFn
  private readonly now: () => Date
  private shuttingDown = false

  constructor(private readonly deps: ConversionServiceDeps) {
    this.spawn = deps.spawn ?? defaultSpawn
    this.kill = deps.kill ?? ((child) => killProcessTree(child))
    this.now = deps.now ?? (() => new Date())
  }

  onChanged(listener: (job: ConversionJob) => void): Unsubscribe {
    this.events.on('changed', listener)
    return () => this.events.off('changed', listener)
  }

  onRemoved(listener: (id: string) => void): Unsubscribe {
    this.events.on('removed', listener)
    return () => this.events.off('removed', listener)
  }

  list(): ConversionJob[] {
    return [...this.jobs.values()].map((s) => ({ ...s.job })).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** Opens the file picker and inspects every chosen file with FFprobe. */
  async pickFiles(): Promise<ConverterInput[]> {
    // Checked first, so nobody picks files only to learn FFmpeg is missing.
    const { ffprobe } = await this.deps.toolchain()
    const paths = (await this.deps.dialogs.pickFiles()).slice(0, MAX_CONVERSION_INPUTS)
    if (paths.length === 0) return []
    const release = this.deps.acquire(['ffprobe'])
    try {
      const results: ConverterInput[] = new Array(paths.length)
      let next = 0
      const worker = async (): Promise<void> => {
        for (let i = next++; i < paths.length; i = next++) {
          const path = paths[i]
          if (path) results[i] = await this.inspect(ffprobe, path)
        }
      }
      await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker))
      return results
    } finally {
      release()
    }
  }

  async chooseFolder(): Promise<PickedFolder | null> {
    const path = await this.deps.dialogs.pickFolder()
    if (!path) return null
    const token = randomUUID()
    this.folders.set(token, path)
    return { token, path }
  }

  async start(request: ConversionRequest): Promise<ConversionJob[]> {
    const inputs = request.inputs.map((token) => {
      const file = this.picked.get(token)
      if (!file) throw new AppError('NOT_FOUND', 'A selected file is no longer available. Add it again.')
      if (!file.probe?.source) throw new AppError('VALIDATION_FAILED', `${file.input.name} has no audio that can be converted.`)
      return file
    })
    await this.deps.toolchain() // fail early with a clear message when FFmpeg is missing

    let custom: string | null = null
    if (request.destination.kind === 'custom') {
      custom = this.folders.get(request.destination.token) ?? null
      if (!custom) throw new AppError('NOT_FOUND', 'The chosen output folder is no longer available. Choose it again.')
    }
    const base = this.deps.settings().downloadDirectory ?? this.deps.defaultDownloadDir

    const created: ConversionJob[] = []
    // One timestamp per batch, so lists sorted newest-first keep the batch in the order picked.
    const createdAt = this.now().toISOString()
    for (const input of inputs) {
      const outputDir = request.destination.kind === 'source' ? dirname(input.path) : (custom ?? base)
      const job: ConversionJob = {
        id: randomUUID(),
        inputName: input.input.name,
        format: request.format,
        qualityLabel: '',
        status: 'queued',
        progress: 0,
        speed: null,
        eta: null,
        durationSeconds: input.probe?.durationSeconds ?? null,
        outputPath: null,
        outputSizeBytes: null,
        error: null,
        createdAt,
        completedAt: null
      }
      this.jobs.set(job.id, { job, input, format: request.format, quality: request.quality, outputDir, child: null, cancelled: false })
      this.queue.push(job.id)
      this.emit(job, true)
      created.push({ ...job })
    }
    this.deps.logger.info(`Queued ${created.length} conversion(s) to ${request.format}`)
    this.pump()
    return created
  }

  async cancel(id: string): Promise<void> {
    const state = this.require(id)
    const queued = this.queue.indexOf(id)
    if (queued !== -1) {
      this.queue.splice(queued, 1)
      this.update(state, { status: 'cancelled', speed: null, eta: null }, true)
      return
    }
    if (state.job.status === 'converting') {
      state.cancelled = true
      if (state.child) await this.kill(state.child)
    }
  }

  /** Removes a finished job from the list. Files are not touched. */
  remove(id: string): void {
    const state = this.require(id)
    if (ACTIVE.has(state.job.status)) throw new AppError('BUSY', 'Cancel the conversion before removing it.')
    this.jobs.delete(id)
    this.events.emit('removed', id)
  }

  /** Where "Show in folder" should point: the converted file, or the output folder. */
  location(id: string): string {
    const state = this.require(id)
    return state.job.outputPath ?? state.outputDir
  }

  hasActiveJobs(): boolean {
    return [...this.jobs.values()].some((s) => ACTIVE.has(s.job.status))
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    this.queue.length = 0
    const running = this.running ? this.jobs.get(this.running) : null
    if (running) {
      running.cancelled = true
      if (running.child) await this.kill(running.child)
    }
    this.events.removeAllListeners()
  }

  private async inspect(ffprobe: string, path: string): Promise<ConverterInput> {
    const token = randomUUID()
    const input: ConverterInput = { token, name: basename(path), path, sizeBytes: 0, durationSeconds: null, source: null, error: null }
    let probe: ProbeInfo | null = null
    try {
      const info = await stat(path)
      if (!info.isFile()) throw new AppError('VALIDATION_FAILED', 'This is not a file.')
      input.sizeBytes = info.size
      if (info.size === 0) throw new AppError('VALIDATION_FAILED', 'This file is empty.')
      const result = await this.deps.run(ffprobe, probeArgs(path), { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 })
      if (result.exitCode !== 0) throw new AppError('VALIDATION_FAILED', classifyFfmpegError(result.stderr))
      probe = parseProbe(JSON.parse(result.stdout))
      input.durationSeconds = probe.durationSeconds
      input.source = probe.source
      if (!probe.source) input.error = 'This file has no audio to convert.'
    } catch (error) {
      input.error = error instanceof AppError ? error.message : 'This file could not be read as audio or video.'
      if (!(error instanceof AppError)) this.deps.logger.warn(`Could not inspect ${path}`, error)
    }
    this.picked.set(token, { input, path, probe })
    while (this.picked.size > MAX_PICKED) {
      const oldest = this.picked.keys().next().value
      if (oldest === undefined) break
      this.picked.delete(oldest)
    }
    return input
  }

  /** One conversion at a time: FFmpeg already uses several cores per file. */
  private pump(): void {
    if (this.running || this.shuttingDown) return
    const id = this.queue.shift()
    if (!id) return
    this.running = id
    void this.run(id).finally(() => {
      this.running = null
      this.pump()
    })
  }

  private async run(id: string): Promise<void> {
    const state = this.jobs.get(id)
    if (!state?.input.probe) return
    const { input, format, quality, outputDir } = state
    const probe = input.probe!
    let release: (() => void) | null = null
    let temp: string | null = null
    this.update(state, { status: 'converting', progress: 0 }, true)

    try {
      const { ffmpeg, ffprobe } = await this.deps.toolchain()
      release = this.deps.acquire(['ffmpeg', 'ffprobe'])
      await mkdir(outputDir, { recursive: true })
      const base = outputBaseName(input.path)
      // FFmpeg chooses the muxer from the extension, so the temporary name keeps it.
      temp = join(outputDir, `${base}.mediaflow-${id.slice(0, 8)}.${format}`)
      const plan = buildConversionArgs(input.path, temp, format, quality, probe)
      this.update(state, { qualityLabel: plan.qualityLabel }, true)
      this.deps.logger.info(`Converting ${input.input.name} to ${format} (${plan.qualityLabel})`)

      await this.runFfmpeg(state, ffmpeg, plan.args, probe.durationSeconds)

      const check = await this.deps.run(ffprobe, probeArgs(temp), { timeoutMs: 30_000, maxOutputBytes: 4 * 1024 * 1024 })
      const problem = check.exitCode === 0 ? verifyOutput(parseProbe(JSON.parse(check.stdout)), format, probe.durationSeconds) : 'The converted file could not be read back.'
      if (problem) throw new AppError('OPERATION_FAILED', problem)

      const final = await uniqueOutputPath(outputDir, base, format, exists, input.path)
      await rename(temp, final)
      temp = null
      const size = (await stat(final)).size
      this.update(state, {
        status: 'completed',
        progress: 100,
        speed: null,
        eta: 0,
        outputPath: final,
        outputSizeBytes: size,
        completedAt: this.now().toISOString()
      }, true)
      this.deps.logger.info(`Converted ${input.input.name} → ${final}`)
    } catch (error) {
      if (state.cancelled) {
        this.update(state, { status: 'cancelled', speed: null, eta: null }, true)
        this.deps.logger.info(`Cancelled conversion of ${input.input.name}`)
      } else {
        const message = error instanceof AppError ? error.message : 'The conversion failed unexpectedly. Details were written to the log file.'
        if (!(error instanceof AppError)) this.deps.logger.error(`Conversion of ${input.input.name} failed`, error)
        else this.deps.logger.warn(`Conversion of ${input.input.name} failed: ${message}`)
        this.update(state, { status: 'failed', speed: null, eta: null, error: message }, true)
      }
    } finally {
      release?.()
      state.child = null
      if (temp) await rm(temp, { force: true }).catch(() => {})
    }
  }

  private runFfmpeg(state: JobState, ffmpeg: string, args: string[], duration: number | null): Promise<void> {
    return new Promise((resolve, reject) => {
      if (state.cancelled) {
        reject(new AppError('CANCELLED', 'Cancelled'))
        return
      }
      const child = this.spawn(ffmpeg, args)
      state.child = child
      const parser = new FfmpegProgressParser()
      const stderr: string[] = []
      if (child.stdout) {
        createInterface({ input: child.stdout }).on('line', (line) => {
          const progress = parser.push(line)
          if (!progress || progress.done) return
          const elapsed = progress.outTimeSeconds
          const percent = duration && elapsed !== null ? Math.min(99.9, (elapsed / duration) * 100) : state.job.progress
          const eta = duration && elapsed !== null && progress.speed ? Math.max(0, (duration - elapsed) / progress.speed) : null
          this.update(state, { progress: Math.round(percent * 10) / 10, speed: progress.speed, eta: eta === null ? null : Math.round(eta) })
        })
      }
      if (child.stderr) {
        createInterface({ input: child.stderr }).on('line', (line) => {
          if (!line.trim()) return
          stderr.push(line)
          if (stderr.length > STDERR_TAIL) stderr.shift()
        })
      }
      child.once('error', (error) => reject(new AppError('ENGINE_MISSING', 'FFmpeg could not be started. Check Software Updates.', { cause: error })))
      child.once('close', (code) => {
        if (state.cancelled) reject(new AppError('CANCELLED', 'Cancelled'))
        else if (code === 0) resolve()
        else reject(new AppError('OPERATION_FAILED', classifyFfmpegError(stderr.join('\n'))))
      })
    })
  }

  private update(state: JobState, changes: Partial<ConversionJob>, force = false): void {
    Object.assign(state.job, changes)
    this.emit(state.job, force || changes.status !== undefined)
  }

  private emit(job: ConversionJob, force: boolean): void {
    if (this.shuttingDown) return
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(job.id) ?? 0) < EMIT_INTERVAL_MS) return
    this.lastEmit.set(job.id, now)
    this.events.emit('changed', { ...job })
  }

  private require(id: string): JobState {
    const state = this.jobs.get(id)
    if (!state) throw new AppError('NOT_FOUND', 'This conversion no longer exists.')
    return state
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
