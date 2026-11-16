import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { z } from 'zod'
import type { EngineId, InstallStage, InstallTarget } from '@shared/types/engines'
import type { ArchiveExtractor } from '../../utils/archive'
import { sha256File } from '../../utils/checksum'
import { ensureFreeSpace } from '../../utils/disk'
import { AppError } from '../../utils/errors'
import type { Logger } from '../../utils/logger'
import type { TrustedHttpClient } from '../network/trusted-http'
import { incompatibilityReason, inspectBinary } from './binary-format'
import type { EngineManifestStore, ManifestEntry } from './engine-manifest'
import type { EngineProber, ProbeResult } from './engine-probe'
import type { ArchivePackage } from './archive-package'
import { DENO_MAX_ARCHIVE_BYTES, resolveDenoPackage } from './deno-engine'
import type { FfmpegProvider } from './ffmpeg-engine'
import { executableName, type PlatformTarget } from './platform'
import { YTDLP_PROVIDER_IDS, resolveYtDlpDownload, type ResolvedDownload, type YtDlpChannel } from './ytdlp-engine'

export interface InstallProgressUpdate {
  stage: InstallStage
  receivedBytes: number
  totalBytes: number | null
  version: string | null
}

export type ProgressListener = (update: InstallProgressUpdate) => void

export interface InstalledEngine {
  id: EngineId
  version: string
  path: string
}

export interface EngineInstallerDeps {
  http: TrustedHttpClient
  target: PlatformTarget
  /** Managed engines folder for this platform, e.g. <userData>/engines/win32-x64 */
  engineDir: string
  /** Scratch space on the same volume as engineDir, so the final move is a rename. */
  stagingRoot: string
  prober: EngineProber
  manifest: EngineManifestStore
  ffmpegProvider: FfmpegProvider | null
  extract: ArchiveExtractor
  logger: Logger
  /** Overridable for tests; defaults to the signed GitHub release lookup. */
  resolveYtDlp?: (http: TrustedHttpClient, target: PlatformTarget, signal?: AbortSignal, channel?: YtDlpChannel) => Promise<ResolvedDownload>
  /** Overridable for tests; defaults to Deno's GitHub release lookup. */
  resolveDeno?: (http: TrustedHttpClient, target: PlatformTarget, signal?: AbortSignal) => Promise<ArchivePackage>
}

/**
 * The new version failed its check after being put in place, and the previous
 * version was restored. Recorded as "rolled back" in the update history.
 */
export class UpdateRolledBack extends AppError {
  constructor(message: string, options?: { cause?: unknown }) {
    super('INTEGRITY', message, options)
    this.name = 'UpdateRolledBack'
  }
}

/** The version kept for rolling back one install target. */
export interface RollbackSet {
  savedAt: string
  entries: Partial<Record<EngineId, ManifestEntry>>
}

const TARGET_ENGINES: Record<InstallTarget, EngineId[]> = {
  'yt-dlp': ['yt-dlp'],
  ffmpeg: ['ffmpeg', 'ffprobe'],
  deno: ['deno']
}
const ENGINE_LABELS: Record<EngineId, string> = { 'yt-dlp': 'yt-dlp', ffmpeg: 'FFmpeg', ffprobe: 'FFprobe', deno: 'Deno' }

/** Slack allowed over the size GitHub reports, before a download is treated as suspicious. */
const SIZE_TOLERANCE_BYTES = 1024 * 1024
const BACKUP_SUFFIX = '.previous'
const ROLLBACK_DIR = '.rollback'
const ROLLBACK_RECORD = 'rollback.json'

const manifestEntrySchema = z.object({
  version: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative(),
  installedAt: z.string(),
  provider: z.string(),
  sourceUrl: z.string()
})
const rollbackSchema = z.object({
  savedAt: z.string(),
  entries: z.partialRecord(z.enum(['yt-dlp', 'ffmpeg', 'ffprobe', 'deno']), manifestEntrySchema)
})

interface Placement {
  id: EngineId
  staged: string
  destination: string
}

/**
 * Downloads, verifies and installs managed engines. Nothing reaches the
 * engines folder unless its checksum matches the provider's published value,
 * the binary targets this platform, and it runs and reports a version — both
 * in the staging folder and again once in place. The version it replaces is
 * kept for rolling back.
 */
export class EngineInstaller {
  constructor(private readonly deps: EngineInstallerDeps) {}

  async installYtDlp(signal: AbortSignal, onProgress: ProgressListener, channel: YtDlpChannel = 'stable'): Promise<InstalledEngine[]> {
    const { http, target, prober } = this.deps
    onProgress({ stage: 'resolving', receivedBytes: 0, totalBytes: null, version: null })
    const resolve = this.deps.resolveYtDlp ?? resolveYtDlpDownload
    const download = await resolve(http, target, signal, channel)
    const { version } = download

    return this.withStaging(async (stagingDir) => {
      await ensureFreeSpace(stagingDir, download.size * 2)
      const staged = join(stagingDir, executableName('yt-dlp', target.platform))

      const result = await http.download(download.url, staged, {
        signal,
        maxBytes: download.size + SIZE_TOLERANCE_BYTES,
        onProgress: (p) => onProgress({ stage: 'downloading', ...p, version })
      })

      onProgress({ stage: 'verifying', receivedBytes: result.size, totalBytes: result.size, version })
      if (result.sha256 !== download.sha256) {
        throw new AppError('INTEGRITY', 'The downloaded yt-dlp does not match its signed checksum. It was discarded.')
      }
      await this.prepareExecutable(staged)
      const probe = expectWorking(await prober.probeYtDlp(staged), 'yt-dlp')

      onProgress({ stage: 'installing', receivedBytes: result.size, totalBytes: result.size, version })
      const destination = join(this.deps.engineDir, basename(staged))
      const entry = manifestEntry(probe.version.version, result.sha256, result.size, YTDLP_PROVIDER_IDS[download.channel ?? channel], download.url)
      await this.commit('yt-dlp', [{ id: 'yt-dlp', staged, destination }], { 'yt-dlp': entry })
      return [{ id: 'yt-dlp', version: probe.version.version, path: destination }]
    })
  }

  async installFfmpegToolchain(signal: AbortSignal, onProgress: ProgressListener): Promise<InstalledEngine[]> {
    const { http, target, ffmpegProvider: provider } = this.deps
    if (!provider) {
      throw new AppError('UNSUPPORTED', `No trusted FFmpeg build is available for ${target.key}. Install FFmpeg with your system package manager.`)
    }
    onProgress({ stage: 'resolving', receivedBytes: 0, totalBytes: null, version: null })
    const pkg = await provider.resolve(http, signal)
    return this.installArchivePackage('ffmpeg', pkg, { providerId: provider.id, maxArchiveBytes: provider.maxArchiveBytes, requireSameBuild: true }, signal, onProgress)
  }

  async installDeno(signal: AbortSignal, onProgress: ProgressListener): Promise<InstalledEngine[]> {
    const { http, target } = this.deps
    onProgress({ stage: 'resolving', receivedBytes: 0, totalBytes: null, version: null })
    const resolve = this.deps.resolveDeno ?? resolveDenoPackage
    const pkg = await resolve(http, target, signal)
    return this.installArchivePackage('deno', pkg, { providerId: 'deno-github', maxArchiveBytes: DENO_MAX_ARCHIVE_BYTES, requireSameBuild: false }, signal, onProgress)
  }

  /** The version kept for rolling back `target`, or null when there is none. */
  async rollbackInfo(target: InstallTarget): Promise<RollbackSet | null> {
    const dir = this.rollbackDir(target)
    try {
      const parsed = rollbackSchema.safeParse(JSON.parse(await readFile(join(dir, ROLLBACK_RECORD), 'utf8')))
      if (!parsed.success) return null
      for (const id of TARGET_ENGINES[target]) {
        if (!parsed.data.entries[id]) return null
        const file = join(dir, executableName(id, this.deps.target.platform))
        if ((await stat(file)).size !== parsed.data.entries[id]!.size) return null
      }
      return parsed.data
    } catch {
      return null
    }
  }

  /**
   * Puts the kept previous version back. It is checked (hash, then run) before
   * and after the swap; the version it replaces becomes the new rollback copy,
   * so a rollback can itself be undone.
   */
  async rollback(target: InstallTarget): Promise<InstalledEngine[]> {
    const kept = await this.rollbackInfo(target)
    if (!kept) throw new AppError('NOT_FOUND', 'There is no previous version to roll back to.')
    const dir = this.rollbackDir(target)
    const ids = TARGET_ENGINES[target]
    return this.withStaging(async (stagingDir) => {
      const placements: Placement[] = []
      for (const id of ids) {
        const name = executableName(id, this.deps.target.platform)
        const staged = join(stagingDir, name)
        await rename(join(dir, name), staged)
        placements.push({ id, staged, destination: join(this.deps.engineDir, name) })
      }
      try {
        for (const placement of placements) {
          if ((await sha256File(placement.staged)) !== kept.entries[placement.id]!.sha256) {
            throw new AppError('INTEGRITY', `The kept ${ENGINE_LABELS[placement.id]} has changed since it was saved, so it was not restored.`)
          }
          await this.prepareExecutable(placement.staged)
          expectWorking(await this.probe(placement.id, placement.staged), ENGINE_LABELS[placement.id])
        }
      } catch (error) {
        // Leave the rollback copy where it was.
        for (const placement of placements) await rename(placement.staged, join(dir, basename(placement.destination))).catch(() => {})
        throw error
      }
      await rm(join(dir, ROLLBACK_RECORD), { force: true })
      await this.commit(target, placements, kept.entries)
      return ids.map((id) => ({ id, version: kept.entries[id]!.version, path: join(this.deps.engineDir, executableName(id, this.deps.target.platform)) }))
    })
  }

  /**
   * Shared path for engines distributed as archives: download each archive,
   * verify its checksum before extracting anything, locate the executables,
   * check and run them, then swap them into place together.
   */
  private async installArchivePackage(
    target: InstallTarget,
    pkg: ArchivePackage,
    spec: { providerId: string; maxArchiveBytes: number; requireSameBuild: boolean },
    signal: AbortSignal,
    onProgress: ProgressListener
  ): Promise<InstalledEngine[]> {
    const { http } = this.deps
    const { version } = pkg
    const ids = TARGET_ENGINES[target]
    const knownTotal = pkg.archives.every((a) => a.size !== null) ? pkg.archives.reduce((sum, a) => sum + (a.size ?? 0), 0) : null

    return this.withStaging(async (stagingDir) => {
      // Archive + extracted contents + the installed copies.
      await ensureFreeSpace(stagingDir, (knownTotal ?? spec.maxArchiveBytes) * 4)
      const extractDir = join(stagingDir, 'extracted')
      await mkdir(extractDir)

      let completed = 0
      for (const archive of pkg.archives) {
        const archivePath = join(stagingDir, archive.fileName)
        const result = await http.download(archive.url, archivePath, {
          signal,
          maxBytes: archive.size !== null ? archive.size + SIZE_TOLERANCE_BYTES : spec.maxArchiveBytes,
          onProgress: (p) => onProgress({ stage: 'downloading', receivedBytes: completed + p.receivedBytes, totalBytes: knownTotal, version })
        })
        completed += result.size
        onProgress({ stage: 'verifying', receivedBytes: completed, totalBytes: knownTotal, version })
        if (result.sha256 !== archive.sha256) {
          throw new AppError('INTEGRITY', `${archive.fileName} does not match its published checksum. It was discarded.`)
        }
        onProgress({ stage: 'extracting', receivedBytes: completed, totalBytes: knownTotal, version })
        await this.deps.extract(archivePath, extractDir, signal)
        await rm(archivePath, { force: true })
      }

      const staged: { id: EngineId; path: string; version: string; build: string }[] = []
      for (const id of ids) {
        const path = await findExtractedExecutable(extractDir, executableName(id, this.deps.target.platform))
        if (!path) throw new AppError('INTEGRITY', `The downloaded archive does not contain ${ENGINE_LABELS[id]}.`)
        await this.prepareExecutable(path)
        const probe = expectWorking(await this.probe(id, path), ENGINE_LABELS[id])
        staged.push({ id, path, version: probe.version.version, build: probe.version.build })
      }
      if (spec.requireSameBuild && new Set(staged.map((s) => s.build)).size > 1) {
        throw new AppError('INTEGRITY', `The downloaded ${ids.map((id) => ENGINE_LABELS[id]).join(' and ')} report different versions.`)
      }

      onProgress({ stage: 'installing', receivedBytes: completed, totalBytes: knownTotal, version })
      const sourceUrl = pkg.archives.map((a) => a.url).join(' ')
      // Hashed before moving: the archives were verified; these record the installed files.
      const entries = Object.fromEntries(
        await Promise.all(staged.map(async (s) => [s.id, await this.recordFor(s.path, s.version, spec.providerId, sourceUrl)] as const))
      ) as Partial<Record<EngineId, ManifestEntry>>
      const placements = staged.map((s) => ({ id: s.id, staged: s.path, destination: join(this.deps.engineDir, basename(s.path)) }))
      await this.commit(target, placements, entries)
      return staged.map((s) => ({ id: s.id, version: s.version, path: join(this.deps.engineDir, basename(s.path)) }))
    })
  }

  /**
   * Swaps the staged files in, runs them again where they now live, and only
   * then records them. If any of them fails that check, the previous files
   * are put back (UpdateRolledBack). On success the replaced version is kept
   * as the rollback copy for `target`.
   */
  private async commit(target: InstallTarget, placements: Placement[], entries: Partial<Record<EngineId, ManifestEntry>>): Promise<void> {
    const before = (await this.deps.manifest.read()).engines
    const backedUp = await this.swapIntoPlace(placements)

    for (const placement of placements) {
      const result = await this.probe(placement.id, placement.destination).catch(
        (error: unknown): ProbeResult => ({ ok: false, problem: { code: 'VERSION_FAILED', message: String(error) } })
      )
      if (!result.ok) {
        await this.restoreBackups(placements, backedUp)
        const label = ENGINE_LABELS[placement.id]
        this.deps.logger.error(`${label} failed its check after installation; restored the previous version`, result.problem)
        throw new UpdateRolledBack(
          backedUp.length > 0
            ? `The new ${label} did not work after installation (${result.problem.message}). The previous version was restored.`
            : `The new ${label} did not work after installation (${result.problem.message}). It was removed.`
        )
      }
    }

    await this.keepForRollback(target, placements, backedUp, before)
    await this.deps.manifest.update(entries)
  }

  /** Moves the replaced files (`<name>.previous`) into `.rollback/<target>` with their install records. */
  private async keepForRollback(
    target: InstallTarget,
    placements: Placement[],
    backedUp: string[],
    before: Partial<Record<EngineId, ManifestEntry>>
  ): Promise<void> {
    const dir = this.rollbackDir(target)
    const complete = placements.every((p) => backedUp.includes(p.destination) && before[p.id])
    try {
      if (!complete) {
        // A fresh install, or an unrecorded/broken copy was replaced: nothing worth rolling back to.
        for (const destination of backedUp) await rm(destination + BACKUP_SUFFIX, { force: true })
        await rm(dir, { recursive: true, force: true })
        return
      }
      await rm(dir, { recursive: true, force: true })
      await mkdir(dir, { recursive: true })
      for (const p of placements) await rename(p.destination + BACKUP_SUFFIX, join(dir, basename(p.destination)))
      const record: RollbackSet = {
        savedAt: new Date().toISOString(),
        entries: Object.fromEntries(placements.map((p) => [p.id, before[p.id]!])) as Partial<Record<EngineId, ManifestEntry>>
      }
      await writeFile(join(dir, ROLLBACK_RECORD), JSON.stringify(record, null, 2), 'utf8')
    } catch (error) {
      // Rolling back is a convenience; the update itself has succeeded.
      this.deps.logger.warn(`Could not keep the previous ${target} for rolling back`, error)
      for (const destination of backedUp) await rm(destination + BACKUP_SUFFIX, { force: true }).catch(() => {})
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  private rollbackDir(target: InstallTarget): string {
    return join(this.deps.engineDir, ROLLBACK_DIR, target)
  }

  private probe(id: EngineId, path: string): Promise<ProbeResult> {
    const { prober } = this.deps
    switch (id) {
      case 'yt-dlp':
        return prober.probeYtDlp(path)
      case 'ffmpeg':
        return prober.probeFfmpeg(path)
      case 'ffprobe':
        return prober.probeFfprobe(path)
      case 'deno':
        return prober.probeDeno(path)
    }
  }

  /**
   * Completes or undoes a swap interrupted by a crash or power loss: a leftover
   * `<name>.previous` is restored when `<name>` is missing, otherwise removed.
   * Also clears abandoned staging folders.
   */
  async recoverInterruptedInstalls(): Promise<void> {
    await rm(this.deps.stagingRoot, { recursive: true, force: true })
    let entries: string[]
    try {
      entries = await readdir(this.deps.engineDir)
    } catch {
      return
    }
    for (const entry of entries.filter((name) => name.endsWith(BACKUP_SUFFIX))) {
      const backup = join(this.deps.engineDir, entry)
      const original = backup.slice(0, -BACKUP_SUFFIX.length)
      if (await exists(original)) {
        await rm(backup, { force: true })
      } else {
        await rename(backup, original)
        this.deps.logger.warn(`Restored ${basename(original)} after an interrupted installation`)
      }
    }
  }

  private async withStaging<T>(work: (stagingDir: string) => Promise<T>): Promise<T> {
    await mkdir(this.deps.engineDir, { recursive: true })
    await mkdir(this.deps.stagingRoot, { recursive: true })
    const stagingDir = await mkdtemp(join(this.deps.stagingRoot, 'install-'))
    try {
      return await work(stagingDir)
    } finally {
      await rm(stagingDir, { recursive: true, force: true }).catch((error: unknown) => this.deps.logger.warn('Could not remove staging folder', error))
    }
  }

  private async prepareExecutable(path: string): Promise<void> {
    if (this.deps.target.platform !== 'win32') await chmod(path, 0o755)
    const reason = incompatibilityReason(await inspectBinary(path), this.deps.target.platform, this.deps.target.arch)
    if (reason) throw new AppError('INTEGRITY', `The downloaded file cannot run on this computer. ${reason}`)
  }

  private async recordFor(path: string, version: string, provider: string, url: string): Promise<ManifestEntry> {
    const [sha256, info] = await Promise.all([sha256File(path), stat(path)])
    return manifestEntry(version, sha256, info.size, provider, url)
  }

  /**
   * Moves staged files over the installed ones. Existing files are first renamed
   * to `<name>.previous`; if any step fails, every file is put back. Returns the
   * destinations that had a previous file (still kept as `.previous`).
   */
  private async swapIntoPlace(pairs: Placement[]): Promise<string[]> {
    const backedUp: string[] = []
    const placed: string[] = []
    try {
      for (const { staged, destination } of pairs) {
        if (await exists(destination)) {
          await rm(destination + BACKUP_SUFFIX, { force: true })
          await rename(destination, destination + BACKUP_SUFFIX)
          backedUp.push(destination)
        }
        await rename(staged, destination)
        placed.push(destination)
      }
    } catch (error) {
      await this.restoreBackups(
        pairs.filter((p) => placed.includes(p.destination)),
        backedUp
      )
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EBUSY' || code === 'EPERM') {
        throw new AppError('BUSY', 'An engine file is in use. Close any program using it and try again.', { cause: error })
      }
      throw error
    }
    return backedUp
  }

  /** Removes newly placed files and puts every `.previous` back. */
  private async restoreBackups(placed: Placement[], backedUp: string[]): Promise<void> {
    for (const { destination } of placed) await rm(destination, { force: true }).catch(() => {})
    for (const destination of backedUp) {
      await rename(destination + BACKUP_SUFFIX, destination).catch((restoreError: unknown) =>
        this.deps.logger.error(`Could not restore ${destination}`, restoreError)
      )
    }
  }
}

function manifestEntry(version: string, sha256: string, size: number, provider: string, sourceUrl: string): ManifestEntry {
  return { version, sha256, size, installedAt: new Date().toISOString(), provider, sourceUrl }
}

function expectWorking(probe: ProbeResult, name: string): Extract<ProbeResult, { ok: true }> {
  if (!probe.ok) {
    throw new AppError('INTEGRITY', `The downloaded ${name} could not be run: ${probe.problem.message}`)
  }
  return probe
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Finds a regular file named `name` in the extracted tree. Symlinks are ignored
 * so an archive cannot point the installer at files outside the staging folder.
 * Prefers a copy inside a `bin` folder, as FFmpeg distributions use.
 */
export async function findExtractedExecutable(root: string, name: string): Promise<string | null> {
  const matches: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6) return
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.isFile() && entry.name === name) matches.push(full)
    }
  }
  await walk(root, 0)
  matches.sort((a, b) => Number(basename(join(b, '..')) === 'bin') - Number(basename(join(a, '..')) === 'bin') || a.length - b.length)
  return matches[0] ?? null
}
