import type { EngineProviderInfo } from '@shared/types/engines'
import { sha256FromDigest } from '../../utils/checksum'
import { AppError } from '../../utils/errors'
import type { TrustedHttpClient } from '../network/trusted-http'
import type { ArchivePackage } from './archive-package'
import { findAsset, githubReleaseSchema } from './github-release'
import type { PlatformTarget } from './platform'

/**
 * Deno is the JavaScript runtime yt-dlp uses by default to solve YouTube's
 * JavaScript challenges. yt-dlp starts it itself, sandboxed (no network, no
 * file system prompts, no npm, cached code only).
 */
export const DENO_RELEASE_API = 'https://api.github.com/repos/denoland/deno/releases/latest'

export const DENO_PROVIDER: EngineProviderInfo = {
  name: 'Deno official releases (github.com/denoland/deno)',
  homepage: 'https://github.com/denoland/deno',
  license: 'MIT'
}

export const DENO_MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

const ASSETS: Record<string, string> = {
  'win32-x64': 'deno-x86_64-pc-windows-msvc.zip',
  'win32-arm64': 'deno-aarch64-pc-windows-msvc.zip',
  'darwin-x64': 'deno-x86_64-apple-darwin.zip',
  'darwin-arm64': 'deno-aarch64-apple-darwin.zip',
  // Deno publishes glibc builds only.
  'linux-x64:glibc': 'deno-x86_64-unknown-linux-gnu.zip',
  'linux-arm64:glibc': 'deno-aarch64-unknown-linux-gnu.zip'
}

export function denoAssetName(target: PlatformTarget): string | null {
  const key = target.libc ? `${target.key}:${target.libc}` : target.key
  return ASSETS[key] ?? null
}

/**
 * Deno's `.sha256sum` sidecars come in two formats: `sha256sum` output on Unix
 * builds and PowerShell `Get-FileHash` output (upper-case) on Windows builds.
 * Both contain exactly one 64-digit hex hash.
 */
export function parseDenoChecksum(text: string): string | null {
  const matches = text.match(/\b[a-fA-F0-9]{64}\b/g)
  return matches?.length === 1 && matches[0] ? matches[0].toLowerCase() : null
}

/** The newest Deno release with a build for this platform (no download). */
export async function latestDeno(
  http: TrustedHttpClient,
  target: PlatformTarget,
  signal?: AbortSignal
): Promise<{ version: string; releasedAt: string | null; notesUrl: string | null }> {
  const assetName = denoAssetName(target)
  if (!assetName) throw new AppError('UNSUPPORTED', `Deno does not publish a build for ${target.key}.`)
  const release = await http.getJson(DENO_RELEASE_API, githubReleaseSchema, signal)
  if (release.draft || release.prerelease || !findAsset(release.assets, assetName)) {
    throw new AppError('OPERATION_FAILED', `The latest Deno release does not contain ${assetName}.`)
  }
  return { version: release.tag_name.replace(/^v/, ''), releasedAt: release.published_at ?? null, notesUrl: release.html_url ?? null }
}

export async function resolveDenoPackage(
  http: TrustedHttpClient,
  target: PlatformTarget,
  signal?: AbortSignal
): Promise<ArchivePackage> {
  const assetName = denoAssetName(target)
  if (!assetName) throw new AppError('UNSUPPORTED', `Deno does not publish a build for ${target.key}.`)

  const release = await http.getJson(DENO_RELEASE_API, githubReleaseSchema, signal)
  if (release.draft || release.prerelease) {
    throw new AppError('OPERATION_FAILED', 'The latest Deno release is not a stable release.')
  }
  const asset = findAsset(release.assets, assetName)
  const sidecar = findAsset(release.assets, `${assetName}.sha256sum`)
  if (!asset || !sidecar) throw new AppError('OPERATION_FAILED', `The Deno release does not contain ${assetName}.`)

  const expected = parseDenoChecksum(await http.getText(sidecar.browser_download_url, signal))
  if (!expected) throw new AppError('INTEGRITY', 'The Deno release does not publish a readable checksum.')
  const reported = sha256FromDigest(asset.digest)
  if (reported && reported !== expected) {
    throw new AppError('INTEGRITY', 'GitHub reports a different checksum than the published Deno checksum.')
  }

  return {
    version: release.tag_name.replace(/^v/, ''),
    archives: [{ url: asset.browser_download_url, fileName: asset.name, sha256: expected, size: asset.size }]
  }
}
