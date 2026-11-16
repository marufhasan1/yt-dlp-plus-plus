import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EnginesSnapshot } from '@shared/types/engines'
import { UpdateRolledBack, type EngineInstaller, type InstalledEngine } from '../../electron/services/engines/engine-installer'
import { EngineManager } from '../../electron/services/engines/engine-manager'
import { EngineManifestStore } from '../../electron/services/engines/engine-manifest'
import { EngineProber } from '../../electron/services/engines/engine-probe'
import { detectPlatform, executableName } from '../../electron/services/engines/platform'
import { openDatabase, type SqliteDatabase } from '../../electron/services/storage/database'
import { EngineVersionsRepository } from '../../electron/services/storage/engine-versions.repository'
import { UpdateHistoryRepository } from '../../electron/services/storage/update-history.repository'
import { AppError } from '../../electron/utils/errors'
import { silentLogger } from '../../electron/utils/logger'
import type { ProcessRunner, RunResult } from '../../electron/utils/process'
import { nativeExecutable, peHeader, elfHeader } from '../helpers/fake-binary'

const target = detectPlatform()
type Engine = 'yt-dlp' | 'ffmpeg' | 'ffprobe' | 'deno'
const exe = (name: Engine) => executableName(name, target.platform)
const CAPABILITIES = ' --\n' + ['libmp3lame', 'aac', 'pcm_s16le', 'flac', 'libopus', 'mp4', 'webm', 'matroska', 'ipod', 'mp3', 'wav', 'opus'].map((n) => ` X ${n} x`).join('\n')

/** Answers version probes based on the file name: yt-dlp → date, ffmpeg/ffprobe → `builds[name]`. */
function runner(builds: Record<string, string> = {}): ProcessRunner {
  return vi.fn(async (file: string, args: readonly string[]): Promise<RunResult> => {
    const result = (stdout: string): RunResult => ({ exitCode: 0, signal: null, stdout, stderr: '', timedOut: false })
    if (args.includes('-encoders') || args.includes('-muxers')) return result(CAPABILITIES)
    if (file.endsWith(exe('yt-dlp'))) return result('2026.10.26\n')
    if (file.endsWith(exe('deno'))) return result('deno 2.9.8 (stable, release, x86_64-pc-windows-msvc)\n')
    const tool = file.endsWith(exe('ffprobe')) ? 'ffprobe' : 'ffmpeg'
    return result(`${tool} version ${builds[tool] ?? 'n9.0.2-1'} Copyright`)
  })
}

let root: string
let managed: string
let system: string
let db: SqliteDatabase
let installer: {
  installYtDlp: ReturnType<typeof vi.fn>
  installFfmpegToolchain: ReturnType<typeof vi.fn>
  installDeno: ReturnType<typeof vi.fn>
  recoverInterruptedInstalls: ReturnType<typeof vi.fn>
  rollbackInfo: ReturnType<typeof vi.fn>
  rollback: ReturnType<typeof vi.fn>
}
let history: UpdateHistoryRepository
let versions: EngineVersionsRepository

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ytdlpp-manager-'))
  managed = join(root, 'managed')
  system = join(root, 'system')
  mkdirSync(managed, { recursive: true })
  mkdirSync(system, { recursive: true })
  db = openDatabase(':memory:', silentLogger)
  history = new UpdateHistoryRepository(db)
  versions = new EngineVersionsRepository(db)
  installer = {
    installYtDlp: vi.fn(),
    installFfmpegToolchain: vi.fn(),
    installDeno: vi.fn(),
    recoverInterruptedInstalls: vi.fn(async () => {}),
    rollbackInfo: vi.fn(async () => null),
    rollback: vi.fn()
  }
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

let channel: 'stable' | 'nightly' = 'stable'

function manager(builds: Record<string, string> = {}): EngineManager {
  return new EngineManager({
    target,
    locations: { managed, bundled: null, system: [system] },
    prober: new EngineProber(runner(builds)),
    installer: installer as unknown as EngineInstaller,
    manifest: new EngineManifestStore(managed),
    versions,
    history,
    providers: {
      'yt-dlp': { name: 'yt-dlp', homepage: 'https://github.com/yt-dlp/yt-dlp', license: 'Unlicense' },
      ffmpeg: { name: 'BtbN', homepage: 'https://github.com/BtbN/FFmpeg-Builds', license: 'LGPL' },
      deno: { name: 'Deno', homepage: 'https://github.com/denoland/deno', license: 'MIT' }
    },
    logger: silentLogger,
    ytdlpChannel: () => channel
  })
}

function place(dir: string, name: Engine, content: Buffer = nativeExecutable()): string {
  const path = join(dir, exe(name))
  writeFileSync(path, content, { mode: 0o755 })
  return path
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : String(e))
  )
}

describe('EngineManager detection', () => {
  it('reports every engine as missing on a clean system', async () => {
    const snapshot = await manager().initialize()
    expect(snapshot.initialized).toBe(true)
    expect(Object.values(snapshot.engines).map((e) => e.health)).toEqual(['missing', 'missing', 'missing', 'missing'])
    expect(installer.recoverInterruptedInstalls).toHaveBeenCalledOnce()
  })

  it('prefers managed engines over system ones', async () => {
    place(managed, 'yt-dlp')
    place(system, 'yt-dlp')
    place(system, 'ffmpeg')
    place(system, 'ffprobe')
    const snapshot = await manager().initialize()
    expect(snapshot.engines['yt-dlp']).toMatchObject({ health: 'ok', source: 'managed', version: '2026.10.26' })
    expect(snapshot.engines.ffmpeg).toMatchObject({ health: 'ok', source: 'system', version: '9.0.2', build: 'n9.0.2-1' })
    expect(versions.get('ffmpeg')?.installedVersion).toBe('9.0.2')
  })

  it('never pairs FFmpeg and FFprobe from different places', async () => {
    place(managed, 'ffmpeg') // incomplete managed toolchain
    place(system, 'ffmpeg')
    place(system, 'ffprobe')
    const snapshot = await manager().initialize()
    expect(snapshot.engines.ffmpeg.source).toBe('system')
    expect(snapshot.engines.ffprobe.source).toBe('system')
  })

  it('degrades a toolchain whose builds differ', async () => {
    place(system, 'ffmpeg')
    place(system, 'ffprobe')
    const snapshot = await manager({ ffmpeg: 'n9.0.2-1', ffprobe: 'n8.1-3' }).initialize()
    expect(snapshot.engines.ffmpeg.health).toBe('degraded')
    expect(snapshot.engines.ffprobe.problems.map((p) => p.code)).toContain('TOOLCHAIN_MISMATCH')
  })

  it('flags binaries for the wrong platform', async () => {
    place(managed, 'yt-dlp', target.platform === 'win32' ? elfHeader('x64') : peHeader('x64'))
    const snapshot = await manager().initialize()
    expect(snapshot.engines['yt-dlp']).toMatchObject({ health: 'broken', problems: [{ code: 'INCOMPATIBLE_BINARY' }] })
  })

  it('detects managed binaries that changed since installation', async () => {
    const content = Buffer.concat([nativeExecutable(), Buffer.from('original')])
    const path = place(managed, 'yt-dlp', content)
    await new EngineManifestStore(managed).update({
      'yt-dlp': {
        version: '2026.10.26',
        sha256: createHash('sha256').update(content).digest('hex'),
        size: content.length,
        installedAt: new Date().toISOString(),
        provider: 'yt-dlp-github',
        sourceUrl: 'https://github.com/x'
      }
    })
    const engines = manager()
    expect((await engines.initialize()).engines['yt-dlp'].health).toBe('ok')

    // Same size, different bytes: only the deep check can tell.
    const tampered = Buffer.from(content)
    tampered[tampered.length - 1] = 0x21
    writeFileSync(path, tampered)
    expect((await engines.refresh(false)).engines['yt-dlp'].health).toBe('ok')
    expect((await engines.refresh(true)).engines['yt-dlp']).toMatchObject({
      health: 'broken',
      problems: [{ code: 'INTEGRITY_MISMATCH' }]
    })

    // A size change is caught by the quick check.
    writeFileSync(path, Buffer.concat([content, Buffer.from('extra')]))
    expect((await engines.refresh(false)).engines['yt-dlp'].health).toBe('broken')
  })

  it('emits snapshots while checking and after', async () => {
    const engines = manager()
    const seen: EnginesSnapshot[] = []
    engines.onChanged((s) => seen.push(s))
    await engines.initialize()
    expect(seen.some((s) => s.checking)).toBe(true)
    expect(seen.at(-1)).toMatchObject({ checking: false, initialized: true })
  })

  it('only exposes usable engine paths', async () => {
    const path = place(managed, 'yt-dlp')
    const engines = manager()
    await engines.initialize()
    expect(engines.executablePath('yt-dlp')).toBe(path)
    expect(engines.executablePath('ffmpeg')).toBeNull()
  })
})

describe('EngineManager installation', () => {
  const installed = (id: 'yt-dlp' | 'ffmpeg' | 'ffprobe', version: string): InstalledEngine => ({
    id,
    version,
    path: join(managed, exe(id))
  })

  it('installs, re-detects and records history', async () => {
    installer.installYtDlp.mockImplementation(async (_signal: AbortSignal, onProgress: (u: unknown) => void) => {
      onProgress({ stage: 'downloading', receivedBytes: 5, totalBytes: 10, version: '2026.10.26' })
      place(managed, 'yt-dlp')
      return [installed('yt-dlp', '2026.10.26')]
    })
    const engines = manager()
    await engines.initialize()
    const snapshot = await engines.installTarget('yt-dlp')

    expect(snapshot.engines['yt-dlp']).toMatchObject({ health: 'ok', source: 'managed' })
    expect(snapshot.install).toMatchObject({ target: 'yt-dlp', stage: 'completed', version: '2026.10.26' })
    expect(history.recent()).toMatchObject([
      { component: 'yt-dlp', previousVersion: null, newVersion: '2026.10.26', status: 'success' }
    ])
  })

  it('records failures for every engine in the toolchain', async () => {
    installer.installFfmpegToolchain.mockRejectedValue(new AppError('INTEGRITY', 'Checksum mismatch'))
    const engines = manager()
    await engines.initialize()
    expect(await codeOf(engines.installTarget('ffmpeg'))).toBe('INTEGRITY')
    expect(engines.snapshot().install).toMatchObject({ stage: 'failed', error: 'Checksum mismatch' })
    expect(history.recent().map((h) => [h.component, h.status])).toEqual([
      ['ffprobe', 'failed'],
      ['ffmpeg', 'failed']
    ])
  })

  it('cancels an installation in progress', async () => {
    installer.installYtDlp.mockImplementation(
      (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new AppError('CANCELLED', 'cancelled')))
        })
    )
    const engines = manager()
    await engines.initialize()
    const pending = engines.installTarget('yt-dlp')
    await vi.waitFor(() => expect(installer.installYtDlp).toHaveBeenCalled())
    engines.cancelInstall()
    expect(await codeOf(pending)).toBe('CANCELLED')
    expect(engines.snapshot().install?.stage).toBe('cancelled')
    expect(history.recent()).toEqual([])
  })

  it('refuses a second installation while one is running', async () => {
    let finish: () => void = () => {}
    installer.installYtDlp.mockImplementation(() => new Promise<InstalledEngine[]>((resolve) => (finish = () => resolve([]))))
    const engines = manager()
    await engines.initialize()
    const first = engines.installTarget('yt-dlp')
    expect(await codeOf(engines.installTarget('ffmpeg'))).toBe('BUSY')
    await vi.waitFor(() => expect(installer.installYtDlp).toHaveBeenCalled())
    finish()
    await first
  })

  it('refuses to replace engines that are in use', async () => {
    const engines = manager()
    await engines.initialize()
    const release = engines.acquire(['ffmpeg'])
    expect(await codeOf(engines.installTarget('ffmpeg'))).toBe('BUSY')
    expect(installer.installFfmpegToolchain).not.toHaveBeenCalled()
    release()
    release() // releasing twice is harmless
    installer.installFfmpegToolchain.mockResolvedValue([])
    expect(await codeOf(engines.installTarget('ffmpeg'))).toBeNull()
  })
})

describe('EngineManager — updates', () => {
  const installed = (id: 'yt-dlp', version: string): InstalledEngine => ({ id, version, path: join(managed, exe(id)) })

  it('installs yt-dlp from the selected channel', async () => {
    channel = 'nightly'
    installer.installYtDlp.mockResolvedValue([installed('yt-dlp', '2026.11.04.232659')])
    const engines = manager()
    await engines.initialize()
    await engines.installTarget('yt-dlp')
    expect(installer.installYtDlp).toHaveBeenCalledWith(expect.any(AbortSignal), expect.any(Function), 'nightly')
    channel = 'stable'
  })

  it('records an update that failed its check in place as rolled back', async () => {
    installer.installYtDlp.mockRejectedValue(new UpdateRolledBack('The new yt-dlp did not work after installation. The previous version was restored.'))
    const engines = manager()
    await engines.initialize()
    expect(await codeOf(engines.installTarget('yt-dlp'))).toBe('INTEGRITY')
    expect(history.recent()).toMatchObject([{ component: 'yt-dlp', status: 'rolled_back', errorMessage: expect.stringMatching(/restored/) }])
  })

  it('reports the kept version, rolls back to it, and refuses while the engine is in use', async () => {
    place(managed, 'yt-dlp')
    installer.rollbackInfo.mockImplementation(async (t: string) => (t === 'yt-dlp' ? { savedAt: '', entries: { 'yt-dlp': { version: '2026.09.01' } } } : null))
    const engines = manager({ [exe('yt-dlp')]: '2026.10.26' })
    await engines.initialize()
    expect(engines.snapshot().rollback).toEqual({ 'yt-dlp': '2026.09.01', ffmpeg: null, deno: null })

    const leases: number[] = []
    engines.onLeasesChanged(() => leases.push(1))
    const release = engines.acquire(['yt-dlp', 'ffmpeg', 'ffprobe'])
    expect(engines.isInUse('yt-dlp')).toBe(true)
    expect(engines.snapshot().inUse).toEqual(['yt-dlp', 'ffmpeg'])
    expect(await codeOf(engines.rollbackTarget('yt-dlp'))).toBe('BUSY')
    release()
    expect(leases).toHaveLength(2)
    expect(engines.isInUse('yt-dlp')).toBe(false)

    installer.rollback.mockResolvedValue([installed('yt-dlp', '2026.09.01')])
    await engines.rollbackTarget('yt-dlp')
    expect(installer.rollback).toHaveBeenCalledWith('yt-dlp')
    expect(history.recent()).toMatchObject([{ component: 'yt-dlp', previousVersion: '2026.10.26', newVersion: '2026.09.01', status: 'rolled_back' }])

    installer.rollback.mockRejectedValue(new AppError('NOT_FOUND', 'There is no previous version to roll back to.'))
    expect(await codeOf(engines.rollbackTarget('yt-dlp'))).toBe('NOT_FOUND')
    expect(engines.snapshot().install).toMatchObject({ stage: 'failed' })
  })

  it('does not offer a rollback for a copy it does not manage', async () => {
    place(system, 'yt-dlp')
    installer.rollbackInfo.mockResolvedValue({ savedAt: '', entries: { 'yt-dlp': { version: '2026.09.01' } } })
    const engines = manager({ [exe('yt-dlp')]: '2026.10.26' })
    await engines.initialize()
    expect(engines.snapshot().rollback['yt-dlp']).toBeNull()
  })
})

describe('EngineManager — Deno', () => {
  it('detects the JavaScript runtime and installs it on request', async () => {
    place(system, 'deno')
    installer.installDeno.mockImplementation(async () => {
      place(managed, 'deno')
      return [{ id: 'deno', version: '2.9.8', path: join(managed, exe('deno')) }]
    })
    const engines = manager()
    expect((await engines.initialize()).engines.deno).toMatchObject({ health: 'ok', source: 'system', version: '2.9.8' })
    const snapshot = await engines.installTarget('deno')
    expect(installer.installDeno).toHaveBeenCalledOnce()
    expect(snapshot.engines.deno).toMatchObject({ health: 'ok', source: 'managed' })
    expect(history.recent()[0]).toMatchObject({ component: 'deno', newVersion: '2.9.8', status: 'success' })
  })
})

describe('EngineManager.waitForRuntime', () => {
  it('waits for startup detection instead of failing', async () => {
    place(managed, 'yt-dlp')
    const engines = manager()
    expect(() => engines.runtime()).toThrow(/still being checked/)
    const waiting = engines.waitForRuntime(5000)
    void engines.initialize()
    expect((await waiting).ytdlp).toBe(join(managed, exe('yt-dlp')))
  })

  it('still reports a missing yt-dlp once detection has finished', async () => {
    const engines = manager()
    void engines.initialize()
    await expect(engines.waitForRuntime(5000)).rejects.toMatchObject({ code: 'ENGINE_MISSING' })
  })
})
