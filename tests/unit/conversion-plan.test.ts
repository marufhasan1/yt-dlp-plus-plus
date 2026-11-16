import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FfmpegProgressParser,
  buildConversionArgs,
  classifyFfmpegError,
  fileUrl,
  outputBaseName,
  parseProbe,
  probeArgs,
  uniqueOutputPath,
  verifyOutput,
  type ProbeInfo
} from '../../electron/services/media/conversion-plan'

const fixture = (name: string) => readFileSync(join(__dirname, '..', 'fixtures', 'ffmpeg', name), 'utf8')
// Real FFprobe output for files generated with FFmpeg 8.0.
const wav = parseProbe(JSON.parse(fixture('probe-wav-pcm16.json')))
const mp3WithCover = parseProbe(JSON.parse(fixture('probe-mp3-with-cover.json')))
const video = parseProbe(JSON.parse(fixture('probe-mp4-video.json')))
const flac24 = parseProbe(JSON.parse(fixture('probe-flac-24bit.json')))

const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('parseProbe (real FFprobe output)', () => {
  it('reads a 16-bit WAV with Unicode tags', () => {
    expect(wav).toMatchObject({
      durationSeconds: 20,
      coverVideoIndex: null,
      source: {
        codec: 'pcm_s16le',
        sampleRate: 44100,
        channels: 2,
        bitrateKbps: 1411,
        bitDepth: 16,
        lossless: true,
        hasVideo: false,
        hasCover: false,
        title: 'Tone Ünïcode',
        artist: 'MediaFlow Test'
      }
    })
  })

  it('recognises embedded cover art as a cover, not as video', () => {
    expect(mp3WithCover.source).toMatchObject({ codec: 'mp3', lossless: false, hasVideo: false, hasCover: true, title: 'With Cover' })
    expect(mp3WithCover.coverVideoIndex).toBe(0)
  })

  it('reads the audio of a video file', () => {
    expect(video.source).toMatchObject({ codec: 'aac', hasVideo: true, hasCover: false })
    expect(video.durationSeconds).toBeCloseTo(12, 0)
  })

  it('reads 24-bit lossless sources', () => {
    expect(flac24.source).toMatchObject({ codec: 'flac', bitDepth: 24, sampleRate: 96000, lossless: true })
  })

  it('reports files without audio', () => {
    expect(parseProbe({ streams: [{ codec_type: 'video', codec_name: 'h264' }], format: { duration: '3' } }).source).toBeNull()
    expect(() => parseProbe({ streams: 'nope' })).toThrow()
  })
})

describe('buildConversionArgs', () => {
  const build = (probe: ProbeInfo, format: Parameters<typeof buildConversionArgs>[2], quality: Parameters<typeof buildConversionArgs>[3] = 'best') =>
    buildConversionArgs('C:\\Music\\in.wav', 'C:\\Out\\out.tmp', format, quality, probe)

  it('uses file: URLs so names are never read as protocols', () => {
    const { args } = build(wav, 'mp3', '192')
    expect(argAfter(args, '-i')).toBe('file:C:\\Music\\in.wav')
    expect(args.at(-1)).toBe('file:C:\\Out\\out.tmp')
    expect(fileUrl('concat:evil|file')).toBe('file:concat:evil|file')
    // Never overwrite, never prompt.
    expect(args).toEqual(expect.arrayContaining(['-nostdin', '-n', '-progress', 'pipe:1']))
    // The input may read local files only (no http:, concat:, … from playlists inside it).
    expect(args.slice(args.indexOf('-i') - 2, args.indexOf('-i'))).toEqual(['-protocol_whitelist', 'file'])
    expect(probeArgs('/m/a.m3u8').slice(2, 4)).toEqual(['-protocol_whitelist', 'file'])
  })

  it.each([
    ['mp3', '192', ['-c:a', 'libmp3lame', '-b:a', '192k'], '192 kbps'],
    ['mp3', 'best', ['-c:a', 'libmp3lame', '-q:a', '0'], 'Best (VBR)'],
    ['m4a', '256', ['-c:a', 'aac', '-b:a', '256k'], '256 kbps'],
    ['m4a', 'best', ['-c:a', 'aac', '-b:a', '256k'], '256 kbps'],
    ['opus', '128', ['-c:a', 'libopus', '-b:a', '128k'], '128 kbps'],
    ['flac', '320', ['-c:a', 'flac'], 'Lossless'],
    ['wav', 'best', ['-c:a', 'pcm_s16le'], 'Uncompressed (16-bit)']
  ] as const)('%s %s', (format, quality, codecArgs, label) => {
    const { args, qualityLabel, copy } = build(wav, format, quality)
    expect(args.join(' ')).toContain(codecArgs.join(' '))
    expect(qualityLabel).toBe(label)
    expect(copy).toBe(false)
  })

  it('keeps the original stream when the codec already matches and quality is "best"', () => {
    expect(build(mp3WithCover, 'mp3').copy).toBe(true)
    expect(argAfter(build(mp3WithCover, 'mp3').args, '-c:a')).toBe('copy')
    expect(build(video, 'm4a').qualityLabel).toBe('Original quality (no re-encoding)')
    // An explicit bitrate is honoured even for the same codec.
    expect(build(mp3WithCover, 'mp3', '128').copy).toBe(false)
    // FLAC → FLAC is always a lossless copy.
    expect(build(flac24, 'flac', '128').copy).toBe(true)
  })

  it('stores lossy sources as 16-bit FLAC and keeps the depth of lossless ones', () => {
    expect(build(video, 'flac').args.join(' ')).toContain('-c:a flac -sample_fmt s16')
    expect(build(wav, 'flac').args).not.toContain('-sample_fmt')
  })

  it('keeps 24-bit for WAV only when the source really is 24-bit lossless', () => {
    expect(argAfter(build(flac24, 'wav').args, '-c:a')).toBe('pcm_s24le')
    expect(argAfter(build(video, 'wav').args, '-c:a')).toBe('pcm_s16le') // AAC source: 24 bits would add nothing
  })

  it('carries cover art into MP3, M4A and FLAC, and drops video otherwise', () => {
    for (const format of ['mp3', 'm4a', 'flac'] as const) {
      expect(build(mp3WithCover, format, '192').args.join(' ')).toContain('-map 0:v:0 -c:v copy -disposition:v:0 attached_pic')
    }
    for (const format of ['opus', 'wav'] as const) expect(build(mp3WithCover, format).args).toContain('-vn')
    expect(build(video, 'mp3', '192').args).toContain('-vn') // a real video track is never copied
  })

  it('downmixes surround to stereo where the encoder needs it', () => {
    const surround: ProbeInfo = { ...wav, source: { ...wav.source!, channels: 6, codec: 'eac3', lossless: false } }
    expect(build(surround, 'mp3', '192').args.join(' ')).toContain('-ac 2')
    expect(build(surround, 'opus', '192').args.join(' ')).toContain('-ac 2')
    expect(build(surround, 'flac').args).not.toContain('-ac')
  })

  it('adds container options', () => {
    expect(build(wav, 'mp3', '192').args.join(' ')).toContain('-id3v2_version 3')
    expect(build(wav, 'm4a', '192').args.join(' ')).toContain('-movflags +faststart')
  })
})

describe('FfmpegProgressParser (real -progress output)', () => {
  it('emits one update per block', () => {
    const parser = new FfmpegProgressParser()
    const updates = fixture('progress-flac.txt')
      .split(/\r?\n/)
      .map((line) => parser.push(line))
      .filter((u) => u !== null)
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.at(-1)).toMatchObject({ done: true, outTimeSeconds: expect.closeTo(8, 0) })
  })

  it('treats N/A as unknown', () => {
    const parser = new FfmpegProgressParser()
    parser.push('out_time_us=N/A')
    parser.push('speed=N/A')
    expect(parser.push('progress=continue')).toEqual({ outTimeSeconds: null, speed: null, done: false })
    parser.push('out_time_us=5000000')
    parser.push('speed= 42.5x')
    expect(parser.push('progress=continue')).toEqual({ outTimeSeconds: 5, speed: 42.5, done: false })
  })
})

describe('output files', () => {
  it('derives the name from the input', () => {
    expect(outputBaseName('C:\\Music\\Tést fïle ñ 🎵.wav')).toBe('Tést fïle ñ 🎵')
    expect(outputBaseName('/music/archive.tar.flac')).toBe('archive.tar')
    expect(outputBaseName('/music/.wav')).toBe('.wav')
    expect([...outputBaseName(`/m/${'x'.repeat(400)}.mp3`)]).toHaveLength(180)
  })

  it('never overwrites, including the input itself', async () => {
    const taken = new Set([join('/out', 'Song.mp3'), join('/out', 'Song (1).mp3')])
    const exists = async (p: string) => taken.has(p)
    expect(await uniqueOutputPath('/out', 'Song', 'mp3', exists, '/elsewhere/Song.wav')).toBe(join('/out', 'Song (2).mp3'))
    // Converting /music/Song.mp3 to MP3 in its own folder must not target itself.
    expect(await uniqueOutputPath('/music', 'Song', 'mp3', async () => false, join('/music', 'Song.mp3'))).toBe(join('/music', 'Song (1).mp3'))
  })
})

describe('errors and verification', () => {
  it('explains real FFmpeg failures', () => {
    expect(classifyFfmpegError(fixture('error-invalid-input.txt'))).toBe('This file is damaged or is not a supported audio or video file.')
    expect(classifyFfmpegError('[out#0] Error opening output: No space left on device')).toMatch(/disk space/)
    expect(classifyFfmpegError('[aost#0:0] Unknown encoder \'libfdk_aac\'')).toMatch(/cannot encode/)
    expect(classifyFfmpegError('something odd')).toBe('FFmpeg could not convert the file: something odd')
  })

  it('accepts complete output in the expected codec only', () => {
    const output = (codec: string, duration: number): ProbeInfo => ({ durationSeconds: duration, coverVideoIndex: null, source: { ...wav.source!, codec } })
    expect(verifyOutput(output('mp3', 20), 'mp3', 20)).toBeNull()
    expect(verifyOutput(output('pcm_s24le', 20), 'wav', 20)).toBeNull()
    expect(verifyOutput(output('aac', 20), 'mp3', 20)).toMatch(/unexpected audio/)
    expect(verifyOutput(output('mp3', 9), 'mp3', 20)).toMatch(/incomplete/)
    expect(verifyOutput({ durationSeconds: 20, coverVideoIndex: null, source: null }, 'mp3', 20)).toMatch(/no audio/)
  })
})
