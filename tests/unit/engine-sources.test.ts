import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ENGINE_DOWNLOAD_HOSTS, ffmpegProviderFor, parseRiedlDownloadUrl, selectBtbnAsset } from '../../electron/services/engines/ffmpeg-engine'
import type { GithubRelease } from '../../electron/services/engines/github-release'
import { detectPlatform, type PlatformTarget } from '../../electron/services/engines/platform'
import { YTDLP_RELEASE_API, resolveYtDlpDownload, ytDlpAssetName } from '../../electron/services/engines/ytdlp-engine'
import { TrustedHttpClient } from '../../electron/services/network/trusted-http'
import { AppError } from '../../electron/utils/errors'
import { fakeFetch, type FakeRoute } from '../helpers/fake-fetch'

const fixtureDir = join(__dirname, '..', 'fixtures', 'engines')
const fixtureBytes = (name: string): Buffer => readFileSync(join(fixtureDir, name))

function target(key: string, libc: 'glibc' | 'musl' | null = null): PlatformTarget {
  const [platform, arch] = key.split('-') as [NodeJS.Platform, string]
  return { platform, arch, libc: platform === 'linux' ? (libc ?? 'glibc') : null, key }
}

function http(routes: Record<string, FakeRoute>): TrustedHttpClient {
  return new TrustedHttpClient({ fetch: fakeFetch(routes), allowedHosts: ENGINE_DOWNLOAD_HOSTS, userAgent: 'test' })
}

async function errorCode(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : `non-AppError: ${String(e)}`)
  )
}

describe('yt-dlp release resolution', () => {
  // Real release metadata, checksum list and signature from yt-dlp 2026.10.26.
  const release = JSON.parse(fixtureBytes('ytdlp-release-2026.10.26.json').toString('utf8')) as GithubRelease
  const sums = fixtureBytes('ytdlp-2026.10.26-SHA2-256SUMS')
  const signature = fixtureBytes('ytdlp-2026.10.26-SHA2-256SUMS.sig')
  const sumsUrl = release.assets.find((a) => a.name === 'SHA2-256SUMS')!.browser_download_url
  const sigUrl = release.assets.find((a) => a.name === 'SHA2-256SUMS.sig')!.browser_download_url

  const routes = (overrides: Partial<{ release: unknown; sums: Uint8Array }> = {}): Record<string, FakeRoute> => ({
    [YTDLP_RELEASE_API]: { body: JSON.stringify(overrides.release ?? release) },
    [sumsUrl]: { body: overrides.sums ?? sums },
    [sigUrl]: { body: signature }
  })

  it.each([
    ['win32-x64', null, 'yt-dlp.exe'],
    ['win32-arm64', null, 'yt-dlp_arm64.exe'],
    ['darwin-x64', null, 'yt-dlp_macos'],
    ['darwin-arm64', null, 'yt-dlp_macos'],
    ['linux-x64', 'glibc', 'yt-dlp_linux'],
    ['linux-arm64', 'glibc', 'yt-dlp_linux_aarch64'],
    ['linux-x64', 'musl', 'yt-dlp_musllinux'],
    ['linux-arm64', 'musl', 'yt-dlp_musllinux_aarch64']
  ] as const)('uses the standalone build for %s (%s)', (key, libc, asset) => {
    expect(ytDlpAssetName(target(key, libc))).toBe(asset)
  })

  it('has no build for unsupported targets', () => {
    expect(ytDlpAssetName(target('linux-ia32'))).toBeNull()
    expect(ytDlpAssetName({ platform: 'freebsd', arch: 'x64', libc: null, key: 'freebsd-x64' })).toBeNull()
  })

  it('resolves a download whose checksum comes from the signed list', async () => {
    const resolved = await resolveYtDlpDownload(http(routes()), target('win32-x64'))
    expect(resolved).toEqual({
      channel: 'stable',
      version: '2026.10.26',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe',
      fileName: 'yt-dlp.exe',
      size: 23575744,
      sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d'
    })
  })

  it('rejects a checksum list that was altered after signing', async () => {
    const tampered = Buffer.from(
      sums.toString('utf8').replace('f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d', 'a'.repeat(64))
    )
    expect(await errorCode(resolveYtDlpDownload(http(routes({ sums: tampered })), target('win32-x64')))).toBe('INTEGRITY')
  })

  it('rejects a release whose GitHub digest disagrees with the signed list', async () => {
    const altered = structuredClone(release)
    const asset = altered.assets.find((a) => a.name === 'yt-dlp.exe')!
    asset.digest = `sha256:${'b'.repeat(64)}`
    expect(await errorCode(resolveYtDlpDownload(http(routes({ release: altered })), target('win32-x64')))).toBe('INTEGRITY')
  })

  it('refuses pre-releases and releases without signatures', async () => {
    expect(
      await errorCode(resolveYtDlpDownload(http(routes({ release: { ...release, prerelease: true } })), target('win32-x64')))
    ).toBe('OPERATION_FAILED')
    const unsigned = { ...release, assets: release.assets.filter((a) => a.name !== 'SHA2-256SUMS.sig') }
    expect(await errorCode(resolveYtDlpDownload(http(routes({ release: unsigned })), target('win32-x64')))).toBe(
      'OPERATION_FAILED'
    )
  })
})

describe('FFmpeg providers', () => {
  // Real asset names from BtbN/FFmpeg-Builds release autobuild-2026-11-01-12-49.
  const names = JSON.parse(fixtureBytes('btbn-autobuild-asset-names.json').toString('utf8')) as string[]
  const release: GithubRelease = {
    tag_name: 'autobuild-2026-11-01-12-49',
    prerelease: false,
    draft: false,
    assets: names.map((name) => ({
      name,
      size: 1,
      browser_download_url: `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-01-12-49/${name}`
    }))
  }

  it.each([
    ['win64', 'ffmpeg-n9.0.2-42-gd7643a0fe3-win64-lgpl-9.0.zip'],
    ['winarm64', 'ffmpeg-n9.0.2-42-gd7643a0fe3-winarm64-lgpl-9.0.zip'],
    ['linux64', 'ffmpeg-n9.0.2-42-gd7643a0fe3-linux64-lgpl-9.0.tar.xz'],
    ['linuxarm64', 'ffmpeg-n9.0.2-42-gd7643a0fe3-linuxarm64-lgpl-9.0.tar.xz']
  ])('selects the newest LGPL static release build for %s', (buildTarget, expected) => {
    const selected = selectBtbnAsset(release, buildTarget)
    expect(selected?.name).toBe(expected)
    expect(selected?.version).toBe('9.0.2')
  })

  it('never selects GPL, shared or master builds', () => {
    const onlyOthers: GithubRelease = {
      ...release,
      assets: release.assets.filter((a) => !/-lgpl-\d/.test(a.name) || /shared/.test(a.name))
    }
    expect(selectBtbnAsset(onlyOthers, 'win64')).toBeNull()
  })

  it('maps each platform to a provider', () => {
    expect(ffmpegProviderFor(target('win32-x64'))?.id).toBe('btbn')
    expect(ffmpegProviderFor(target('win32-arm64'))?.id).toBe('btbn')
    expect(ffmpegProviderFor(target('linux-x64'))?.id).toBe('btbn')
    expect(ffmpegProviderFor(target('linux-arm64'))?.id).toBe('btbn')
    expect(ffmpegProviderFor(target('darwin-arm64'))?.id).toBe('martin-riedl')
    expect(ffmpegProviderFor(target('darwin-x64'))?.id).toBe('martin-riedl')
    expect(ffmpegProviderFor(target('linux-x64', 'musl'))).toBeNull()
  })

  it('resolves the BtbN package with its published checksum', async () => {
    const asset = 'ffmpeg-n9.0.2-42-gd7643a0fe3-win64-lgpl-9.0.zip'
    const base = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-11-01-12-49/'
    const hash = '187fef3a0221148eaf9c342c82309209277d84b2257efcac7d230687b77f2862'
    const releases = [{ ...release, tag_name: 'latest' }, release]
    const provider = ffmpegProviderFor(target('win32-x64'))!
    const pkg = await provider.resolve(
      http({
        'https://api.github.com/repos/BtbN/FFmpeg-Builds/releases?per_page=10': { body: JSON.stringify(releases) },
        [`${base}checksums.sha256`]: { body: `${hash}  ${asset}\n` }
      })
    )
    expect(pkg).toEqual({ version: '9.0.2', archives: [{ url: base + asset, fileName: asset, sha256: hash, size: 1 }] })
  })

  it('parses Martin Riedl download locations', () => {
    expect(
      parseRiedlDownloadUrl('https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip')
    ).toEqual({ version: '9.0.2', build: '1789931890_9.0.2', builtAt: 1789931890, tool: 'ffmpeg' })
    expect(parseRiedlDownloadUrl('https://ffmpeg.martin-riedl.de/download/linux/arm64/1_9.0.2/ffmpeg.zip')).toBeNull()
    expect(parseRiedlDownloadUrl('https://evil.example/download/macos/arm64/1_9.0.2/ffmpeg.zip')).toBeNull()
  })

  it('resolves the macOS package through the redirect and sidecar checksums', async () => {
    const dl = (tool: string) => `https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/${tool}.zip`
    const provider = ffmpegProviderFor(target('darwin-arm64'))!
    const pkg = await provider.resolve(
      http({
        'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip': { finalUrl: dl('ffmpeg') },
        'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip': { finalUrl: dl('ffprobe') },
        [`${dl('ffmpeg')}.sha256`]: { body: `${'c'.repeat(64)}  ffmpeg.zip\n` },
        [`${dl('ffprobe')}.sha256`]: { body: `${'d'.repeat(64)}  ffprobe.zip\n` }
      })
    )
    expect(pkg.version).toBe('9.0.2')
    expect(pkg.archives.map((a) => [a.fileName, a.sha256])).toEqual([
      ['ffmpeg.zip', 'c'.repeat(64)],
      ['ffprobe.zip', 'd'.repeat(64)]
    ])
  })
})

describe('detectPlatform', () => {
  it('describes the current machine', () => {
    const current = detectPlatform()
    expect(current.key).toBe(`${process.platform}-${process.arch}`)
    expect(current.libc === null).toBe(process.platform !== 'linux')
  })
})
