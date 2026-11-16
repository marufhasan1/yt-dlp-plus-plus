import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineId, EngineStatus, EnginesSnapshot, InstallTarget } from '@shared/types/engines'
import type { AppSettings } from '@shared/types/settings'
import { DEFAULT_SETTINGS } from '@shared/validation/settings'
import type { EngineManifest } from '../../electron/services/engines/engine-manifest'
import { btbnBuildId, parseRiedlDownloadUrl } from '../../electron/services/engines/ffmpeg-engine'
import { openDatabase, type SqliteDatabase } from '../../electron/services/storage/database'
import { EngineVersionsRepository } from '../../electron/services/storage/engine-versions.repository'
import { UpdateChecksRepository } from '../../electron/services/storage/update-checks.repository'
import { UpdateHistoryRepository } from '../../electron/services/storage/update-history.repository'
import { describeAppUpdateError, type AppRelease, type AppUpdateBackend } from '../../electron/services/updates/app-updater'
import { evaluateEngineUpdate, type EngineCandidate, type InstalledEngineInfo } from '../../electron/services/updates/engine-update-check'
import { htmlToText, releaseNotesText } from '../../electron/services/updates/release-notes'
import { UpdateService, type UpdateNotice } from '../../electron/services/updates/update.service'
import { compareVersions, parseFfmpegBuild } from '../../electron/services/updates/versions'
import { AppError } from '../../electron/utils/errors'
import { silentLogger } from '../../electron/utils/logger'

describe('version comparison', () => {
  it('compares numerically, never as strings', () => {
    expect(compareVersions('2026.10.26', '2026.9.1')).toBe(1)
    expect(compareVersions('9.0.10', '9.0.2')).toBe(1)
    expect(compareVersions('v2.9.8', '2.9.8')).toBe(0)
    expect(compareVersions('9.0', '9.0.0')).toBe(0)
    expect(compareVersions('2026.11.04.232659', '2026.10.26')).toBe(1) // nightly vs stable
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1)
    expect(compareVersions('unknown', '1.0')).toBe(0)
  })

  it('reads FFmpeg build identifiers as printed by real builds', () => {
    expect(parseFfmpegBuild('n9.0.2-48-gd4070a14ce-20261109')).toEqual({ version: '9.0.2', commits: 48 }) // BtbN, `ffmpeg -version`
    expect(parseFfmpegBuild('n9.0.2-48-gd4070a14ce')).toEqual({ version: '9.0.2', commits: 48 }) // BtbN asset name
    expect(parseFfmpegBuild('9.0.2')).toEqual({ version: '9.0.2', commits: 0 })
    expect(parseFfmpegBuild('8.0-full_build-www.gyan.dev')).toBeNull() // vendor build string
    expect(parseFfmpegBuild('N-121456-g1234abcd-20261101')).toBeNull() // git master
    expect(btbnBuildId('ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0.zip', 'win64')).toBe('n9.0.2-48-gd4070a14ce')
    expect(btbnBuildId('ffmpeg-n8.1.3-34-ga35157abb9-linuxarm64-lgpl-8.1.tar.xz', 'linuxarm64')).toBe('n8.1.3-34-ga35157abb9')
    expect(parseRiedlDownloadUrl('https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip')).toMatchObject({ version: '9.0.2', build: '1789931890_9.0.2', builtAt: 1789931890 })
  })
})

describe('update decisions', () => {
  const installed = (version: string | null, extra: Partial<InstalledEngineInfo> = {}): InstalledEngineInfo => ({ version, build: null, source: 'managed', record: null, ...extra })
  const record = (provider: string, sourceUrl = 'https://github.com/x') => ({ version: '', sha256: 'a'.repeat(64), size: 1, installedAt: '', provider, sourceUrl })
  const candidate = (version: string, extra: Partial<EngineCandidate> = {}): EngineCandidate => ({ version, build: version, releasedAt: null, notesUrl: null, channel: null, ...extra })

  it('yt-dlp: newer releases, and channel switches in both directions', () => {
    const stable = installed('2026.10.26', { record: record('yt-dlp-github') })
    expect(evaluateEngineUpdate('yt-dlp', stable, candidate('2026.10.26', { channel: 'stable' }))).toEqual({ available: false, channelSwitch: false })
    expect(evaluateEngineUpdate('yt-dlp', stable, candidate('2026.11.20', { channel: 'stable' }))).toEqual({ available: true, channelSwitch: false })
    expect(evaluateEngineUpdate('yt-dlp', stable, candidate('2026.11.04.232659', { channel: 'nightly' }))).toEqual({ available: true, channelSwitch: true })
    // Back from nightly to stable is offered even though stable is older.
    const nightly = installed('2026.11.04.232659', { record: record('yt-dlp-nightly') })
    expect(evaluateEngineUpdate('yt-dlp', nightly, candidate('2026.10.26', { channel: 'stable' }))).toEqual({ available: true, channelSwitch: true })
    expect(evaluateEngineUpdate('yt-dlp', nightly, candidate('2026.11.04.232659', { channel: 'nightly' })).available).toBe(false)
    // A system copy's channel is told by its version.
    expect(evaluateEngineUpdate('yt-dlp', installed('2026.11.04.232659', { source: 'system' }), candidate('2026.11.05.010101', { channel: 'nightly' }))).toEqual({ available: true, channelSwitch: false })
    expect(evaluateEngineUpdate('yt-dlp', installed(null), candidate('2026.11.20', { channel: 'stable' })).available).toBe(false)
  })

  it('FFmpeg: newer builds of the same version count; older branches do not', () => {
    const ours = installed('9.0.2', { build: 'n9.0.2-42-gd7643a0fe3-20261105', record: record('btbn') })
    expect(evaluateEngineUpdate('ffmpeg', ours, candidate('9.0.2', { build: 'n9.0.2-48-gd4070a14ce' })).available).toBe(true)
    expect(evaluateEngineUpdate('ffmpeg', { ...ours, build: 'n9.0.2-48-gd4070a14ce-20261109' }, candidate('9.0.2', { build: 'n9.0.2-48-gd4070a14ce' })).available).toBe(false)
    expect(evaluateEngineUpdate('ffmpeg', installed('9.1', { build: 'n9.1-3-gabc-20261201' }), candidate('9.0.2', { build: 'n9.0.2-48-gd4070a14ce' })).available).toBe(false)
    // A system build with a vendor string falls back to the version number.
    expect(evaluateEngineUpdate('ffmpeg', installed('8.0', { build: '8.0-full_build-www.gyan.dev', source: 'system' }), candidate('9.0.2', { build: 'n9.0.2-48-gd4070a14ce' })).available).toBe(true)
    // macOS (Martin Riedl's server): a later build time is newer.
    const riedl = installed('9.0.2', {
      record: record('martin-riedl', 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffprobe.zip')
    })
    expect(evaluateEngineUpdate('ffmpeg', riedl, candidate('9.0.2', { build: '1790500000_9.0.2' })).available).toBe(true)
    expect(evaluateEngineUpdate('ffmpeg', riedl, candidate('9.0.2', { build: '1789931890_9.0.2' })).available).toBe(false)
  })

  it('Deno: plain versions', () => {
    expect(evaluateEngineUpdate('deno', installed('2.9.8'), candidate('2.10.0')).available).toBe(true)
    expect(evaluateEngineUpdate('deno', installed('2.9.8'), candidate('2.9.8')).available).toBe(false)
  })
})

describe('release notes and updater errors', () => {
  it('turns release HTML into plain text', () => {
    const text = htmlToText('<h2>Changes</h2><ul><li>Fix &amp; improve</li><li>It&#39;s &#x2014; done</li></ul><script>alert(1)</script><p>One<br>two</p><img src=x onerror=alert(1)>')
    expect(text).toBe("Changes\n\n• Fix & improve\n• It's — done\n\nOne\ntwo")
    expect(releaseNotesText([{ version: '0.2.0', note: '<p>New</p>' }, { version: '0.1.1', note: null }])).toBe('0.2.0\nNew')
    expect(releaseNotesText(null)).toBeNull()
    expect(htmlToText(`<p>${'x'.repeat(30_000)}</p>`)).toHaveLength(20_000)
  })

  it('explains updater failures', () => {
    expect(describeAppUpdateError(new Error('sha512 checksum mismatch, expected abc, got def'))).toMatch(/verification failed.*checksum/i)
    expect(describeAppUpdateError(new Error('New version 0.2.0 is not signed by the application owner: publisherNames: X'))).toMatch(/not signed/)
    expect(describeAppUpdateError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toMatch(/could not be reached/)
    expect(describeAppUpdateError(new Error('HttpError: 404 Not Found'))).toMatch(/No published release/)
    // Real electron-updater error for a GitHub repository without a release feed (packaged build).
    const github404 = Object.assign(
      new Error('404 \n"method: GET url: https://github.com/mediaflow-qa-nonexistent/mediaflow-qa-nonexistent-repo/releases.atom\\n\\nPlease double check that your authentication token is correct. Due to security reasons, actual status maybe not reported, but 404.\\n"'),
      { name: 'HttpError' }
    )
    expect(describeAppUpdateError(github404)).toBe('No published release was found on the update server.')
    expect(describeAppUpdateError(new Error('weird'))).toMatch(/log file/)
  })
})

// ─── UpdateService ───────────────────────────────────────────────────────────

function status(id: EngineId, version: string | null, extra: Partial<EngineStatus> = {}): EngineStatus {
  return { id, health: version ? 'ok' : 'missing', version, build: null, source: version ? 'managed' : null, path: version ? `/e/${id}` : null, problems: [], checkedAt: null, ...extra }
}

class FakeEngines {
  readonly events = new EventEmitter()
  inUse = new Set<InstallTarget>()
  busy = false
  versions: Record<EngineId, string | null> = { 'yt-dlp': '2026.10.26', ffmpeg: '9.0.2', ffprobe: '9.0.2', deno: '2.9.8' }
  builds: Partial<Record<EngineId, string>> = { ffmpeg: 'n9.0.2-48-gd4070a14ce-20261109' }
  sources: Partial<Record<EngineId, EngineStatus['source']>> = {}
  rollback: Record<InstallTarget, string | null> = { 'yt-dlp': null, ffmpeg: null, deno: null }
  manifest: EngineManifest = { schemaVersion: 1, engines: { 'yt-dlp': { version: '2026.10.26', sha256: 'a'.repeat(64), size: 1, installedAt: '', provider: 'yt-dlp-github', sourceUrl: '' } } }
  installs: InstallTarget[] = []
  nextVersion: Partial<Record<InstallTarget, string>> = {}

  snapshot = (): EnginesSnapshot => ({
    target: 'win32-x64',
    platform: 'win32',
    arch: 'x64',
    initialized: true,
    checking: false,
    enginesDir: '/e',
    engines: Object.fromEntries(
      (['yt-dlp', 'ffmpeg', 'ffprobe', 'deno'] as EngineId[]).map((id) => [id, status(id, this.versions[id], { build: this.builds[id] ?? null, ...(this.sources[id] ? { source: this.sources[id] } : {}) })])
    ) as Record<EngineId, EngineStatus>,
    providers: { 'yt-dlp': { name: 'p', homepage: 'h', license: 'l' }, ffmpeg: { name: 'p', homepage: 'h', license: 'l' }, deno: { name: 'p', homepage: 'h', license: 'l' } },
    install: null,
    rollback: { ...this.rollback },
    inUse: [...this.inUse]
  })
  onChanged = (listener: (s: EnginesSnapshot) => void) => {
    this.events.on('changed', listener)
    return () => this.events.off('changed', listener)
  }
  onLeasesChanged = (listener: () => void) => {
    this.events.on('leases', listener)
    return () => this.events.off('leases', listener)
  }
  isInUse = (target: InstallTarget) => this.inUse.has(target)
  isBusy = () => this.busy
  installRecords = async () => this.manifest
  installTarget = async (target: InstallTarget) => {
    this.installs.push(target)
    const version = this.nextVersion[target]
    if (!version) throw new AppError('INTEGRITY', 'The new yt-dlp did not work after installation. The previous version was restored.')
    this.rollback[target] = this.versions[target === 'ffmpeg' ? 'ffmpeg' : target]
    this.versions[target === 'ffmpeg' ? 'ffmpeg' : target] = version
    return this.snapshot()
  }
  rollbackTarget = async (target: InstallTarget) => {
    const back = this.rollback[target]
    if (!back) throw new AppError('NOT_FOUND', 'There is no previous version to roll back to.')
    this.rollback[target] = this.versions[target === 'ffmpeg' ? 'ffmpeg' : target]
    this.versions[target === 'ffmpeg' ? 'ffmpeg' : target] = back
    return this.snapshot()
  }
  releaseLeases(): void {
    this.inUse.clear()
    this.events.emit('leases')
  }
}

class FakeApp implements AppUpdateBackend {
  reason: string | null = null
  release: AppRelease | null = { version: '0.2.0', releasedAt: '2026-11-08T10:00:00.000Z', notes: 'New things', notesUrl: 'https://github.com/o/r/releases/tag/v0.2.0' }
  downloadError: Error | null = null
  installed = 0
  unavailableReason = () => this.reason
  check = vi.fn(async () => this.release)
  download = async (onProgress: (percent: number) => void) => {
    onProgress(40)
    onProgress(100)
    if (this.downloadError) throw this.downloadError
  }
  cancelDownload = vi.fn()
  install = () => {
    this.installed++
  }
}

let db: SqliteDatabase
let engines: FakeEngines
let appBackend: FakeApp
let settings: AppSettings
let now: Date
let checkers: Record<InstallTarget, ReturnType<typeof vi.fn>>
const services: UpdateService[] = []

function service(appVersion = '0.1.0'): UpdateService {
  const created = new UpdateService({
    engines: engines as never,
    checkers: checkers as never,
    app: appBackend,
    appVersion,
    checks: new UpdateChecksRepository(db),
    versions: new EngineVersionsRepository(db),
    history: new UpdateHistoryRepository(db),
    settings: () => settings,
    logger: silentLogger,
    now: () => now,
    startupDelayMs: 60_000,
    tickMs: 3_600_000
  })
  services.push(created)
  return created
}

beforeEach(() => {
  db = openDatabase(':memory:', silentLogger)
  engines = new FakeEngines()
  appBackend = new FakeApp()
  settings = { ...DEFAULT_SETTINGS }
  now = new Date('2026-11-10T08:00:00.000Z')
  checkers = {
    'yt-dlp': vi.fn(async (channel: string) => ({ version: channel === 'nightly' ? '2026.11.04.232659' : '2026.11.20', build: '2026.11.20', releasedAt: '2026-11-20T00:00:00Z', notesUrl: 'https://github.com/yt-dlp/yt-dlp/releases/tag/2026.11.20', channel })),
    ffmpeg: vi.fn(async () => ({ version: '9.0.2', build: 'n9.0.2-48-gd4070a14ce', releasedAt: null, notesUrl: null, channel: null })),
    deno: vi.fn(async () => {
      throw new AppError('NETWORK', 'api.github.com could not be reached.')
    })
  }
})
afterEach(() => {
  for (const s of services.splice(0)) s.stop()
  db.close()
})

describe('UpdateService', () => {
  it('checks every component, records the results, and remembers them across restarts', async () => {
    const updates = service()
    const snapshot = await updates.checkAll('manual')
    const c = snapshot.components
    expect(c.app).toMatchObject({ state: 'available', installedVersion: '0.1.0', latestVersion: '0.2.0', releaseNotes: 'New things' })
    expect(c['yt-dlp']).toMatchObject({ state: 'available', installedVersion: '2026.10.26', latestVersion: '2026.11.20', channel: 'stable', checkedAt: now.toISOString() })
    expect(c.ffmpeg).toMatchObject({ state: 'up-to-date', latestVersion: '9.0.2' })
    expect(c.deno).toMatchObject({ state: 'failed', message: 'api.github.com could not be reached.' })
    expect(snapshot.lastCheckedAll).toBe(now.toISOString())
    expect(new EngineVersionsRepository(db).get('ffprobe')).toMatchObject({ latestVersion: '9.0.2', checkedAt: now.toISOString() })

    const later = service()
    await later.start() // loads install records
    const restored = later.snapshot().components
    expect(restored['yt-dlp']).toMatchObject({ state: 'available', latestVersion: '2026.11.20' })
    expect(restored.app).toMatchObject({ state: 'available', latestVersion: '0.2.0' }) // found before the restart
    expect(restored.deno.state).toBe('failed')
  })

  it('follows the yt-dlp channel setting', async () => {
    settings = { ...settings, ytdlpChannel: 'nightly' }
    const c = (await service().check('yt-dlp')).components['yt-dlp']
    expect(checkers['yt-dlp']).toHaveBeenCalledWith('nightly')
    expect(c).toMatchObject({ state: 'available', channel: 'nightly', channelSwitch: true, latestVersion: '2026.11.04.232659' })
    expect(c.message).toMatch(/stable channel; nightly is selected/)
  })

  it('updates an engine, or waits while it is in use and then updates', async () => {
    const updates = service()
    updates.start()
    const notices: UpdateNotice[] = []
    updates.onNotice((n) => notices.push(n))
    await updates.check('yt-dlp')
    engines.nextVersion['yt-dlp'] = '2026.11.20'

    engines.inUse.add('yt-dlp')
    expect(await updates.updateEngine('yt-dlp')).toEqual({ deferred: true })
    expect(updates.snapshot().components['yt-dlp'].state).toBe('waiting')
    expect(engines.installs).toEqual([])

    engines.releaseLeases()
    await vi.waitFor(() => expect(updates.snapshot().components['yt-dlp'].state).toBe('updated'))
    expect(engines.installs).toEqual(['yt-dlp'])
    expect(notices).toEqual([expect.objectContaining({ component: 'yt-dlp', kind: 'updated', version: '2026.11.20' })])
    expect(updates.snapshot().components['yt-dlp']).toMatchObject({ installedVersion: '2026.11.20', rollbackVersion: '2026.10.26' })

    // Rolling back.
    await updates.rollback('yt-dlp')
    expect(updates.snapshot().components['yt-dlp']).toMatchObject({ installedVersion: '2026.10.26', state: 'available' })
  })

  it('reports failed updates and can cancel a waiting one', async () => {
    const updates = service()
    await updates.check('yt-dlp')
    await expect(updates.updateEngine('yt-dlp')).rejects.toMatchObject({ code: 'INTEGRITY' })
    expect(updates.snapshot().components['yt-dlp']).toMatchObject({ state: 'failed', message: expect.stringMatching(/previous version was restored/) })

    engines.inUse.add('yt-dlp')
    await updates.updateEngine('yt-dlp')
    updates.cancelWaiting('yt-dlp')
    engines.releaseLeases()
    expect(engines.installs).toEqual(['yt-dlp']) // only the first, failed attempt
    engines.versions.deno = null
    await expect(updates.updateEngine('deno')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    engines.busy = true
    await expect(updates.updateEngine('ffmpeg')).rejects.toMatchObject({ code: 'BUSY' })
  })

  it('checks on schedule, and updates yt-dlp automatically only when allowed', async () => {
    const updates = service()
    updates.start()
    await updates.tick() // not due yet: the first check waits a moment after startup
    expect(checkers['yt-dlp']).not.toHaveBeenCalled()

    now = new Date(now.getTime() + 61_000)
    engines.nextVersion['yt-dlp'] = '2026.11.20'
    await updates.tick()
    expect(checkers['yt-dlp']).toHaveBeenCalledOnce()
    expect(engines.installs).toEqual([]) // automatic updates are opt-in

    // Next check after the interval; this time with automatic yt-dlp updates and without other engines.
    settings = { ...settings, autoUpdateYtdlp: true, checkEngineUpdates: false }
    now = new Date(now.getTime() + 23 * 3_600_000)
    await updates.tick()
    expect(checkers['yt-dlp']).toHaveBeenCalledOnce()
    now = new Date(now.getTime() + 2 * 3_600_000)
    await updates.tick()
    expect(checkers['yt-dlp']).toHaveBeenCalledTimes(2)
    expect(checkers.ffmpeg).toHaveBeenCalledOnce() // only from the first, full check
    expect(engines.installs).toEqual(['yt-dlp'])

    settings = { ...settings, autoCheckUpdates: false }
    now = new Date(now.getTime() + 48 * 3_600_000)
    await updates.tick()
    expect(checkers['yt-dlp']).toHaveBeenCalledTimes(2)
    expect(updates.snapshot().nextScheduledCheck).toBeNull()
  })

  it('never auto-updates a system copy', async () => {
    settings = { ...settings, autoUpdateYtdlp: true }
    engines.sources['yt-dlp'] = 'system'
    engines.nextVersion['yt-dlp'] = '2026.11.20'
    const updates = service()
    await updates.checkAll('scheduled')
    expect(updates.snapshot().components['yt-dlp']).toMatchObject({ state: 'available', systemCopy: true })
    expect(engines.installs).toEqual([])
  })

  it('notifies about a new app version found by an automatic check, if enabled', async () => {
    const notices: UpdateNotice[] = []
    const updates = service()
    updates.onNotice((n) => notices.push(n))
    await updates.checkAll('manual')
    expect(notices).toEqual([]) // the user is already looking
    appBackend.release = { ...appBackend.release!, version: '0.3.0' }
    await updates.checkAll('scheduled')
    expect(notices).toEqual([expect.objectContaining({ component: 'app', kind: 'available', version: '0.3.0' })])
    settings = { ...settings, appUpdateNotifications: false }
    appBackend.release = { ...appBackend.release!, version: '0.4.0' }
    await updates.checkAll('scheduled')
    expect(notices).toHaveLength(1)
  })

  it('downloads, installs and records the app update after the restart', async () => {
    const updates = service()
    await updates.check('app')
    const progress: (number | null)[] = []
    updates.onChanged((s) => progress.push(s.components.app.progress))
    await updates.downloadApp()
    expect(updates.snapshot().components.app.state).toBe('ready')
    expect(progress).toContain(0)
    updates.installApp()
    expect(appBackend.installed).toBe(1)
    expect(new UpdateHistoryRepository(db).recent()).toEqual([]) // recorded once the new version runs

    const restarted = service('0.2.0')
    expect(new UpdateHistoryRepository(db).recent()).toEqual([expect.objectContaining({ component: 'app', previousVersion: '0.1.0', newVersion: '0.2.0', status: 'success' })])
    expect(restarted.snapshot().components.app.state).toBe('updated')
  })

  it('records a failed app download with a clear reason', async () => {
    appBackend.downloadError = new Error('sha512 checksum mismatch, expected x, got y')
    const updates = service()
    await expect(updates.downloadApp()).rejects.toMatchObject({ code: 'OPERATION_FAILED' }) // checks first after a restart
    expect(appBackend.check).toHaveBeenCalledOnce()
    expect(updates.snapshot().components.app).toMatchObject({ state: 'failed', message: expect.stringMatching(/verification failed/i) })
    expect(new UpdateHistoryRepository(db).recent()[0]).toMatchObject({ component: 'app', status: 'failed' })
    expect(() => updates.installApp()).toThrow(AppError)
  })

  it('says why the app cannot update itself', async () => {
    appBackend.reason = 'The portable version cannot update itself. Download the new version from the releases page.'
    const updates = service()
    const app = (await updates.check('app')).components.app
    expect(app).toMatchObject({ state: 'unavailable', message: expect.stringMatching(/portable/) })
    expect(appBackend.check).not.toHaveBeenCalled()
  })
})
