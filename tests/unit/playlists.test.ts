import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadJob } from '@shared/types/downloads'
import type { PlaylistDownloadRequest } from '@shared/types/playlists'
import { DEFAULT_SETTINGS } from '@shared/validation/settings'
import { channelVideosUrl, playlistDownloadRequestSchema } from '@shared/validation/media'
import type { PreparedDownload } from '../../electron/services/download/download-manager'
import { buildProfilePlan } from '../../electron/services/media/format-selection'
import { LinkAnalyzer } from '../../electron/services/media/link-analyzer'
import { PlaylistDetected } from '../../electron/services/media/media-info.service'
import { outputTemplate } from '../../electron/services/media/ytdlp-command'
import { classifyYtDlpError } from '../../electron/services/media/ytdlp-errors'
import { PlaylistService, parseFlatPlaylist } from '../../electron/services/playlist/playlist.service'
import { openDatabase, type SqliteDatabase } from '../../electron/services/storage/database'
import { PlaylistRepository } from '../../electron/services/storage/playlist.repository'
import { AppError } from '../../electron/utils/errors'
import { childPath, sanitizeFolderName } from '../../electron/utils/filename'
import { silentLogger } from '../../electron/utils/logger'
import type { ProcessRunner } from '../../electron/utils/process'

const fixtureText = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'ytdlp', name), 'utf8')
// Real flat output: Blender's "Official Blender Open Movies" playlist (CC-BY films) and a channel's Videos tab.
const openMovies = JSON.parse(fixtureText('playlist-open-movies.flat.json')) as { entries: Record<string, unknown>[] } & Record<string, unknown>
const channel = JSON.parse(fixtureText('channel-videos.flat.json')) as Record<string, unknown>
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335'

async function code(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(
    () => null,
    (e: unknown) => (e instanceof AppError ? e.code : String(e))
  )
}

describe('parseFlatPlaylist (real yt-dlp output)', () => {
  it('reads the playlist and every entry', () => {
    const playlist = parseFlatPlaylist(openMovies, PLAYLIST_URL)
    expect(playlist).toMatchObject({
      sourceId: 'youtubetab:PL6B3937A5D230E335',
      title: 'Official Blender Open Movies',
      uploader: 'Blender',
      truncated: false
    })
    expect(playlist.entries).toHaveLength(17)
    expect(playlist.entries[0]).toMatchObject({
      position: 1,
      videoId: 'l5OZu-IrXpw',
      url: 'https://www.youtube.com/watch?v=l5OZu-IrXpw',
      title: 'SINGULARITY - Painterly Space Adventure',
      durationSeconds: 391,
      uploader: 'Blender Studio',
      unavailableReason: null
    })
    expect(playlist.entries[15]).toMatchObject({ position: 16, title: 'Big Buck Bunny', durationSeconds: 597 })
    // Small (~240 px) list thumbnails, never the page-sized ones.
    expect(playlist.entries[0]?.thumbnailUrl).toMatch(/^https:\/\/i\.ytimg\.com\/vi\/l5OZu-IrXpw\/hqdefault\.jpg/)
  })

  it('handles a channel Videos tab, which reports no total count', () => {
    const tab = parseFlatPlaylist(channel, 'https://www.youtube.com/@BlenderOfficial/videos')
    expect(tab.title).toBe('Blender - Videos')
    expect(tab.entries).toHaveLength(5)
    expect(tab.truncated).toBe(false)
    // At the cap, an unknown count means there may be more.
    expect(parseFlatPlaylist(channel, 'x', 5).truncated).toBe(true)
  })

  it('marks private, deleted, members-only and live entries as unavailable', () => {
    const [a, b, c, d, e] = openMovies.entries
    const tweaked = {
      ...openMovies,
      entries: [
        { ...a, title: '[Private video]', duration: null },
        { ...b, title: '[Deleted video]', duration: null },
        { ...c, availability: 'subscriber_only' },
        { ...d, live_status: 'is_upcoming' },
        e
      ]
    }
    const reasons = parseFlatPlaylist(tweaked, PLAYLIST_URL).entries.map((entry) => entry.unavailableReason)
    expect(reasons).toEqual(['Private video', 'Deleted video', 'Members only', 'Not released yet', null])
  })

  it('skips entries without a usable link and refuses pages of playlists', () => {
    const [a, b] = openMovies.entries
    const withBadLink = parseFlatPlaylist({ ...openMovies, entries: [{ ...a, url: 'javascript:alert(1)' }, b] }, PLAYLIST_URL)
    expect(withBadLink.entries.map((e) => e.position)).toEqual([1])
    const tabs = {
      ...openMovies,
      entries: [{ _type: 'url', id: 'x', url: 'https://www.youtube.com/@BlenderOfficial/videos', ie_key: 'YoutubeTab' }]
    }
    expect(() => parseFlatPlaylist(tabs, PLAYLIST_URL)).toThrow(/lists other playlists/)
    expect(() => parseFlatPlaylist({ nope: true }, PLAYLIST_URL)).toThrow(AppError)
  })
})

describe('channel links', () => {
  it.each([
    ['https://www.youtube.com/@BlenderOfficial', 'https://www.youtube.com/@BlenderOfficial/videos'],
    ['https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg', 'https://www.youtube.com/channel/UCSMOQeBJ2RAnuFungnQOxLg/videos'],
    ['https://www.youtube.com/@BlenderOfficial/playlists', 'https://www.youtube.com/@BlenderOfficial/playlists'],
    [PLAYLIST_URL, PLAYLIST_URL]
  ])('%s → %s', (input, output) => {
    expect(channelVideosUrl(input)).toBe(output)
  })
})

describe('folder and file names from untrusted titles', () => {
  it.each([
    ['Official Blender Open Movies', 'Official Blender Open Movies'],
    ['AC/DC: Live? <Best> | "Hits"*', 'AC DC Live Best Hits'],
    ['../../etc/passwd', 'etc passwd'],
    ['Trailing dots...', 'Trailing dots'],
    ['  ', 'Playlist'],
    ['CON', 'Playlist'],
    ['nul.txt', 'Playlist'],
    ['Mix\u0000with\u001fcontrol', 'Mixwithcontrol'],
    ['日本語のプレイリスト 🎵', '日本語のプレイリスト 🎵']
  ])('%j → %j', (input, output) => {
    expect(sanitizeFolderName(input)).toBe(output)
  })

  it('caps the length', () => {
    expect([...sanitizeFolderName('x'.repeat(500))]).toHaveLength(100)
  })

  it('never resolves outside the parent folder', () => {
    expect(childPath('/downloads', 'Playlist')).toBe(resolve('/downloads', 'Playlist'))
    expect(() => childPath('/downloads', '../outside')).toThrow()
    expect(() => childPath('/downloads', '.')).toThrow()
  })

  it('accepts only numeric playlist prefixes', () => {
    expect(outputTemplate('title', '007 - ')).toBe('007 - %(title).180B.%(ext)s')
    expect(() => outputTemplate('title', '%(id)s - ')).toThrow()
    expect(() => outputTemplate('title', '../ ')).toThrow()
  })
})

describe('buildProfilePlan (expressions verified against real yt-dlp)', () => {
  const extras = { embedMetadata: false, embedThumbnail: false }
  const sortOf = (args: string[]) => args[args.indexOf('-S') + 1]

  it('MP4 up to 1080p: resolution and frame rate first, then H.264, then stereo', () => {
    const plan = buildProfilePlan({ kind: 'video', container: 'mp4', height: 1080, codec: 'auto' }, extras)
    expect(plan.args.slice(0, 2)).toEqual([
      '-f',
      "bv*[vcodec~='^(avc|h264|hev|hvc|av01)']+ba[acodec~='^(mp4a|aac)']/b[vcodec~='^(avc|h264|hev|hvc|av01)'][acodec~='^(mp4a|aac)']/bv*+ba/b"
    ])
    expect(sortOf(plan.args)).toBe('res:1080,fps,vcodec:h264,channels:2')
    expect(plan.args).toEqual(expect.arrayContaining(['--merge-output-format', 'mp4', '--remux-video', 'mp4']))
    expect(plan.qualityLabel).toBe('Up to 1080p')
    expect(plan.streams).toEqual([])
  })

  it.each([
    [{ container: 'mp4', height: 'best', codec: 'auto' }, 'res,fps,vcodec:h264,channels:2', 'Best available'],
    [{ container: 'webm', height: 720, codec: 'auto' }, 'res:720,fps,vcodec:vp9,channels:2', 'Up to 720p'],
    [{ container: 'mkv', height: 'best', codec: 'auto' }, 'res,fps,channels:2', 'Best available'],
    [{ container: 'mp4', height: 2160, codec: 'av1' }, 'res:2160,fps,vcodec:av01,channels:2', 'Up to 2160p (4K) · AV1'],
    [{ container: 'mkv', height: 1080, codec: 'hevc' }, 'res:1080,fps,vcodec:h265,channels:2', 'Up to 1080p · H.265']
  ] as const)('%j sorts by %s', (selection, sort, label) => {
    const plan = buildProfilePlan({ kind: 'video', ...selection }, extras)
    expect(sortOf(plan.args)).toBe(sort)
    expect(plan.qualityLabel).toBe(label)
  })

  it('WebM never falls back to streams that cannot be merged into WebM', () => {
    const plan = buildProfilePlan({ kind: 'video', container: 'webm', height: 'best', codec: 'auto' }, extras)
    expect(plan.args[1]).not.toMatch(/\/bv\*\+ba\/b$/)
  })

  it('audio: stereo source, preferring one that can be copied', () => {
    const m4a = buildProfilePlan({ kind: 'audio', format: 'm4a', quality: 'best' }, extras)
    expect(m4a.args).toEqual(['-f', 'ba/b', '-S', 'channels:2,acodec:aac', '-x', '--audio-format', 'm4a', '--audio-quality', '0'])
    const mp3 = buildProfilePlan({ kind: 'audio', format: 'mp3', quality: '320' }, { embedMetadata: true, embedThumbnail: true })
    expect(mp3.args).toEqual(['-f', 'ba/b', '-S', 'channels:2', '-x', '--audio-format', 'mp3', '--audio-quality', '320K', '--embed-metadata', '--embed-thumbnail'])
    expect(buildProfilePlan({ kind: 'audio', format: 'flac', quality: '320' }, extras).args).not.toContain('--audio-quality')
  })
})

describe('PlaylistRepository', () => {
  let db: SqliteDatabase
  let repository: PlaylistRepository
  beforeEach(() => {
    db = openDatabase(':memory:', silentLogger)
    repository = new PlaylistRepository(db)
  })
  afterEach(() => db.close())

  it('saves, lists and refreshes without losing download links', () => {
    const input = parseFlatPlaylist(openMovies, PLAYLIST_URL)
    const id = repository.save(input)
    expect(repository.list()).toMatchObject([{ id, title: 'Official Blender Open Movies', totalItems: 17, unavailableItems: 0 }])

    db.prepare(
      `INSERT INTO downloads (id, url, title, media_type, output_format, output_path, status)
       VALUES ('dl-1', 'https://x', 'Big Buck Bunny', 'video', 'mp4', '/tmp', 'completed')`
    ).run()
    repository.linkDownload(id, 16, 'dl-1', 'completed')

    // The playlist changes upstream: Big Buck Bunny moves to the front and a video is removed.
    const bunny = input.entries[15]!
    const reordered = { ...input, entries: [bunny, ...input.entries.slice(0, 15)].map((e, i) => ({ ...e, position: i + 1 })) }
    expect(repository.save(reordered)).toBe(id) // same playlist, refreshed in place
    const details = repository.get(id)!
    expect(details.entries).toHaveLength(16)
    expect(details.entries[0]).toMatchObject({ position: 1, title: 'Big Buck Bunny', downloadId: 'dl-1', status: 'completed' })
    expect(details.entries[1]).toMatchObject({ position: 2, downloadId: null, status: 'pending' })
  })

  it('mirrors job status onto entries, but never revives unavailable ones', () => {
    const input = parseFlatPlaylist(openMovies, PLAYLIST_URL)
    input.entries[1]!.unavailableReason = 'Private video'
    const id = repository.save(input)
    db.prepare(`INSERT INTO downloads (id, url, title, media_type, output_format, output_path, status) VALUES ('dl-2', 'u', 't', 'video', 'mp4', '/', 'queued')`).run()
    repository.linkDownload(id, 1, 'dl-2', 'queued')
    repository.setStatusForDownload('dl-2', 'downloading')
    expect(repository.get(id)!.entries[0]?.status).toBe('downloading')
    expect(repository.get(id)!.entries[1]).toMatchObject({ status: 'unavailable', available: false, unavailableReason: 'Private video' })
    expect(repository.list()[0]?.unavailableItems).toBe(1)
  })

  it('removing a playlist keeps its download jobs', () => {
    const id = repository.save(parseFlatPlaylist(openMovies, PLAYLIST_URL))
    db.prepare(`INSERT INTO downloads (id, url, title, media_type, output_format, output_path, status, playlist_id) VALUES ('dl-3', 'u', 't', 'video', 'mp4', '/', 'completed', ?)`).run(id)
    repository.remove(id)
    expect(repository.get(id)).toBeNull()
    expect(db.prepare("SELECT playlist_id FROM downloads WHERE id = 'dl-3'").get()).toEqual({ playlist_id: null })
    expect(db.prepare('SELECT COUNT(*) AS n FROM playlist_items').get()).toEqual({ n: 0 })
  })
})

describe('PlaylistService', () => {
  let db: SqliteDatabase
  let repository: PlaylistRepository
  let enqueued: PreparedDownload[]
  let jobs: Map<string, DownloadJob>
  let changed: ((job: DownloadJob) => void) | null
  let settings = { ...DEFAULT_SETTINGS }
  let stdout: string
  let failure: string | null
  /** Source ids the fake download manager reports as already downloaded. */
  let downloadedBefore: Set<string>

  beforeEach(() => {
    db = openDatabase(':memory:', silentLogger)
    repository = new PlaylistRepository(db)
    enqueued = []
    jobs = new Map()
    changed = null
    settings = { ...DEFAULT_SETTINGS }
    stdout = JSON.stringify(openMovies)
    failure = null
    downloadedBefore = new Set()
  })
  afterEach(() => db.close())

  function service(): PlaylistService {
    const run: ProcessRunner = vi.fn(async () => ({
      exitCode: failure ? 1 : 0,
      signal: null,
      stdout: failure ? '' : stdout,
      stderr: failure ?? '',
      timedOut: false
    }))
    let counter = 0
    return new PlaylistService({
      runtime: () => ({ ytdlp: '/yt-dlp', ffmpegLocation: '/ff', deno: null }),
      acquire: () => () => {},
      run,
      thumbnails: { cached: vi.fn(async () => 'data:image/jpeg;base64,T') } as never,
      repository,
      downloads: {
        baseDestination: () => resolve('/downloads'),
        find: (id) => jobs.get(id) ?? null,
        setThumbnail: vi.fn(),
        downloadedSources: async (ids) => new Set(ids.filter((sourceId) => downloadedBefore.has(sourceId))),
        onChanged: (listener) => {
          changed = listener
          return () => {}
        },
        enqueue: async (items) => {
          enqueued.push(...items)
          return items.map((item) => {
            const id = `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
            const job = { id, status: 'queued', playlistId: item.playlist?.id ?? null, playlistPosition: item.playlist?.position ?? null } as DownloadJob
            db.prepare(`INSERT INTO downloads (id, url, title, media_type, output_format, output_path, status) VALUES (?, 'u', 't', 'video', 'mp4', '/', 'queued')`).run(id)
            jobs.set(id, job)
            return job
          })
        }
      },
      settings: () => settings,
      logger: silentLogger
    })
  }

  it('lists a playlist and returns it with entries', async () => {
    const details = await service().analyze(PLAYLIST_URL)
    expect(details).toMatchObject({ title: 'Official Blender Open Movies', totalItems: 17, thumbnail: 'data:image/jpeg;base64,T' })
    expect(details.entries.every((e) => e.status === 'pending')).toBe(true)
    // Analysing again refreshes the same record.
    expect((await service().analyze(PLAYLIST_URL)).id).toBe(details.id)
  })

  it('reports a playlist that does not exist', async () => {
    failure = fixtureText('errors.txt').split(/\r?\n/)[3]!
    expect(classifyYtDlpError(failure).code).toBe('PLAYLIST_UNAVAILABLE')
    expect(await code(service().analyze('https://www.youtube.com/playlist?list=PLwiyx1dc3P2JR9N8gQaQN_BCvlSlap7re'))).toBe('NOT_FOUND')
  })

  it('queues one job per selected video into a playlist folder, numbered in order', async () => {
    const playlists = service()
    const { id } = await playlists.analyze(PLAYLIST_URL)
    const result = await playlists.download({
      playlistId: id,
      positions: [3, 16],
      selection: { kind: 'video', container: 'mp4', height: 720, codec: 'auto' },
      options: { embedMetadata: true, embedThumbnail: true },
      numberFiles: true,
      skipDownloaded: true
    })
    expect(result).toEqual({ queued: 2, skipped: 0, alreadyDownloaded: 0 })
    expect(enqueued.map((item) => [item.title, item.filenamePrefix, item.destination])).toEqual([
      ['CHARGE - Blender Open Movie', '003 - ', resolve('/downloads', 'Official Blender Open Movies')],
      ['Big Buck Bunny', '016 - ', resolve('/downloads', 'Official Blender Open Movies')]
    ])
    expect(enqueued[0]).toMatchObject({ sourceId: 'youtube:UXqq0ZvbOnk', playlist: { id, position: 3, title: 'Official Blender Open Movies' } })
    const entries = playlists.get(id).entries
    expect(entries[2]?.downloadId).not.toBeNull()
    expect(entries[2]?.status).toBe('queued')

    // Job progress is mirrored onto the entry.
    changed?.({ ...jobs.get(entries[2]!.downloadId!)!, status: 'completed' })
    expect(playlists.get(id).entries[2]?.status).toBe('completed')
  })

  it('skips unavailable and already-running entries; honours settings', async () => {
    settings = { ...settings, playlistSubfolders: false }
    const [first, ...rest] = openMovies.entries
    stdout = JSON.stringify({ ...openMovies, entries: [{ ...first, title: '[Private video]' }, ...rest] })
    const playlists = service()
    const { id } = await playlists.analyze(PLAYLIST_URL)

    const firstRun = await playlists.download({
      playlistId: id,
      positions: 'all',
      selection: { kind: 'audio', format: 'mp3', quality: '192' },
      options: { embedMetadata: false, embedThumbnail: false },
      numberFiles: false,
      skipDownloaded: false
    })
    // The private first entry is skipped, not fatal.
    expect(firstRun).toEqual({ queued: 16, skipped: 1, alreadyDownloaded: 0 })
    expect(enqueued.every((item) => item.destination === resolve('/downloads') && item.filenamePrefix === undefined)).toBe(true)

    // Everything is still queued, so asking again queues nothing new.
    await expect(
      playlists.download({
        playlistId: id,
        positions: [1, 2],
        selection: { kind: 'audio', format: 'mp3', quality: '192' },
        options: { embedMetadata: false, embedThumbnail: false },
        numberFiles: false,
        skipDownloaded: false
      })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('leaves out videos already downloaded in the same format, and paused ones', async () => {
    const playlists = service()
    const { id } = await playlists.analyze(PLAYLIST_URL)
    downloadedBefore = new Set(['youtube:UXqq0ZvbOnk']) // entry 3, "CHARGE"
    const request: PlaylistDownloadRequest = {
      playlistId: id,
      positions: [3, 16],
      selection: { kind: 'audio', format: 'mp3', quality: '192' },
      options: { embedMetadata: false, embedThumbnail: false },
      numberFiles: false,
      skipDownloaded: true
    }
    expect(await playlists.download(request)).toEqual({ queued: 1, skipped: 1, alreadyDownloaded: 1 })
    expect(enqueued.map((item) => item.title)).toEqual(['Big Buck Bunny'])

    // A paused job counts as in progress: it is resumed, not queued twice.
    const bunny = playlists.get(id).entries[15]!
    jobs.set(bunny.downloadId!, { ...jobs.get(bunny.downloadId!)!, status: 'paused' })
    await expect(playlists.download({ ...request, positions: [16] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    // Everything selected was downloaded before: say so.
    await expect(playlists.download({ ...request, positions: [3] })).rejects.toThrow('already downloaded as MP3')
    // Without the option, it is downloaded again.
    expect(await playlists.download({ ...request, positions: [3], skipDownloaded: false })).toMatchObject({ queued: 1 })
  })

  it('validates download requests', () => {
    const base = { playlistId: '00000000-0000-4000-8000-000000000000', selection: { kind: 'audio', format: 'mp3', quality: '192' }, options: { embedMetadata: true, embedThumbnail: true }, numberFiles: true, skipDownloaded: true }
    expect(playlistDownloadRequestSchema.safeParse({ ...base, positions: 'all' }).success).toBe(true)
    expect(playlistDownloadRequestSchema.safeParse({ ...base, positions: [0] }).success).toBe(false)
    expect(playlistDownloadRequestSchema.safeParse({ ...base, positions: [] }).success).toBe(false)
    expect(playlistDownloadRequestSchema.safeParse({ ...base, positions: 'all', destination: 'C:\\' }).success).toBe(false)
  })
})

describe('LinkAnalyzer', () => {
  it('routes playlists to the playlist service', async () => {
    const media = { analyze: vi.fn(async () => { throw new PlaylistDetected() }), cancel: vi.fn() }
    const playlists = { analyze: vi.fn(async () => ({ id: 'p' })), cancel: vi.fn() }
    const links = new LinkAnalyzer(media as never, playlists as never)
    expect(await links.analyze(PLAYLIST_URL)).toEqual({ kind: 'playlist', playlist: { id: 'p' } })
    links.cancel()
    expect(media.cancel).toHaveBeenCalled()
    expect(playlists.cancel).toHaveBeenCalled()
  })

  it('passes single videos and other errors through', async () => {
    const media = { analyze: vi.fn(async () => ({ title: 'v' })), cancel: vi.fn() }
    const previous = vi.fn(async () => [])
    const links = new LinkAnalyzer(media as never, { analyze: vi.fn() } as never, previous)
    media.analyze.mockResolvedValueOnce({ title: 'v', sourceId: 'youtube:aqz-KE-bpKQ' } as never)
    expect(await links.analyze('https://youtu.be/aqz-KE-bpKQ')).toEqual({ kind: 'media', media: { title: 'v', sourceId: 'youtube:aqz-KE-bpKQ' }, previousDownloads: [] })
    expect(previous).toHaveBeenCalledWith('youtube:aqz-KE-bpKQ')
    media.analyze.mockRejectedValueOnce(new AppError('NETWORK', 'offline'))
    expect(await code(links.analyze('https://youtu.be/aqz-KE-bpKQ'))).toBe('NETWORK')
  })
})

describe('thumbnails served as WebP under a .jpg name', () => {
  // YouTube's signed playlist thumbnails (hqdefault.jpg?sqp=…) arrive as image/webp,
  // which Electron's encoder cannot read (observed with the real playlist above).
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(32)])

  it('passes genuine, small WebP data through untouched', async () => {
    const { passThroughWebp, ThumbnailService } = await import('../../electron/services/media/thumbnail.service')
    expect(passThroughWebp(webp)).toBe(`data:image/webp;base64,${webp.toString('base64')}`)
    expect(passThroughWebp(Buffer.from('<html>not an image</html>'))).toBeNull()
    expect(passThroughWebp(Buffer.concat([webp, Buffer.alloc(600 * 1024)]))).toBeNull()

    const { fakeFetch } = await import('../helpers/fake-fetch')
    const url = 'https://i.ytimg.com/vi/x/hqdefault.jpg?sqp=abc'
    const service = new ThumbnailService(fakeFetch({ [url]: { body: webp, headers: { 'content-type': 'image/webp' } } }), () => null, silentLogger)
    expect(await service.cached(url, 240)).toMatch(/^data:image\/webp;base64,/)
  })
})
