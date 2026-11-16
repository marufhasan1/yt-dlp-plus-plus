import { z } from 'zod'
import type { EngineProviderInfo } from '@shared/types/engines'
import { isSha256, parseChecksumList, sha256FromDigest } from '../../utils/checksum'
import { AppError } from '../../utils/errors'
import type { TrustedHttpClient } from '../network/trusted-http'
import { githubReleaseSchema, type GithubAsset, type GithubRelease } from './github-release'
import type { ArchivePackage, PackageArchive } from './archive-package'
import type { PlatformTarget } from './platform'

/**
 * There is no single official FFmpeg binary distribution, so each platform is
 * served by a specific, reputable build provider. Providers are fixed in code
 * (not user-editable) so the app never downloads executables from arbitrary
 * locations. Every archive is verified against a SHA-256 published by the
 * provider before anything is extracted or run.
 */

export type FfmpegPackage = ArchivePackage

export interface FfmpegProvider {
  id: string
  info: EngineProviderInfo
  /** Upper bound for a single archive, as a download safeguard. */
  maxArchiveBytes: number
  resolve(http: TrustedHttpClient, signal?: AbortSignal): Promise<FfmpegPackage>
  /** The newest build this provider offers, without downloading it. */
  latest(http: TrustedHttpClient, signal?: AbortSignal): Promise<FfmpegLatest>
}

export interface FfmpegLatest {
  version: string
  /** Provider build identifier: "n9.0.2-48-gd4070a14ce" (BtbN) or "1789931890_9.0.2" (Riedl). */
  build: string
  releasedAt: string | null
  notesUrl: string | null
}

/** "ffmpeg-n9.0.2-48-gd4070a14ce-win64-lgpl-9.0.zip" → "n9.0.2-48-gd4070a14ce" */
export function btbnBuildId(assetName: string, buildTarget: string): string | null {
  const end = assetName.indexOf(`-${buildTarget}-lgpl-`)
  return assetName.startsWith('ffmpeg-n') && end > 0 ? assetName.slice('ffmpeg-'.length, end) : null
}

// ─── BtbN/FFmpeg-Builds (Windows, Linux) ─────────────────────────────────────

const BTBN_RELEASES_API = 'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=10'

const BTBN_TARGETS: Record<string, string> = {
  'win32-x64': 'win64',
  'win32-arm64': 'winarm64',
  // BtbN Linux builds link against glibc, so musl systems are not covered.
  'linux-x64:glibc': 'linux64',
  'linux-arm64:glibc': 'linuxarm64'
}

/**
 * Picks the newest stable-branch LGPL static build for `buildTarget` from an
 * immutable `autobuild-*` release, e.g. `ffmpeg-n9.0.2-42-gd7643a0fe3-win64-lgpl-9.0.zip`.
 * LGPL builds include every encoder MediaFlow needs (LAME, Opus, AAC, FLAC).
 */
export function selectBtbnAsset(
  release: GithubRelease,
  buildTarget: string
): { name: string; version: string; url: string; size: number; digest: string | null } | null {
  const pattern = new RegExp(`^ffmpeg-n(\\d+\\.\\d+(?:\\.\\d+)?)[\\w.-]*?-${buildTarget}-lgpl-(\\d+)\\.(\\d+)\\.(zip|tar\\.xz)$`)
  let best: { asset: GithubAsset; version: string; branch: number } | null = null
  for (const asset of release.assets) {
    const match = pattern.exec(asset.name)
    if (!match?.[1]) continue
    const branch = Number(match[2]) * 1000 + Number(match[3])
    if (!best || branch > best.branch) best = { asset, version: match[1], branch }
  }
  if (!best) return null
  return {
    name: best.asset.name,
    version: best.version,
    url: best.asset.browser_download_url,
    size: best.asset.size,
    digest: best.asset.digest ?? null
  }
}

function btbnProvider(buildTarget: string): FfmpegProvider {
  return {
    id: 'btbn',
    info: {
      name: 'BtbN FFmpeg builds (github.com/BtbN/FFmpeg-Builds)',
      homepage: 'https://github.com/BtbN/FFmpeg-Builds',
      license: 'LGPL-3.0-or-later'
    },
    maxArchiveBytes: 600 * 1024 * 1024,
    async latest(http, signal) {
      const { release, asset } = await newestBtbnBuild(http, buildTarget, signal)
      return {
        version: asset.version,
        build: btbnBuildId(asset.name, buildTarget) ?? `n${asset.version}`,
        releasedAt: release.published_at ?? null,
        notesUrl: release.html_url ?? 'https://github.com/BtbN/FFmpeg-Builds/releases'
      }
    },
    async resolve(http, signal) {
      const { release, asset } = await newestBtbnBuild(http, buildTarget, signal)

      const checksums = release.assets.find((a) => a.name === 'checksums.sha256')
      if (!checksums) throw new AppError('INTEGRITY', 'The FFmpeg release does not publish checksums.')
      const expected = parseChecksumList(await http.getText(checksums.browser_download_url, signal)).get(asset.name)
      if (!expected) throw new AppError('INTEGRITY', `No published checksum for ${asset.name}.`)
      const reported = sha256FromDigest(asset.digest)
      if (reported && reported !== expected) {
        throw new AppError('INTEGRITY', 'GitHub reports a different checksum than the published checksum list.')
      }

      return {
        version: asset.version,
        archives: [{ url: asset.url, fileName: asset.name, sha256: expected, size: asset.size }]
      }
    }
  }
}

async function newestBtbnBuild(http: TrustedHttpClient, buildTarget: string, signal?: AbortSignal) {
  const releases = await http.getJson(BTBN_RELEASES_API, z.array(githubReleaseSchema), signal)
  // `latest` is a rolling tag whose files change daily; autobuild-* releases never change.
  const release = releases.find((r) => r.tag_name.startsWith('autobuild-') && !r.draft && !r.prerelease)
  if (!release) throw new AppError('OPERATION_FAILED', 'No FFmpeg build is currently available from BtbN.')
  const asset = selectBtbnAsset(release, buildTarget)
  if (!asset) throw new AppError('UNSUPPORTED', `No FFmpeg release build is available for ${buildTarget}.`)
  return { release, asset }
}

// ─── Martin Riedl's build server (macOS) ─────────────────────────────────────

const RIEDL_HOST = 'ffmpeg.martin-riedl.de'

/** Parses a resolved download URL such as https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip */
export function parseRiedlDownloadUrl(url: string): { version: string; build: string; builtAt: number; tool: 'ffmpeg' | 'ffprobe' } | null {
  const match = /^https:\/\/ffmpeg\.martin-riedl\.de\/download\/macos\/(?:arm64|amd64)\/(\d+)_([\w.-]+)\/(ffmpeg|ffprobe)\.zip$/.exec(url)
  if (!match?.[1] || !match[2] || !match[3]) return null
  return { version: match[2], build: `${match[1]}_${match[2]}`, builtAt: Number(match[1]), tool: match[3] as 'ffmpeg' | 'ffprobe' }
}

function riedlProvider(cpu: 'arm64' | 'amd64'): FfmpegProvider {
  return {
    id: 'martin-riedl',
    info: {
      name: "Martin Riedl's FFmpeg build server (ffmpeg.martin-riedl.de)",
      homepage: 'https://ffmpeg.martin-riedl.de',
      license: 'GPL (includes x264 and x265)'
    },
    maxArchiveBytes: 300 * 1024 * 1024,
    async latest(http, signal) {
      const resolved = await http.resolveRedirects(`https://${RIEDL_HOST}/redirect/latest/macos/${cpu}/release/ffmpeg.zip`, signal)
      const parsed = parseRiedlDownloadUrl(resolved)
      if (!parsed) throw new AppError('OPERATION_FAILED', 'Unexpected download location from the FFmpeg build server.')
      return {
        version: parsed.version,
        build: parsed.build,
        releasedAt: new Date(parsed.builtAt * 1000).toISOString(),
        notesUrl: `https://${RIEDL_HOST}`
      }
    },
    async resolve(http, signal) {
      const archives: PackageArchive[] = []
      const versions = new Set<string>()
      for (const tool of ['ffmpeg', 'ffprobe'] as const) {
        // The "latest" link redirects to an immutable, versioned path.
        const resolved = await http.resolveRedirects(
          `https://${RIEDL_HOST}/redirect/latest/macos/${cpu}/release/${tool}.zip`,
          signal
        )
        const parsed = parseRiedlDownloadUrl(resolved)
        if (!parsed || parsed.tool !== tool) {
          throw new AppError('OPERATION_FAILED', 'Unexpected download location from the FFmpeg build server.')
        }
        const sha256 = (await http.getText(`${resolved}.sha256`, signal)).trim().split(/\s+/)[0]?.toLowerCase() ?? ''
        if (!isSha256(sha256)) throw new AppError('INTEGRITY', `No valid checksum is published for ${tool}.`)
        versions.add(parsed.version)
        archives.push({ url: resolved, fileName: `${tool}.zip`, sha256, size: null })
      }
      if (versions.size !== 1) {
        throw new AppError('OPERATION_FAILED', 'The FFmpeg build server returned mismatched FFmpeg and FFprobe versions.')
      }
      return { version: [...versions][0] ?? '', archives }
    }
  }
}

// ─── Registry ────────────────────────────────────────────────────────────────

export function ffmpegProviderFor(target: PlatformTarget): FfmpegProvider | null {
  if (target.platform === 'darwin') {
    if (target.arch === 'arm64') return riedlProvider('arm64')
    if (target.arch === 'x64') return riedlProvider('amd64')
    return null
  }
  const key = target.libc ? `${target.key}:${target.libc}` : target.key
  const buildTarget = BTBN_TARGETS[key]
  return buildTarget ? btbnProvider(buildTarget) : null
}

/** Every host the engine installers may contact, including GitHub's download redirect targets. */
export const ENGINE_DOWNLOAD_HOSTS = [
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  RIEDL_HOST
] as const
