import type { EngineId } from '@shared/types/engines'

export type Libc = 'glibc' | 'musl'

export interface PlatformTarget {
  platform: NodeJS.Platform
  arch: string
  /** Only set on Linux, where glibc and musl need different builds. */
  libc: Libc | null
  /** e.g. "win32-x64"; also the name of the managed engines sub-folder. */
  key: string
}

export function detectPlatform(platform: NodeJS.Platform = process.platform, arch: string = process.arch): PlatformTarget {
  const libc = platform === 'linux' ? detectLibc() : null
  return { platform, arch, libc, key: `${platform}-${arch}` }
}

function detectLibc(): Libc {
  // Same heuristic Node's own tooling uses: glibc builds report their runtime version.
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  return report?.header?.glibcVersionRuntime ? 'glibc' : 'musl'
}

export function executableName(engine: EngineId, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${engine}.exe` : engine
}
