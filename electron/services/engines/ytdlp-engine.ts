import type { EngineProviderInfo } from '@shared/types/engines'
import { parseChecksumList, sha256FromDigest } from '../../utils/checksum'
import { AppError } from '../../utils/errors'
import type { TrustedHttpClient } from '../network/trusted-http'
import { findAsset, githubReleaseSchema, type GithubAsset, type GithubRelease } from './github-release'
import type { PlatformTarget } from './platform'
import { verifyDetachedSignature } from './signature'
import { YTDLP_SIGNING_KEY, YTDLP_SIGNING_KEY_FINGERPRINT } from './ytdlp-signing-key'

export const YTDLP_RELEASE_API = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
/** Nightly builds are published to a separate repository, signed with the same release key. */
export const YTDLP_NIGHTLY_API = 'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest'

export type YtDlpChannel = 'stable' | 'nightly'

const RELEASE_API: Record<YtDlpChannel, string> = { stable: YTDLP_RELEASE_API, nightly: YTDLP_NIGHTLY_API }

/** Manifest provider id per channel, so the installed channel is known later. */
export const YTDLP_PROVIDER_IDS: Record<YtDlpChannel, string> = { stable: 'yt-dlp-github', nightly: 'yt-dlp-nightly' }

export const YTDLP_PROVIDER: EngineProviderInfo = {
  name: 'yt-dlp official releases (github.com/yt-dlp/yt-dlp)',
  homepage: 'https://github.com/yt-dlp/yt-dlp',
  // The standalone executables bundle GPLv3+ code; yt-dlp's own source is Unlicense.
  license: 'Unlicense (source); GPLv3+ (standalone executable)'
}

/**
 * Standalone executables published with each yt-dlp release. None of these
 * need Python. macOS gets a universal2 build that runs natively on both CPUs.
 */
const ASSETS: Record<string, string> = {
  'win32-x64': 'yt-dlp.exe',
  'win32-arm64': 'yt-dlp_arm64.exe',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
  'linux-x64:glibc': 'yt-dlp_linux',
  'linux-arm64:glibc': 'yt-dlp_linux_aarch64',
  'linux-x64:musl': 'yt-dlp_musllinux',
  'linux-arm64:musl': 'yt-dlp_musllinux_aarch64'
}

export function ytDlpAssetName(target: PlatformTarget): string | null {
  const key = target.libc ? `${target.key}:${target.libc}` : target.key
  return ASSETS[key] ?? null
}

export interface ResolvedDownload {
  channel: YtDlpChannel
  version: string
  url: string
  fileName: string
  size: number
  sha256: string
}

/**
 * Resolves the latest stable yt-dlp build for this platform and its expected
 * SHA-256. The checksum list must carry a valid signature from yt-dlp's pinned
 * release key, and must agree with the digest GitHub reports for the asset.
 */
export async function resolveYtDlpDownload(
  http: TrustedHttpClient,
  target: PlatformTarget,
  signal?: AbortSignal,
  channel: YtDlpChannel = 'stable'
): Promise<ResolvedDownload> {
  const { release, asset } = await latestYtDlpRelease(http, target, channel, signal)
  const assetName = asset.name
  const sumsAsset = requireAsset(release.assets, 'SHA2-256SUMS')
  const signatureAsset = requireAsset(release.assets, 'SHA2-256SUMS.sig')

  const [sums, signature] = await Promise.all([
    http.getBytes(sumsAsset.browser_download_url, signal),
    http.getBytes(signatureAsset.browser_download_url, signal)
  ])
  await verifyDetachedSignature(sums, signature, YTDLP_SIGNING_KEY, YTDLP_SIGNING_KEY_FINGERPRINT)

  const expected = parseChecksumList(Buffer.from(sums).toString('utf8')).get(assetName)
  if (!expected) {
    throw new AppError('INTEGRITY', `The signed checksum list does not include ${assetName}.`)
  }
  const reported = sha256FromDigest(asset.digest)
  if (reported && reported !== expected) {
    throw new AppError('INTEGRITY', 'GitHub reports a different checksum than the signed checksum list.')
  }

  return {
    channel,
    version: release.tag_name,
    url: asset.browser_download_url,
    fileName: asset.name,
    size: asset.size,
    sha256: expected
  }
}

/** The latest release of a channel and this platform's asset in it (no download, no verification yet). */
export async function latestYtDlpRelease(
  http: TrustedHttpClient,
  target: PlatformTarget,
  channel: YtDlpChannel,
  signal?: AbortSignal
): Promise<{ release: GithubRelease; asset: GithubAsset }> {
  const assetName = ytDlpAssetName(target)
  if (!assetName) {
    throw new AppError('UNSUPPORTED', `yt-dlp does not publish a standalone build for ${target.key}.`)
  }
  const release = await http.getJson(RELEASE_API[channel], githubReleaseSchema, signal)
  if (release.draft || release.prerelease) {
    throw new AppError('OPERATION_FAILED', `The latest yt-dlp ${channel} release is not a final release.`)
  }
  return { release, asset: requireAsset(release.assets, assetName) }
}

function requireAsset(assets: GithubAsset[], name: string): GithubAsset {
  const asset = findAsset(assets, name)
  if (!asset) throw new AppError('OPERATION_FAILED', `The yt-dlp release does not contain ${name}.`)
  return asset
}
