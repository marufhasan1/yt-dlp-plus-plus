import type { AudioFormat } from '@shared/types/media'
import type { ConverterSource } from '@shared/types/converter'

const CODEC_NAMES: Record<string, string> = {
  aac: 'AAC',
  mp3: 'MP3',
  opus: 'Opus',
  vorbis: 'Vorbis',
  flac: 'FLAC',
  alac: 'ALAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
  wmav2: 'WMA',
  wavpack: 'WavPack',
  ape: "Monkey's Audio",
  truehd: 'TrueHD'
}

export function codecName(codec: string): string {
  if (codec.startsWith('pcm_')) return 'PCM'
  return CODEC_NAMES[codec] ?? codec.toUpperCase()
}

function channelName(channels: number): string {
  if (channels === 1) return 'mono'
  if (channels === 2) return 'stereo'
  if (channels === 6) return '5.1'
  if (channels === 8) return '7.1'
  return `${channels} channels`
}

/** "AAC · 44.1 kHz · stereo · 128 kbps", "PCM 24-bit · 96 kHz · mono" */
export function describeSource(source: ConverterSource): string {
  const parts = [source.bitDepth && source.lossless ? `${codecName(source.codec)} ${source.bitDepth}-bit` : codecName(source.codec)]
  if (source.sampleRate) parts.push(`${Number((source.sampleRate / 1000).toFixed(1))} kHz`)
  if (source.channels) parts.push(channelName(source.channels))
  if (source.bitrateKbps && !source.lossless) parts.push(`${source.bitrateKbps} kbps`)
  return parts.join(' · ')
}

/** Source codecs the converter keeps as they are (no re-encoding) for each output format. */
export const SAME_CODEC: Record<AudioFormat, string | null> = {
  mp3: 'mp3',
  m4a: 'aac',
  opus: 'opus',
  flac: 'flac',
  wav: null
}

export function isLosslessFormat(format: AudioFormat): boolean {
  return format === 'flac' || format === 'wav'
}

/** 42 → "42×", 0.8 → "0.8×" */
export function formatRealtime(speed: number | null): string {
  if (speed === null || !Number.isFinite(speed) || speed <= 0) return '—'
  return `${speed >= 10 ? Math.round(speed) : Number(speed.toFixed(1))}×`
}
