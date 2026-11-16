import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ProgressAggregator,
  parseProgressLine,
  postprocessorLabel
} from '../../electron/services/download/download-progress'
import { classifyYtDlpError } from '../../electron/services/media/ytdlp-errors'

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'ytdlp', name), 'utf8')
const lines = (name: string) => fixture(name).split(/\r?\n/).filter(Boolean)

describe('parseProgressLine (real yt-dlp output)', () => {
  it('parses download progress with empty fields for unknown values', () => {
    expect(parseProgressLine('[MF-PROGRESS] downloading|1024|18294110||345310.12188454735|53|134')).toEqual({
      type: 'progress',
      status: 'downloading',
      downloadedBytes: 1024,
      totalBytes: 18294110,
      totalBytesEstimate: null,
      speed: 345310.12188454735,
      eta: 53,
      formatId: '134'
    })
  })

  it('parses post-processing events and the JSON-encoded final path', () => {
    expect(parseProgressLine('[MF-PP] started|Merger')).toEqual({ type: 'postprocess', status: 'started', name: 'Merger' })
    const file = lines('download-merge.stdout.txt').find((l) => l.startsWith('[MF-FILE]'))!
    expect(parseProgressLine(file)).toEqual({
      type: 'file',
      path: expect.stringMatching(/Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film \[aqz-KE-bpKQ\]\.mp4$/)
    })
  })

  it('ignores yt-dlp’s own messages and malformed lines', () => {
    expect(parseProgressLine('WARNING: Unknown codec iamf.001.001.Opus')).toBeNull()
    expect(parseProgressLine('[MF-FILE] not json')).toBeNull()
    expect(parseProgressLine('[download] 50%')).toBeNull()
  })
})

describe('ProgressAggregator (real merge download: 134 video + 140 audio)', () => {
  const planned = [
    { formatId: '134', kind: 'video' as const, bytes: 18294110 },
    { formatId: '140', kind: 'audio' as const, bytes: 10271496 }
  ]

  it('weights both streams and reaches 100 % before post-processing', () => {
    const aggregator = new ProgressAggregator(planned)
    const stdout = lines('download-merge.stdout.txt')
    const stderr = lines('download-merge.stderr.txt')
    const seen: number[] = []
    let videoStage = ''
    for (const line of stdout) {
      const event = parseProgressLine(line)
      if (event && event.type !== 'file') {
        const snapshot = aggregator.apply(event)
        seen.push(snapshot.progress)
        if (event.type === 'progress' && event.formatId === '134') videoStage = snapshot.stage
      }
    }
    expect(videoStage).toBe('Downloading video (1 of 2)')
    // Never moves backwards when the second stream starts.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]!)
    expect(aggregator.snapshot()).toMatchObject({ progress: 100, downloadedBytes: 18294110 + 10271496, totalBytes: 28565606 })

    for (const line of stderr) {
      const event = parseProgressLine(line)
      if (event) aggregator.apply(event)
    }
    expect(aggregator.snapshot()).toMatchObject({ phase: 'processing', stage: 'Finishing', speed: 0 })
  })

  it('derives ETA from the remaining bytes of all streams', () => {
    const aggregator = new ProgressAggregator(planned)
    const snapshot = aggregator.apply({
      type: 'progress',
      status: 'downloading',
      downloadedBytes: 8294110,
      totalBytes: 18294110,
      totalBytesEstimate: null,
      speed: 1_000_000,
      eta: 10,
      formatId: '134'
    })
    // 10 MB left of the video + 10.27 MB of audio still to come.
    expect(snapshot.eta).toBe(Math.round((28565606 - 8294110) / 1_000_000))
    expect(snapshot.progress).toBeCloseTo((8294110 / 28565606) * 100, 0)
  })

  it('copes with streams the plan did not expect', () => {
    const aggregator = new ProgressAggregator([])
    const snapshot = aggregator.apply({
      type: 'progress',
      status: 'downloading',
      downloadedBytes: 50,
      totalBytes: 100,
      totalBytesEstimate: null,
      speed: 10,
      eta: 5,
      formatId: '18'
    })
    expect(snapshot.progress).toBe(50)
  })

  it('labels post-processors', () => {
    expect(postprocessorLabel('Merger')).toBe('Merging video and audio')
    expect(postprocessorLabel('ExtractAudio')).toBe('Converting audio')
    expect(postprocessorLabel('FixupM4a')).toBe('Fixing up the file')
    expect(postprocessorLabel('SomethingNew')).toBe('Processing')
  })
})

describe('classifyYtDlpError', () => {
  it.each([
    [0, 'VIDEO_UNAVAILABLE'],
    [1, 'VIDEO_UNAVAILABLE'], // HTTP 404 from a generic page
    [2, 'NETWORK'] // DNS failure
  ])('classifies captured real error %i', (index, code) => {
    expect(classifyYtDlpError(lines('errors.txt')[index]!).code).toBe(code)
  })

  it.each([
    ['ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video', 'PRIVATE_VIDEO'],
    ['ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.', 'AGE_RESTRICTED'],
    ['ERROR: [youtube] abc: Sign in to confirm you’re not a bot.', 'BOT_CHECK'],
    ['ERROR: [youtube] abc: The uploader has not made this video available in your country', 'GEO_BLOCKED'],
    ['ERROR: Unsupported URL: https://example.com/', 'UNSUPPORTED_URL'],
    ['ERROR: [download] Got error: HTTP Error 429: Too Many Requests', 'RATE_LIMITED'],
    ['ERROR: Postprocessing: ffprobe and ffmpeg not found. Please install or provide the path', 'FFMPEG_MISSING'],
    ['ERROR: unable to write data: [Errno 28] No space left on device', 'DISK_FULL'],
    ["ERROR: unable to open for writing: [Errno 13] Permission denied: 'C:\\\\x'", 'PERMISSION_DENIED'],
    ['ERROR: [youtube] abc: Requested format is not available. Use --list-formats', 'FORMAT_UNAVAILABLE']
  ])('classifies %s', (stderr, code) => {
    expect(classifyYtDlpError(stderr).code).toBe(code)
  })

  it('keeps unknown errors readable without the extractor prefix', () => {
    expect(classifyYtDlpError('WARNING: noise\nERROR: [vimeo] 12345: Something odd happened')).toEqual({
      code: 'UNKNOWN',
      message: 'Something odd happened'
    })
    expect(classifyYtDlpError('').message).toMatch(/stopped unexpectedly/)
  })

  it('reads errors whose message follows an empty "ERROR:" line', () => {
    // Real yt-dlp output when the connection dropped mid-download (it prints "ERROR: \r[download] Got error: …").
    const stderr = readFileSync(join(__dirname, '..', 'fixtures', 'ytdlp', 'network-drop.stderr.txt'), 'utf8')
    expect(classifyYtDlpError(stderr).code).toBe('NETWORK')
    expect(classifyYtDlpError('ERROR: \n[download] Got error: something new. Giving up after 10 retries')).toEqual({
      code: 'UNKNOWN',
      message: 'something new. Giving up after 10 retries'
    })
  })
})
