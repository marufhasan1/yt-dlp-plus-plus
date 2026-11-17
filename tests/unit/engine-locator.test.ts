import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { locateEngine, locateFfmpegToolchain, systemSearchDirs } from '../../electron/services/engines/engine-locator'
import { executableName } from '../../electron/services/engines/platform'

describe('systemSearchDirs', () => {
  it('keeps absolute PATH entries, drops relative ones and adds package-manager folders', () => {
    expect(systemSearchDirs('/usr/bin:.:bin::/opt/tools:/usr/bin', 'darwin')).toEqual([
      '/usr/bin',
      '/opt/tools',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/local/bin'
    ])
  })

  it('handles Windows PATH quoting and case-insensitive duplicates', () => {
    expect(systemSearchDirs('C:\\Tools;"C:\\Program Files\\FFmpeg\\bin";c:\\tools;.\\local', 'win32')).toEqual([
      'C:\\Tools',
      'C:\\Program Files\\FFmpeg\\bin'
    ])
  })

  it('copes with an empty PATH', () => {
    expect(systemSearchDirs(undefined, 'win32')).toEqual([])
  })
})

describe('locating engines', () => {
  const platform = process.platform
  let root: string
  const dirs = { managed: '', bundled: '', systemA: '', systemB: '' }
  const put = (dir: string, name: 'yt-dlp' | 'ffmpeg' | 'ffprobe') => writeFileSync(join(dir, executableName(name, platform)), 'x')

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ytdlpp-locate-'))
    for (const key of Object.keys(dirs) as (keyof typeof dirs)[]) {
      dirs[key] = join(root, key)
      mkdirSync(dirs[key])
    }
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  const locations = () => ({ managed: dirs.managed, bundled: dirs.bundled, system: [dirs.systemA, dirs.systemB] })

  it('searches managed, then bundled, then system, in PATH order', async () => {
    put(dirs.systemB, 'yt-dlp')
    expect(await locateEngine('yt-dlp', locations(), platform)).toMatchObject({ source: 'system' })
    put(dirs.systemA, 'yt-dlp')
    expect((await locateEngine('yt-dlp', locations(), platform))?.path).toContain('systemA')
    put(dirs.bundled, 'yt-dlp')
    expect(await locateEngine('yt-dlp', locations(), platform)).toMatchObject({ source: 'bundled' })
    put(dirs.managed, 'yt-dlp')
    expect(await locateEngine('yt-dlp', locations(), platform)).toMatchObject({ source: 'managed' })
  })

  it('ignores directories with the engine’s name', async () => {
    mkdirSync(join(dirs.managed, executableName('yt-dlp', platform)))
    expect(await locateEngine('yt-dlp', locations(), platform)).toBeNull()
  })

  it('takes FFmpeg and FFprobe from the first place that has both', async () => {
    put(dirs.managed, 'ffprobe')
    put(dirs.systemA, 'ffmpeg')
    put(dirs.systemB, 'ffmpeg')
    put(dirs.systemB, 'ffprobe')
    const found = await locateFfmpegToolchain(locations(), platform)
    expect(found.ffmpeg?.path).toContain('systemB')
    expect(found.ffprobe?.path).toContain('systemB')
  })

  it('reports a half-installed toolchain so the missing part can be named', async () => {
    put(dirs.managed, 'ffmpeg')
    const found = await locateFfmpegToolchain(locations(), platform)
    expect(found.ffmpeg).toMatchObject({ source: 'managed' })
    expect(found.ffprobe).toBeNull()
  })
})
