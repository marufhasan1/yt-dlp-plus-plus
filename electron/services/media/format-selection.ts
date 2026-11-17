import type {
  AudioFormat,
  AudioQuality,
  CodecPreference,
  ContainerOption,
  DownloadOptions,
  DownloadSelection,
  ResolutionOption,
  VideoCodec,
  VideoContainer
} from '@shared/types/media'
import { estimateAudioBytes } from '@shared/media/estimate'

/**
 * Turns yt-dlp's format list into the choices YT-DLP++ offers, and a choice
 * into validated yt-dlp arguments. Pure functions: no I/O, fully testable
 * against real `--dump-single-json` output.
 */

export type AudioCodec = 'aac' | 'opus' | 'vorbis' | 'mp3' | 'flac' | 'ac3' | 'eac3'

/** The fields of a yt-dlp format entry this module reads. Everything is optional: sites differ. */
export interface RawFormat {
  format_id: string
  ext?: string | null
  vcodec?: string | null
  acodec?: string | null
  width?: number | null
  height?: number | null
  fps?: number | null
  tbr?: number | null
  abr?: number | null
  filesize?: number | null
  filesize_approx?: number | null
  protocol?: string | null
  format_note?: string | null
  language_preference?: number | null
  dynamic_range?: string | null
  audio_channels?: number | null
  has_drm?: boolean | null
}

export interface NormalizedFormat {
  id: string
  ext: string
  video: VideoCodec | null
  audio: AudioCodec | null
  /** Video stream whose codec yt-dlp could not report (common outside YouTube). */
  unknownVideo: boolean
  shortSide: number | null
  fps: number | null
  hdr: boolean
  sizeBytes: number | null
  bitrateKbps: number | null
  audioBitrateKbps: number | null
  channels: number | null
  languagePreference: number
  isDrc: boolean
  isHls: boolean
}

export function videoCodecFamily(vcodec: string | null | undefined): VideoCodec | null {
  const codec = (vcodec ?? '').toLowerCase()
  if (/^(avc1|avc3|h264)/.test(codec)) return 'h264'
  if (/^(hev1|hvc1|hevc|h265)/.test(codec)) return 'hevc'
  if (/^(vp09|vp9)/.test(codec)) return 'vp9'
  if (/^(vp08|vp8)/.test(codec)) return 'vp8'
  if (/^(av01|av1)/.test(codec)) return 'av1'
  return null
}

export function audioCodecFamily(acodec: string | null | undefined): AudioCodec | null {
  const codec = (acodec ?? '').toLowerCase()
  if (/^(mp4a|aac)/.test(codec)) return 'aac'
  if (codec.startsWith('opus')) return 'opus'
  if (codec.startsWith('vorbis')) return 'vorbis'
  if (/^(mp3|mp4a\.6b|mp4a\.69)/.test(codec)) return 'mp3'
  if (codec.startsWith('flac')) return 'flac'
  if (/^(ac-3|ac3)/.test(codec)) return 'ac3'
  if (/^(ec-3|eac3)/.test(codec)) return 'eac3'
  return null
}

/**
 * Keeps downloadable audio/video formats with codecs we can reason about.
 * Drops storyboards (mhtml), DRM-protected formats and streams in codecs that
 * no output container here can hold (e.g. IAMF).
 */
export function normalizeFormats(raw: readonly RawFormat[], durationSeconds: number | null): NormalizedFormat[] {
  const result: NormalizedFormat[] = []
  for (const format of raw) {
    if (!format.format_id || format.protocol === 'mhtml' || format.has_drm) continue
    const hasVideo = format.vcodec !== 'none'
    const hasAudio = format.acodec !== 'none'
    const video = hasVideo ? videoCodecFamily(format.vcodec) : null
    const audio = hasAudio ? audioCodecFamily(format.acodec) : null
    // yt-dlp reports null/undefined when it does not know a codec, and "none" when the stream is absent.
    const videoUnknown = format.vcodec == null && (format.height ?? 0) > 0
    // A named video codec we cannot place (e.g. a new codec) is skipped rather than guessed at.
    if (format.vcodec != null && format.vcodec !== 'none' && !video) continue
    if (!video && !videoUnknown && !audio) continue

    const shortSide =
      format.width && format.height ? Math.min(format.width, format.height) : (format.height ?? null)
    const bitrate = format.tbr ?? null
    const estimated = bitrate && durationSeconds ? Math.round((bitrate * 1000 * durationSeconds) / 8) : null
    result.push({
      id: format.format_id,
      ext: format.ext ?? '',
      video,
      audio,
      unknownVideo: !video && videoUnknown,
      shortSide: video || videoUnknown ? shortSide : null,
      fps: format.fps ? Math.round(format.fps) : null,
      hdr: Boolean(format.dynamic_range && format.dynamic_range !== 'SDR'),
      sizeBytes: format.filesize ?? format.filesize_approx ?? estimated,
      bitrateKbps: bitrate,
      audioBitrateKbps: format.abr ?? (video ? null : bitrate),
      channels: format.audio_channels ?? null,
      languagePreference: format.language_preference ?? -1,
      isDrc: /-drc$/i.test(format.format_id) || /\bDRC\b/.test(format.format_note ?? ''),
      isHls: (format.protocol ?? '').startsWith('m3u8')
    })
  }
  return result
}

// ─── Container compatibility ─────────────────────────────────────────────────

/** Codecs each container can hold without re-encoding. MKV holds everything listed here. */
const CONTAINER_VIDEO: Record<VideoContainer, readonly VideoCodec[]> = {
  mp4: ['h264', 'hevc', 'av1'],
  webm: ['vp9', 'vp8', 'av1'],
  mkv: ['h264', 'hevc', 'vp9', 'vp8', 'av1']
}
const CONTAINER_AUDIO: Record<VideoContainer, readonly AudioCodec[]> = {
  mp4: ['aac', 'mp3'],
  webm: ['opus', 'vorbis'],
  mkv: ['aac', 'opus', 'vorbis', 'mp3', 'flac', 'ac3', 'eac3']
}
/** Automatic codec choice per container, most preferred first. */
const AUTO_CODEC_ORDER: Record<VideoContainer, readonly VideoCodec[]> = {
  mp4: ['h264', 'av1', 'hevc'],
  webm: ['vp9', 'av1', 'vp8'],
  mkv: ['av1', 'vp9', 'h264', 'hevc', 'vp8']
}

export const CODEC_LABELS: Record<VideoCodec, string> = {
  h264: 'H.264',
  hevc: 'H.265',
  vp9: 'VP9',
  av1: 'AV1',
  vp8: 'VP8'
}
const AUDIO_CODEC_LABELS: Record<AudioCodec, string> = {
  aac: 'AAC',
  opus: 'Opus',
  vorbis: 'Vorbis',
  mp3: 'MP3',
  flac: 'FLAC',
  ac3: 'Dolby Digital',
  eac3: 'Dolby Digital Plus'
}

const CONTAINERS: readonly VideoContainer[] = ['mp4', 'webm', 'mkv']

function fitsVideo(format: NormalizedFormat, container: VideoContainer): boolean {
  if (format.video) return CONTAINER_VIDEO[container].includes(format.video)
  // Unknown codecs can only be remuxed on a best-effort basis; never into WebM.
  return format.unknownVideo && container !== 'webm'
}

function fitsAudio(format: NormalizedFormat, container: VideoContainer): boolean {
  return format.audio !== null && CONTAINER_AUDIO[container].includes(format.audio)
}

function isVideoSource(format: NormalizedFormat): boolean {
  return format.video !== null || format.unknownVideo
}

export function resolutionLabel(shortSide: number, fps: number | null): string {
  const rate = fps && fps > 30 ? String(fps) : ''
  const suffix = shortSide >= 4320 ? ' (8K)' : shortSide >= 2160 ? ' (4K)' : ''
  return `${shortSide}p${rate}${suffix}`
}

// ─── Picking streams ─────────────────────────────────────────────────────────

/**
 * Video streams usable for `container`. A muxed stream's audio must fit too.
 * If the media has sound but no separate audio stream fits the container,
 * only muxed streams qualify — otherwise the result would be silent.
 */
function videoCandidates(formats: readonly NormalizedFormat[], container: VideoContainer): NormalizedFormat[] {
  const usable = formats.filter(
    (f) => isVideoSource(f) && fitsVideo(f, container) && (f.audio === null || fitsAudio(f, container))
  )
  const hasSound = formats.some((f) => f.audio !== null)
  const separateAudioFits = formats.some((f) => !isVideoSource(f) && fitsAudio(f, container))
  return hasSound && !separateAudioFits ? usable.filter((f) => f.audio !== null) : usable
}

function compareVideo(container: VideoContainer) {
  const order = AUTO_CODEC_ORDER[container]
  return (a: NormalizedFormat, b: NormalizedFormat): number =>
    (b.fps ?? 0) - (a.fps ?? 0) ||
    rank(order, a.video) - rank(order, b.video) ||
    Number(a.hdr) - Number(b.hdr) || // SDR first: plays everywhere
    Number(a.isHls) - Number(b.isHls) ||
    Number(a.audio !== null) - Number(b.audio !== null) || // separate streams beat muxed at equal quality
    (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0)
}

function rank<T>(order: readonly T[], value: T | null): number {
  const index = value === null ? -1 : order.indexOf(value)
  return index === -1 ? order.length : index
}

export function pickVideo(
  formats: readonly NormalizedFormat[],
  container: VideoContainer,
  height: number | 'best',
  codec: CodecPreference
): NormalizedFormat | null {
  let candidates = videoCandidates(formats, container)
  if (candidates.length === 0) return null
  const target = height === 'best' ? Math.max(...candidates.map((f) => f.shortSide ?? 0)) : height
  candidates = candidates.filter((f) => (f.shortSide ?? 0) === target)
  if (codec !== 'auto' && candidates.some((f) => f.video === codec)) {
    candidates = candidates.filter((f) => f.video === codec)
  }
  return [...candidates].sort(compareVideo(container))[0] ?? null
}

/**
 * Prefers non-DRC, stereo, original-language audio, then the requested codec
 * (so extraction can copy instead of re-encode), then bitrate.
 */
export function pickAudio(
  formats: readonly NormalizedFormat[],
  accept: (format: NormalizedFormat) => boolean,
  preferCodec: AudioCodec | null = null
): NormalizedFormat | null {
  const candidates = formats.filter((f) => !isVideoSource(f) && f.audio !== null && accept(f))
  return (
    [...candidates].sort(
      (a, b) =>
        Number(a.isDrc) - Number(b.isDrc) ||
        Number((a.channels ?? 2) > 2) - Number((b.channels ?? 2) > 2) ||
        b.languagePreference - a.languagePreference ||
        Number(b.audio === preferCodec) - Number(a.audio === preferCodec) ||
        Number(a.isHls) - Number(b.isHls) ||
        (b.audioBitrateKbps ?? 0) - (a.audioBitrateKbps ?? 0)
    )[0] ?? null
  )
}

// ─── Options shown to the user ───────────────────────────────────────────────

export function containerOptions(formats: readonly NormalizedFormat[]): ContainerOption[] {
  const options: ContainerOption[] = []

  for (const container of CONTAINERS) {
    // videoCandidates already guarantees the sound can come along without re-encoding.
    const candidates = videoCandidates(formats, container)
    const audio = pickAudio(formats, (f) => fitsAudio(f, container))
    if (candidates.length === 0) continue

    const heights = [...new Set(candidates.map((f) => f.shortSide).filter((h): h is number => h !== null))].sort(
      (a, b) => b - a
    )
    const resolutions: ResolutionOption[] = heights.map((height) => {
      const atHeight = candidates.filter((f) => f.shortSide === height)
      const chosen = pickVideo(formats, container, height, 'auto')
      const audioBytes = chosen?.audio ? 0 : (audio?.sizeBytes ?? null)
      const fps = Math.max(...atHeight.map((f) => f.fps ?? 0)) || null
      return {
        height,
        label: resolutionLabel(height, fps),
        fps,
        codecs: AUTO_CODEC_ORDER[container].filter((codec) => atHeight.some((f) => f.video === codec)),
        hdr: atHeight.some((f) => f.hdr),
        estimatedBytes: chosen?.sizeBytes != null && audioBytes !== null ? chosen.sizeBytes + audioBytes : null
      }
    })
    options.push({ container, resolutions })
  }
  return options
}

export function audioSummary(formats: readonly NormalizedFormat[]): {
  available: boolean
  codecs: string[]
  bestBitrateKbps: number | null
  channels: number | null
} {
  const audio = formats.filter((f) => f.audio !== null)
  const bitrates = audio.map((f) => f.audioBitrateKbps).filter((b): b is number => b !== null)
  const channels = audio.map((f) => f.channels).filter((c): c is number => c !== null)
  return {
    available: audio.length > 0,
    codecs: [...new Set(audio.map((f) => AUDIO_CODEC_LABELS[f.audio as AudioCodec]))],
    bestBitrateKbps: bitrates.length > 0 ? Math.round(Math.max(...bitrates)) : null,
    channels: channels.length > 0 ? Math.max(...channels) : null
  }
}

// ─── Download plan ───────────────────────────────────────────────────────────

export interface PlannedStream {
  formatId: string
  kind: 'video' | 'audio' | 'muxed'
  bytes: number | null
}

/** Everything about a download that does not depend on paths or engine locations. */
export interface DownloadPlan {
  kind: 'video' | 'audio' | 'subtitles'
  /** yt-dlp arguments for format selection and post-processing (no paths, no URL). */
  args: string[]
  outputFormat: string
  qualityLabel: string | null
  streams: PlannedStream[]
  estimatedBytes: number | null
}

/** Containers yt-dlp can embed a cover image into. */
const THUMBNAIL_CONTAINERS = new Set(['mp4', 'mkv', 'm4a', 'mp3', 'opus', 'flac'])

export function supportsEmbeddedThumbnail(format: string): boolean {
  return THUMBNAIL_CONTAINERS.has(format)
}

const AUDIO_TARGET_CODEC: Record<AudioFormat, AudioCodec | null> = {
  mp3: 'mp3',
  m4a: 'aac',
  opus: 'opus',
  wav: null,
  flac: 'flac'
}

export class PlanError extends Error {}

export function buildDownloadPlan(
  formats: readonly NormalizedFormat[],
  durationSeconds: number | null,
  selection: DownloadSelection,
  options: DownloadOptions
): DownloadPlan {
  const subtitleArgs = options.subtitles ? subtitlesArgs(options.subtitles) : []

  if (options.subtitles?.only) {
    return {
      kind: 'subtitles',
      args: ['--skip-download', ...subtitleArgs],
      outputFormat: options.subtitles.format,
      qualityLabel: options.subtitles.languages.join(', '),
      streams: [],
      estimatedBytes: null
    }
  }

  if (selection.kind === 'audio') {
    const target = AUDIO_TARGET_CODEC[selection.format]
    const source = pickAudio(formats, () => true, target)
    if (!source && !formats.some((f) => f.audio)) throw new PlanError('This media has no audio.')
    const args = ['-f', source ? `${source.id}/ba/b` : 'ba/b', '-x', '--audio-format', selection.format]
    if (selection.format !== 'wav' && selection.format !== 'flac') {
      args.push('--audio-quality', selection.quality === 'best' ? '0' : `${selection.quality}K`)
    }
    args.push(...postProcessingArgs(selection.format, options), ...subtitleArgs)
    return {
      kind: 'audio',
      args,
      outputFormat: selection.format,
      qualityLabel: audioQualityLabel(selection.format, selection.quality),
      streams: source ? [{ formatId: source.id, kind: 'audio', bytes: source.sizeBytes }] : [],
      // A source already in the target codec is kept as-is, so its own size is exact.
      estimatedBytes:
        source && source.audio === target && source.sizeBytes !== null
          ? source.sizeBytes
          : estimateAudioBytes(selection.format, selection.quality, durationSeconds, source?.audioBitrateKbps ?? null, false)
    }
  }

  const { container, height, codec } = selection
  const video = pickVideo(formats, container, height, codec)
  if (!video) throw new PlanError(`No ${container.toUpperCase()} video is available at this resolution.`)
  const audio = video.audio ? null : pickAudio(formats, (f) => fitsAudio(f, container))
  const limit = video.shortSide ? `[height<=${Math.max(video.shortSide, 1)}]` : ''
  // Exact streams first; yt-dlp's own choice as a fallback if a format vanished since analysis.
  const exact = audio ? `${video.id}+${audio.id}` : video.id
  const selector = `${exact}/bv*${limit}+ba/b${limit}/bv*+ba/b`
  const streams: PlannedStream[] = [
    { formatId: video.id, kind: video.audio ? 'muxed' : 'video', bytes: video.sizeBytes },
    ...(audio ? [{ formatId: audio.id, kind: 'audio' as const, bytes: audio.sizeBytes }] : [])
  ]
  const known = streams.every((s) => s.bytes !== null)
  const label = video.shortSide ? resolutionLabel(video.shortSide, video.fps) : 'Best available'
  return {
    kind: 'video',
    args: [
      '-f',
      selector,
      '--merge-output-format',
      container,
      '--remux-video',
      container,
      ...postProcessingArgs(container, options),
      ...subtitleArgs
    ],
    outputFormat: container,
    qualityLabel: video.video ? `${label} · ${CODEC_LABELS[video.video]}` : label,
    streams,
    estimatedBytes: known ? streams.reduce((sum, s) => sum + (s.bytes ?? 0), 0) : null
  }
}

// ─── Batch plans (playlist entries that were not analysed one by one) ───────

/**
 * yt-dlp format filters that only accept streams fitting the container. MP4
 * falls back to any streams (FFmpeg can put VP9/Opus in MP4); WebM does not,
 * because merging H.264/AAC into WebM fails inside FFmpeg with an unclear
 * error, while a missing format gives yt-dlp's clear "not available".
 */
const PROFILE_FORMAT: Record<VideoContainer, string> = {
  mp4:
    "bv*[vcodec~='^(avc|h264|hev|hvc|av01)']+ba[acodec~='^(mp4a|aac)']" +
    "/b[vcodec~='^(avc|h264|hev|hvc|av01)'][acodec~='^(mp4a|aac)']/bv*+ba/b",
  webm: "bv*[vcodec~='^(vp0?9|vp8|av01)']+ba[acodec~='^(opus|vorbis)']/b[vcodec~='^(vp0?9|vp8|av01)'][acodec~='^(opus|vorbis)']",
  mkv: 'bv*+ba/b'
}

/** yt-dlp's names for codec preferences in `-S`. */
const SORT_CODEC: Record<VideoCodec, string> = { h264: 'h264', hevc: 'h265', vp9: 'vp9', av1: 'av01', vp8: 'vp8' }
/** Mirrors AUTO_CODEC_ORDER's first choice; MKV keeps yt-dlp's own order (AV1 first). */
const AUTO_SORT_CODEC: Record<VideoContainer, VideoCodec | null> = { mp4: 'h264', webm: 'vp9', mkv: null }
const AUDIO_SORT_CODEC: Record<AudioFormat, string | null> = { m4a: 'aac', opus: 'opus', mp3: null, wav: null, flac: null }

/**
 * A plan for a video YT-DLP++ has not analysed (a playlist entry), expressed
 * as yt-dlp format filters and sort order so that yt-dlp picks the same kind
 * of streams `buildDownloadPlan` would:
 *  - resolution and frame rate first (otherwise a muxed 360p stream can win on
 *    codec/channels, as observed with real YouTube data);
 *  - then the codec preference;
 *  - then stereo audio (yt-dlp would otherwise prefer 5.1 surround).
 */
export function buildProfilePlan(selection: DownloadSelection, options: Omit<DownloadOptions, 'subtitles'>): DownloadPlan {
  const extras: DownloadOptions = { ...options, subtitles: null }

  if (selection.kind === 'audio') {
    const preferred = AUDIO_SORT_CODEC[selection.format]
    const args = ['-f', 'ba/b', '-S', ['channels:2', ...(preferred ? [`acodec:${preferred}`] : [])].join(','), '-x', '--audio-format', selection.format]
    if (selection.format !== 'wav' && selection.format !== 'flac') {
      args.push('--audio-quality', selection.quality === 'best' ? '0' : `${selection.quality}K`)
    }
    args.push(...postProcessingArgs(selection.format, extras))
    return {
      kind: 'audio',
      args,
      outputFormat: selection.format,
      qualityLabel: audioQualityLabel(selection.format, selection.quality),
      streams: [],
      estimatedBytes: null
    }
  }

  const { container, height, codec } = selection
  const sortCodec = codec === 'auto' ? AUTO_SORT_CODEC[container] : codec
  const sort = [height === 'best' ? 'res' : `res:${height}`, 'fps', ...(sortCodec ? [`vcodec:${SORT_CODEC[sortCodec]}`] : []), 'channels:2']
  const resolution = height === 'best' ? 'Best available' : `Up to ${resolutionLabel(height, null)}`
  return {
    kind: 'video',
    args: [
      '-f',
      PROFILE_FORMAT[container],
      '-S',
      sort.join(','),
      '--merge-output-format',
      container,
      '--remux-video',
      container,
      ...postProcessingArgs(container, extras)
    ],
    outputFormat: container,
    qualityLabel: codec === 'auto' ? resolution : `${resolution} · ${CODEC_LABELS[codec]}`,
    streams: [],
    estimatedBytes: null
  }
}

function postProcessingArgs(format: string, options: DownloadOptions): string[] {
  const args: string[] = []
  if (options.embedMetadata) args.push('--embed-metadata')
  if (options.embedThumbnail && supportsEmbeddedThumbnail(format)) args.push('--embed-thumbnail')
  return args
}

function subtitlesArgs(subtitles: NonNullable<DownloadOptions['subtitles']>): string[] {
  const args = ['--write-subs', '--write-auto-subs', '--sub-langs', subtitles.languages.join(','), '--sub-format', `${subtitles.format}/best`]
  if (subtitles.format === 'srt') args.push('--convert-subs', 'srt')
  return args
}

export function audioQualityLabel(format: AudioFormat, quality: AudioQuality): string {
  if (format === 'wav') return 'Uncompressed'
  if (format === 'flac') return 'Lossless'
  return quality === 'best' ? 'Best quality' : `${quality} kbps`
}
