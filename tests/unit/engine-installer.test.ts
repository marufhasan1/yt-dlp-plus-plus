import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineInstaller, UpdateRolledBack, findExtractedExecutable } from '../../electron/services/engines/engine-installer'
import { EngineManifestStore } from '../../electron/services/engines/engine-manifest'
import { EngineProber } from '../../electron/services/engines/engine-probe'
import type { FfmpegProvider } from '../../electron/services/engines/ffmpeg-engine'
import { detectPlatform, executableName } from '../../electron/services/engines/platform'
import type { ResolvedDownload } from '../../electron/services/engines/ytdlp-engine'
import { TrustedHttpClient } from '../../electron/services/network/trusted-http'
import { AppError } from '../../electron/utils/errors'
import { silentLogger } from '../../electron/utils/logger'
import type { ProcessRunner } from '../../electron/utils/process'
import { elfHeader, nativeExecutable, peHeader } from '../helpers/fake-binary'
import { fakeFetch, type FakeRoute } from '../helpers/fake-fetch'

const target = detectPlatform()
const exe = (name: 'yt-dlp' | 'ffmpeg' | 'ffprobe') => executableName(name, target.platform)
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex')

/** When true, the copies placed in the engines folder crash while the staged ones work. */
let installedCopiesFail = false

/** A runner whose answers depend on which staged file is executed. */
function runnerReporting(versions: Record<string, string | null>): ProcessRunner {
  return vi.fn(async (file: string, args: readonly string[]) => {
    const name = Object.keys(versions).find((key) => file.endsWith(key))
    const placed = file.startsWith(engineDir) && !file.includes('.staging')
    const version = name && !(installedCopiesFail && placed) ? versions[name] : null
    if (version === null || version === undefined) {
      return { exitCode: 1, signal: null, stdout: '', stderr: 'crash', timedOut: false }
    }
    if (args.includes('-encoders') || args.includes('-muxers')) {
      // Enough rows for the capability check to pass.
      const rows = ['libmp3lame', 'aac', 'pcm_s16le', 'flac', 'libopus', 'mp4', 'webm', 'matroska', 'ipod', 'mp3', 'wav', 'opus']
      return { exitCode: 0, signal: null, stdout: ` --\n${rows.map((r) => ` A....D ${r} x`).join('\n')}`, stderr: '', timedOut: false }
    }
    const tool = name?.startsWith('ffprobe') ? 'ffprobe' : 'ffmpeg'
    const stdout = name?.startsWith('yt-dlp') ? `${version}\n` : `${tool} version ${version} Copyright`
    return { exitCode: 0, signal: null, stdout, stderr: '', timedOut: false }
  })
}

let root: string
let engineDir: string
let stagingRoot: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ytdlpp-installer-'))
  engineDir = join(root, 'engines', target.key)
  stagingRoot = join(root, 'engines', '.staging')
  installedCopiesFail = false
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function setup(options: {
  routes?: Record<string, FakeRoute>
  versions?: Record<string, string | null>
  resolveYtDlp?: (...args: unknown[]) => Promise<ResolvedDownload>
  provider?: FfmpegProvider | null
  extract?: (archive: string, destination: string) => Promise<void>
}) {
  const http = new TrustedHttpClient({
    fetch: fakeFetch(options.routes ?? {}),
    allowedHosts: ['github.com'],
    userAgent: 'test'
  })
  const manifest = new EngineManifestStore(engineDir)
  const installer = new EngineInstaller({
    http,
    target,
    engineDir,
    stagingRoot,
    prober: new EngineProber(runnerReporting(options.versions ?? {})),
    manifest,
    ffmpegProvider: options.provider ?? null,
    extract: options.extract ?? (async () => {}),
    logger: silentLogger,
    resolveYtDlp: options.resolveYtDlp
  })
  return { installer, manifest }
}

function ytDlpRelease(binary: Buffer, overrides: Partial<ResolvedDownload> = {}): () => Promise<ResolvedDownload> {
  return async () => ({
    channel: 'stable',
    version: '2026.10.26',
    url: 'https://github.com/yt-dlp.bin',
    fileName: exe('yt-dlp'),
    size: binary.length,
    sha256: sha256(binary),
    ...overrides
  })
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : String(e))
  )
}

const noop = () => {}

describe('EngineInstaller — yt-dlp', () => {
  const binary = Buffer.concat([nativeExecutable(), Buffer.from('yt-dlp payload')])

  it('installs a verified, working binary and records it', async () => {
    const { installer, manifest } = setup({
      routes: { 'https://github.com/yt-dlp.bin': { body: binary } },
      versions: { [exe('yt-dlp')]: '2026.10.26' },
      resolveYtDlp: ytDlpRelease(binary)
    })
    const stages: string[] = []
    const installed = await installer.installYtDlp(new AbortController().signal, (p) => stages.push(p.stage))

    const path = join(engineDir, exe('yt-dlp'))
    expect(installed).toEqual([{ id: 'yt-dlp', version: '2026.10.26', path }])
    expect(readFileSync(path).equals(binary)).toBe(true)
    expect(await manifest.get('yt-dlp')).toMatchObject({ version: '2026.10.26', sha256: sha256(binary), size: binary.length })
    expect(stages).toEqual(expect.arrayContaining(['resolving', 'downloading', 'verifying', 'installing']))
    expect(readdirSync(stagingRoot)).toEqual([])
  })

  it('discards a download whose checksum does not match and keeps the old binary', async () => {
    mkdirSync(engineDir, { recursive: true })
    writeFileSync(join(engineDir, exe('yt-dlp')), 'old')
    const { installer } = setup({
      routes: { 'https://github.com/yt-dlp.bin': { body: binary } },
      versions: { [exe('yt-dlp')]: '2026.10.26' },
      resolveYtDlp: ytDlpRelease(binary, { sha256: 'f'.repeat(64) })
    })
    expect(await codeOf(installer.installYtDlp(new AbortController().signal, noop))).toBe('INTEGRITY')
    expect(readFileSync(join(engineDir, exe('yt-dlp')), 'utf8')).toBe('old')
    expect(readdirSync(stagingRoot)).toEqual([])
  })

  it('rejects a binary built for another platform', async () => {
    const foreign = Buffer.concat([target.platform === 'win32' ? elfHeader('x64') : peHeader('x64'), Buffer.from('x')])
    const { installer } = setup({
      routes: { 'https://github.com/yt-dlp.bin': { body: foreign } },
      versions: { [exe('yt-dlp')]: '2026.10.26' },
      resolveYtDlp: ytDlpRelease(foreign)
    })
    expect(await codeOf(installer.installYtDlp(new AbortController().signal, noop))).toBe('INTEGRITY')
    expect(existsSync(join(engineDir, exe('yt-dlp')))).toBe(false)
  })

  it('rejects a binary that does not run', async () => {
    const { installer } = setup({
      routes: { 'https://github.com/yt-dlp.bin': { body: binary } },
      versions: { [exe('yt-dlp')]: null },
      resolveYtDlp: ytDlpRelease(binary)
    })
    expect(await codeOf(installer.installYtDlp(new AbortController().signal, noop))).toBe('INTEGRITY')
    expect(existsSync(join(engineDir, exe('yt-dlp')))).toBe(false)
  })

  it('replaces an existing installation without leaving backups', async () => {
    mkdirSync(engineDir, { recursive: true })
    writeFileSync(join(engineDir, exe('yt-dlp')), 'old')
    const { installer } = setup({
      routes: { 'https://github.com/yt-dlp.bin': { body: binary } },
      versions: { [exe('yt-dlp')]: '2026.10.26' },
      resolveYtDlp: ytDlpRelease(binary)
    })
    await installer.installYtDlp(new AbortController().signal, noop)
    expect(readFileSync(join(engineDir, exe('yt-dlp'))).equals(binary)).toBe(true)
    expect(readdirSync(engineDir).sort()).toEqual([exe('yt-dlp'), 'manifest.json'].sort())
  })

  it('stops when cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    const { installer } = setup({
      routes: { 'https://github.com/yt-dlp.bin': { body: binary } },
      resolveYtDlp: ytDlpRelease(binary)
    })
    expect(await codeOf(installer.installYtDlp(controller.signal, noop))).toBe('CANCELLED')
    expect(existsSync(join(engineDir, exe('yt-dlp')))).toBe(false)
  })
})

describe('EngineInstaller — FFmpeg toolchain', () => {
  const archive = Buffer.from('pretend archive')
  const provider = (sha = sha256(archive)): FfmpegProvider => ({
    id: 'test',
    info: { name: 'Test builds', homepage: 'https://github.com', license: 'LGPL' },
    maxArchiveBytes: 1024,
    latest: async () => ({ version: '9.0.2', build: 'n9.0.2-42-gabc', releasedAt: null, notesUrl: null }),
    resolve: async () => ({
      version: '9.0.2',
      archives: [{ url: 'https://github.com/ffmpeg.zip', fileName: 'ffmpeg.zip', sha256: sha, size: archive.length }]
    })
  })
  const extractBoth = async (_archive: string, destination: string) => {
    const bin = join(destination, 'ffmpeg-n9.0.2', 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, exe('ffmpeg')), Buffer.concat([nativeExecutable(), Buffer.from('ffmpeg')]))
    writeFileSync(join(bin, exe('ffprobe')), Buffer.concat([nativeExecutable(), Buffer.from('ffprobe')]))
  }

  it('installs FFmpeg and FFprobe together', async () => {
    const { installer, manifest } = setup({
      routes: { 'https://github.com/ffmpeg.zip': { body: archive } },
      versions: { [exe('ffmpeg')]: 'n9.0.2-42', [exe('ffprobe')]: 'n9.0.2-42' },
      provider: provider(),
      extract: extractBoth
    })
    const installed = await installer.installFfmpegToolchain(new AbortController().signal, noop)
    expect(installed.map((e) => [e.id, e.version])).toEqual([
      ['ffmpeg', '9.0.2'],
      ['ffprobe', '9.0.2']
    ])
    expect(existsSync(join(engineDir, exe('ffmpeg')))).toBe(true)
    expect(existsSync(join(engineDir, exe('ffprobe')))).toBe(true)
    expect(await manifest.get('ffprobe')).toMatchObject({ version: '9.0.2', provider: 'test' })
  })

  it('refuses mismatched FFmpeg and FFprobe builds', async () => {
    const { installer } = setup({
      routes: { 'https://github.com/ffmpeg.zip': { body: archive } },
      versions: { [exe('ffmpeg')]: 'n9.0.2-42', [exe('ffprobe')]: 'n8.1' },
      provider: provider(),
      extract: extractBoth
    })
    expect(await codeOf(installer.installFfmpegToolchain(new AbortController().signal, noop))).toBe('INTEGRITY')
    expect(existsSync(join(engineDir, exe('ffmpeg')))).toBe(false)
  })

  it('never extracts an archive with the wrong checksum', async () => {
    const extract = vi.fn(extractBoth)
    const { installer } = setup({
      routes: { 'https://github.com/ffmpeg.zip': { body: archive } },
      provider: provider('0'.repeat(64)),
      extract
    })
    expect(await codeOf(installer.installFfmpegToolchain(new AbortController().signal, noop))).toBe('INTEGRITY')
    expect(extract).not.toHaveBeenCalled()
  })

  it('reports platforms without a trusted provider', async () => {
    const { installer } = setup({ provider: null })
    expect(await codeOf(installer.installFfmpegToolchain(new AbortController().signal, noop))).toBe('UNSUPPORTED')
  })
})

describe('EngineInstaller — crash recovery', () => {
  it('restores a backup whose replacement never arrived and drops stale ones', async () => {
    mkdirSync(engineDir, { recursive: true })
    mkdirSync(join(stagingRoot, 'install-abc'), { recursive: true })
    writeFileSync(join(engineDir, `${exe('ffmpeg')}.previous`), 'old ffmpeg')
    writeFileSync(join(engineDir, exe('ffprobe')), 'new ffprobe')
    writeFileSync(join(engineDir, `${exe('ffprobe')}.previous`), 'old ffprobe')

    const { installer } = setup({})
    await installer.recoverInterruptedInstalls()

    expect(readFileSync(join(engineDir, exe('ffmpeg')), 'utf8')).toBe('old ffmpeg')
    expect(readFileSync(join(engineDir, exe('ffprobe')), 'utf8')).toBe('new ffprobe')
    expect(readdirSync(engineDir).sort()).toEqual([exe('ffmpeg'), exe('ffprobe')].sort())
    expect(existsSync(stagingRoot)).toBe(false)
  })
})

describe('findExtractedExecutable', () => {
  it('prefers the copy inside bin/', async () => {
    mkdirSync(join(root, 'pkg', 'doc'), { recursive: true })
    mkdirSync(join(root, 'pkg', 'bin'), { recursive: true })
    writeFileSync(join(root, 'pkg', 'doc', 'ffmpeg'), 'doc')
    writeFileSync(join(root, 'pkg', 'bin', 'ffmpeg'), 'bin')
    expect(await findExtractedExecutable(root, 'ffmpeg')).toBe(join(root, 'pkg', 'bin', 'ffmpeg'))
    expect(await findExtractedExecutable(root, 'ffprobe')).toBeNull()
  })
})

describe('EngineInstaller — updates and rollback', () => {
  const v1 = Buffer.concat([nativeExecutable(), Buffer.from('yt-dlp 2026.09.01')])
  const v2 = Buffer.concat([nativeExecutable(), Buffer.from('yt-dlp 2026.10.26 build')])
  const kept = () => join(engineDir, '.rollback', 'yt-dlp', exe('yt-dlp'))

  /** Installs v1, then updates to v2; the runner reports whatever `versions` says at the time. */
  async function installBoth() {
    const versions: Record<string, string | null> = { [exe('yt-dlp')]: '2026.09.01' }
    let release = ytDlpRelease(v1, { version: '2026.09.01', url: 'https://github.com/v1.bin' })
    const { installer, manifest } = setup({
      routes: { 'https://github.com/v1.bin': { body: v1 }, 'https://github.com/v2.bin': { body: v2 } },
      versions,
      resolveYtDlp: (...args) => release(...(args as []))
    })
    await installer.installYtDlp(new AbortController().signal, noop)
    versions[exe('yt-dlp')] = '2026.10.26'
    release = ytDlpRelease(v2, { url: 'https://github.com/v2.bin' })
    return { installer, manifest, versions, update: () => installer.installYtDlp(new AbortController().signal, noop) }
  }

  it('keeps the replaced version, with its install record, for rolling back', async () => {
    const { installer, manifest, update } = await installBoth()
    expect(await installer.rollbackInfo('yt-dlp')).toBeNull() // a fresh install has nothing to go back to
    await update()
    expect(readFileSync(join(engineDir, exe('yt-dlp'))).equals(v2)).toBe(true)
    expect(readFileSync(kept()).equals(v1)).toBe(true)
    expect((await installer.rollbackInfo('yt-dlp'))?.entries['yt-dlp']).toMatchObject({ version: '2026.09.01', sha256: sha256(v1) })
    expect(await manifest.get('yt-dlp')).toMatchObject({ version: '2026.10.26', sha256: sha256(v2) })
    // No stray backups next to the engines.
    expect(readdirSync(engineDir).filter((name) => name.endsWith('.previous'))).toEqual([])
  })

  it('rolls back, keeping the newer version so the rollback can be undone', async () => {
    const { installer, manifest, versions, update } = await installBoth()
    await update()
    versions[exe('yt-dlp')] = '2026.09.01'
    const restored = await installer.rollback('yt-dlp')
    expect(restored).toEqual([{ id: 'yt-dlp', version: '2026.09.01', path: join(engineDir, exe('yt-dlp')) }])
    expect(readFileSync(join(engineDir, exe('yt-dlp'))).equals(v1)).toBe(true)
    expect(await manifest.get('yt-dlp')).toMatchObject({ version: '2026.09.01', sha256: sha256(v1) })
    expect(readFileSync(kept()).equals(v2)).toBe(true)
    expect((await installer.rollbackInfo('yt-dlp'))?.entries['yt-dlp']?.version).toBe('2026.10.26')
  })

  it('refuses to restore a kept copy that was changed, and leaves everything as it was', async () => {
    const { installer, update } = await installBoth()
    await update()
    const tampered = Buffer.from(v1)
    tampered[tampered.length - 1] = 0x21 // same size, different content
    writeFileSync(kept(), tampered)
    expect(await codeOf(installer.rollback('yt-dlp'))).toBe('INTEGRITY')
    expect(readFileSync(join(engineDir, exe('yt-dlp'))).equals(v2)).toBe(true)
    expect(existsSync(kept())).toBe(true)
    // A kept copy of the wrong size is not offered at all.
    writeFileSync(kept(), 'short')
    expect(await installer.rollbackInfo('yt-dlp')).toBeNull()
    expect(await codeOf(installer.rollback('yt-dlp'))).toBe('NOT_FOUND')
  })

  it('puts the previous version back when the new one fails once in place', async () => {
    const { installer, manifest, update } = await installBoth()
    installedCopiesFail = true
    const failure = await update().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(UpdateRolledBack)
    expect((failure as Error).message).toMatch(/previous version was restored/)
    expect(readFileSync(join(engineDir, exe('yt-dlp'))).equals(v1)).toBe(true)
    expect(await manifest.get('yt-dlp')).toMatchObject({ version: '2026.09.01' })
    expect(await installer.rollbackInfo('yt-dlp')).toBeNull()
    expect(readdirSync(engineDir).filter((name) => name.endsWith('.previous'))).toEqual([])
  })

  it('records the channel a yt-dlp build came from', async () => {
    const { installer, manifest } = setup({
      routes: { 'https://github.com/nightly.bin': { body: v2 } },
      versions: { [exe('yt-dlp')]: '2026.11.04.232659' },
      resolveYtDlp: ytDlpRelease(v2, { channel: 'nightly', version: '2026.11.04.232659', url: 'https://github.com/nightly.bin' })
    })
    await installer.installYtDlp(new AbortController().signal, noop, 'nightly')
    expect(await manifest.get('yt-dlp')).toMatchObject({ provider: 'yt-dlp-nightly', version: '2026.11.04.232659' })
  })
})
