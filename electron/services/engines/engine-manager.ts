import { EventEmitter } from 'node:events'
import { access, chmod, constants, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  EngineId,
  EngineProblem,
  EngineProviderInfo,
  EngineStatus,
  EnginesSnapshot,
  InstallProgress,
  InstallTarget
} from '@shared/types/engines'
import type { Unsubscribe } from '@shared/types/ipc'
import { sha256File } from '../../utils/checksum'
import { AppError, toIpcError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import type { EngineVersionsRepository } from '../storage/engine-versions.repository'
import type { EngineRuntime } from '../media/ytdlp-command'
import type { UpdateHistoryRepository } from '../storage/update-history.repository'
import { incompatibilityReason, inspectBinary } from './binary-format'
import { UpdateRolledBack, type EngineInstaller, type InstalledEngine, type InstallProgressUpdate } from './engine-installer'
import { locateEngine, locateFfmpegToolchain, type EngineLocations, type LocatedEngine } from './engine-locator'
import type { EngineManifest, EngineManifestStore, ManifestEntry } from './engine-manifest'
import type { EngineProber, ProbeResult } from './engine-probe'
import type { PlatformTarget } from './platform'
import type { YtDlpChannel } from './ytdlp-engine'

export interface EngineManagerDeps {
  target: PlatformTarget
  locations: EngineLocations
  prober: EngineProber
  installer: EngineInstaller
  manifest: EngineManifestStore
  versions: EngineVersionsRepository
  history: UpdateHistoryRepository
  providers: Record<InstallTarget, EngineProviderInfo | null>
  logger: Logger
  /** The yt-dlp release channel to install from (Settings → Updates). */
  ytdlpChannel?: () => YtDlpChannel
}

const ENGINE_IDS: readonly EngineId[] = ['yt-dlp', 'ffmpeg', 'ffprobe', 'deno']
const TARGET_ENGINES: Record<InstallTarget, EngineId[]> = {
  'yt-dlp': ['yt-dlp'],
  ffmpeg: ['ffmpeg', 'ffprobe'],
  deno: ['deno']
}
const PROGRESS_INTERVAL_MS = 200
const INSTALL_TARGETS: readonly InstallTarget[] = ['yt-dlp', 'ffmpeg', 'deno']

/**
 * Single owner of engine state. Detection and installation are serialised so a
 * binary is never replaced while it is being probed, and engines leased by
 * running jobs cannot be replaced at all.
 */
export class EngineManager {
  private statuses: Record<EngineId, EngineStatus>
  private initialized = false
  private checking = false
  private install: InstallProgress | null = null
  private installAbort: AbortController | null = null
  private readonly leases = new Map<EngineId, number>()
  private readonly events = new EventEmitter()
  private queue: Promise<unknown> = Promise.resolve()
  private lastProgressEmit = 0
  private rollback: Record<InstallTarget, string | null> = { 'yt-dlp': null, ffmpeg: null, deno: null }
  private markReady: () => void = () => {}
  /** Resolves once the first detection after startup has finished. */
  private readonly ready = new Promise<void>((resolve) => {
    this.markReady = resolve
  })

  constructor(private readonly deps: EngineManagerDeps) {
    this.statuses = Object.fromEntries(ENGINE_IDS.map((id) => [id, emptyStatus(id, 'checking')])) as Record<
      EngineId,
      EngineStatus
    >
  }

  snapshot(): EnginesSnapshot {
    const { target, locations, providers } = this.deps
    return {
      target: target.key,
      platform: target.platform,
      arch: target.arch,
      initialized: this.initialized,
      checking: this.checking,
      enginesDir: locations.managed,
      engines: structuredClone(this.statuses),
      providers: { ...providers },
      install: this.install ? { ...this.install } : null,
      rollback: { ...this.rollback },
      inUse: INSTALL_TARGETS.filter((target) => this.isInUse(target))
    }
  }

  /** Whether downloads or conversions are using any engine of `target`. */
  isInUse(target: InstallTarget): boolean {
    return TARGET_ENGINES[target].some((engine) => (this.leases.get(engine) ?? 0) > 0)
  }

  /** Install records of the managed engines (provider, source, version). */
  installRecords(): Promise<EngineManifest> {
    return this.deps.manifest.read()
  }

  /** Whether an install, update or rollback is running. */
  isBusy(): boolean {
    return this.installAbort !== null
  }

  onChanged(listener: (snapshot: EnginesSnapshot) => void): Unsubscribe {
    this.events.on('changed', listener)
    return () => this.events.off('changed', listener)
  }

  /** Startup: repair interrupted installs, then detect every engine. */
  initialize(): Promise<EnginesSnapshot> {
    return this.exclusive(async () => {
      try {
        await this.deps.installer.recoverInterruptedInstalls()
      } catch (error) {
        this.deps.logger.error('Recovering interrupted engine installs failed', error)
      }
      try {
        await this.detect(false)
      } finally {
        // Even if detection failed, waiting callers must not hang: they get a clear error from runtime().
        this.initialized = true
        this.markReady()
      }
      this.emit()
      return this.snapshot()
    })
  }

  refresh(deep: boolean): Promise<EnginesSnapshot> {
    return this.exclusive(async () => {
      await this.detect(deep)
      return this.snapshot()
    })
  }

  /**
   * Like `runtime()`, but waits for the first detection after startup to
   * finish instead of failing, so a link pasted right after launch just works.
   */
  async waitForRuntime(timeoutMs = 120_000): Promise<EngineRuntime> {
    await this.waitUntilReady(timeoutMs)
    return this.runtime()
  }

  /** FFmpeg and FFprobe (always from the same build), for the audio converter. */
  async waitForToolchain(timeoutMs = 120_000): Promise<{ ffmpeg: string; ffprobe: string }> {
    await this.waitUntilReady(timeoutMs)
    if (!this.initialized) {
      throw new AppError('BUSY', 'The media engines are still being checked. Try again in a moment.')
    }
    const ffmpeg = this.executablePath('ffmpeg')
    const ffprobe = this.executablePath('ffprobe')
    if (!ffmpeg || !ffprobe) {
      throw new AppError('ENGINE_MISSING', 'FFmpeg is not installed or not working. Set it up in Software Updates.')
    }
    return { ffmpeg, ffprobe }
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    if (this.initialized) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.ready,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      })
    ])
    clearTimeout(timer)
  }

  /**
   * Engine locations for running yt-dlp. FFmpeg is passed by folder; FFprobe
   * lives next to it because the toolchain is always resolved as a pair.
   */
  runtime(): EngineRuntime {
    if (!this.initialized) {
      throw new AppError('BUSY', 'The media engines are still being checked. Try again in a moment.')
    }
    const ytdlp = this.executablePath('yt-dlp')
    if (!ytdlp) {
      throw new AppError('ENGINE_MISSING', 'yt-dlp is not installed or not working. Set it up in Software Updates.')
    }
    const ffmpeg = this.executablePath('ffmpeg')
    const ffprobe = this.executablePath('ffprobe')
    return {
      ytdlp,
      ffmpegLocation: ffmpeg && ffprobe ? dirname(ffmpeg) : null,
      deno: this.executablePath('deno'),
      ytdlpVersion: this.statuses['yt-dlp'].version
    }
  }

  /** Path of a usable engine, or null if it is missing or broken. */
  executablePath(engine: EngineId): string | null {
    const status = this.statuses[engine]
    return status.health === 'ok' || status.health === 'degraded' ? status.path : null
  }

  /**
   * Marks engines as in use for the lifetime of a job (download, conversion).
   * Installs refuse to replace leased engines. Call the returned function when done.
   */
  acquire(engines: readonly EngineId[]): () => void {
    for (const engine of engines) this.leases.set(engine, (this.leases.get(engine) ?? 0) + 1)
    this.events.emit('leases')
    let released = false
    return () => {
      if (released) return
      released = true
      for (const engine of engines) this.leases.set(engine, Math.max(0, (this.leases.get(engine) ?? 1) - 1))
      this.events.emit('leases')
    }
  }

  /** Called whenever engines are taken or released by jobs (for deferred updates). */
  onLeasesChanged(listener: () => void): Unsubscribe {
    this.events.on('leases', listener)
    return () => this.events.off('leases', listener)
  }

  async installTarget(target: InstallTarget): Promise<EnginesSnapshot> {
    if (this.installAbort) {
      throw new AppError('BUSY', 'Another installation is already in progress.')
    }
    if (!this.deps.providers[target]) {
      throw new AppError('UNSUPPORTED', 'No trusted build of this engine is available for your platform.')
    }
    const affected = TARGET_ENGINES[target]
    if (affected.some((engine) => (this.leases.get(engine) ?? 0) > 0)) {
      throw new AppError('BUSY', 'This engine is in use. Finish or cancel active downloads and conversions first.')
    }

    const abort = new AbortController()
    this.installAbort = abort
    this.install = { target, stage: 'resolving', receivedBytes: 0, totalBytes: null, version: null, error: null }
    this.emit()

    return this.exclusive(async () => {
      const previous = Object.fromEntries(affected.map((id) => [id, this.statuses[id].version])) as Record<
        EngineId,
        string | null
      >
      this.deps.logger.info(`Installing ${target}`)
      try {
        const onProgress = (update: InstallProgressUpdate): void => this.onInstallProgress(target, update)
        const installers: Record<InstallTarget, () => Promise<InstalledEngine[]>> = {
          'yt-dlp': () => this.deps.installer.installYtDlp(abort.signal, onProgress, this.deps.ytdlpChannel?.() ?? 'stable'),
          ffmpeg: () => this.deps.installer.installFfmpegToolchain(abort.signal, onProgress),
          deno: () => this.deps.installer.installDeno(abort.signal, onProgress)
        }
        const installed = await installers[target]()

        for (const engine of installed) {
          this.deps.history.record({
            component: engine.id,
            previousVersion: previous[engine.id] ?? null,
            newVersion: engine.version,
            status: 'success'
          })
          this.deps.logger.info(`Installed ${engine.id} ${engine.version} at ${engine.path}`)
        }
        this.install = { ...this.install!, stage: 'completed', version: installed[0]?.version ?? null }
      } catch (error) {
        const ipcError = toIpcError(error)
        const cancelled = ipcError.code === 'CANCELLED' || abort.signal.aborted
        this.install = {
          ...this.install!,
          stage: cancelled ? 'cancelled' : 'failed',
          error: cancelled ? null : ipcError.message
        }
        if (cancelled) {
          this.deps.logger.info(`Installation of ${target} cancelled`)
        } else {
          this.deps.logger.error(`Installation of ${target} failed`, error)
          for (const engine of affected) {
            this.deps.history.record({
              component: engine,
              previousVersion: previous[engine] ?? null,
              newVersion: this.install.version,
              // The new version was installed, failed its check in place, and the previous one was put back.
              status: error instanceof UpdateRolledBack ? 'rolled_back' : 'failed',
              errorMessage: ipcError.message
            })
          }
        }
        throw cancelled ? new AppError('CANCELLED', 'The installation was cancelled.', { cause: error }) : error
      } finally {
        this.installAbort = null
        // Re-detect whatever is now on disk. Failures are logged by detect() and must not mask the install result.
        await this.detect(false).catch(() => {})
      }
      return this.snapshot()
    })
  }

  /**
   * Restores the version kept from before the last update of `target`. The
   * replaced version is kept in turn, so the rollback can be undone.
   */
  async rollbackTarget(target: InstallTarget): Promise<EnginesSnapshot> {
    if (this.installAbort) throw new AppError('BUSY', 'Another installation is already in progress.')
    if (this.isInUse(target)) {
      throw new AppError('BUSY', 'This engine is in use. Finish or cancel active downloads and conversions first.')
    }
    const abort = new AbortController()
    this.installAbort = abort
    this.install = { target, stage: 'installing', receivedBytes: 0, totalBytes: null, version: this.rollback[target], error: null }
    this.emit()
    return this.exclusive(async () => {
      const affected = TARGET_ENGINES[target]
      const previous = Object.fromEntries(affected.map((id) => [id, this.statuses[id].version])) as Record<EngineId, string | null>
      try {
        const restored = await this.deps.installer.rollback(target)
        for (const engine of restored) {
          this.deps.history.record({ component: engine.id, previousVersion: previous[engine.id] ?? null, newVersion: engine.version, status: 'rolled_back' })
          this.deps.logger.info(`Rolled back ${engine.id} from ${previous[engine.id] ?? 'unknown'} to ${engine.version}`)
        }
        this.install = { ...this.install!, stage: 'completed', version: restored[0]?.version ?? null }
      } catch (error) {
        const ipcError = toIpcError(error)
        this.install = { ...this.install!, stage: 'failed', error: ipcError.message }
        this.deps.logger.error(`Rolling back ${target} failed`, error)
        for (const engine of affected) {
          this.deps.history.record({ component: engine, previousVersion: previous[engine] ?? null, newVersion: this.rollback[target], status: 'failed', errorMessage: ipcError.message })
        }
        throw error
      } finally {
        this.installAbort = null
        await this.detect(false).catch(() => {})
      }
      return this.snapshot()
    })
  }

  cancelInstall(): void {
    this.installAbort?.abort()
  }

  dispose(): void {
    this.installAbort?.abort()
    this.events.removeAllListeners()
  }

  private onInstallProgress(target: InstallTarget, update: InstallProgressUpdate): void {
    this.install = { target, ...update, error: null }
    const now = Date.now()
    // Byte counters arrive per network chunk; stage changes are always forwarded.
    if (update.stage !== 'downloading' || now - this.lastProgressEmit >= PROGRESS_INTERVAL_MS) {
      this.lastProgressEmit = now
      this.emit()
    }
  }

  private async detect(deep: boolean): Promise<void> {
    const { locations, target, prober, logger } = this.deps
    this.checking = true
    this.emit()
    try {
      const manifest = await this.deps.manifest.read()
      const [ytdlp, toolchain, deno] = await Promise.all([
        locateEngine('yt-dlp', locations, target.platform),
        locateFfmpegToolchain(locations, target.platform),
        locateEngine('deno', locations, target.platform)
      ])
      const [ytdlpStatus, ffmpegStatus, ffprobeStatus, denoStatus] = await Promise.all([
        this.evaluate('yt-dlp', ytdlp, manifest.engines['yt-dlp'], deep, (p) => prober.probeYtDlp(p)),
        this.evaluate('ffmpeg', toolchain.ffmpeg, manifest.engines.ffmpeg, deep, (p) => prober.probeFfmpeg(p)),
        this.evaluate('ffprobe', toolchain.ffprobe, manifest.engines.ffprobe, deep, (p) => prober.probeFfprobe(p)),
        this.evaluate('deno', deno, manifest.engines.deno, deep, (p) => prober.probeDeno(p))
      ])

      const ffmpegBuild = ffmpegStatus.build ?? ffmpegStatus.version
      const ffprobeBuild = ffprobeStatus.build ?? ffprobeStatus.version
      if (isUsable(ffmpegStatus) && isUsable(ffprobeStatus) && ffmpegBuild !== ffprobeBuild) {
        const problem: EngineProblem = {
          code: 'TOOLCHAIN_MISMATCH',
          message: `FFmpeg (${ffmpegBuild}) and FFprobe (${ffprobeBuild}) are different builds. Reinstall them together.`
        }
        for (const status of [ffmpegStatus, ffprobeStatus]) {
          status.problems.push(problem)
          status.health = 'degraded'
        }
      }

      this.statuses = { 'yt-dlp': ytdlpStatus, ffmpeg: ffmpegStatus, ffprobe: ffprobeStatus, deno: denoStatus }
      for (const target of INSTALL_TARGETS) {
        const kept = await this.deps.installer.rollbackInfo(target)
        const managed = TARGET_ENGINES[target].every((id) => this.statuses[id].source === 'managed')
        this.rollback[target] = kept && managed ? (kept.entries[TARGET_ENGINES[target][0]!]?.version ?? null) : null
      }
      for (const status of Object.values(this.statuses)) {
        this.deps.versions.setInstalledVersion(status.id, status.version)
        logger.info(
          `Engine ${status.id}: ${status.health}` +
            (status.version ? ` ${status.version}` : '') +
            (status.source ? ` (${status.source}: ${status.path})` : '') +
            (status.problems.length > 0 ? ` — ${status.problems.map((p) => p.code).join(', ')}` : '')
        )
      }
    } catch (error) {
      logger.error('Engine detection failed', error)
      throw error
    } finally {
      this.checking = false
      this.emit()
    }
  }

  private async evaluate(
    id: EngineId,
    located: LocatedEngine | null,
    record: ManifestEntry | undefined,
    deep: boolean,
    probe: (path: string) => Promise<ProbeResult>
  ): Promise<EngineStatus> {
    const checkedAt = new Date().toISOString()
    if (!located) {
      return { ...emptyStatus(id, 'missing'), checkedAt, problems: [{ code: 'NOT_FOUND', message: 'Not installed.' }] }
    }
    const base = { ...emptyStatus(id, 'broken'), source: located.source, path: located.path, checkedAt }
    const broken = (problem: EngineProblem): EngineStatus => ({ ...base, problems: [problem] })
    const { platform, arch } = this.deps.target

    try {
      const reason = incompatibilityReason(await inspectBinary(located.path), platform, arch)
      if (reason) return broken({ code: 'INCOMPATIBLE_BINARY', message: reason })
    } catch {
      return broken({ code: 'NOT_EXECUTABLE', message: 'The file could not be read.' })
    }

    if (platform !== 'win32' && !(await this.ensureExecutable(located))) {
      return broken({ code: 'NOT_EXECUTABLE', message: 'The file does not have permission to run.' })
    }

    if (located.source === 'managed' && record) {
      const mismatch = await this.integrityProblem(located.path, record, deep)
      if (mismatch) return broken(mismatch)
    }

    const result = await probe(located.path)
    if (!result.ok) return broken(result.problem)
    return {
      ...base,
      health: result.problems.length > 0 ? 'degraded' : 'ok',
      version: result.version.version,
      build: result.version.build !== result.version.version ? result.version.build : null,
      problems: result.problems
    }
  }

  /** Managed binaries without execute permission are ours, so the permission is restored. */
  private async ensureExecutable(located: LocatedEngine): Promise<boolean> {
    try {
      await access(located.path, constants.X_OK)
      return true
    } catch {
      if (located.source !== 'managed') return false
      try {
        await chmod(located.path, 0o755)
        this.deps.logger.warn(`Restored execute permission on ${located.path}`)
        return true
      } catch {
        return false
      }
    }
  }

  private async integrityProblem(path: string, record: ManifestEntry, deep: boolean): Promise<EngineProblem | null> {
    const problem: EngineProblem = {
      code: 'INTEGRITY_MISMATCH',
      message: 'The file has changed since it was installed. Reinstall to repair it.'
    }
    if ((await stat(path)).size !== record.size) return problem
    if (deep && (await sha256File(path)) !== record.sha256) return problem
    return null
  }

  private emit(): void {
    this.events.emit('changed', this.snapshot())
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => {})
    return run
  }
}

function emptyStatus(id: EngineId, health: EngineStatus['health']): EngineStatus {
  return { id, health, version: null, build: null, source: null, path: null, problems: [], checkedAt: null }
}

function isUsable(status: EngineStatus): boolean {
  return status.health === 'ok' || status.health === 'degraded'
}
