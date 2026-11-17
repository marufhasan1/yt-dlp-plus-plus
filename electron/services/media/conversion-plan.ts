import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import type { ConverterSource } from '@shared/types/converter'
import type { AudioFormat, AudioQuality } from '@shared/types/media'

/*
 * Pure building blocks of the audio converter: reading FFprobe output,
 * building FFmpeg arguments, following FFmpeg's progress output, naming
 * output files and checking the result. Behaviour was verified against real
 * FFmpeg (resampling for Opus, cover art in MP3/M4A/FLAC, 24-bit WAV).
 */

// ─── FFprobe ─────────────────────────────────────────────────────────────────

const tagsSchema = z.record(z.string(), z.string()).nullish()

const probeSchema = z
  .object({
    streams: z
      .array(
        z
          .object({
            codec_type: z.string().nullish(),
            codec_name: z.string().nullish(),
            sample_rate: z.string().nullish(),
            channels: z.number().nullish(),
            bit_rate: z.string().nullish(),
            bits_per_raw_sample: z.string().nullish(),
            bits_per_sample: z.number().nullish(),
            duration: z.string().nullish(),
            disposition: z.object({ attached_pic: z.number().nullish() }).loose().nullish(),
            tags: tagsSchema
          })
          .loose()
      )
      .nullish(),
    format: z
      .object({ duration: z.string().nullish(), bit_rate: z.string().nullish(), tags: tagsSchema })
      .loose()
      .nullish()
  })
  .loose()

export interface ProbeInfo {
  durationSeconds: number | null
  /** Null when the file has no audio stream. */
  source: ConverterSource | null
  /** Position of the embedded cover among the file's video streams (for `-map 0:v:N`), if it is JPEG or PNG. */
  coverVideoIndex: number | null
}

const LOSSLESS = /^(pcm_|flac$|alac$|wavpack$|ape$|tta$|mlp$|truehd$)/

function positive(value: string | number | null | undefined): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function tag(tags: Record<string, string> | null | undefined, name: string): string | null {
  if (!tags) return null
  const key = Object.keys(tags).find((k) => k.toLowerCase() === name)
  const value = key ? tags[key]?.trim() : undefined
  return value ? value.slice(0, 300) : null
}

/** Throws when the output is not FFprobe JSON. */
export function parseProbe(json: unknown): ProbeInfo {
  const parsed = probeSchema.parse(json)
  const streams = parsed.streams ?? []
  const audio = streams.find((s) => s.codec_type === 'audio')
  const videos = streams.filter((s) => s.codec_type === 'video')
  const coverIndex = videos.findIndex((s) => s.disposition?.attached_pic === 1 && (s.codec_name === 'mjpeg' || s.codec_name === 'png'))
  const durationSeconds = positive(parsed.format?.duration) ?? positive(audio?.duration)

  if (!audio?.codec_name) return { durationSeconds, source: null, coverVideoIndex: null }
  const formatTags = parsed.format?.tags
  return {
    durationSeconds,
    coverVideoIndex: coverIndex === -1 ? null : coverIndex,
    source: {
      codec: audio.codec_name,
      sampleRate: positive(audio.sample_rate),
      channels: positive(audio.channels),
      bitrateKbps: (() => {
        const bps = positive(audio.bit_rate) ?? (videos.length === 0 ? positive(parsed.format?.bit_rate) : null)
        return bps ? Math.round(bps / 1000) : null
      })(),
      bitDepth: positive(audio.bits_per_raw_sample) ?? positive(audio.bits_per_sample),
      lossless: LOSSLESS.test(audio.codec_name),
      hasVideo: videos.some((s) => s.disposition?.attached_pic !== 1),
      hasCover: coverIndex !== -1,
      title: tag(formatTags, 'title') ?? tag(audio.tags, 'title'),
      artist: tag(formatTags, 'artist') ?? tag(audio.tags, 'artist')
    }
  }
}

/**
 * Inputs may only read local files: a picked file that is really a playlist or
 * a concat list (HLS, ffconcat) must not make FFmpeg open URLs or other files.
 */
export const INPUT_PROTOCOLS = ['-protocol_whitelist', 'file'] as const

export function probeArgs(path: string): string[] {
  return ['-v', 'error', ...INPUT_PROTOCOLS, '-print_format', 'json', '-show_format', '-show_streams', fileUrl(path)]
}

/**
 * FFmpeg treats `name:` prefixes as protocols (http:, concat:, …). The `file:`
 * prefix makes every path a plain local file, whatever its name contains.
 */
export function fileUrl(path: string): string {
  return `file:${path}`
}

// ─── Conversion arguments ────────────────────────────────────────────────────

const COPYABLE: Partial<Record<AudioFormat, string>> = { mp3: 'mp3', m4a: 'aac', opus: 'opus', flac: 'flac' }
const DEFAULT_BEST_KBPS = 256
/** Containers that can carry a cover image. */
const COVER_FORMATS = new Set<AudioFormat>(['mp3', 'm4a', 'flac'])

export const OUTPUT_CODECS: Record<AudioFormat, readonly string[]> = {
  mp3: ['mp3'],
  m4a: ['aac'],
  opus: ['opus'],
  flac: ['flac'],
  wav: ['pcm_s16le', 'pcm_s24le']
}

export interface ConversionArgs {
  args: string[]
  qualityLabel: string
  /** The source stream is copied rather than re-encoded. */
  copy: boolean
}

export function buildConversionArgs(
  input: string,
  output: string,
  format: AudioFormat,
  quality: AudioQuality,
  probe: ProbeInfo
): ConversionArgs {
  const source = probe.source
  if (!source) throw new Error('No audio stream to convert')

  // Same codec and "best": keep the original stream untouched (no generation loss).
  const copy = (quality === 'best' || format === 'flac') && COPYABLE[format] === source.codec
  const stereo = (source.channels ?? 2) > 2 && (format === 'mp3' || format === 'opus') ? ['-ac', '2'] : []
  let codec: string[]
  let qualityLabel: string

  if (copy) {
    codec = ['-c:a', 'copy']
    qualityLabel = format === 'flac' ? 'Lossless' : 'Original quality (no re-encoding)'
  } else if (format === 'mp3') {
    codec = ['-c:a', 'libmp3lame', ...(quality === 'best' ? ['-q:a', '0'] : ['-b:a', `${quality}k`]), ...stereo]
    qualityLabel = quality === 'best' ? 'Best (VBR)' : `${quality} kbps`
  } else if (format === 'm4a' || format === 'opus') {
    const kbps = quality === 'best' ? DEFAULT_BEST_KBPS : Number(quality)
    codec = ['-c:a', format === 'm4a' ? 'aac' : 'libopus', '-b:a', `${kbps}k`, ...stereo]
    qualityLabel = `${kbps} kbps`
  } else if (format === 'flac') {
    // Decoded lossy audio is float; left alone FLAC would store it as 24-bit, a bigger file
    // with nothing more in it. Lossless sources keep their own depth.
    codec = ['-c:a', 'flac', ...(source.lossless ? [] : ['-sample_fmt', 's16'])]
    qualityLabel = 'Lossless'
  } else {
    // WAV keeps 24-bit only when the source really had it; lossy sources gain nothing from it.
    const bits = source.lossless && (source.bitDepth ?? 16) > 16 ? 24 : 16
    codec = ['-c:a', bits === 24 ? 'pcm_s24le' : 'pcm_s16le']
    qualityLabel = `Uncompressed (${bits}-bit)`
  }

  const cover =
    probe.coverVideoIndex !== null && COVER_FORMATS.has(format)
      ? ['-map', `0:v:${probe.coverVideoIndex}`, '-c:v', 'copy', '-disposition:v:0', 'attached_pic']
      : ['-vn']
  const container =
    format === 'mp3' ? ['-id3v2_version', '3'] : format === 'm4a' ? ['-movflags', '+faststart'] : []

  return {
    args: [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-progress',
      'pipe:1',
      '-stats_period',
      '0.5',
      ...INPUT_PROTOCOLS,
      '-i',
      fileUrl(input),
      '-map',
      '0:a:0',
      ...cover,
      '-map_metadata',
      '0',
      ...codec,
      ...container,
      // Never overwrite: the output name is chosen to be unused.
      '-n',
      fileUrl(output)
    ],
    qualityLabel,
    copy
  }
}

// ─── Progress ────────────────────────────────────────────────────────────────

export interface FfmpegProgress {
  outTimeSeconds: number | null
  /** Multiple of real time. */
  speed: number | null
  done: boolean
}

/**
 * `-progress pipe:1` prints blocks of key=value lines, each ending with
 * `progress=continue` or `progress=end`. Values are "N/A" until known.
 */
export class FfmpegProgressParser {
  private block = new Map<string, string>()

  push(line: string): FfmpegProgress | null {
    const index = line.indexOf('=')
    if (index <= 0) return null
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key !== 'progress') {
      this.block.set(key, value)
      return null
    }
    const outTimeUs = Number(this.block.get('out_time_us'))
    const speed = Number(this.block.get('speed')?.replace(/x$/, ''))
    this.block = new Map()
    return {
      outTimeSeconds: Number.isFinite(outTimeUs) && outTimeUs >= 0 ? outTimeUs / 1_000_000 : null,
      speed: Number.isFinite(speed) && speed > 0 ? speed : null,
      done: value === 'end'
    }
  }
}

// ─── Output files ────────────────────────────────────────────────────────────

/** The input's name without its extension, bounded in length. */
export function outputBaseName(inputPath: string): string {
  const name = basename(inputPath, extname(inputPath)).replace(/[. ]+$/, '').trim()
  return [...(name || 'audio')].slice(0, 180).join('')
}

/**
 * First free name of the form "Base.ext", "Base (1).ext", … in `dir`. Never
 * returns `avoid` (the input file), so converting a file to its own format in
 * its own folder cannot overwrite it.
 */
export async function uniqueOutputPath(
  dir: string,
  base: string,
  ext: string,
  exists: (path: string) => Promise<boolean>,
  avoid: string
): Promise<string> {
  for (let n = 0; n < 1000; n++) {
    const candidate = join(dir, n === 0 ? `${base}.${ext}` : `${base} (${n}).${ext}`)
    if (candidate.toLowerCase() === avoid.toLowerCase()) continue
    if (!(await exists(candidate))) return candidate
  }
  throw new Error('No free output file name')
}

// ─── Errors and verification ─────────────────────────────────────────────────

const ERRORS: { pattern: RegExp; message: string }[] = [
  {
    pattern: /Invalid data found when processing input|could not find codec parameters|moov atom not found|Header missing|End of file/i,
    message: 'This file is damaged or is not a supported audio or video file.'
  },
  { pattern: /No such file or directory/i, message: 'The file no longer exists or was moved.' },
  { pattern: /Permission denied|Access is denied/i, message: 'YT-DLP++ is not allowed to read the file or write to the output folder.' },
  { pattern: /No space left on device|not enough space/i, message: 'There is not enough free disk space.' },
  { pattern: /Unknown encoder|Encoder not found|encoder.*not found/i, message: 'The installed FFmpeg build cannot encode this format.' },
  { pattern: /does not contain any stream|Output file .* does not contain|matches no streams/i, message: 'This file has no audio to convert.' }
]

/** A user-facing message for FFmpeg's stderr. */
export function classifyFfmpegError(stderr: string): string {
  for (const rule of ERRORS) if (rule.pattern.test(stderr)) return rule.message
  const last = stderr
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean)
    .at(-1)
  return last ? `FFmpeg could not convert the file: ${last.slice(0, 200)}` : 'FFmpeg stopped unexpectedly.'
}

/**
 * Checks the converted file before it replaces nothing and is shown as done:
 * it must contain an audio stream in the expected codec and roughly the full
 * duration of the source.
 */
export function verifyOutput(output: ProbeInfo, format: AudioFormat, sourceDuration: number | null): string | null {
  if (!output.source) return 'The converted file contains no audio.'
  if (!OUTPUT_CODECS[format].includes(output.source.codec)) {
    return `The converted file has unexpected audio (${output.source.codec}).`
  }
  if (sourceDuration && output.durationSeconds !== null && output.durationSeconds < sourceDuration * 0.9) {
    return 'The converted file is shorter than the original; the conversion was incomplete.'
  }
  return null
}
