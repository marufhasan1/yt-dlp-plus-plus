import { EventEmitter } from 'node:events'
import type { EngineId, EnginesSnapshot, InstallStage, InstallTarget } from '@shared/types/engines'
import type { Unsubscribe } from '@shared/types/ipc'
import type { AppSettings } from '@shared/types/settings'
import type { ComponentUpdate, UpdateComponentId, UpdateHistoryEntry, UpdatesSnapshot } from '@shared/types/updates'
import { AppError, toIpcError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import type { EngineManager } from '../engines/engine-manager'
import type { EngineVersionsRepository } from '../storage/engine-versions.repository'
import type { StoredCheck, UpdateChecksRepository } from '../storage/update-checks.repository'
import type { UpdateHistoryRepository } from '../storage/update-history.repository'
import { describeAppUpdateError, type AppRelease, type AppUpdateBackend } from './app-updater'
import { evaluateEngineUpdate, installedYtDlpChannel, type EngineChecker } from './engine-update-check'
import { compareVersions } from './versions'

export interface UpdateServiceDeps {
  engines: Pick<
    EngineManager,
    'snapshot' | 'onChanged' | 'onLeasesChanged' | 'isInUse' | 'isBusy' | 'installRecords' | 'installTarget' | 'rollbackTarget'
  >
  checkers: Partial<Record<InstallTarget, EngineChecker>>
  app: AppUpdateBackend
  appVersion: string
  checks: UpdateChecksRepository
  versions: Pick<EngineVersionsRepository, 'setLatestVersion'>
  history: Pick<UpdateHistoryRepository, 'record' | 'recent'>
  settings: () => AppSettings
  logger: Logger
  now?: () => Date
  /** Wait after startup before the first automatic check. */
  startupDelayMs?: number
  /** How often to see whether an automatic check is due. */
  tickMs?: number
}

const ENGINE_TARGETS: readonly InstallTarget[] = ['yt-dlp', 'ffmpeg', 'deno']
const COMPONENTS: readonly UpdateComponentId[] = ['app', ...ENGINE_TARGETS]
const PRIMARY: Record<InstallTarget, EngineId> = { 'yt-dlp': 'yt-dlp', ffmpeg: 'ffmpeg', deno: 'deno' }
const TARGET_ENGINES: Record<InstallTarget, EngineId[]> = { 'yt-dlp': ['yt-dlp'], ffmpeg: ['ffmpeg', 'ffprobe'], deno: ['deno'] }
const DOWNLOAD_STAGES: readonly InstallStage[] = ['resolving', 'downloading']
const INSTALL_STAGES: readonly InstallStage[] = ['verifying', 'extracting', 'installing']
const LABELS: Record<UpdateComponentId, string> = { app: 'YT-DLP++', 'yt-dlp': 'yt-dlp', ffmpeg: 'FFmpeg', deno: 'Deno' }

type AppPhase = 'idle' | 'downloading' | 'ready' | 'failed'

/** Set when the app update installer is started; checked at the next start. */
const PENDING_APP_UPDATE = 'updates.pendingAppUpdate'

/** A notice for the renderer, e.g. a new YT-DLP++ version found by an automatic check. */
export interface UpdateNotice {
  component: UpdateComponentId
  version: string
  kind: 'available' | 'updated' | 'failed'
  message: string | null
}

/**
 * Update checks and updates for the application and every engine: on demand,
 * on a schedule (Settings → Updates), deferred while engines are in use, with
 * history and rollback. Files are only touched through EngineManager, which
 * verifies everything it installs.
 */
export class UpdateService {
  private readonly stored = new Map<UpdateComponentId, StoredCheck>()
  private readonly checking = new Set<UpdateComponentId>()
  private readonly waiting = new Set<InstallTarget>()
  private readonly updated = new Set<UpdateComponentId>()
  private readonly failures = new Map<UpdateComponentId, string>()
  private appRelease: AppRelease | null = null
  private appPhase: AppPhase = 'idle'
  private appProgress: number | null = null
  private checkingAll = false
  private lastCheckedAll: string | null
  private startedAt: Date | null = null
  private timers: NodeJS.Timeout[] = []
  private unsubscribers: Unsubscribe[] = []
  private readonly events = new EventEmitter()
  private readonly now: () => Date
  /** Install records of managed engines (provider, source), refreshed after checks and installs. */
  private records: Awaited<ReturnType<EngineManager['installRecords']>> = { schemaVersion: 1, engines: {} }
  private refreshingRecords = false

  constructor(private readonly deps: UpdateServiceDeps) {
    this.now = deps.now ?? (() => new Date())
    for (const check of deps.checks.all()) this.stored.set(check.component, check)
    this.lastCheckedAll = deps.checks.lastCheckedAll()
    this.settlePendingAppUpdate()
  }

  /** An app update was installed before this start: record whether this is now the new version. */
  private settlePendingAppUpdate(): void {
    const pending = this.deps.checks.getState(PENDING_APP_UPDATE)
    if (!pending) return
    this.deps.checks.deleteState(PENDING_APP_UPDATE)
    try {
      const { from, to } = JSON.parse(pending) as { from: string; to: string }
      const succeeded = compareVersions(this.deps.appVersion, to) >= 0
      this.deps.history.record({
        component: 'app',
        previousVersion: from,
        newVersion: to,
        status: succeeded ? 'success' : 'failed',
        errorMessage: succeeded ? null : `Still running ${this.deps.appVersion}: the installer did not complete.`
      })
      if (succeeded) this.updated.add('app')
      this.deps.logger.info(succeeded ? `Updated YT-DLP++ from ${from} to ${to}` : `YT-DLP++ update to ${to} did not complete`)
    } catch (error) {
      this.deps.logger.warn('Unreadable pending app update record', error)
    }
  }

  /** Listens to engine changes and starts the automatic checks. */
  start(): void {
    this.startedAt = this.now()
    this.unsubscribers.push(
      this.deps.engines.onChanged((snapshot) => {
        this.emit()
        const install = snapshot.install
        const settled = !install || ['completed', 'failed', 'cancelled'].includes(install.stage)
        if (!snapshot.checking && settled) void this.refreshRecords()
      }),
      this.deps.engines.onLeasesChanged(() => this.runDeferred())
    )
    void this.refreshRecords()
    const startup = setTimeout(() => void this.tick(), this.deps.startupDelayMs ?? 20_000)
    const interval = setInterval(() => void this.tick(), this.deps.tickMs ?? 15 * 60_000)
    startup.unref?.()
    interval.unref?.()
    this.timers.push(startup, interval)
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer)
    this.timers = []
    for (const unsubscribe of this.unsubscribers) unsubscribe()
    this.unsubscribers = []
    this.deps.app.cancelDownload()
    this.events.removeAllListeners()
  }

  onChanged(listener: (snapshot: UpdatesSnapshot) => void): Unsubscribe {
    this.events.on('changed', listener)
    return () => this.events.off('changed', listener)
  }

  onNotice(listener: (notice: UpdateNotice) => void): Unsubscribe {
    this.events.on('notice', listener)
    return () => this.events.off('notice', listener)
  }

  private async refreshRecords(): Promise<void> {
    if (this.refreshingRecords) return
    this.refreshingRecords = true
    try {
      this.records = await this.deps.engines.installRecords()
      this.emit()
    } catch (error) {
      this.deps.logger.warn('Could not read the engine install records', error)
    } finally {
      this.refreshingRecords = false
    }
  }

  history(limit = 30): UpdateHistoryEntry[] {
    return this.deps.history.recent(limit)
  }

  // ─── Checks ─────────────────────────────────────────────────────────────────

  async check(component: UpdateComponentId): Promise<UpdatesSnapshot> {
    if (component === 'app') await this.checkApp()
    else await this.checkEngine(component)
    return this.snapshot()
  }

  /**
   * Checks everything. A scheduled check leaves out the engines when the user
   * turned engine checks off, and may then install a new yt-dlp (opt-in).
   */
  async checkAll(reason: 'manual' | 'scheduled' = 'manual'): Promise<UpdatesSnapshot> {
    if (this.checkingAll) return this.snapshot()
    this.checkingAll = true
    this.emit()
    const settings = this.deps.settings()
    const engines = reason === 'manual' || settings.checkEngineUpdates ? ENGINE_TARGETS : (['yt-dlp'] as const)
    try {
      await Promise.all([this.checkApp(reason), ...engines.map((target) => this.checkEngine(target))])
      this.lastCheckedAll = this.now().toISOString()
      this.deps.checks.setLastCheckedAll(this.lastCheckedAll)
      this.deps.logger.info(`Update check (${reason}) finished: ${this.summary()}`)
    } finally {
      this.checkingAll = false
      this.emit()
    }
    if (reason === 'scheduled' && settings.autoUpdateYtdlp) {
      const ytdlp = this.component('yt-dlp')
      if (ytdlp.state === 'available' && !ytdlp.systemCopy && !ytdlp.channelSwitch) {
        this.deps.logger.info(`Updating yt-dlp to ${ytdlp.latestVersion} automatically`)
        await this.updateEngine('yt-dlp').catch(() => {})
      }
    }
    return this.snapshot()
  }

  private async checkApp(reason: 'manual' | 'scheduled' = 'manual'): Promise<void> {
    if (this.deps.app.unavailableReason() || this.appPhase === 'downloading') return
    this.checking.add('app')
    this.failures.delete('app')
    this.emit()
    const checkedAt = this.now().toISOString()
    try {
      const release = await this.deps.app.check()
      const known = this.appRelease?.version
      this.appRelease = release
      // A downloaded update stays ready unless the check found a different version.
      if (!(this.appPhase === 'ready' && release?.version === known)) this.appPhase = 'idle'
      const result: StoredCheck = {
        component: 'app',
        latestVersion: release?.version ?? this.deps.appVersion,
        latestBuild: null,
        channel: null,
        releasedAt: release?.releasedAt ?? null,
        notesUrl: release?.notesUrl ?? null,
        checkedAt,
        errorMessage: null
      }
      this.deps.checks.saveResult(result)
      this.stored.set('app', result)
      if (release) {
        this.deps.logger.info(`YT-DLP++ ${release.version} is available (installed ${this.deps.appVersion})`)
        if (reason === 'scheduled' && release.version !== known && this.deps.settings().appUpdateNotifications) {
          this.events.emit('notice', { component: 'app', version: release.version, kind: 'available', message: null } satisfies UpdateNotice)
        }
      }
    } catch (error) {
      this.recordCheckFailure('app', describeAppUpdateError(error), checkedAt, error)
    } finally {
      this.checking.delete('app')
      this.emit()
    }
  }

  private async checkEngine(target: InstallTarget): Promise<void> {
    const checker = this.deps.checkers[target]
    if (!checker || this.checking.has(target)) return
    this.checking.add(target)
    this.failures.delete(target)
    this.emit()
    const checkedAt = this.now().toISOString()
    try {
      const candidate = await checker(this.deps.settings().ytdlpChannel)
      const result: StoredCheck = {
        component: target,
        latestVersion: candidate.version,
        latestBuild: candidate.build !== candidate.version ? candidate.build : null,
        channel: candidate.channel,
        releasedAt: candidate.releasedAt,
        notesUrl: candidate.notesUrl,
        checkedAt,
        errorMessage: null
      }
      this.deps.checks.saveResult(result)
      for (const engine of TARGET_ENGINES[target]) this.deps.versions.setLatestVersion(engine, candidate.version, checkedAt)
      this.stored.set(target, result)
      await this.refreshRecords()
    } catch (error) {
      this.recordCheckFailure(target, toIpcError(error).message, checkedAt, error)
    } finally {
      this.checking.delete(target)
      this.emit()
    }
  }

  private recordCheckFailure(component: UpdateComponentId, message: string, checkedAt: string, error: unknown): void {
    this.deps.logger.warn(`Update check for ${component} failed: ${message}`, error)
    this.deps.checks.saveFailure(component, message, checkedAt)
    const previous = this.stored.get(component)
    this.stored.set(component, {
      component,
      latestVersion: previous?.latestVersion ?? null,
      latestBuild: previous?.latestBuild ?? null,
      channel: previous?.channel ?? null,
      releasedAt: previous?.releasedAt ?? null,
      notesUrl: previous?.notesUrl ?? null,
      checkedAt,
      errorMessage: message
    })
  }

  // ─── Engine updates ─────────────────────────────────────────────────────────

  /**
   * Updates an engine through EngineManager (verified download, checked in
   * place, previous version kept). While downloads or conversions use the
   * engine, the update waits and runs as soon as they finish.
   */
  async updateEngine(target: InstallTarget): Promise<{ deferred: boolean }> {
    if (!this.component(target).installedVersion) {
      throw new AppError('VALIDATION_FAILED', `${LABELS[target]} is not installed. Install it first.`)
    }
    if (this.deps.engines.isBusy()) throw new AppError('BUSY', 'Another installation is already in progress.')
    if (this.deps.engines.isInUse(target)) {
      this.waiting.add(target)
      this.deps.logger.info(`Update of ${target} deferred until downloads and conversions using it finish`)
      this.emit()
      return { deferred: true }
    }
    await this.runEngineUpdate(target)
    return { deferred: false }
  }

  cancelWaiting(target: InstallTarget): void {
    if (this.waiting.delete(target)) this.emit()
  }

  async rollback(target: InstallTarget): Promise<UpdatesSnapshot> {
    this.waiting.delete(target)
    try {
      await this.deps.engines.rollbackTarget(target)
      this.updated.delete(target)
      this.failures.delete(target)
    } catch (error) {
      this.failures.set(target, toIpcError(error).message)
      throw error
    } finally {
      await this.refreshRecords()
    }
    return this.snapshot()
  }

  private async runEngineUpdate(target: InstallTarget): Promise<void> {
    this.failures.delete(target)
    this.waiting.delete(target)
    const before = this.component(target).installedVersion
    try {
      await this.deps.engines.installTarget(target)
      this.updated.add(target)
      await this.refreshRecords()
      const after = this.deps.engines.snapshot().engines[PRIMARY[target]].version
      this.deps.logger.info(`Updated ${target} from ${before ?? 'none'} to ${after ?? 'unknown'}`)
      this.events.emit('notice', { component: target, version: after ?? '', kind: 'updated', message: null } satisfies UpdateNotice)
    } catch (error) {
      const message = toIpcError(error).message
      if (toIpcError(error).code !== 'CANCELLED') this.failures.set(target, message)
      throw error
    } finally {
      this.emit()
    }
  }

  /** Runs deferred updates once their engines are free. */
  private runDeferred(): void {
    for (const target of [...this.waiting]) {
      if (this.deps.engines.isInUse(target) || this.deps.engines.isBusy()) continue
      this.waiting.delete(target)
      this.deps.logger.info(`Running the deferred update of ${target}`)
      this.runEngineUpdate(target).catch((error: unknown) => {
        this.events.emit('notice', {
          component: target,
          version: this.component(target).latestVersion ?? '',
          kind: 'failed',
          message: toIpcError(error).message
        } satisfies UpdateNotice)
      })
    }
  }

  // ─── Application update ─────────────────────────────────────────────────────

  async downloadApp(): Promise<void> {
    // After a restart only the last result is known; the updater needs a fresh check before downloading.
    if (!this.appRelease) await this.checkApp()
    if (!this.appRelease) {
      throw new AppError('VALIDATION_FAILED', this.failures.get('app') ?? this.stored.get('app')?.errorMessage ?? 'YT-DLP++ is up to date.')
    }
    if (this.appPhase === 'downloading' || this.appPhase === 'ready') return
    this.appPhase = 'downloading'
    this.appProgress = 0
    this.failures.delete('app')
    this.emit()
    let lastEmit = 0
    try {
      await this.deps.app.download((percent) => {
        this.appProgress = Math.max(0, Math.min(100, percent))
        if (Date.now() - lastEmit > 250) {
          lastEmit = Date.now()
          this.emit()
        }
      })
      this.appPhase = 'ready'
      this.appProgress = 100
      this.deps.logger.info(`YT-DLP++ ${this.appRelease.version} downloaded and verified; ready to install`)
    } catch (error) {
      const message = describeAppUpdateError(error)
      this.appPhase = 'failed'
      this.appProgress = null
      this.failures.set('app', message)
      this.deps.logger.error(`Downloading YT-DLP++ ${this.appRelease.version} failed`, error)
      this.deps.history.record({ component: 'app', previousVersion: this.deps.appVersion, newVersion: this.appRelease.version, status: 'failed', errorMessage: message })
      throw new AppError('OPERATION_FAILED', message, { cause: error })
    } finally {
      this.emit()
    }
  }

  cancelAppDownload(): void {
    this.deps.app.cancelDownload()
  }

  /** Quits and installs. Running downloads are paused by the normal shutdown and offered for resuming afterwards. */
  installApp(): void {
    if (this.appPhase !== 'ready' || !this.appRelease) throw new AppError('VALIDATION_FAILED', 'The update has not been downloaded yet.')
    this.deps.logger.info(`Installing YT-DLP++ ${this.appRelease.version} and restarting`)
    // The outcome is recorded at the next start, when the running version shows whether it worked.
    this.deps.checks.setState(PENDING_APP_UPDATE, JSON.stringify({ from: this.deps.appVersion, to: this.appRelease.version }))
    this.deps.app.install()
  }

  // ─── State ──────────────────────────────────────────────────────────────────

  snapshot(): UpdatesSnapshot {
    const settings = this.deps.settings()
    return {
      components: Object.fromEntries(COMPONENTS.map((id) => [id, this.component(id)])) as Record<UpdateComponentId, ComponentUpdate>,
      checkingAll: this.checkingAll,
      lastCheckedAll: this.lastCheckedAll,
      nextScheduledCheck: settings.autoCheckUpdates ? this.nextDue(settings).toISOString() : null
    }
  }

  private component(id: UpdateComponentId): ComponentUpdate {
    return id === 'app' ? this.appComponent() : this.engineComponent(id)
  }

  private appComponent(): ComponentUpdate {
    const stored = this.stored.get('app')
    const reason = this.deps.app.unavailableReason()
    const release = this.appRelease
    const base: ComponentUpdate = {
      id: 'app',
      installedVersion: this.deps.appVersion,
      latestVersion: release?.version ?? (stored?.errorMessage ? null : (stored?.latestVersion ?? null)),
      releasedAt: release?.releasedAt ?? null,
      checkedAt: stored?.checkedAt ?? null,
      state: 'unknown',
      message: null,
      notesUrl: release?.notesUrl ?? null,
      releaseNotes: release?.notes ?? null,
      progress: this.appPhase === 'downloading' ? this.appProgress : null,
      channel: null,
      channelSwitch: false,
      systemCopy: false,
      rollbackVersion: null
    }
    if (reason) return { ...base, state: 'unavailable', message: reason }
    if (this.checking.has('app')) return { ...base, state: 'checking' }
    if (this.appPhase === 'downloading') return { ...base, state: 'downloading' }
    if (this.appPhase === 'ready') return { ...base, state: 'ready' }
    const failure = this.failures.get('app') ?? stored?.errorMessage
    if (failure) return { ...base, state: 'failed', message: failure }
    if (release) return { ...base, state: 'available' }
    if (stored?.latestVersion && compareVersions(stored.latestVersion, this.deps.appVersion) > 0) {
      // Found before the last restart; downloading checks again first.
      return { ...base, state: 'available', latestVersion: stored.latestVersion, notesUrl: stored.notesUrl, releasedAt: stored.releasedAt }
    }
    if (!stored) return { ...base, state: 'unknown' }
    return { ...base, state: this.updated.has('app') ? 'updated' : 'up-to-date' }
  }

  private engineComponent(target: InstallTarget): ComponentUpdate {
    const engines: EnginesSnapshot = this.deps.engines.snapshot()
    const status = engines.engines[PRIMARY[target]]
    const stored = this.stored.get(target)
    const systemCopy = TARGET_ENGINES[target].some((id) => engines.engines[id].source !== null && engines.engines[id].source !== 'managed')
    const base: ComponentUpdate = {
      id: target,
      installedVersion: status.version,
      latestVersion: stored?.latestVersion ?? null,
      releasedAt: stored?.releasedAt ?? null,
      checkedAt: stored?.checkedAt ?? null,
      state: 'unknown',
      message: null,
      notesUrl: stored?.notesUrl ?? null,
      releaseNotes: null,
      progress: null,
      channel: target === 'yt-dlp' ? (stored?.channel ?? this.deps.settings().ytdlpChannel) : null,
      channelSwitch: false,
      systemCopy,
      rollbackVersion: engines.rollback[target]
    }
    if (!engines.providers[target] || !this.deps.checkers[target]) {
      return {
        ...base,
        state: 'unavailable',
        message: status.version
          ? "No trusted build is published for this platform; update it with your system's package manager."
          : 'No trusted build is published for this platform.'
      }
    }
    if (this.checking.has(target)) return { ...base, state: 'checking' }
    const install = engines.install
    if (install?.target === target && DOWNLOAD_STAGES.includes(install.stage)) return { ...base, state: 'downloading' }
    if (install?.target === target && INSTALL_STAGES.includes(install.stage)) return { ...base, state: 'installing' }
    if (this.waiting.has(target)) return { ...base, state: 'waiting', message: 'Waits for downloads and conversions using it to finish.' }
    const failure = this.failures.get(target)
    if (failure) return { ...base, state: 'failed', message: failure }
    if (!status.version) return { ...base, state: 'unavailable', message: 'Not installed.' }
    if (!stored) return { ...base, state: 'unknown' }
    if (stored.errorMessage) return { ...base, state: 'failed', message: stored.errorMessage }
    if (!stored.latestVersion) return { ...base, state: 'unknown' }

    const decision = evaluateEngineUpdate(
      target,
      { version: status.version, build: status.build, source: status.source, record: this.records.engines[PRIMARY[target]] ?? null },
      { version: stored.latestVersion, build: stored.latestBuild ?? stored.latestVersion, releasedAt: stored.releasedAt, notesUrl: stored.notesUrl, channel: stored.channel }
    )
    if (decision.available) {
      return {
        ...base,
        state: 'available',
        channelSwitch: decision.channelSwitch,
        message:
          target === 'yt-dlp' && decision.channelSwitch
            ? `Installed from the ${installedYtDlpChannel({ version: status.version, build: null, source: status.source, record: this.records.engines['yt-dlp'] ?? null })} channel; ${stored.channel} is selected in Settings.`
            : null
      }
    }
    return { ...base, state: this.updated.has(target) ? 'updated' : 'up-to-date' }
  }

  private summary(): string {
    return COMPONENTS.map((id) => {
      const c = this.component(id)
      return `${id} ${c.state}${c.latestVersion ? ` (${c.latestVersion})` : ''}`
    }).join(', ')
  }

  private nextDue(settings: AppSettings): Date {
    const interval = settings.updateCheckIntervalHours * 3_600_000
    if (this.lastCheckedAll) return new Date(Date.parse(this.lastCheckedAll) + interval)
    return new Date((this.startedAt ?? this.now()).getTime() + (this.deps.startupDelayMs ?? 20_000))
  }

  /** Runs the automatic check when it is due (and enabled). */
  async tick(): Promise<void> {
    const settings = this.deps.settings()
    if (!settings.autoCheckUpdates || this.checkingAll) return
    if (this.now().getTime() < this.nextDue(settings).getTime()) return
    await this.checkAll('scheduled').catch((error: unknown) => this.deps.logger.error('Automatic update check failed', error))
  }

  private emit(): void {
    this.events.emit('changed', this.snapshot())
  }
}
