import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MediaInfoService } from '../../electron/services/media/media-info.service'
import { ThumbnailService, isPublicHttpsUrl, selectThumbnailUrl } from '../../electron/services/media/thumbnail.service'
import { analyzeArgs, commonArgs, downloadArgs, type EngineRuntime } from '../../electron/services/media/ytdlp-command'
import { AppError } from '../../electron/utils/errors'
import { silentLogger } from '../../electron/utils/logger'
import type { ProcessRunner, RunResult } from '../../electron/utils/process'
import { classifyMediaUrl, mediaUrlSchema } from '@shared/validation/media'
import { fakeFetch } from '../helpers/fake-fetch'

const infoJson = readFileSync(join(__dirname, '..', 'fixtures', 'ytdlp', 'big-buck-bunny.info.json'), 'utf8')
const URL_BBB = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'
const runtime: EngineRuntime = { ytdlp: '/engines/yt-dlp', ffmpegLocation: '/engines', deno: '/engines/deno' }

describe('URL validation', () => {
  it.each([
    URL_BBB,
    'https://youtu.be/aqz-KE-bpKQ',
    'https://www.youtube.com/shorts/aqz-KE-bpKQ',
    'https://vimeo.com/76979871',
    '  https://example.com/video.mp4  '
  ])('accepts %s', (url) => {
    expect(mediaUrlSchema.safeParse(url).success).toBe(true)
  })

  it.each(['', 'not a url', 'file:///C:/Windows/win.ini', 'javascript:alert(1)', 'ftp://example.com/a.mp4', 'https://user:pw@example.com/v', `https://example.com/${'a'.repeat(2100)}`])(
    'rejects %s',
    (url) => {
      expect(mediaUrlSchema.safeParse(url).success).toBe(false)
    }
  )

  it('recognises YouTube link shapes', () => {
    expect(classifyMediaUrl(URL_BBB)).toEqual({ kind: 'youtube-video', videoId: 'aqz-KE-bpKQ', playlistId: null })
    expect(classifyMediaUrl('https://youtu.be/aqz-KE-bpKQ?t=10')).toMatchObject({ kind: 'youtube-video', videoId: 'aqz-KE-bpKQ' })
    expect(classifyMediaUrl('https://m.youtube.com/shorts/aqz-KE-bpKQ')).toMatchObject({ kind: 'youtube-video' })
    expect(classifyMediaUrl(`${URL_BBB}&list=PL123`)).toMatchObject({ kind: 'youtube-video', playlistId: 'PL123' })
    expect(classifyMediaUrl('https://www.youtube.com/playlist?list=PL123')).toMatchObject({ kind: 'youtube-playlist' })
    expect(classifyMediaUrl('https://www.youtube.com/@Blender')).toMatchObject({ kind: 'youtube-channel' })
    expect(classifyMediaUrl('https://youtube.com.evil.example/watch?v=aqz-KE-bpKQ')).toMatchObject({ kind: 'other' })
  })
})

describe('yt-dlp command lines', () => {
  it('ignores user config, forces UTF-8 and wires the engines', () => {
    expect(commonArgs(runtime)).toEqual([
      '--ignore-config', '--no-colors', '--encoding', 'utf-8', '--no-playlist', '--socket-timeout', '30',
      '--js-runtimes', 'deno:/engines/deno', '--ffmpeg-location', '/engines'
    ])
    expect(commonArgs({ ...runtime, deno: null, ffmpegLocation: null })).not.toContain('--js-runtimes')
  })

  it('puts the URL last, after "--", so it can never be read as an option', () => {
    const analyze = analyzeArgs(runtime, URL_BBB)
    expect(analyze.slice(-2)).toEqual(['--', URL_BBB])
    const download = downloadArgs({
      runtime,
      plan: { kind: 'video', args: ['-f', '18'], outputFormat: 'mp4', qualityLabel: '360p', streams: [], estimatedBytes: null },
      url: URL_BBB,
      destination: '/home/me/Downloads',
      tempDir: '/tmp/job',
      filenameTemplate: 'title-id',
      skipExisting: true,
      platform: 'linux'
    })
    expect(download.slice(-2)).toEqual(['--', URL_BBB])
    expect(download).toEqual(
      expect.arrayContaining(['--paths', '/home/me/Downloads', 'temp:/tmp/job', '--output', '%(title).150B [%(id)s].%(ext)s', '--no-overwrites', '--progress', '--no-simulate'])
    )
    expect(download).not.toContain('--windows-filenames')
    expect(downloadArgs({ ...{ runtime, url: URL_BBB, destination: 'D:\\', tempDir: 'C:\\t', filenameTemplate: 'title' as const, skipExisting: false, platform: 'win32' as const, plan: { kind: 'video' as const, args: [], outputFormat: 'mp4', qualityLabel: null, streams: [], estimatedBytes: null } } })).toEqual(
      expect.arrayContaining(['--windows-filenames', '--force-overwrites'])
    )
  })
})

describe('thumbnails', () => {
  const thumbs = JSON.parse(infoJson).thumbnails as { url: string; width?: number }[]

  it('picks a ~480 px JPEG over WebP and oversized images', () => {
    expect(selectThumbnailUrl(thumbs, null)).toBe('https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg')
    expect(selectThumbnailUrl([], 'https://example.com/t.jpg')).toBe('https://example.com/t.jpg')
    expect(selectThumbnailUrl([{ url: 'http://example.com/t.jpg' }], null)).toBeNull()
  })

  it.each([
    ['https://i.ytimg.com/vi/x/hq.jpg', true],
    ['http://i.ytimg.com/vi/x/hq.jpg', false],
    ['https://localhost/x.jpg', false],
    ['https://127.0.0.1/x.jpg', false],
    ['https://192.168.1.10/x.jpg', false],
    ['https://10.0.0.5/x.jpg', false],
    ['https://169.254.169.254/latest/meta-data', false],
    ['https://[::1]/x.jpg', false],
    ['https://printer.local/x.jpg', false],
    ['https://8.8.8.8/x.jpg', true]
  ])('%s public: %s', (url, expected) => {
    expect(isPublicHttpsUrl(url)).toBe(expected)
  })

  it('returns an encoded data URL, or null for non-images', async () => {
    const encode = vi.fn(() => 'data:image/jpeg;base64,AAA')
    const service = new ThumbnailService(
      fakeFetch({
        'https://i.ytimg.com/a.jpg': { body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'image/jpeg' } },
        'https://i.ytimg.com/b.html': { body: '<html>', headers: { 'content-type': 'text/html' } },
        'https://i.ytimg.com/redirect.jpg': { body: 'x', headers: { 'content-type': 'image/jpeg' }, finalUrl: 'https://127.0.0.1/x' }
      }),
      encode,
      silentLogger
    )
    expect(await service.load('https://i.ytimg.com/a.jpg')).toBe('data:image/jpeg;base64,AAA')
    expect(await service.load('https://i.ytimg.com/b.html')).toBeNull()
    expect(await service.load('https://i.ytimg.com/redirect.jpg')).toBeNull()
    expect(await service.load('https://i.ytimg.com/missing.jpg')).toBeNull()
    expect(encode).toHaveBeenCalledTimes(1)
  })

  it('never follows redirects, so the address check covers the only host contacted', async () => {
    const seen: RequestInit[] = []
    const service = new ThumbnailService(
      async (_url, init) => {
        seen.push(init)
        throw new TypeError('Redirect not allowed')
      },
      () => 'x',
      silentLogger
    )
    expect(await service.load('https://evil.example/x.jpg')).toBeNull()
    expect(seen[0]?.redirect).toBe('error')
  })

  it('passes small, genuine JPEG/PNG/WebP files through without decoding them', async () => {
    const { passThroughImage, sniffImage } = await import('../../electron/services/media/thumbnail.service')
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)])
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)])
    expect(passThroughImage(jpeg, 480)).toBe(`data:image/jpeg;base64,${jpeg.toString('base64')}`)
    expect(passThroughImage(png, 480)).toMatch(/^data:image\/png;base64,/)
    expect(sniffImage(Buffer.from('<svg onload=alert(1)>'))).toBeNull()
    expect(passThroughImage(Buffer.from('GIF89a......'), 480)).toBeNull()
    expect(passThroughImage(Buffer.concat([jpeg, Buffer.alloc(600 * 1024)]), 480)).toBeNull()
  })
})

describe('MediaInfoService (real info JSON, fake process)', () => {
  function service(result: Partial<RunResult>, deno: string | null = '/engines/deno') {
    const run: ProcessRunner = vi.fn(async () => ({ exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...result }))
    const release = vi.fn()
    const acquire = vi.fn(() => release)
    const thumbnails = { load: vi.fn(async () => 'data:image/jpeg;base64,THUMB') }
    const media = new MediaInfoService({
      runtime: () => ({ ...runtime, deno }),
      acquire,
      run,
      thumbnails: thumbnails as never,
      logger: silentLogger
    })
    return { media, run, acquire, release }
  }

  it('turns yt-dlp metadata into a compact analysis', async () => {
    const { media, run, release } = service({ stdout: infoJson })
    const analysis = await media.analyze(URL_BBB)
    expect(analysis).toMatchObject({
      sourceId: 'youtube:aqz-KE-bpKQ',
      title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film',
      uploader: 'Blender',
      durationSeconds: 635,
      uploadDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      thumbnail: 'data:image/jpeg;base64,THUMB',
      notices: []
    })
    expect(analysis.video.map((c) => c.container)).toEqual(['mp4', 'webm', 'mkv'])
    expect(analysis.audio).toMatchObject({ available: true, codecs: expect.arrayContaining(['AAC', 'Opus']) })
    // The analysis is cached so a download can be planned against it.
    const { plan } = media.plan({
      analysisId: analysis.analysisId,
      selection: { kind: 'video', container: 'mp4', height: 1080, codec: 'auto' },
      options: { embedMetadata: true, embedThumbnail: true, subtitles: null }
    })
    expect(plan.args[1]?.startsWith('299+140/')).toBe(true)
    expect(release).toHaveBeenCalledOnce()
    expect(vi.mocked(run).mock.calls[0]?.[2]).toMatchObject({ killTree: true, env: { PYTHONIOENCODING: 'utf-8' } })
  })

  it('warns when YouTube is analysed without a JavaScript runtime', async () => {
    const { media } = service({ stdout: infoJson }, null)
    expect((await media.analyze(URL_BBB)).notices.map((n) => n.code)).toEqual(['JS_RUNTIME_MISSING'])
  })

  it('reports classified yt-dlp failures', async () => {
    const { media } = service({ exitCode: 1, stderr: 'ERROR: [youtube] aaaaaaaaaaa: This video is unavailable' })
    await expect(media.analyze('https://www.youtube.com/watch?v=aaaaaaaaaaa')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses playlist pages and live streams', async () => {
    const { media, run } = service({ stdout: infoJson })
    await expect(media.analyze('https://www.youtube.com/playlist?list=PL123')).rejects.toMatchObject({ code: 'UNSUPPORTED' })
    expect(run).not.toHaveBeenCalled()
    const live = service({ stdout: JSON.stringify({ ...JSON.parse(infoJson), is_live: true, live_status: 'is_live' }) })
    await expect(live.media.analyze(URL_BBB)).rejects.toMatchObject({ code: 'UNSUPPORTED' })
  })

  it('rejects unreadable output and expired analyses', async () => {
    const { media } = service({ stdout: 'not json' })
    await expect(media.analyze(URL_BBB)).rejects.toBeInstanceOf(AppError)
    expect(() =>
      media.plan({
        analysisId: '00000000-0000-4000-8000-000000000000',
        selection: { kind: 'audio', format: 'mp3', quality: '192' },
        options: { embedMetadata: false, embedThumbnail: false, subtitles: null }
      })
    ).toThrow(/expired/)
  })
})
