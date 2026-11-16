import type { AudioFormat, AudioQuality } from '../types/media'

/** Bitrate libmp3lame's best VBR setting (V0) averages for typical music. */
const MP3_V0_KBPS = 245
/** 48 kHz, 16-bit stereo PCM, the usual decode of web audio. */
const PCM_KBPS = 1536
/** FLAC typically stores web audio at about 60 % of PCM. */
const FLAC_RATIO = 0.6

/**
 * Rough output size of an audio conversion, for display only. `copied` means
 * the source already uses the target codec and is kept as-is.
 */
export function estimateAudioBytes(
  format: AudioFormat,
  quality: AudioQuality,
  durationSeconds: number | null,
  sourceKbps: number | null,
  copied: boolean
): number | null {
  if (!durationSeconds) return null
  let kbps: number | null
  if (format === 'wav') kbps = PCM_KBPS
  else if (format === 'flac') kbps = PCM_KBPS * FLAC_RATIO
  else if (copied) kbps = sourceKbps
  else if (quality === 'best') kbps = format === 'mp3' ? MP3_V0_KBPS : (sourceKbps ?? 192)
  else kbps = Number(quality)
  return kbps ? Math.round((kbps * 1000 * durationSeconds) / 8) : null
}
