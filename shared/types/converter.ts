import type { AudioFormat, AudioQuality } from './media'

/** What FFprobe found in a picked file. */
export interface ConverterSource {
  /** e.g. "aac", "pcm_s16le", "opus" */
  codec: string
  sampleRate: number | null
  channels: number | null
  bitrateKbps: number | null
  /** Bits per sample for lossless sources (16, 24…), when reported. */
  bitDepth: number | null
  lossless: boolean
  /** The file also has a (non-cover) video stream; only its audio is converted. */
  hasVideo: boolean
  hasCover: boolean
  title: string | null
  artist: string | null
}

/**
 * A local file the user picked in the native file dialog. The renderer refers
 * to it only by `token`; the path never travels back to the main process.
 */
export interface ConverterInput {
  token: string
  name: string
  /** For display only. */
  path: string
  sizeBytes: number
  durationSeconds: number | null
  /** Null when the file could not be read as media; see `error`. */
  source: ConverterSource | null
  error: string | null
}

export type ConverterDestination =
  | { kind: 'downloads' }
  /** Next to each original file. */
  | { kind: 'source' }
  /** A folder chosen in the native folder dialog. */
  | { kind: 'custom'; token: string }

export interface ConversionRequest {
  inputs: string[]
  format: AudioFormat
  quality: AudioQuality
  destination: ConverterDestination
}

export type ConversionStatus = 'queued' | 'converting' | 'completed' | 'failed' | 'cancelled'

export interface ConversionJob {
  id: string
  inputName: string
  format: AudioFormat
  /** e.g. "192 kbps", "Lossless", "Copied (no re-encoding)" */
  qualityLabel: string
  status: ConversionStatus
  /** 0–100 */
  progress: number
  /** Multiple of real time, e.g. 42 for "42×". */
  speed: number | null
  /** Seconds remaining. */
  eta: number | null
  durationSeconds: number | null
  /** Final file once completed. */
  outputPath: string | null
  outputSizeBytes: number | null
  error: string | null
  createdAt: string
  completedAt: string | null
}

/** A folder picked in the native dialog, referenced by token. */
export interface PickedFolder {
  token: string
  path: string
}
