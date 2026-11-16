import { createWriteStream, existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { AppError } from './errors'
import { runProcess, type ProcessRunner } from './process'

export type ArchiveExtractor = (archive: string, destination: string, signal?: AbortSignal) => Promise<void>

/**
 * Extracts `.zip` files in-process and everything else (`.tar.xz`, `.tar.gz`)
 * with the operating system's tar. Linux's GNU tar cannot read zip files, and
 * some engines (Deno) are only published as zip.
 */
export function createArchiveExtractor(tarPath: string | null, run: ProcessRunner = runProcess): ArchiveExtractor {
  const tar = createTarExtractor(tarPath, run)
  return (archive, destination, signal) =>
    archive.toLowerCase().endsWith('.zip') ? extractZip(archive, destination, signal) : tar(archive, destination, signal)
}

/**
 * Locates the operating system's tar. Windows 10 1803+ and macOS ship bsdtar
 * (zip, tar.xz, tar.gz); Linux ships GNU tar (tar.xz needs `xz` installed).
 * Only absolute, well-known locations are used so PATH cannot substitute a
 * different program.
 */
export function findSystemTar(platform: NodeJS.Platform = process.platform): string | null {
  const candidates =
    platform === 'win32'
      ? [join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')]
      : ['/usr/bin/tar', '/bin/tar']
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

/**
 * Extracts `archive` into the existing directory `destination`. Both bsdtar
 * and GNU tar refuse absolute member paths and `..` traversal by default.
 * Callers must still treat extracted files as untrusted.
 */
export function createTarExtractor(tarPath: string | null, run: ProcessRunner = runProcess): ArchiveExtractor {
  return async (archive, destination, signal) => {
    if (!tarPath) {
      throw new AppError('UNSUPPORTED', 'The system "tar" program was not found, so the archive cannot be extracted.')
    }
    const result = await run(tarPath, ['-xf', archive, '-C', destination], { timeoutMs: 10 * 60_000, signal })
    if (result.exitCode !== 0) {
      throw new AppError(
        'OPERATION_FAILED',
        'The downloaded archive could not be extracted. On Linux, make sure "xz" is installed.',
        { cause: result.stderr.trim() }
      )
    }
  }
}

export interface ZipLimits {
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
}

const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 1024 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024
}

/**
 * Extracts regular files and directories only (symlink entries are written as
 * plain files, never as links). yauzl rejects absolute paths and `..`
 * segments; every target is additionally checked to stay inside `destination`.
 * Declared and actual sizes are bounded to defuse zip bombs.
 */
export async function extractZip(
  archive: string,
  destination: string,
  signal?: AbortSignal,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS
): Promise<void> {
  const root = resolve(destination)
  const zip = await new Promise<yauzl.ZipFile>((resolvePromise, reject) =>
    yauzl.open(archive, { lazyEntries: true, autoClose: true, validateEntrySizes: true, strictFileNames: true }, (error, file) =>
      error || !file ? reject(invalidArchive(error)) : resolvePromise(file)
    )
  )

  let entries = 0
  let total = 0
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const fail = (error: unknown): void => {
        zip.close()
        reject(error instanceof AppError ? error : invalidArchive(error))
      }
      zip.on('error', fail)
      zip.on('end', () => resolvePromise())
      zip.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          if (signal?.aborted) throw new AppError('CANCELLED', 'The installation was cancelled.')
          entries += 1
          total += entry.uncompressedSize
          if (entries > limits.maxEntries || entry.uncompressedSize > limits.maxEntryBytes || total > limits.maxTotalBytes) {
            throw new AppError('INTEGRITY', 'The archive is larger than allowed.')
          }
          const target = resolve(root, entry.fileName)
          if (target !== root && !target.startsWith(root + sep)) {
            throw new AppError('INTEGRITY', 'The archive contains a path outside its folder.')
          }
          if (entry.fileName.endsWith('/')) {
            await mkdir(target, { recursive: true })
          } else {
            await mkdir(dirname(target), { recursive: true })
            const source = await new Promise<NodeJS.ReadableStream>((ok, ko) =>
              zip.openReadStream(entry, (error, stream) => (error || !stream ? ko(invalidArchive(error)) : ok(stream)))
            )
            await pipeline(source, createWriteStream(target, { flags: 'wx' }), { signal })
          }
          zip.readEntry()
        })().catch(fail)
      })
      zip.readEntry()
    })
  } catch (error) {
    if (signal?.aborted) throw new AppError('CANCELLED', 'The installation was cancelled.', { cause: error })
    throw error
  }
}

function invalidArchive(cause: unknown): AppError {
  return new AppError('INTEGRITY', 'The downloaded archive is damaged or invalid.', { cause })
}
