import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DENO_RELEASE_API,
  denoAssetName,
  parseDenoChecksum,
  resolveDenoPackage
} from '../../electron/services/engines/deno-engine'
import { EngineInstaller } from '../../electron/services/engines/engine-installer'
import { EngineManifestStore } from '../../electron/services/engines/engine-manifest'
import { EngineProber, parseDenoVersion } from '../../electron/services/engines/engine-probe'
import { ENGINE_DOWNLOAD_HOSTS } from '../../electron/services/engines/ffmpeg-engine'
import { detectPlatform, executableName, type PlatformTarget } from '../../electron/services/engines/platform'
import { TrustedHttpClient } from '../../electron/services/network/trusted-http'
import { createArchiveExtractor, extractZip } from '../../electron/utils/archive'
import { AppError } from '../../electron/utils/errors'
import { silentLogger } from '../../electron/utils/logger'
import { nativeExecutable } from '../helpers/fake-binary'
import { fakeFetch } from '../helpers/fake-fetch'
import { buildZip } from '../helpers/zip'

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'engines', name), 'utf8')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mediaflow-zip-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function code(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : String(e))
  )
}

describe('Deno release data (real v2.9.8 files)', () => {
  it('reads both sidecar formats Deno publishes', () => {
    // Windows builds: PowerShell Get-FileHash output, upper-case.
    expect(parseDenoChecksum(fixture('deno-windows.zip.sha256sum'))).toBe(
      'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf'
    )
    // Unix builds: sha256sum output.
    expect(parseDenoChecksum(fixture('deno-linux.zip.sha256sum'))).toBe(
      'e890975bc2549807bbcc0b584ffafda72cc7c93349dd99c80483dd784f6c4609'
    )
    expect(parseDenoChecksum('no hash here')).toBeNull()
    expect(parseDenoChecksum(`${'a'.repeat(64)} ${'b'.repeat(64)}`)).toBeNull()
  })

  it('parses `deno --version`', () => {
    expect(parseDenoVersion(fixture('deno-version.txt'))).toEqual({ version: '2.9.8', build: '2.9.8' })
    expect(parseDenoVersion('node v22.0.0')).toBeNull()
  })

  it.each([
    ['win32-x64', null, 'deno-x86_64-pc-windows-msvc.zip'],
    ['win32-arm64', null, 'deno-aarch64-pc-windows-msvc.zip'],
    ['darwin-arm64', null, 'deno-aarch64-apple-darwin.zip'],
    ['linux-x64', 'glibc', 'deno-x86_64-unknown-linux-gnu.zip'],
    ['linux-x64', 'musl', null]
  ] as const)('maps %s (%s) to %s', (key, libc, asset) => {
    const [platform, arch] = key.split('-') as [NodeJS.Platform, string]
    expect(denoAssetName({ platform, arch, libc, key })).toBe(asset)
  })

  it('resolves the release and cross-checks the GitHub digest', async () => {
    const target: PlatformTarget = { platform: 'win32', arch: 'x64', libc: null, key: 'win32-x64' }
    const base = 'https://github.com/denoland/deno/releases/download/v2.9.8/'
    const hash = 'cba84b26e0df5ae7f74fc66b86a95b866872a86292ebd84fa1e959927edd93bf'
    const release = (digest: string) => ({
      tag_name: 'v2.9.8',
      prerelease: false,
      draft: false,
      assets: [
        { name: 'deno-x86_64-pc-windows-msvc.zip', size: 42917472, browser_download_url: `${base}deno-x86_64-pc-windows-msvc.zip`, digest },
        { name: 'deno-x86_64-pc-windows-msvc.zip.sha256sum', size: 177, browser_download_url: `${base}deno-x86_64-pc-windows-msvc.zip.sha256sum` }
      ]
    })
    const client = (digest: string) =>
      new TrustedHttpClient({
        fetch: fakeFetch({
          [DENO_RELEASE_API]: { body: JSON.stringify(release(digest)) },
          [`${base}deno-x86_64-pc-windows-msvc.zip.sha256sum`]: { body: fixture('deno-windows.zip.sha256sum') }
        }),
        allowedHosts: ENGINE_DOWNLOAD_HOSTS,
        userAgent: 'test'
      })
    expect(await resolveDenoPackage(client(`sha256:${hash}`), target)).toEqual({
      version: '2.9.8',
      archives: [{ url: `${base}deno-x86_64-pc-windows-msvc.zip`, fileName: 'deno-x86_64-pc-windows-msvc.zip', sha256: hash, size: 42917472 }]
    })
    expect(await code(resolveDenoPackage(client(`sha256:${'0'.repeat(64)}`), target))).toBe('INTEGRITY')
  })
})

describe('extractZip', () => {
  it('extracts nested files with Unicode names', async () => {
    const archive = join(dir, 'ok.zip')
    writeFileSync(archive, buildZip([{ name: 'pkg/' }, { name: 'pkg/bin/tool ü.txt', data: 'hello' }]))
    mkdirSync(join(dir, 'out'))
    await extractZip(archive, join(dir, 'out'))
    expect(readFileSync(join(dir, 'out', 'pkg', 'bin', 'tool ü.txt'), 'utf8')).toBe('hello')
  })

  it.each([
    ['a parent-directory path', '../escape.txt'],
    ['an absolute path', '/etc/escape.txt'],
    ['a drive path', 'C:/escape.txt']
  ])('refuses %s', async (_label, name) => {
    const archive = join(dir, 'evil.zip')
    writeFileSync(archive, buildZip([{ name, data: 'x' }]))
    mkdirSync(join(dir, 'out'))
    expect(await code(extractZip(archive, join(dir, 'out')))).toBe('INTEGRITY')
    expect(existsSync(join(dir, 'escape.txt'))).toBe(false)
  })

  it('refuses archives that would expand beyond the limits', async () => {
    const archive = join(dir, 'bomb.zip')
    writeFileSync(archive, buildZip([{ name: 'a.bin', data: Buffer.alloc(2048) }]))
    mkdirSync(join(dir, 'out'))
    const limits = { maxEntries: 10, maxEntryBytes: 1024, maxTotalBytes: 4096 }
    expect(await code(extractZip(archive, join(dir, 'out'), undefined, limits))).toBe('INTEGRITY')
  })

  it('rejects damaged archives', async () => {
    const archive = join(dir, 'broken.zip')
    writeFileSync(archive, 'PK not really a zip')
    expect(await code(extractZip(archive, dir))).toBe('INTEGRITY')
  })

  it('is chosen by file extension', async () => {
    const archive = join(dir, 'pkg.ZIP')
    writeFileSync(archive, buildZip([{ name: 'deno', data: 'bin' }]))
    mkdirSync(join(dir, 'out'))
    // A null tar path proves the zip path never touches tar.
    await createArchiveExtractor(null)(archive, join(dir, 'out'))
    expect(readdirSync(join(dir, 'out'))).toEqual(['deno'])
  })
})

describe('EngineInstaller — Deno (real zip extraction)', () => {
  it('downloads, verifies, extracts and installs Deno', async () => {
    const target = detectPlatform()
    const binary = Buffer.concat([nativeExecutable(), Buffer.from('deno payload')])
    const zip = buildZip([{ name: executableName('deno', target.platform), data: binary }])
    const engineDir = join(dir, 'engines', target.key)
    const installer = new EngineInstaller({
      http: new TrustedHttpClient({ fetch: fakeFetch({ 'https://github.com/deno.zip': { body: zip } }), allowedHosts: ['github.com'], userAgent: 't' }),
      target,
      engineDir,
      stagingRoot: join(dir, 'engines', '.staging'),
      prober: new EngineProber(async () => ({ exitCode: 0, signal: null, stdout: fixture('deno-version.txt'), stderr: '', timedOut: false })),
      manifest: new EngineManifestStore(engineDir),
      ffmpegProvider: null,
      extract: createArchiveExtractor(null),
      logger: silentLogger,
      resolveDeno: async () => ({
        version: '2.9.8',
        archives: [{ url: 'https://github.com/deno.zip', fileName: 'deno.zip', sha256: createHash('sha256').update(zip).digest('hex'), size: zip.length }]
      })
    })
    const installed = await installer.installDeno(new AbortController().signal, () => {})
    expect(installed).toEqual([{ id: 'deno', version: '2.9.8', path: join(engineDir, executableName('deno', target.platform)) }])
    expect(readFileSync(installed[0]!.path).equals(binary)).toBe(true)
    expect(await new EngineManifestStore(engineDir).get('deno')).toMatchObject({ version: '2.9.8', provider: 'deno-github' })
  })
})
