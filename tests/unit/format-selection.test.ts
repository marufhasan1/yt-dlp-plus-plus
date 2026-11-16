import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DownloadOptions } from '@shared/types/media'
import {
  buildDownloadPlan,
  containerOptions,
  normalizeFormats,
  pickAudio,
  resolutionLabel,
  type NormalizedFormat,
  type RawFormat
} from '../../electron/services/media/format-selection'

// Real `yt-dlp --dump-single-json` output (Big Buck Bunny, CC-BY, Blender Foundation), with a JS runtime.
const info = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'ytdlp', 'big-buck-bunny.info.json'), 'utf8')) as {
  duration: number
  formats: RawFormat[]
}
const formats = normalizeFormats(info.formats, info.duration)
const NO_EXTRAS: DownloadOptions = { embedMetadata: false, embedThumbnail: false, subtitles: null }

const ids = (list: NormalizedFormat[]) => list.map((f) => f.id)

describe('normalizeFormats (real YouTube data)', () => {
  it('drops storyboards, unknown codecs and codec-less HLS audio', () => {
    const kept = ids(formats)
    expect(kept.some((id) => id.startsWith('sb'))).toBe(false) // mhtml storyboards
    expect(kept).not.toContain('773') // IAMF audio, no known codec
    expect(kept).not.toContain('233') // HLS audio without a codec
    expect(kept).toContain('299') // 1080p60 H.264
    expect(kept).toContain('18') // muxed 360p
  })

  it('classifies codecs, resolution, DRC and sizes', () => {
    const byId = new Map(formats.map((f) => [f.id, f]))
    expect(byId.get('299')).toMatchObject({ video: 'h264', audio: null, shortSide: 1080, fps: 60, sizeBytes: 257619653 })
    expect(byId.get('315')).toMatchObject({ video: 'vp9', shortSide: 2160 })
    expect(byId.get('401')).toMatchObject({ video: 'av1', shortSide: 2160 })
    expect(byId.get('18')).toMatchObject({ video: 'h264', audio: 'aac', shortSide: 360 })
    expect(byId.get('140-drc')?.isDrc).toBe(true)
    expect(byId.get('380')?.audio).toBe('ac3')
    // HLS formats without a size get an estimate from bitrate × duration.
    expect(byId.get('312')?.sizeBytes).toBeGreaterThan(0)
  })
})

describe('containerOptions (real YouTube data)', () => {
  const options = containerOptions(formats)
  const heights = (container: string) => options.find((o) => o.container === container)?.resolutions.map((r) => r.height)

  it('offers MP4, WebM and MKV', () => {
    expect(options.map((o) => o.container)).toEqual(['mp4', 'webm', 'mkv'])
  })

  it('offers 4K MP4 only through AV1, since no H.264 stream exists above 1080p', () => {
    const mp4 = options.find((o) => o.container === 'mp4')!
    expect(heights('mp4')).toEqual([2160, 1440, 1080, 720, 480, 360, 240, 144])
    expect(mp4.resolutions[0]).toMatchObject({ label: '2160p60 (4K)', codecs: ['av1'] })
    expect(mp4.resolutions.find((r) => r.height === 1080)?.codecs).toEqual(['h264', 'av1'])
  })

  it('lists only resolutions that exist', () => {
    expect(heights('webm')).toEqual([2160, 1440, 1080, 720, 480, 360, 240, 144])
    expect(heights('webm')).not.toContain(4320)
  })

  it('estimates sizes from the chosen streams', () => {
    const mp4_1080 = options.find((o) => o.container === 'mp4')!.resolutions.find((r) => r.height === 1080)!
    // 299 (H.264 1080p60) + 140 (AAC, non-DRC)
    expect(mp4_1080.estimatedBytes).toBe(257619653 + 10271496)
  })
})

describe('stream picking', () => {
  it('prefers non-DRC stereo original audio', () => {
    expect(pickAudio(formats, (f) => f.audio === 'aac')?.id).toBe('140')
    expect(pickAudio(formats, (f) => f.audio === 'opus')?.id).toBe('251')
    // 258 is 5.1 AAC at 388 kbps; stereo wins for compatibility.
    expect(pickAudio(formats, () => true)?.channels ?? 2).toBeLessThanOrEqual(2)
  })

  it('formats resolution labels', () => {
    expect(resolutionLabel(1080, 60)).toBe('1080p60')
    expect(resolutionLabel(720, 30)).toBe('720p')
    expect(resolutionLabel(2160, 60)).toBe('2160p60 (4K)')
    expect(resolutionLabel(4320, 30)).toBe('4320p (8K)')
  })
})

describe('buildDownloadPlan (real YouTube data)', () => {
  it('MP4 1080p: H.264 video + AAC audio, merged and remuxed into MP4', () => {
    const plan = buildDownloadPlan(formats, info.duration, { kind: 'video', container: 'mp4', height: 1080, codec: 'auto' }, NO_EXTRAS)
    expect(plan.args.slice(0, 2)).toEqual(['-f', '299+140/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b'])
    expect(plan.args).toEqual(expect.arrayContaining(['--merge-output-format', 'mp4', '--remux-video', 'mp4']))
    expect(plan.qualityLabel).toBe('1080p60 · H.264')
    expect(plan.streams).toEqual([
      { formatId: '299', kind: 'video', bytes: 257619653 },
      { formatId: '140', kind: 'audio', bytes: 10271496 }
    ])
  })

  it('honours an explicit codec preference when available', () => {
    const plan = buildDownloadPlan(formats, info.duration, { kind: 'video', container: 'mp4', height: 1080, codec: 'av1' }, NO_EXTRAS)
    expect(plan.args[1]?.startsWith('399+140/')).toBe(true)
    expect(plan.qualityLabel).toBe('1080p60 · AV1')
  })

  it('WebM best: VP9 4K + Opus', () => {
    const plan = buildDownloadPlan(formats, info.duration, { kind: 'video', container: 'webm', height: 'best', codec: 'auto' }, NO_EXTRAS)
    expect(plan.args[1]?.startsWith('315+251/')).toBe(true)
  })

  it('MP3 192 kbps: re-encodes the best stereo source', () => {
    const plan = buildDownloadPlan(formats, info.duration, { kind: 'audio', format: 'mp3', quality: '192' }, NO_EXTRAS)
    expect(plan.args).toEqual(expect.arrayContaining(['-x', '--audio-format', 'mp3', '--audio-quality', '192K']))
    expect(plan.qualityLabel).toBe('192 kbps')
    expect(plan.estimatedBytes).toBe(Math.round((192 * 1000 * info.duration) / 8))
  })

  it('M4A best: keeps the AAC source as-is', () => {
    const plan = buildDownloadPlan(formats, info.duration, { kind: 'audio', format: 'm4a', quality: 'best' }, NO_EXTRAS)
    expect(plan.args[1]).toBe('140/ba/b')
    expect(plan.estimatedBytes).toBe(10271496) // the source file's exact size
  })

  it('WAV and FLAC take no bitrate argument', () => {
    for (const format of ['wav', 'flac'] as const) {
      const plan = buildDownloadPlan(formats, info.duration, { kind: 'audio', format, quality: '320' }, NO_EXTRAS)
      expect(plan.args).not.toContain('--audio-quality')
    }
  })

  it('embeds metadata and thumbnails only where the container supports it', () => {
    const extras: DownloadOptions = { embedMetadata: true, embedThumbnail: true, subtitles: null }
    const mp4 = buildDownloadPlan(formats, info.duration, { kind: 'video', container: 'mp4', height: 720, codec: 'auto' }, extras)
    const webm = buildDownloadPlan(formats, info.duration, { kind: 'video', container: 'webm', height: 720, codec: 'auto' }, extras)
    const wav = buildDownloadPlan(formats, info.duration, { kind: 'audio', format: 'wav', quality: 'best' }, extras)
    expect(mp4.args).toEqual(expect.arrayContaining(['--embed-metadata', '--embed-thumbnail']))
    expect(webm.args).toContain('--embed-metadata')
    expect(webm.args).not.toContain('--embed-thumbnail')
    expect(wav.args).not.toContain('--embed-thumbnail')
  })

  it('subtitles: alongside the video, or on their own', () => {
    const subtitles = { languages: ['en', 'de'], format: 'srt' as const, only: false }
    const withVideo = buildDownloadPlan(formats, info.duration, { kind: 'video', container: 'mkv', height: 'best', codec: 'auto' }, { ...NO_EXTRAS, subtitles })
    expect(withVideo.args).toEqual(expect.arrayContaining(['--write-subs', '--sub-langs', 'en,de', '--convert-subs', 'srt']))
    const only = buildDownloadPlan(formats, info.duration, { kind: 'video', container: 'mkv', height: 'best', codec: 'auto' }, { ...NO_EXTRAS, subtitles: { ...subtitles, only: true, format: 'vtt' } })
    expect(only.kind).toBe('subtitles')
    expect(only.args).toContain('--skip-download')
    expect(only.args).not.toContain('-f')
    expect(only.args).not.toContain('--convert-subs')
  })

  it('rejects a resolution that does not exist for the container', () => {
    expect(() =>
      buildDownloadPlan(formats, info.duration, { kind: 'video', container: 'mp4', height: 4320, codec: 'auto' }, NO_EXTRAS)
    ).toThrow(/No MP4 video/)
  })
})

describe('edge cases', () => {
  it('never offers a container whose audio would have to be re-encoded', () => {
    const opusOnly = normalizeFormats(
      [
        { format_id: 'v', vcodec: 'avc1.64001F', acodec: 'none', width: 1280, height: 720, tbr: 1000 },
        { format_id: 'a', vcodec: 'none', acodec: 'opus', abr: 128 }
      ],
      60
    )
    const options = containerOptions(opusOnly)
    expect(options.map((o) => o.container)).toEqual(['mkv'])
  })

  it('handles sites that do not report codecs', () => {
    const generic = normalizeFormats([{ format_id: 'http-720p', ext: 'mp4', width: 1280, height: 720 }], null)
    const options = containerOptions(generic)
    expect(options.map((o) => o.container)).toEqual(['mp4', 'mkv'])
    const plan = buildDownloadPlan(generic, null, { kind: 'video', container: 'mp4', height: 'best', codec: 'auto' }, NO_EXTRAS)
    expect(plan.args[1]?.startsWith('http-720p/')).toBe(true)
    expect(plan.qualityLabel).toBe('720p')
  })

  it('keeps vertical videos labelled by their short side', () => {
    const vertical = normalizeFormats(
      [
        { format_id: 'v', vcodec: 'avc1', acodec: 'none', width: 1080, height: 1920 },
        { format_id: 'a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 }
      ],
      30
    )
    expect(containerOptions(vertical)[0]?.resolutions[0]?.label).toBe('1080p')
  })
})
