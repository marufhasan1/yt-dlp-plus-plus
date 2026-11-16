import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DownloadJob } from '@shared/types/downloads'
import type { DownloadRequest, MediaAnalysis } from '@shared/types/media'
import { DEFAULT_SETTINGS } from '@shared/validation/settings'
import { DownloadManager } from '../../electron/services/download/download-manager'
import { DownloadWorker } from '../../electron/services/download/download-worker'
import type { DownloadPlan } from '../../electron/services/media/format-selection'
import { openDatabase, type SqliteDatabase } from '../../electron/services/storage/database'
import { DownloadRepository } from '../../electron/services/storage/download.repository'
import { AppError } from '../../electron/utils/errors'
import { silentLogger } from '../../electron/utils/logger'

const fixture = (name: string) =>
  readFileSync(join(__dirname, '..', 'fixtures', 'ytdlp', name), 'utf8').split(/\r?\n/).filter(Boolean)

const PLAN: DownloadPlan = {
  kind: 'video',
  args: ['-f', '134+140'],
  outputFormat: 'mp4',
  qualityLabel: '360p · H.264',
  streams: [
    { formatId: '134', kind: 'video', bytes: 18294110 },
    { formatId: '140', kind: 'audio', bytes: 10271496 }
  ],
  estimatedBytes: 28565606
}

const REQUEST: DownloadRequest = {
  analysisId: '11111111-1111-4111-8111-111111111111',
  selection: { kind: 'video', container: 'mp4', height: 360, codec: 'auto' },
  options: { embedMetadata: false, embedThumbnail: false, subtitles: null }
}

type Script = { stdout: string[]; stderr: string[]; code: number } | 'hang' | { stdout: string[]; hang: true }

/** A stand-in for the yt-dlp process that replays recorded output. */
function fakeProcess(script: Script): ChildProcess {
  const child = new EventEmitter() as ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  Object.assign(child, { stdout, stderr, pid: 4242, exitCode: null, signalCode: null })
  if (script === 'hang') return child
  setImmediate(() => {
    for (const line of script.stdout) {
      // The file yt-dlp reports as final is created, so size and existence checks see it.
      const final = /^\[MF-FILE\] (".*")$/.exec(line)?.[1]
      if (final) writeFileSync(JSON.parse(final) as string, 'video')
      stdout.write(`${line}\n`)
    }
    if ('hang' in script) return
    for (const line of script.stderr) stderr.write(`${line}\n`)
    stdout.end()
    stderr.end()
    setTimeout(() => child.emit('close', script.code), 5)
  })
  return child
}

const recorded = fixture('download-merge.stdout.txt')
/** Real yt-dlp output of a merged download, with the final file placed in the test folder. */
const success = (): Script => ({
  stdout: recorded.map((line) =>
    line.startsWith('[MF-FILE]') ? `[MF-FILE] ${JSON.stringify(join(root, 'Downloads', `Video ${++files}.mp4`))}` : line
  ),
  stderr: fixture('download-merge.stderr.txt'),
  code: 0
})
const FAILURE: Script = { stdout: [], stderr: ['ERROR: [youtube] aqz-KE-bpKQ: This video is unavailable'], code: 1 }
/** Real yt-dlp text for a failed name lookup. */
const NETWORK_FAILURE: Script = { stdout: recorded.slice(0, 5), stderr: [fixture('errors.txt')[2]!], code: 1 }
/** Downloading has finished and FFmpeg is merging. */
const MERGING: Script = { stdout: [...recorded.slice(0, 5), '[MF-PP] started|Merger'], hang: true }

let root: string
let files: number
let db: SqliteDatabase
let repository: DownloadRepository
let scripts: Script[]
let settings = { ...DEFAULT_SETTINGS }
let ffmpegLocation: string | null
let sourceIds: string[]
let retryBaseDelayMs: number
/** PIDs the fake OS reports as still running yt-dlp from an earlier session. */
let runningOrphans: Set<number>
const killOrphan = vi.fn(async (pid: number) => {
  runningOrphans.delete(pid)
})
const trash = vi.fn(async (path: string) => rmSync(path))
const release = vi.fn()
const acquire = vi.fn(() => release)
const kill = vi.fn(async (child: ChildProcess) => {
  child.emit('close', null)
})
const spawned: string[][] = []

function manager(): DownloadManager {
  let calls = 0
  return new DownloadManager({
    repository,
    // Each request is a different video unless the test lists source ids.
    media: {
      plan: () => {
        const sourceId = sourceIds.shift() ?? `youtube:video-${++calls}-${Math.random()}`
        const analysis = { analysisId: REQUEST.analysisId, url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ', sourceId, title: 'Big Buck Bunny', thumbnail: null } as MediaAnalysis
        return { cached: { analysis, formats: [], createdAt: 0 }, plan: PLAN }
      }
    },
    engines: {
      runtime: () => ({ ytdlp: '/engines/yt-dlp', ffmpegLocation, deno: null }),
      acquire
    },
    settings: () => settings,
    defaultDownloadDir: join(root, 'Downloads'),
    tempRoot: join(root, 'tmp'),
    createWorker: () =>
      new DownloadWorker({
        logger: silentLogger,
        kill,
        spawn: (_file, args) => {
          spawned.push([...args])
          return fakeProcess(scripts.shift() ?? success())
        }
      }),
    logger: silentLogger,
    trash,
    platform: 'linux',
    retryBaseDelayMs,
    orphans: {
      inspect: async (pid) => (runningOrphans.has(pid) ? { executable: '/engines/yt-dlp', startedAt: null } : null),
      kill: killOrphan
    }
  })
}

async function settle(downloads: DownloadManager, id: string, statuses: DownloadJob['status'][]): Promise<DownloadJob> {
  await vi.waitFor(() => expect(statuses).toContain(downloads.get(id).status), { timeout: 3000 })
  return downloads.get(id)
}

const tempOf = (id: string) => join(root, 'tmp', id)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ytdlpp-dm-'))
  files = 0
  db = openDatabase(':memory:', silentLogger)
  repository = new DownloadRepository(db)
  scripts = []
  sourceIds = []
  retryBaseDelayMs = 20
  runningOrphans = new Set()
  settings = { ...DEFAULT_SETTINGS }
  ffmpegLocation = '/engines'
  spawned.length = 0
  vi.clearAllMocks()
})
afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

describe('DownloadManager', () => {
  it('runs a download from queue to completion and records it', async () => {
    const downloads = manager()
    const seen: DownloadJob[] = []
    downloads.onChanged((job) => seen.push(job))

    const queued = await downloads.start(REQUEST)
    expect(queued).toMatchObject({ status: 'queued', title: 'Big Buck Bunny', outputFormat: 'mp4', quality: '360p · H.264', interrupted: false })

    const done = await settle(downloads, queued.id, ['completed', 'failed'])
    expect(done).toMatchObject({ status: 'completed', progress: 100, error: null, outputPath: join(root, 'Downloads', 'Video 1.mp4'), totalBytes: 5 })
    expect(seen.map((j) => j.status)).toEqual(expect.arrayContaining(['queued', 'downloading', 'processing', 'completed']))
    expect(seen.some((j) => j.stage === 'Downloading video (1 of 2)')).toBe(true)

    // Engines were leased for the run and released after.
    expect(acquire).toHaveBeenCalledWith(['yt-dlp', 'ffmpeg', 'ffprobe', 'deno'])
    // Both happen in the run's clean-up, just after "completed" is reported.
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce())
    // The per-job scratch folder is gone.
    await vi.waitFor(() => expect(existsSync(tempOf(queued.id))).toBe(false))
    // Persisted.
    expect(repository.get(queued.id)?.job).toMatchObject({ status: 'completed', progress: 100, sourceId: queued.sourceId })
    expect(spawned[0]?.slice(-2)).toEqual(['--', 'https://www.youtube.com/watch?v=aqz-KE-bpKQ'])
    expect(spawned[0]).toEqual(expect.arrayContaining(['--paths', `temp:${tempOf(queued.id)}`]))
  })

  it('classifies failures and allows a retry', async () => {
    scripts = [FAILURE, success()]
    const downloads = manager()
    const { id } = await downloads.start(REQUEST)
    const failed = await settle(downloads, id, ['failed', 'completed'])
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'VIDEO_UNAVAILABLE' })
    expect(repository.get(id)?.job.errorCode).toBe('VIDEO_UNAVAILABLE')
    expect(spawned).toHaveLength(1) // not a network problem: no automatic retry

    expect(downloads.retry(id).status).toBe('queued')
    expect((await settle(downloads, id, ['completed', 'failed'])).status).toBe('completed')
  })

  it('respects the simultaneous-download limit, and raises it live', async () => {
    settings = { ...settings, maxConcurrentDownloads: 1 }
    scripts = ['hang', 'hang']
    const downloads = manager()
    const first = await downloads.start(REQUEST)
    const second = await downloads.start(REQUEST)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    expect(downloads.get(first.id).status).toBe('downloading')
    expect(downloads.get(second.id).status).toBe('queued')

    settings = { ...settings, maxConcurrentDownloads: 2 }
    downloads.settingsChanged()
    await vi.waitFor(() => expect(spawned).toHaveLength(2))

    await downloads.cancel(first.id)
    expect((await settle(downloads, first.id, ['cancelled'])).status).toBe('cancelled')
    expect(kill).toHaveBeenCalledOnce()
    await downloads.cancel(second.id)
  })

  it('cancels a queued job without starting it', async () => {
    settings = { ...settings, maxConcurrentDownloads: 1 }
    scripts = ['hang']
    const downloads = manager()
    const running = await downloads.start(REQUEST)
    const waiting = await downloads.start(REQUEST)
    await downloads.cancel(waiting.id)
    expect(downloads.get(waiting.id).status).toBe('cancelled')
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    await downloads.cancel(running.id)
    await settle(downloads, running.id, ['cancelled'])
    expect(spawned).toHaveLength(1)
    await vi.waitFor(() => expect(existsSync(tempOf(running.id))).toBe(false))
  })

  it('only removes finished jobs, and keeps the history row', async () => {
    scripts = ['hang']
    const downloads = manager()
    const job = await downloads.start(REQUEST)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    await expect(downloads.remove(job.id)).rejects.toBeInstanceOf(AppError)
    await downloads.cancel(job.id)
    await settle(downloads, job.id, ['cancelled'])

    await downloads.remove(job.id)
    expect(downloads.list()).toEqual([])
    expect(repository.list()).toEqual([])
    expect(repository.get(job.id)).toMatchObject({ dismissed: true }) // still in the database for history
  })

  it('refuses to start without FFmpeg', async () => {
    ffmpegLocation = null
    await expect(manager().start(REQUEST)).rejects.toMatchObject({ code: 'ENGINE_MISSING' })
  })
})

describe('pause and resume', () => {
  it('stops a running download, keeps its partial files, and continues them on resume', async () => {
    scripts = [{ stdout: recorded.slice(0, 20), hang: true }]
    const downloads = manager()
    const { id } = await downloads.start(REQUEST)
    await vi.waitFor(() => expect(downloads.get(id).downloadedBytes).toBeGreaterThan(0))
    writeFileSync(join(tempOf(id), 'video.f134.mp4.part'), 'partial')

    await downloads.pause(id)
    const paused = await settle(downloads, id, ['paused'])
    expect(paused).toMatchObject({ status: 'paused', interrupted: false, speed: 0 })
    expect(paused.progress).toBeGreaterThan(0)
    expect(kill).toHaveBeenCalledOnce()
    expect(existsSync(join(tempOf(id), 'video.f134.mp4.part'))).toBe(true)
    expect(repository.get(id)?.job.status).toBe('paused')
    expect(downloads.hasActiveJobs()).toBe(false)

    const resumed = downloads.resume(id)
    expect(resumed.status).toBe('queued')
    expect(resumed.progress).toBe(paused.progress) // not reset while waiting
    await settle(downloads, id, ['completed'])
    // The same command, with the same scratch folder, ran again.
    expect(spawned).toHaveLength(2)
    expect(spawned[1]).toEqual(spawned[0])
    expect(existsSync(tempOf(id))).toBe(false)
  })

  it('pauses queued jobs without starting them, and resumes all in order', async () => {
    settings = { ...settings, maxConcurrentDownloads: 1 }
    scripts = ['hang']
    const downloads = manager()
    const running = await downloads.start(REQUEST)
    const waiting = await downloads.start(REQUEST)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))

    expect(await downloads.pauseAll()).toBe(2)
    await settle(downloads, running.id, ['paused'])
    expect(downloads.get(waiting.id).status).toBe('paused')
    expect(spawned).toHaveLength(1) // the queued job never started in the freed slot

    expect(downloads.resumeAll()).toBe(2)
    await settle(downloads, running.id, ['completed'])
    await settle(downloads, waiting.id, ['completed'])
  })

  it('does not interrupt post-processing, and cancels paused jobs with their files', async () => {
    scripts = [MERGING]
    const downloads = manager()
    const { id } = await downloads.start(REQUEST)
    await settle(downloads, id, ['processing'])
    await expect(downloads.pause(id)).rejects.toMatchObject({ code: 'BUSY' })
    await downloads.cancel(id)
    await settle(downloads, id, ['cancelled'])
    expect(() => downloads.resume(id)).toThrow(AppError)

    scripts = ['hang']
    const second = await downloads.start(REQUEST)
    await settle(downloads, second.id, ['downloading'])
    await downloads.pause(second.id)
    await settle(downloads, second.id, ['paused'])
    await expect(downloads.remove(second.id)).rejects.toMatchObject({ code: 'BUSY' })
    await downloads.cancel(second.id)
    expect(downloads.get(second.id).status).toBe('cancelled')
    expect(existsSync(tempOf(second.id))).toBe(false)
  })
})

describe('automatic retries', () => {
  it('resumes after a network failure, up to the configured number of times', async () => {
    settings = { ...settings, maxRetries: 2 }
    scripts = [NETWORK_FAILURE, NETWORK_FAILURE, success()]
    const downloads = manager()
    const stages: (string | null)[] = []
    downloads.onChanged((job) => stages.push(job.stage))
    const { id } = await downloads.start(REQUEST)
    await settle(downloads, id, ['completed'])
    expect(spawned).toHaveLength(3)
    expect(stages).toContain('Connection problem — retrying in 0 s (attempt 1 of 2)')
    expect(stages.some((stage) => stage?.includes('attempt 2 of 2'))).toBe(true)
  })

  it('gives up when the retries are used up, keeping the partial files for a manual retry', async () => {
    settings = { ...settings, maxRetries: 1 }
    scripts = [NETWORK_FAILURE, NETWORK_FAILURE]
    const downloads = manager()
    const { id } = await downloads.start(REQUEST)
    await vi.waitFor(() => expect(spawned).toHaveLength(2))
    const failed = await settle(downloads, id, ['failed'])
    expect(failed).toMatchObject({ errorCode: 'NETWORK' })
    expect(existsSync(tempOf(id))).toBe(true)

    settings = { ...settings, maxRetries: 0 }
    scripts = [NETWORK_FAILURE]
    const other = await downloads.start(REQUEST)
    expect((await settle(downloads, other.id, ['failed'])).errorCode).toBe('NETWORK')
  })

  it('can be paused or cancelled while waiting to retry', async () => {
    settings = { ...settings, maxRetries: 3 }
    retryBaseDelayMs = 60_000
    scripts = [NETWORK_FAILURE, NETWORK_FAILURE]
    const downloads = manager()
    const { id } = await downloads.start(REQUEST)
    await vi.waitFor(() => expect(downloads.get(id).stage ?? '').toMatch(/retrying in 60 s/))
    await downloads.pause(id)
    expect(downloads.get(id).status).toBe('paused')
    expect(spawned).toHaveLength(1)
    // Resuming starts at once and counts attempts afresh; cancelling during the next wait ends it.
    downloads.resume(id)
    await vi.waitFor(() => expect(downloads.get(id).stage ?? '').toMatch(/attempt 1 of 3/))
    expect(spawned).toHaveLength(2)
    await downloads.cancel(id)
    expect(downloads.get(id).status).toBe('cancelled')
    await vi.waitFor(() => expect(existsSync(tempOf(id))).toBe(false))
  })
})

describe('restart recovery', () => {
  it('records which process owns a running download, and stops it if a crash left it running', async () => {
    scripts = ['hang']
    const crashed = manager()
    const { id } = await crashed.start(REQUEST)
    await vi.waitFor(() => expect(existsSync(join(tempOf(id), '.ytdlpp-owner.json'))).toBe(true))
    expect(JSON.parse(readFileSync(join(tempOf(id), '.ytdlpp-owner.json'), 'utf8'))).toMatchObject({ pid: 4242, executable: '/engines/yt-dlp' })

    // The app dies; the fake OS still runs that yt-dlp. The next start stops it before anything resumes.
    runningOrphans.add(4242)
    const after = manager()
    after.initialize()
    await after.cleanTemp()
    expect(killOrphan).toHaveBeenCalledWith(4242)
    expect(existsSync(join(tempOf(id), '.ytdlpp-owner.json'))).toBe(false)
    expect(after.get(id)).toMatchObject({ status: 'paused', interrupted: true })

    // A paused job's folder keeps its partial files but no owner record.
    scripts = ['hang']
    after.resume(id)
    await settle(after, id, ['downloading'])
    await after.pause(id)
    await settle(after, id, ['paused'])
    await vi.waitFor(() => expect(existsSync(join(tempOf(id), '.ytdlpp-owner.json'))).toBe(false))
    expect(existsSync(tempOf(id))).toBe(true)
    await crashed.cancel(id).catch(() => {})
  })

  it('keeps jobs stopped by a shutdown paused and offers them for resuming', async () => {
    settings = { ...settings, maxConcurrentDownloads: 1 }
    scripts = ['hang']
    const before = manager()
    const running = await before.start(REQUEST)
    const waiting = await before.start(REQUEST)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    writeFileSync(join(tempOf(running.id), 'video.part'), 'partial')
    await before.shutdown()
    expect(repository.get(running.id)?.job).toMatchObject({ status: 'paused', interrupted: true })

    const after = manager()
    expect(after.initialize()).toBe(0) // already saved as paused by the clean shutdown
    expect(after.get(running.id)).toMatchObject({ status: 'paused', interrupted: true })
    expect(after.get(waiting.id)).toMatchObject({ status: 'paused', interrupted: true })
    mkdirSync(tempOf('00000000-0000-4000-8000-00000000dead'))
    await after.cleanTemp()
    expect(existsSync(join(tempOf(running.id), 'video.part'))).toBe(true) // kept for resuming
    expect(existsSync(tempOf('00000000-0000-4000-8000-00000000dead'))).toBe(false) // orphan removed

    after.resume(running.id)
    expect(after.get(running.id).interrupted).toBe(false)
    await settle(after, running.id, ['completed'])
  })

  it('recovers jobs cut off by a crash', async () => {
    scripts = ['hang']
    const crashed = manager()
    const job = await crashed.start(REQUEST)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    // No shutdown: the row is still "downloading" in the database.
    db.prepare(`INSERT INTO downloads (id, url, title, media_type, output_format, output_path, status)
                VALUES ('00000000-0000-4000-8000-0000000000aa', 'u', 'Old', 'video', 'mp4', '/', 'downloading')`).run()

    const after = manager()
    expect(after.initialize()).toBe(1)
    expect(after.get(job.id)).toMatchObject({ status: 'paused', interrupted: true })
    // A job without a stored plan cannot be resumed and is marked failed instead.
    expect(after.get('00000000-0000-4000-8000-0000000000aa')).toMatchObject({ status: 'failed', errorCode: 'INTERRUPTED' })
    await crashed.cancel(job.id)
  })
})

describe('reported output files', () => {
  it('ignores a final file outside the destination folder, or one named on stderr', async () => {
    const outside = join(root, 'Documents', 'taxes.pdf')
    mkdirSync(join(root, 'Documents'))
    writeFileSync(outside, 'private')
    const mfFile = (path: string) => `[MF-FILE] ${JSON.stringify(path)}`
    scripts = [
      { stdout: [...recorded.filter((l) => !l.startsWith('[MF-FILE]')), mfFile(outside)], stderr: [], code: 0 },
      { stdout: recorded.filter((l) => !l.startsWith('[MF-FILE]')), stderr: [mfFile(join(root, 'Downloads', 'Video 99.mp4'))], code: 0 }
    ]
    const downloads = manager()
    const first = await downloads.start(REQUEST)
    expect((await settle(downloads, first.id, ['completed'])).outputPath).toBe(join(root, 'Downloads'))
    // History cannot be used to move the outside file to the Recycle Bin.
    await expect(downloads.deleteRecord(first.id, true)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(trash).not.toHaveBeenCalled()
    expect(existsSync(outside)).toBe(true)

    const second = await downloads.start(REQUEST)
    expect((await settle(downloads, second.id, ['completed'])).outputPath).toBe(join(root, 'Downloads'))
  })
})

describe('duplicates and history', () => {
  it('refuses a second active download of the same video and format, and remembers earlier ones', async () => {
    sourceIds = ['youtube:same', 'youtube:same', 'youtube:same']
    scripts = ['hang']
    const downloads = manager()
    const first = await downloads.start(REQUEST)
    await expect(downloads.start(REQUEST)).rejects.toMatchObject({ code: 'DUPLICATE' })
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    await downloads.cancel(first.id)
    await settle(downloads, first.id, ['cancelled'])
    const second = await downloads.start(REQUEST)
    await settle(downloads, second.id, ['completed'])

    const previous = await downloads.previous('youtube:same')
    expect(previous.map((p) => [p.status, p.fileExists])).toEqual([
      ['completed', true],
      ['cancelled', null]
    ])
    expect(await downloads.downloadedSources(['youtube:same', 'youtube:other'], 'mp4')).toEqual(new Set(['youtube:same']))
    expect(await downloads.downloadedSources(['youtube:same'], 'mp3')).toEqual(new Set())
    rmSync(downloads.get(second.id).outputPath)
    expect(await downloads.downloadedSources(['youtube:same'], 'mp4')).toEqual(new Set()) // file gone: not a duplicate
  })

  it('searches and filters history, including removed jobs', async () => {
    scripts = [success(), FAILURE]
    const downloads = manager()
    const done = await downloads.start(REQUEST)
    await settle(downloads, done.id, ['completed'])
    const failed = await downloads.start(REQUEST)
    await settle(downloads, failed.id, ['failed'])
    db.prepare("UPDATE downloads SET title = 'Sintel 100% [4K]', created_at = '2026-01-15T10:00:00.000Z' WHERE id = ?").run(failed.id)
    await downloads.remove(failed.id)

    const all = await downloads.history({ offset: 0, limit: 50 })
    expect(all.total).toBe(2)
    expect(all.formats).toEqual(['mp4'])
    expect(all.items.find((i) => i.id === done.id)).toMatchObject({ fileExists: true, listed: true })
    expect(all.items.find((i) => i.id === failed.id)).toMatchObject({ fileExists: null, listed: false })

    const query = async (q: object) => (await downloads.history({ offset: 0, limit: 50, ...q })).items.map((i) => i.id)
    expect(await query({ search: '100%' })).toEqual([failed.id]) // LIKE wildcards are matched literally
    expect(await query({ search: '_' })).toEqual([])
    expect(await query({ search: 'youtube.com/watch' })).toHaveLength(2)
    expect(await query({ status: 'failed' })).toEqual([failed.id])
    expect(await query({ format: 'mp3' })).toEqual([])
    expect(await query({ from: '2026-01-15T00:00:00.000Z', to: '2026-01-16T00:00:00.000Z' })).toEqual([failed.id])
    expect((await downloads.history({ offset: 1, limit: 1 })).items).toHaveLength(1)
  })

  it('deletes history entries, and the file only when asked', async () => {
    scripts = [success(), success()]
    const downloads = manager()
    const kept = await downloads.start(REQUEST)
    const trashed = await downloads.start(REQUEST)
    await settle(downloads, kept.id, ['completed'])
    await settle(downloads, trashed.id, ['completed'])
    const keptFile = downloads.get(kept.id).outputPath
    const trashedFile = downloads.get(trashed.id).outputPath
    const removed: string[] = []
    downloads.onRemoved((id) => removed.push(id))

    expect(await downloads.deleteRecord(kept.id, false)).toEqual({ fileDeleted: false })
    expect(existsSync(keptFile)).toBe(true)
    expect(trash).not.toHaveBeenCalled()
    expect(repository.get(kept.id)).toBeNull()

    expect(await downloads.deleteRecord(trashed.id, true)).toEqual({ fileDeleted: true })
    expect(trash).toHaveBeenCalledWith(trashedFile)
    expect(removed).toEqual([kept.id, trashed.id])
    await expect(downloads.deleteRecord(trashed.id, false)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses to delete active work or a missing file, and retries from history', async () => {
    scripts = ['hang', FAILURE, success()]
    const downloads = manager()
    const active = await downloads.start(REQUEST)
    await vi.waitFor(() => expect(spawned).toHaveLength(1))
    await expect(downloads.deleteRecord(active.id, false)).rejects.toMatchObject({ code: 'BUSY' })
    await downloads.cancel(active.id)

    const failed = await downloads.start(REQUEST)
    await settle(downloads, failed.id, ['failed'])
    await expect(downloads.deleteRecord(failed.id, true)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await downloads.remove(failed.id)
    expect(downloads.find(failed.id)).toBeNull()

    // Retrying from History brings the job back to the Downloads list.
    expect(downloads.retry(failed.id).status).toBe('queued')
    expect(repository.get(failed.id)?.dismissed).toBe(false)
    await settle(downloads, failed.id, ['completed'])
    expect(downloads.location(failed.id)).toMatch(/Video \d\.mp4$/)
  })
})
