import { stat } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'
import type { EngineId, EngineSource } from '@shared/types/engines'
import { executableName } from './platform'

export interface EngineLocations {
  /** <userData>/engines/<platform>-<arch> */
  managed: string
  /** Engines shipped inside the application package, if any. */
  bundled: string | null
  /** Directories searched for system-installed engines, in order. */
  system: readonly string[]
}

export interface LocatedEngine {
  source: EngineSource
  path: string
}

/** Extra places GUI apps miss because they do not inherit the login shell's PATH. */
const EXTRA_SYSTEM_DIRS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'],
  linux: ['/usr/local/bin', '/usr/bin', '/snap/bin']
}

/**
 * PATH directories plus well-known package-manager locations. Relative PATH
 * entries (such as ".") are dropped so the working directory can never supply
 * an executable.
 */
export function systemSearchDirs(pathValue: string | undefined, platform: NodeJS.Platform): string[] {
  const rules = platform === 'win32' ? win32 : posix
  const fromPath = (pathValue ?? '')
    .split(rules.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry.length > 0 && rules.isAbsolute(entry))
  const all = [...fromPath, ...(EXTRA_SYSTEM_DIRS[platform] ?? [])]
  const seen = new Set<string>()
  return all.filter((dir) => {
    const key = platform === 'win32' ? dir.toLowerCase() : dir
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function orderedCandidates(locations: EngineLocations): { source: EngineSource; dir: string }[] {
  return [
    { source: 'managed', dir: locations.managed },
    ...(locations.bundled ? [{ source: 'bundled' as const, dir: locations.bundled }] : []),
    ...locations.system.map((dir) => ({ source: 'system' as const, dir }))
  ]
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Returns the first existing copy of `engine`, preferring managed, then bundled, then system. */
export async function locateEngine(
  engine: EngineId,
  locations: EngineLocations,
  platform: NodeJS.Platform
): Promise<LocatedEngine | null> {
  const name = executableName(engine, platform)
  for (const candidate of orderedCandidates(locations)) {
    const path = join(candidate.dir, name)
    if (await isFile(path)) return { source: candidate.source, path }
  }
  return null
}

/**
 * FFmpeg and FFprobe must come from the same place so their versions match.
 * The first location containing both wins. If none has both, the first
 * location containing either is returned so the missing half can be reported.
 */
export async function locateFfmpegToolchain(
  locations: EngineLocations,
  platform: NodeJS.Platform
): Promise<{ ffmpeg: LocatedEngine | null; ffprobe: LocatedEngine | null }> {
  let partial: { ffmpeg: LocatedEngine | null; ffprobe: LocatedEngine | null } | null = null
  for (const candidate of orderedCandidates(locations)) {
    const ffmpegPath = join(candidate.dir, executableName('ffmpeg', platform))
    const ffprobePath = join(candidate.dir, executableName('ffprobe', platform))
    const [hasFfmpeg, hasFfprobe] = await Promise.all([isFile(ffmpegPath), isFile(ffprobePath)])
    const found = {
      ffmpeg: hasFfmpeg ? { source: candidate.source, path: ffmpegPath } : null,
      ffprobe: hasFfprobe ? { source: candidate.source, path: ffprobePath } : null
    }
    if (hasFfmpeg && hasFfprobe) return found
    if ((hasFfmpeg || hasFfprobe) && !partial) partial = found
  }
  return partial ?? { ffmpeg: null, ffprobe: null }
}
