import type { PreviousDownload } from './downloads'
import type { PlaylistDetails } from './playlists'

export type VideoContainer = 'mp4' | 'webm' | 'mkv'
export type AudioFormat = 'mp3' | 'm4a' | 'wav' | 'flac' | 'opus'
export type AudioQuality = 'best' | '128' | '192' | '256' | '320'
export type VideoCodec = 'h264' | 'hevc' | 'vp9' | 'av1' | 'vp8'
export type CodecPreference = 'auto' | VideoCodec
export type SubtitleFormat = 'srt' | 'vtt'

export interface ResolutionOption {
  /** Short side in pixels (1080 for both 1920×1080 and a vertical 1080×1920 video). */
  height: number
  /** e.g. "1080p60", "2160p (4K)" */
  label: string
  fps: number | null
  /** Video codecs available at this resolution that fit the container without re-encoding. */
  codecs: VideoCodec[]
  hdr: boolean
  /** Video + audio, using the automatic codec choice. Null when the source does not report sizes. */
  estimatedBytes: number | null
}

export interface ContainerOption {
  container: VideoContainer
  /** Highest first. */
  resolutions: ResolutionOption[]
}

export interface SubtitleTrack {
  lang: string
  name: string
  /** Machine-generated captions rather than subtitles uploaded by the publisher. */
  automatic: boolean
}

export type MediaNoticeCode = 'JS_RUNTIME_MISSING' | 'PART_OF_PLAYLIST' | 'NO_VIDEO' | 'NO_AUDIO'

export interface MediaNotice {
  code: MediaNoticeCode
  message: string
}

/** What the renderer receives after analysing a URL. Raw format lists stay in the main process. */
export interface MediaAnalysis {
  /** Reference to the analysis cached in the main process; downloads are requested against it. */
  analysisId: string
  url: string
  /** "<extractor>:<id>", e.g. "youtube:aqz-KE-bpKQ" */
  sourceId: string
  extractor: string
  title: string
  uploader: string | null
  durationSeconds: number | null
  /** ISO date (YYYY-MM-DD) */
  uploadDate: string | null
  viewCount: number | null
  /** A small JPEG data URL fetched by the main process, or null. */
  thumbnail: string | null
  /** Only the containers that can be produced from the available streams without re-encoding video. */
  video: ContainerOption[]
  audio: {
    available: boolean
    /** e.g. ["Opus", "AAC"] */
    codecs: string[]
    bestBitrateKbps: number | null
    /** Highest channel count among audio streams. */
    channels: number | null
  }
  subtitles: SubtitleTrack[]
  notices: MediaNotice[]
}

/** A pasted link is either a single video or a playlist (including a channel's Videos tab). */
export type AnalyzeResult =
  /** `previousDownloads`: earlier downloads of the same video, newest first. */
  | { kind: 'media'; media: MediaAnalysis; previousDownloads: PreviousDownload[] }
  | { kind: 'playlist'; playlist: PlaylistDetails }

export type DownloadSelection =
  | { kind: 'video'; container: VideoContainer; height: number | 'best'; codec: CodecPreference }
  | { kind: 'audio'; format: AudioFormat; quality: AudioQuality }

export interface DownloadOptions {
  embedMetadata: boolean
  embedThumbnail: boolean
  subtitles: {
    languages: string[]
    format: SubtitleFormat
    /** Download only the subtitle files, not the media. */
    only: boolean
  } | null
}

export interface DownloadRequest {
  analysisId: string
  selection: DownloadSelection
  options: DownloadOptions
}
